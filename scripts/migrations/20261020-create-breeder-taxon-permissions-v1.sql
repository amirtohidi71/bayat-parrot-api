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
  IF to_regclass('public.breeder_applications') IS NULL OR to_regprocedure('public.uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Breeder foundation requires existing onboarding schema';
  END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS public.bird_species (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  key varchar(100) NOT NULL, "displayName" varchar(100) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_bird_species" PRIMARY KEY(id),
  CONSTRAINT "UQ_bird_species_key" UNIQUE(key),
  CONSTRAINT "CHK_bird_species_text" CHECK (key=btrim(key) AND length(key)>0 AND length(btrim("displayName"))>0)
);
CREATE TABLE breeder_foundation_preflight_v1.expected_bird_species (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  key varchar(100) NOT NULL, "displayName" varchar(100) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_bird_species" PRIMARY KEY(id),
  CONSTRAINT "UQ_bird_species_key" UNIQUE(key),
  CONSTRAINT "CHK_bird_species_text" CHECK (key=btrim(key) AND length(key)>0 AND length(btrim("displayName"))>0)
);
SELECT pg_temp.assert_breeder_table('public.bird_species'::regclass,'breeder_foundation_preflight_v1.expected_bird_species'::regclass);

CREATE TABLE IF NOT EXISTS public.bird_subspecies (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "speciesId" uuid NOT NULL, key varchar(100) NOT NULL, "displayName" varchar(100) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_bird_subspecies" PRIMARY KEY(id),
  CONSTRAINT "UQ_bird_subspecies_species_key" UNIQUE("speciesId",key),
  CONSTRAINT "UQ_bird_subspecies_id_species" UNIQUE(id,"speciesId"),
  CONSTRAINT "FK_bird_subspecies_species" FOREIGN KEY("speciesId") REFERENCES public.bird_species(id) ON DELETE RESTRICT,
  CONSTRAINT "CHK_bird_subspecies_text" CHECK (key=btrim(key) AND length(key)>0 AND length(btrim("displayName"))>0)
);
CREATE TABLE breeder_foundation_preflight_v1.expected_bird_subspecies (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "speciesId" uuid NOT NULL, key varchar(100) NOT NULL, "displayName" varchar(100) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_bird_subspecies" PRIMARY KEY(id),
  CONSTRAINT "UQ_bird_subspecies_species_key" UNIQUE("speciesId",key),
  CONSTRAINT "UQ_bird_subspecies_id_species" UNIQUE(id,"speciesId"),
  CONSTRAINT "FK_bird_subspecies_species" FOREIGN KEY("speciesId") REFERENCES public.bird_species(id) ON DELETE RESTRICT,
  CONSTRAINT "CHK_bird_subspecies_text" CHECK (key=btrim(key) AND length(key)>0 AND length(btrim("displayName"))>0)
);
SELECT pg_temp.assert_breeder_table('public.bird_subspecies'::regclass,'breeder_foundation_preflight_v1.expected_bird_subspecies'::regclass);

CREATE TABLE IF NOT EXISTS public.breeder_species_permissions (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "applicationId" uuid NOT NULL, "speciesId" uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'REQUESTED',
  revision integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_breeder_species_permissions" PRIMARY KEY(id),
  CONSTRAINT "UQ_breeder_species_application_species" UNIQUE("applicationId","speciesId"),
  CONSTRAINT "UQ_breeder_species_identity" UNIQUE(id,"applicationId","speciesId"),
  CONSTRAINT "UQ_breeder_species_event_identity" UNIQUE(id,"applicationId"),
  CONSTRAINT "FK_breeder_species_application" FOREIGN KEY("applicationId") REFERENCES public.breeder_applications(id) ON DELETE RESTRICT,
  CONSTRAINT "FK_breeder_species_taxon" FOREIGN KEY("speciesId") REFERENCES public.bird_species(id) ON DELETE RESTRICT,
  CONSTRAINT "CHK_breeder_species_state" CHECK (state IN ('REQUESTED','APPROVED','REJECTED','REVOKED') AND revision>0)
);
CREATE TABLE breeder_foundation_preflight_v1.expected_breeder_species_permissions (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "applicationId" uuid NOT NULL, "speciesId" uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'REQUESTED',
  revision integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_breeder_species_permissions" PRIMARY KEY(id),
  CONSTRAINT "UQ_breeder_species_application_species" UNIQUE("applicationId","speciesId"),
  CONSTRAINT "UQ_breeder_species_identity" UNIQUE(id,"applicationId","speciesId"),
  CONSTRAINT "UQ_breeder_species_event_identity" UNIQUE(id,"applicationId"),
  CONSTRAINT "FK_breeder_species_application" FOREIGN KEY("applicationId") REFERENCES public.breeder_applications(id) ON DELETE RESTRICT,
  CONSTRAINT "FK_breeder_species_taxon" FOREIGN KEY("speciesId") REFERENCES public.bird_species(id) ON DELETE RESTRICT,
  CONSTRAINT "CHK_breeder_species_state" CHECK (state IN ('REQUESTED','APPROVED','REJECTED','REVOKED') AND revision>0)
);
CREATE INDEX IF NOT EXISTS "IDX_breeder_species_application_state" ON public.breeder_species_permissions ("applicationId",state);
CREATE INDEX "IDX_breeder_species_application_state" ON breeder_foundation_preflight_v1.expected_breeder_species_permissions ("applicationId",state);
SELECT pg_temp.assert_breeder_table('public.breeder_species_permissions'::regclass,'breeder_foundation_preflight_v1.expected_breeder_species_permissions'::regclass);

CREATE TABLE IF NOT EXISTS public.breeder_subspecies_permissions (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "applicationId" uuid NOT NULL, "speciesId" uuid NOT NULL, "subspeciesId" uuid NOT NULL, "speciesPermissionId" uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'REQUESTED',
  revision integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_breeder_subspecies_permissions" PRIMARY KEY(id),
  CONSTRAINT "UQ_breeder_subspecies_application_subspecies" UNIQUE("applicationId","subspeciesId"),
  CONSTRAINT "UQ_breeder_subspecies_listing_identity" UNIQUE(id,"applicationId","speciesId","subspeciesId"),
  CONSTRAINT "UQ_breeder_subspecies_event_identity" UNIQUE(id,"applicationId"),
  CONSTRAINT "FK_breeder_subspecies_parent" FOREIGN KEY("speciesPermissionId","applicationId","speciesId")
    REFERENCES public.breeder_species_permissions(id,"applicationId","speciesId") ON DELETE RESTRICT,
  CONSTRAINT "FK_breeder_subspecies_taxon" FOREIGN KEY("subspeciesId","speciesId")
    REFERENCES public.bird_subspecies(id,"speciesId") ON DELETE RESTRICT,
  CONSTRAINT "CHK_breeder_subspecies_state" CHECK (state IN ('REQUESTED','APPROVED','REJECTED','REVOKED') AND revision>0)
);
CREATE TABLE breeder_foundation_preflight_v1.expected_breeder_subspecies_permissions (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "applicationId" uuid NOT NULL, "speciesId" uuid NOT NULL, "subspeciesId" uuid NOT NULL, "speciesPermissionId" uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'REQUESTED',
  revision integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_breeder_subspecies_permissions" PRIMARY KEY(id),
  CONSTRAINT "UQ_breeder_subspecies_application_subspecies" UNIQUE("applicationId","subspeciesId"),
  CONSTRAINT "UQ_breeder_subspecies_listing_identity" UNIQUE(id,"applicationId","speciesId","subspeciesId"),
  CONSTRAINT "UQ_breeder_subspecies_event_identity" UNIQUE(id,"applicationId"),
  CONSTRAINT "FK_breeder_subspecies_parent" FOREIGN KEY("speciesPermissionId","applicationId","speciesId")
    REFERENCES public.breeder_species_permissions(id,"applicationId","speciesId") ON DELETE RESTRICT,
  CONSTRAINT "FK_breeder_subspecies_taxon" FOREIGN KEY("subspeciesId","speciesId")
    REFERENCES public.bird_subspecies(id,"speciesId") ON DELETE RESTRICT,
  CONSTRAINT "CHK_breeder_subspecies_state" CHECK (state IN ('REQUESTED','APPROVED','REJECTED','REVOKED') AND revision>0)
);
CREATE INDEX IF NOT EXISTS "IDX_breeder_subspecies_application_state" ON public.breeder_subspecies_permissions ("applicationId",state);
CREATE INDEX "IDX_breeder_subspecies_application_state" ON breeder_foundation_preflight_v1.expected_breeder_subspecies_permissions ("applicationId",state);
CREATE INDEX IF NOT EXISTS "IDX_breeder_subspecies_parent_state" ON public.breeder_subspecies_permissions ("speciesPermissionId",state);
CREATE INDEX "IDX_breeder_subspecies_parent_state" ON breeder_foundation_preflight_v1.expected_breeder_subspecies_permissions ("speciesPermissionId",state);
SELECT pg_temp.assert_breeder_table('public.breeder_subspecies_permissions'::regclass,'breeder_foundation_preflight_v1.expected_breeder_subspecies_permissions'::regclass);

CREATE TABLE IF NOT EXISTS public.breeder_permission_events (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "applicationId" uuid NOT NULL, "speciesPermissionId" uuid, "subspeciesPermissionId" uuid,
  revision integer NOT NULL, action varchar(16) NOT NULL, "fromState" varchar(16), "toState" varchar(16) NOT NULL,
  "actorType" varchar(8) NOT NULL, "actorId" varchar(100) NOT NULL, reason varchar(500),
  "requestId" uuid NOT NULL, "requestHash" varchar(64) NOT NULL,
  "affectedListingCount" integer NOT NULL DEFAULT 0, "affectedProductCount" integer NOT NULL DEFAULT 0,
  "occurredAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_breeder_permission_events" PRIMARY KEY(id),
  CONSTRAINT "UQ_breeder_event_species_revision" UNIQUE("speciesPermissionId",revision),
  CONSTRAINT "UQ_breeder_event_subspecies_revision" UNIQUE("subspeciesPermissionId",revision),
  CONSTRAINT "UQ_breeder_event_species_request" UNIQUE("applicationId","requestId","speciesPermissionId"),
  CONSTRAINT "UQ_breeder_event_subspecies_request" UNIQUE("applicationId","requestId","subspeciesPermissionId"),
  CONSTRAINT "FK_breeder_event_species" FOREIGN KEY("speciesPermissionId","applicationId")
    REFERENCES public.breeder_species_permissions(id,"applicationId") ON DELETE RESTRICT,
  CONSTRAINT "FK_breeder_event_subspecies" FOREIGN KEY("subspeciesPermissionId","applicationId")
    REFERENCES public.breeder_subspecies_permissions(id,"applicationId") ON DELETE RESTRICT,
  CONSTRAINT "CHK_breeder_event_subject" CHECK (num_nonnulls("speciesPermissionId","subspeciesPermissionId")=1),
  CONSTRAINT "CHK_breeder_event_audit" CHECK (revision>0 AND "actorType" IN ('CUSTOMER','ADMIN')
    AND length(btrim("actorId"))>0 AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND (reason IS NULL OR length(btrim(reason))>0)
    AND (action='REQUEST' OR ("actorType"='ADMIN' AND reason IS NOT NULL))
    AND "affectedListingCount">=0 AND "affectedProductCount">=0),
  CONSTRAINT "CHK_breeder_event_transition" CHECK (
    (action='REQUEST' AND "toState"='REQUESTED' AND ("fromState" IS NULL OR "fromState" IN ('REJECTED','REVOKED')))
    OR (action='APPROVE' AND "fromState" IS NOT NULL AND "fromState"='REQUESTED' AND "toState"='APPROVED')
    OR (action='REJECT' AND "fromState" IS NOT NULL AND "fromState"='REQUESTED' AND "toState"='REJECTED')
    OR (action='REVOKE' AND "fromState" IS NOT NULL AND "fromState"='APPROVED' AND "toState"='REVOKED')
    OR (action='REGRANT' AND "fromState" IS NOT NULL AND "fromState" IN ('REJECTED','REVOKED') AND "toState"='APPROVED')
  )
);
CREATE TABLE breeder_foundation_preflight_v1.expected_breeder_permission_events (
  id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
  "applicationId" uuid NOT NULL, "speciesPermissionId" uuid, "subspeciesPermissionId" uuid,
  revision integer NOT NULL, action varchar(16) NOT NULL, "fromState" varchar(16), "toState" varchar(16) NOT NULL,
  "actorType" varchar(8) NOT NULL, "actorId" varchar(100) NOT NULL, reason varchar(500),
  "requestId" uuid NOT NULL, "requestHash" varchar(64) NOT NULL,
  "affectedListingCount" integer NOT NULL DEFAULT 0, "affectedProductCount" integer NOT NULL DEFAULT 0,
  "occurredAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_breeder_permission_events" PRIMARY KEY(id),
  CONSTRAINT "UQ_breeder_event_species_revision" UNIQUE("speciesPermissionId",revision),
  CONSTRAINT "UQ_breeder_event_subspecies_revision" UNIQUE("subspeciesPermissionId",revision),
  CONSTRAINT "UQ_breeder_event_species_request" UNIQUE("applicationId","requestId","speciesPermissionId"),
  CONSTRAINT "UQ_breeder_event_subspecies_request" UNIQUE("applicationId","requestId","subspeciesPermissionId"),
  CONSTRAINT "FK_breeder_event_species" FOREIGN KEY("speciesPermissionId","applicationId")
    REFERENCES public.breeder_species_permissions(id,"applicationId") ON DELETE RESTRICT,
  CONSTRAINT "FK_breeder_event_subspecies" FOREIGN KEY("subspeciesPermissionId","applicationId")
    REFERENCES public.breeder_subspecies_permissions(id,"applicationId") ON DELETE RESTRICT,
  CONSTRAINT "CHK_breeder_event_subject" CHECK (num_nonnulls("speciesPermissionId","subspeciesPermissionId")=1),
  CONSTRAINT "CHK_breeder_event_audit" CHECK (revision>0 AND "actorType" IN ('CUSTOMER','ADMIN')
    AND length(btrim("actorId"))>0 AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND (reason IS NULL OR length(btrim(reason))>0)
    AND (action='REQUEST' OR ("actorType"='ADMIN' AND reason IS NOT NULL))
    AND "affectedListingCount">=0 AND "affectedProductCount">=0),
  CONSTRAINT "CHK_breeder_event_transition" CHECK (
    (action='REQUEST' AND "toState"='REQUESTED' AND ("fromState" IS NULL OR "fromState" IN ('REJECTED','REVOKED')))
    OR (action='APPROVE' AND "fromState" IS NOT NULL AND "fromState"='REQUESTED' AND "toState"='APPROVED')
    OR (action='REJECT' AND "fromState" IS NOT NULL AND "fromState"='REQUESTED' AND "toState"='REJECTED')
    OR (action='REVOKE' AND "fromState" IS NOT NULL AND "fromState"='APPROVED' AND "toState"='REVOKED')
    OR (action='REGRANT' AND "fromState" IS NOT NULL AND "fromState" IN ('REJECTED','REVOKED') AND "toState"='APPROVED')
  )
);
CREATE INDEX IF NOT EXISTS "IDX_breeder_event_application_time" ON public.breeder_permission_events ("applicationId","occurredAt",id);
CREATE INDEX "IDX_breeder_event_application_time" ON breeder_foundation_preflight_v1.expected_breeder_permission_events ("applicationId","occurredAt",id);
SELECT pg_temp.assert_breeder_table('public.breeder_permission_events'::regclass,'breeder_foundation_preflight_v1.expected_breeder_permission_events'::regclass);

SELECT pg_temp.install_breeder_function('guard_breeder_identity_v1',$body$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Breeder identity/history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME IN ('bird_species','bird_subspecies') THEN
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['displayName','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['displayName','updatedAt']) THEN
      RAISE EXCEPTION 'Taxonomy identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF TG_OP='INSERT' THEN
      IF NEW.state<>'REQUESTED' OR NEW.revision<>1 THEN
        RAISE EXCEPTION 'Permissions start as requested revision one' USING ERRCODE='23514';
      END IF;
    ELSE
      IF (to_jsonb(NEW)-ARRAY['state','revision','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','updatedAt'])
        OR (NEW.state<>OLD.state AND NEW.revision<>OLD.revision+1)
        OR (NEW.state=OLD.state AND NEW.revision<>OLD.revision) THEN
        RAISE EXCEPTION 'Incompatible permission identity/revision transition' USING ERRCODE='23514';
      END IF;
    END IF;
    IF TG_TABLE_NAME='breeder_subspecies_permissions' AND NEW.state='APPROVED' THEN
      PERFORM 1 FROM public.breeder_species_permissions WHERE id=NEW."speciesPermissionId" AND state='APPROVED' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Parent species permission is not approved' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END$body$);

SELECT pg_temp.install_breeder_function('guard_breeder_event_append_only_v1',$body$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Breeder permission audit is append only' USING ERRCODE='23514';
  END IF;
  NEW."occurredAt"=clock_timestamp();
  RETURN NEW;
END$body$);

SELECT pg_temp.install_breeder_function('assert_breeder_permission_audit_v1',$body$
DECLARE event public.breeder_permission_events%ROWTYPE; prior_state text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.state=OLD.state AND NEW.revision=OLD.revision THEN RETURN NULL; END IF;
  prior_state=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.state END;
  SELECT * INTO event FROM public.breeder_permission_events
    WHERE revision=NEW.revision AND "applicationId"=NEW."applicationId"
      AND CASE WHEN TG_TABLE_NAME='breeder_species_permissions' THEN "speciesPermissionId"=NEW.id ELSE "subspeciesPermissionId"=NEW.id END;
  IF NOT FOUND OR event."toState"<>NEW.state OR event."fromState" IS DISTINCT FROM prior_state THEN
    RAISE EXCEPTION 'Permission transition requires its matching audit event' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='breeder_species_permissions' THEN
    IF NEW.state<>'APPROVED' AND EXISTS (SELECT 1 FROM public.breeder_subspecies_permissions WHERE "speciesPermissionId"=NEW.id AND state='APPROVED') THEN
      -- Check the final projection, not an intermediate state in this transaction.
      IF EXISTS (SELECT 1 FROM public.breeder_species_permissions WHERE id=NEW.id AND state<>'APPROVED') THEN
        RAISE EXCEPTION 'Approved children require an approved parent' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END$body$);

SELECT pg_temp.install_breeder_function('assert_breeder_event_chain_v1',$body$
DECLARE projection_revision integer; projection_state text; previous_state text;
BEGIN
  IF NEW."speciesPermissionId" IS NOT NULL THEN
    SELECT revision,state INTO projection_revision,projection_state FROM public.breeder_species_permissions WHERE id=NEW."speciesPermissionId";
    SELECT "toState" INTO previous_state FROM public.breeder_permission_events WHERE "speciesPermissionId"=NEW."speciesPermissionId" AND revision=NEW.revision-1;
  ELSE
    SELECT revision,state INTO projection_revision,projection_state FROM public.breeder_subspecies_permissions WHERE id=NEW."subspeciesPermissionId";
    SELECT "toState" INTO previous_state FROM public.breeder_permission_events WHERE "subspeciesPermissionId"=NEW."subspeciesPermissionId" AND revision=NEW.revision-1;
  END IF;
  IF projection_revision IS NULL OR NEW.revision>projection_revision
    OR (NEW.revision=projection_revision AND NEW."toState"<>projection_state)
    OR (NEW.revision=1 AND (NEW."fromState" IS NOT NULL OR NEW.action<>'REQUEST'))
    OR (NEW.revision>1 AND (previous_state IS NULL OR NEW."fromState" IS DISTINCT FROM previous_state)) THEN
    RAISE EXCEPTION 'Incompatible permission audit chain' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END$body$);
SELECT pg_temp.install_breeder_trigger('bird_species','TRG_breeder_identity','guard_breeder_identity_v1',false,31);
SELECT pg_temp.install_breeder_trigger('bird_subspecies','TRG_breeder_identity','guard_breeder_identity_v1',false,31);
SELECT pg_temp.install_breeder_trigger('breeder_species_permissions','TRG_breeder_identity','guard_breeder_identity_v1',false,31);
SELECT pg_temp.install_breeder_trigger('breeder_subspecies_permissions','TRG_breeder_identity','guard_breeder_identity_v1',false,31);
SELECT pg_temp.install_breeder_trigger('breeder_species_permissions','TRG_breeder_permission_audit','assert_breeder_permission_audit_v1',true,21);
SELECT pg_temp.install_breeder_trigger('breeder_subspecies_permissions','TRG_breeder_permission_audit','assert_breeder_permission_audit_v1',true,21);
SELECT pg_temp.install_breeder_trigger('breeder_permission_events','TRG_breeder_events_append_only','guard_breeder_event_append_only_v1',false,31);
SELECT pg_temp.install_breeder_trigger('breeder_permission_events','TRG_breeder_event_chain','assert_breeder_event_chain_v1',true,21);

-- Existing unexpected user triggers must not silently change this contract.
DO $triggers$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid IN (
    'public.bird_species'::regclass,'public.bird_subspecies'::regclass,
    'public.breeder_species_permissions'::regclass,'public.breeder_subspecies_permissions'::regclass,
    'public.breeder_permission_events'::regclass)
    AND NOT tgisinternal AND NOT EXISTS (SELECT 1 FROM (VALUES
      ('bird_species','TRG_breeder_identity'), ('bird_subspecies','TRG_breeder_identity'),
      ('breeder_species_permissions','TRG_breeder_identity'), ('breeder_subspecies_permissions','TRG_breeder_identity'),
      ('breeder_species_permissions','TRG_breeder_permission_audit'), ('breeder_subspecies_permissions','TRG_breeder_permission_audit'),
      ('breeder_permission_events','TRG_breeder_events_append_only'), ('breeder_permission_events','TRG_breeder_event_chain')
    ) AS expected(table_name,trigger_name)
      WHERE pg_trigger.tgrelid=to_regclass('public.'||expected.table_name) AND pg_trigger.tgname=expected.trigger_name)) THEN
    RAISE EXCEPTION 'Unexpected breeder foundation trigger';
  END IF;
END $triggers$;
DROP TABLE breeder_foundation_preflight_v1.expected_breeder_permission_events;
DROP TABLE breeder_foundation_preflight_v1.expected_breeder_subspecies_permissions;
DROP TABLE breeder_foundation_preflight_v1.expected_breeder_species_permissions;
DROP TABLE breeder_foundation_preflight_v1.expected_bird_subspecies;
DROP TABLE breeder_foundation_preflight_v1.expected_bird_species;
DROP SCHEMA breeder_foundation_preflight_v1;
COMMIT;
