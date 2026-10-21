\set ON_ERROR_STOP on
-- Forward only. Pause onboarding/listing writes and drain old API instances first.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:breeder-listing-foundation-v1', 0));

CREATE SCHEMA breeder_foundation_preflight_v1;
-- Reference tables are transactional and removed before COMMIT.
-- These helpers exist only in this migration session, never in public.
CREATE OR REPLACE FUNCTION pg_temp.assert_breeder_table(actual regclass, expected regclass)
RETURNS void LANGUAGE plpgsql AS $helper$
DECLARE a jsonb; e jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=actual AND relkind='r' AND relpersistence='p' AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'Incompatible breeder foundation table contract';
  END IF;
  SELECT jsonb_object_agg(att.attname, jsonb_build_array(format_type(att.atttypid,att.atttypmod),
    att.attnotnull,att.attidentity,att.attgenerated,att.attcollation,pg_get_expr(d.adbin,d.adrelid)))
    INTO a FROM pg_attribute att LEFT JOIN pg_attrdef d ON d.adrelid=att.attrelid AND d.adnum=att.attnum
    WHERE att.attrelid=actual AND att.attnum>0 AND NOT att.attisdropped;
  SELECT jsonb_object_agg(att.attname, jsonb_build_array(format_type(att.atttypid,att.atttypmod),
    att.attnotnull,att.attidentity,att.attgenerated,att.attcollation,pg_get_expr(d.adbin,d.adrelid)))
    INTO e FROM pg_attribute att LEFT JOIN pg_attrdef d ON d.adrelid=att.attrelid AND d.adnum=att.attnum
    WHERE att.attrelid=expected AND att.attnum>0 AND NOT att.attisdropped;
  IF a IS DISTINCT FROM e THEN RAISE EXCEPTION 'Incompatible breeder foundation column contract'; END IF;
  SELECT jsonb_object_agg(conname,jsonb_build_array(contype,pg_get_constraintdef(oid),
    convalidated,condeferrable,condeferred,connoinherit)) INTO a FROM pg_constraint WHERE conrelid=actual AND contype<>'t';
  SELECT jsonb_object_agg(conname,jsonb_build_array(contype,pg_get_constraintdef(oid),
    convalidated,condeferrable,condeferred,connoinherit)) INTO e FROM pg_constraint WHERE conrelid=expected AND contype<>'t';
  IF a IS DISTINCT FROM e THEN RAISE EXCEPTION 'Incompatible breeder foundation constraint contract'; END IF;
  SELECT jsonb_object_agg(c.relname,jsonb_build_array(am.amname,i.indisunique,i.indisvalid,i.indisready,
    i.indisprimary,i.indisexclusion,i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,
    i.indclass::text,i.indcollation::text,pg_get_expr(i.indpred,i.indrelid),pg_get_expr(i.indexprs,i.indrelid)))
    INTO a FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE i.indrelid=actual;
  SELECT jsonb_object_agg(c.relname,jsonb_build_array(am.amname,i.indisunique,i.indisvalid,i.indisready,
    i.indisprimary,i.indisexclusion,i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,
    i.indclass::text,i.indcollation::text,pg_get_expr(i.indpred,i.indrelid),pg_get_expr(i.indexprs,i.indrelid)))
    INTO e FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE i.indrelid=expected;
  IF a IS DISTINCT FROM e THEN RAISE EXCEPTION 'Incompatible breeder foundation index contract'; END IF;
END $helper$;

CREATE OR REPLACE FUNCTION pg_temp.install_breeder_function(function_name text, body text)
RETURNS void LANGUAGE plpgsql AS $helper$
DECLARE target regprocedure;
BEGIN
  target=to_regprocedure('public.' || function_name || '()');
  IF target IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=target AND prosrc=body AND prorettype='trigger'::regtype
      AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND NOT prosecdef
      AND provolatile='v' AND proconfig=ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION 'Incompatible breeder foundation function contract';
    END IF;
  ELSE
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, public AS %L',function_name,body);
  END IF;
END $helper$;

CREATE OR REPLACE FUNCTION pg_temp.install_breeder_trigger(table_name text, trigger_name text, function_name text, deferred boolean, trigger_type integer)
RETURNS void LANGUAGE plpgsql AS $helper$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||table_name) AND tgname=trigger_name) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||table_name) AND tgname=trigger_name
      AND NOT tgisinternal AND tgfoid=to_regprocedure('public.'||function_name||'()')
      AND tgtype=trigger_type AND tgenabled='O' AND tgnargs=0 AND tgqual IS NULL AND tgattr::text=''
      AND tgdeferrable=deferred AND tginitdeferred=deferred) THEN
      RAISE EXCEPTION 'Incompatible breeder foundation trigger contract';
    END IF;
  ELSE
    IF deferred THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.%I()', trigger_name,table_name,function_name);
    ELSE
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',trigger_name,table_name,function_name);
    END IF;
  END IF;
END $helper$;

DO $preflight$ BEGIN
  IF to_regclass('public.parrot_sale_listings') IS NULL
    OR to_regclass('public.parrot_sale_listing_creation_ledger') IS NULL
    OR to_regclass('public.breeder_subspecies_permissions') IS NULL THEN
    RAISE EXCEPTION 'Listing kind requires ledger and breeder permission foundations';
  END IF;
END $preflight$;
LOCK TABLE public.breeder_applications, public.parrot_sale_listings, public.parrot_sale_listing_creation_ledger IN SHARE ROW EXCLUSIVE MODE;

-- ADD with a constant default classifies all legacy rows, including ledger-only
-- history, without inferring breeder permissions or changing IDs/timestamps.
ALTER TABLE public.parrot_sale_listings
  ADD COLUMN IF NOT EXISTS "submissionKind" varchar(16) NOT NULL DEFAULT 'ORDINARY',
  ADD COLUMN IF NOT EXISTS "speciesId" uuid,
  ADD COLUMN IF NOT EXISTS "subspeciesId" uuid,
  ADD COLUMN IF NOT EXISTS "breederApplicationId" uuid,
  ADD COLUMN IF NOT EXISTS "breederSubspeciesPermissionId" uuid;
ALTER TABLE public.parrot_sale_listing_creation_ledger
  ADD COLUMN IF NOT EXISTS "submissionKind" varchar(16) NOT NULL DEFAULT 'ORDINARY';

DO $columns$
DECLARE target text; col text;
BEGIN
  FOREACH target IN ARRAY ARRAY['parrot_sale_listings','parrot_sale_listing_creation_ledger'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=to_regclass('public.'||target) AND a.attname='submissionKind' AND NOT a.attisdropped
        AND format_type(a.atttypid,a.atttypmod)='character varying(16)' AND a.attnotnull
        AND a.attidentity='' AND a.attgenerated=''
        AND pg_get_expr(d.adbin,d.adrelid)='''ORDINARY''::character varying') THEN
      RAISE EXCEPTION 'Incompatible listing submission kind column';
    END IF;
  END LOOP;
  FOREACH col IN ARRAY ARRAY['speciesId','subspeciesId','breederApplicationId','breederSubspeciesPermissionId'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.parrot_sale_listings'::regclass AND a.attname=col AND NOT a.attisdropped
        AND a.atttypid='uuid'::regtype AND NOT a.attnotnull AND a.attidentity='' AND a.attgenerated='' AND d.oid IS NULL) THEN
      RAISE EXCEPTION 'Incompatible breeder listing linkage column';
    END IF;
  END LOOP;
END $columns$;

CREATE TABLE breeder_foundation_preflight_v1.expected_breeder_app_owner (
  id uuid, "userId" uuid,
  CONSTRAINT "UQ_breeder_application_id_user" UNIQUE(id,"userId")
);

-- Install only fixed, reviewed constraints. Existing same-name constraints must
-- have the exact PostgreSQL definition and backing index contract.
CREATE OR REPLACE FUNCTION pg_temp.install_breeder_constraint(target regclass, reference regclass, constraint_name text)
RETURNS void LANGUAGE plpgsql AS $helper$
DECLARE a record; e record; ai jsonb; ei jsonb;
BEGIN
  SELECT * INTO e FROM pg_constraint WHERE conrelid=reference AND conname=constraint_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing expected breeder constraint'; END IF;
  SELECT * INTO a FROM pg_constraint WHERE conrelid=target AND conname=constraint_name;
  IF FOUND THEN
    IF a.contype<>e.contype OR pg_get_constraintdef(a.oid)<>pg_get_constraintdef(e.oid)
      OR a.convalidated<>e.convalidated OR a.condeferrable<>e.condeferrable
      OR a.condeferred<>e.condeferred OR a.connoinherit<>e.connoinherit THEN
      RAISE EXCEPTION 'Incompatible breeder listing constraint contract: %',constraint_name;
    END IF;
    IF a.contype IN ('p','u') THEN
      SELECT jsonb_build_array(am.amname,i.indisunique,i.indisvalid,i.indisready,i.indisprimary,i.indisexclusion,
        i.indnatts,i.indnkeyatts,i.indoption::text,i.indclass::text,i.indcollation::text,
        pg_get_expr(i.indpred,i.indrelid),pg_get_expr(i.indexprs,i.indrelid)) INTO ai
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE i.indexrelid=a.conindid;
      SELECT jsonb_build_array(am.amname,i.indisunique,i.indisvalid,i.indisready,i.indisprimary,i.indisexclusion,
        i.indnatts,i.indnkeyatts,i.indoption::text,i.indclass::text,i.indcollation::text,
        pg_get_expr(i.indpred,i.indrelid),pg_get_expr(i.indexprs,i.indrelid)) INTO ei
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE i.indexrelid=e.conindid;
      IF ai IS DISTINCT FROM ei THEN RAISE EXCEPTION 'Incompatible breeder listing unique index contract'; END IF;
    END IF;
  ELSE
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',target,constraint_name,pg_get_constraintdef(e.oid));
  END IF;
END $helper$;
SELECT pg_temp.install_breeder_constraint('public.breeder_applications','breeder_foundation_preflight_v1.expected_breeder_app_owner','UQ_breeder_application_id_user');

CREATE TABLE breeder_foundation_preflight_v1.expected_listing_kind (
  "submissionKind" varchar(16), "sellerUserId" uuid, "speciesId" uuid, "subspeciesId" uuid,
  "breederApplicationId" uuid, "breederSubspeciesPermissionId" uuid,
  CONSTRAINT "CHK_parrot_listing_kind" CHECK ("submissionKind"::text IN ('ORDINARY'::text,'BREEDER'::text)),
  CONSTRAINT "CHK_parrot_listing_breeder_link" CHECK (
    ("submissionKind"='ORDINARY' AND "breederApplicationId" IS NULL AND "breederSubspeciesPermissionId" IS NULL)
    OR ("submissionKind"='BREEDER' AND "breederApplicationId" IS NOT NULL AND "breederSubspeciesPermissionId" IS NOT NULL
      AND "speciesId" IS NOT NULL AND "subspeciesId" IS NOT NULL)),
  CONSTRAINT "CHK_parrot_listing_taxon_parent" CHECK ("subspeciesId" IS NULL OR "speciesId" IS NOT NULL),
  CONSTRAINT "FK_parrot_listing_species" FOREIGN KEY("speciesId") REFERENCES public.bird_species(id) ON DELETE RESTRICT,
  CONSTRAINT "FK_parrot_listing_subspecies" FOREIGN KEY("subspeciesId","speciesId") REFERENCES public.bird_subspecies(id,"speciesId") ON DELETE RESTRICT,
  CONSTRAINT "FK_parrot_listing_breeder_owner" FOREIGN KEY("breederApplicationId","sellerUserId") REFERENCES public.breeder_applications(id,"userId") ON DELETE RESTRICT,
  CONSTRAINT "FK_parrot_listing_breeder_permission" FOREIGN KEY("breederSubspeciesPermissionId","breederApplicationId","speciesId","subspeciesId")
    REFERENCES public.breeder_subspecies_permissions(id,"applicationId","speciesId","subspeciesId") ON DELETE RESTRICT
);
CREATE TABLE breeder_foundation_preflight_v1.expected_ledger_kind (
  "submissionKind" varchar(16),
  CONSTRAINT "CHK_parrot_listing_ledger_kind" CHECK ("submissionKind"::text IN ('ORDINARY'::text,'BREEDER'::text))
);
DO $constraints$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='breeder_foundation_preflight_v1.expected_listing_kind'::regclass LOOP
    PERFORM pg_temp.install_breeder_constraint('public.parrot_sale_listings','breeder_foundation_preflight_v1.expected_listing_kind',item.conname);
  END LOOP;
END $constraints$;
SELECT pg_temp.install_breeder_constraint('public.parrot_sale_listing_creation_ledger','breeder_foundation_preflight_v1.expected_ledger_kind','CHK_parrot_listing_ledger_kind');

CREATE TABLE breeder_foundation_preflight_v1.expected_listing_kind_indexes (id uuid,"breederSubspeciesPermissionId" uuid,"breederApplicationId" uuid,"submissionKind" varchar(16));
CREATE TABLE breeder_foundation_preflight_v1.expected_ledger_kind_indexes ("sellerUserId" uuid,"submissionKind" varchar(16),"createdAt" timestamptz);
CREATE INDEX IF NOT EXISTS "IDX_parrot_listing_breeder_permission" ON public.parrot_sale_listings ("breederSubspeciesPermissionId",id);
CREATE INDEX IF NOT EXISTS "IDX_parrot_listing_breeder_application" ON public.parrot_sale_listings ("breederApplicationId","submissionKind",id);
CREATE INDEX IF NOT EXISTS "IDX_parrot_listing_creation_kind_week" ON public.parrot_sale_listing_creation_ledger ("sellerUserId","submissionKind","createdAt" DESC);
CREATE INDEX "IDX_parrot_listing_breeder_permission" ON breeder_foundation_preflight_v1.expected_listing_kind_indexes ("breederSubspeciesPermissionId",id);
CREATE INDEX "IDX_parrot_listing_breeder_application" ON breeder_foundation_preflight_v1.expected_listing_kind_indexes ("breederApplicationId","submissionKind",id);
CREATE INDEX "IDX_parrot_listing_creation_kind_week" ON breeder_foundation_preflight_v1.expected_ledger_kind_indexes ("sellerUserId","submissionKind","createdAt" DESC);
DO $indexes$
DECLARE item record; a jsonb; e jsonb;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('IDX_parrot_listing_breeder_permission','public.parrot_sale_listings','breeder_foundation_preflight_v1.expected_listing_kind_indexes'),
    ('IDX_parrot_listing_breeder_application','public.parrot_sale_listings','breeder_foundation_preflight_v1.expected_listing_kind_indexes'),
    ('IDX_parrot_listing_creation_kind_week','public.parrot_sale_listing_creation_ledger','breeder_foundation_preflight_v1.expected_ledger_kind_indexes')
  ) AS expected(name,actual_table,reference_table) LOOP
    SELECT jsonb_build_array(am.amname,i.indisunique,i.indisvalid,i.indisready,i.indisprimary,i.indisexclusion,
      i.indnatts,i.indnkeyatts,i.indoption::text,i.indclass::text,i.indcollation::text,
      pg_get_expr(i.indpred,i.indrelid),pg_get_expr(i.indexprs,i.indrelid),
      (SELECT jsonb_agg(att.attname ORDER BY k.position) FROM unnest(i.indkey) WITH ORDINALITY k(number,position)
        LEFT JOIN pg_attribute att ON att.attrelid=i.indrelid AND att.attnum=k.number))
      INTO a FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
      WHERE i.indexrelid=to_regclass('public.'||quote_ident(item.name)) AND i.indrelid=to_regclass(item.actual_table);
    SELECT jsonb_build_array(am.amname,i.indisunique,i.indisvalid,i.indisready,i.indisprimary,i.indisexclusion,
      i.indnatts,i.indnkeyatts,i.indoption::text,i.indclass::text,i.indcollation::text,
      pg_get_expr(i.indpred,i.indrelid),pg_get_expr(i.indexprs,i.indrelid),
      (SELECT jsonb_agg(att.attname ORDER BY k.position) FROM unnest(i.indkey) WITH ORDINALITY k(number,position)
        LEFT JOIN pg_attribute att ON att.attrelid=i.indrelid AND att.attnum=k.number))
      INTO e FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
      WHERE c.relnamespace='breeder_foundation_preflight_v1'::regnamespace AND c.relname=item.name AND i.indrelid=to_regclass(item.reference_table);
    IF a IS DISTINCT FROM e THEN RAISE EXCEPTION 'Incompatible breeder listing index contract'; END IF;
  END LOOP;
END $indexes$;

-- Preserve all stored timestamps verbatim. Existing runtime inserts the ledger
-- timestamp through JavaScript Date; this foundation validates the NEW kind
-- linkage, not a new cross-table timestamp equality contract. The deployed
-- ledger immutability triggers remain unchanged.
DO $history$ BEGIN
  IF EXISTS (SELECT 1 FROM public.parrot_sale_listings l JOIN public.parrot_sale_listing_creation_ledger h ON h."listingId"=l.id
    WHERE l."submissionKind"<>h."submissionKind" OR l."sellerUserId"<>h."sellerUserId") THEN
    RAISE EXCEPTION 'Listing creation ledger differs from listing identity';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.parrot_sale_listing_creation_ledger'::regclass AND contype='f') THEN
    RAISE EXCEPTION 'Permanent listing ledger must remain FK-free';
  END IF;
END $history$;

SELECT pg_temp.install_breeder_function('guard_listing_submission_identity_v1',$body$
BEGIN
  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME='parrot_sale_listing_creation_ledger' THEN
      RAISE EXCEPTION 'Permanent listing creation history cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (NEW."submissionKind"<>OLD."submissionKind" OR NEW."sellerUserId"<>OLD."sellerUserId" OR NEW."createdAt"<>OLD."createdAt") THEN
    RAISE EXCEPTION 'Listing creation identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='parrot_sale_listings' THEN
      IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'Listing identity is immutable' USING ERRCODE='23514'; END IF;
    ELSE
      IF NEW."listingId"<>OLD."listingId" THEN RAISE EXCEPTION 'Ledger identity is immutable' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END$body$);
SELECT pg_temp.install_breeder_function('assert_listing_submission_pair_v1',$body$
DECLARE listing_id uuid; l record; h record;
BEGIN
  IF TG_TABLE_NAME='parrot_sale_listings' THEN listing_id=NEW.id; ELSE listing_id=NEW."listingId"; END IF;
  -- Per-original-listing transaction lock serializes either insertion order
  -- without an FK from permanent history to the removable operational row.
  PERFORM pg_advisory_xact_lock(hashtextextended('listing-kind-integrity:'||listing_id::text,0));
  SELECT * INTO l FROM public.parrot_sale_listings WHERE id=listing_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.parrot_sale_listing_creation_ledger WHERE "listingId"=listing_id;
  IF FOUND AND (l."submissionKind"<>h."submissionKind" OR l."sellerUserId"<>h."sellerUserId") THEN
    RAISE EXCEPTION 'Listing and ledger creation identity differ' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END$body$);
SELECT pg_temp.install_breeder_trigger('parrot_sale_listings','TRG_listing_submission_identity','guard_listing_submission_identity_v1',false,31);
SELECT pg_temp.install_breeder_trigger('parrot_sale_listing_creation_ledger','TRG_listing_submission_identity','guard_listing_submission_identity_v1',false,31);
SELECT pg_temp.install_breeder_trigger('parrot_sale_listings','TRG_listing_submission_pair','assert_listing_submission_pair_v1',true,21);
SELECT pg_temp.install_breeder_trigger('parrot_sale_listing_creation_ledger','TRG_listing_submission_pair','assert_listing_submission_pair_v1',true,21);
DROP TABLE breeder_foundation_preflight_v1.expected_ledger_kind_indexes;
DROP TABLE breeder_foundation_preflight_v1.expected_listing_kind_indexes;
DROP TABLE breeder_foundation_preflight_v1.expected_ledger_kind;
DROP TABLE breeder_foundation_preflight_v1.expected_listing_kind;
DROP TABLE breeder_foundation_preflight_v1.expected_breeder_app_owner;
DROP SCHEMA breeder_foundation_preflight_v1;
COMMIT;
