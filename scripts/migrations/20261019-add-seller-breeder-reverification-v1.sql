\set ON_ERROR_STOP on

-- Forward only. Pause onboarding/listing writes until the new backend is active.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:seller-breeder-reverification-v1', 0));
DO $preflight$
BEGIN
  IF to_regclass('public.seller_verifications') IS NULL
     OR to_regclass('public.breeder_applications') IS NULL THEN
    RAISE EXCEPTION 'Reverification requires seller onboarding tables';
  END IF;
END
$preflight$;
LOCK TABLE public.seller_verifications, public.breeder_applications IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.seller_verifications
  ADD COLUMN IF NOT EXISTS "reapplicationIntent" varchar(32) NOT NULL DEFAULT 'BLOCKED',
  ADD COLUMN IF NOT EXISTS "reapplicationGrantedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "reapplicationGrantedBy" varchar(100),
  ADD COLUMN IF NOT EXISTS "reapplicationGrantReason" varchar(500);
ALTER TABLE public.breeder_applications
  ADD COLUMN IF NOT EXISTS "revokedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "revokedBy" varchar(100),
  ADD COLUMN IF NOT EXISTS "revocationReason" varchar(500),
  ADD COLUMN IF NOT EXISTS "reapplicationIntent" varchar(32) NOT NULL DEFAULT 'BLOCKED';

DO $columns$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('seller_verifications','reapplicationIntent','character varying(32)',true,'''BLOCKED''::character varying'),
    ('seller_verifications','reapplicationGrantedAt','timestamp with time zone',false,NULL),
    ('seller_verifications','reapplicationGrantedBy','character varying(100)',false,NULL),
    ('seller_verifications','reapplicationGrantReason','character varying(500)',false,NULL),
    ('breeder_applications','reapplicationIntent','character varying(32)',true,'''BLOCKED''::character varying'),
    ('breeder_applications','revokedAt','timestamp with time zone',false,NULL),
    ('breeder_applications','revokedBy','character varying(100)',false,NULL),
    ('breeder_applications','revocationReason','character varying(500)',false,NULL)
  ) AS expected(table_name,column_name,column_type,not_null,default_expression)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=to_regclass('public.' || item.table_name)
        AND a.attname=item.column_name AND NOT a.attisdropped
        AND format_type(a.atttypid,a.atttypmod)=item.column_type
        AND a.attnotnull=item.not_null AND a.attidentity='' AND a.attgenerated=''
        AND pg_get_expr(d.adbin,d.adrelid) IS NOT DISTINCT FROM item.default_expression
    ) THEN RAISE EXCEPTION 'Incompatible reverification column contract'; END IF;
  END LOOP;
END
$columns$;

CREATE TEMP TABLE expected_seller_verifications (
  "userId" uuid, status public.seller_verifications_status_enum, "revokedAt" timestamptz,
  "revokedBy" varchar(100), "revocationReason" varchar(500), "reapplicationIntent" varchar(32),
  CHECK ("reapplicationIntent" IN ('BLOCKED','REQUIRE_REVERIFICATION')
    AND (("revokedAt" IS NULL AND "reapplicationIntent"='BLOCKED')
      OR ("revokedAt" IS NOT NULL AND status='APPROVED'
        AND "revokedBy" IS NOT NULL AND length(btrim("revokedBy")) BETWEEN 1 AND 100
        AND "revocationReason" IS NOT NULL AND length(btrim("revocationReason")) BETWEEN 1 AND 500)))
) ON COMMIT DROP;
DO $check$
DECLARE expected text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO expected FROM pg_constraint
    WHERE conrelid='pg_temp.expected_seller_verifications'::regclass AND contype='c';
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.seller_verifications'::regclass
    AND conname='CHK_seller_verifications_reverification') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.seller_verifications'::regclass
      AND conname='CHK_seller_verifications_reverification' AND contype='c' AND convalidated
      AND NOT connoinherit AND pg_get_expr(conbin,conrelid)=expected) THEN
      RAISE EXCEPTION 'Incompatible reverification CHECK contract';
    END IF;
  ELSE
    ALTER TABLE public.seller_verifications ADD CONSTRAINT "CHK_seller_verifications_reverification" CHECK ("reapplicationIntent" IN ('BLOCKED','REQUIRE_REVERIFICATION')
    AND (("revokedAt" IS NULL AND "reapplicationIntent"='BLOCKED')
      OR ("revokedAt" IS NOT NULL AND status='APPROVED'
        AND "revokedBy" IS NOT NULL AND length(btrim("revokedBy")) BETWEEN 1 AND 100
        AND "revocationReason" IS NOT NULL AND length(btrim("revocationReason")) BETWEEN 1 AND 500)));
  END IF;
END
$check$;
CREATE UNIQUE INDEX expected_seller_verifications_old ON expected_seller_verifications ("userId") WHERE status IN ('PENDING','APPROVED');
CREATE UNIQUE INDEX expected_seller_verifications_new ON expected_seller_verifications ("userId") WHERE status IN ('PENDING') OR (status='APPROVED' AND "revokedAt" IS NULL);
DO $index$
DECLARE actual text; previous text; intended text;
BEGIN
  SELECT pg_get_expr(indpred,indrelid) INTO previous FROM pg_index
    WHERE indexrelid='pg_temp.expected_seller_verifications_old'::regclass;
  SELECT pg_get_expr(indpred,indrelid) INTO intended FROM pg_index
    WHERE indexrelid='pg_temp.expected_seller_verifications_new'::regclass;
  IF to_regclass('public."UQ_seller_verifications_active_user"') IS NULL THEN
    RAISE EXCEPTION 'Required active-request index is missing';
  END IF;
  SELECT pg_get_expr(i.indpred,i.indrelid) INTO actual FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    WHERE i.indexrelid='public."UQ_seller_verifications_active_user"'::regclass
      AND i.indrelid='public.seller_verifications'::regclass AND am.amname='btree'
      AND i.indisunique AND i.indisvalid AND i.indisready AND NOT i.indisprimary
      AND NOT i.indisexclusion AND i.indexprs IS NULL AND i.indnatts=1 AND i.indnkeyatts=1
      AND a.attname='userId' AND i.indoption[0]=0
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=c.relam)
      AND i.indcollation[0]=0;
  IF actual IS NULL OR (actual<>previous AND actual<>intended) THEN
    RAISE EXCEPTION 'Incompatible active-request index contract';
  END IF;
  IF actual=previous THEN
    DROP INDEX public."UQ_seller_verifications_active_user";
    CREATE UNIQUE INDEX "UQ_seller_verifications_active_user" ON public.seller_verifications ("userId") WHERE status IN ('PENDING') OR (status='APPROVED' AND "revokedAt" IS NULL);
  END IF;
END
$index$;

CREATE TEMP TABLE expected_breeder_applications (
  "userId" uuid, status public.breeder_applications_status_enum, "revokedAt" timestamptz,
  "revokedBy" varchar(100), "revocationReason" varchar(500), "reapplicationIntent" varchar(32),
  CHECK ("reapplicationIntent" IN ('BLOCKED','REQUIRE_REVERIFICATION')
    AND (("revokedAt" IS NULL AND "reapplicationIntent"='BLOCKED')
      OR ("revokedAt" IS NOT NULL AND status='APPROVED'
        AND "revokedBy" IS NOT NULL AND length(btrim("revokedBy")) BETWEEN 1 AND 100
        AND "revocationReason" IS NOT NULL AND length(btrim("revocationReason")) BETWEEN 1 AND 500)))
) ON COMMIT DROP;
DO $check$
DECLARE expected text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO expected FROM pg_constraint
    WHERE conrelid='pg_temp.expected_breeder_applications'::regclass AND contype='c';
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.breeder_applications'::regclass
    AND conname='CHK_breeder_applications_reverification') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.breeder_applications'::regclass
      AND conname='CHK_breeder_applications_reverification' AND contype='c' AND convalidated
      AND NOT connoinherit AND pg_get_expr(conbin,conrelid)=expected) THEN
      RAISE EXCEPTION 'Incompatible reverification CHECK contract';
    END IF;
  ELSE
    ALTER TABLE public.breeder_applications ADD CONSTRAINT "CHK_breeder_applications_reverification" CHECK ("reapplicationIntent" IN ('BLOCKED','REQUIRE_REVERIFICATION')
    AND (("revokedAt" IS NULL AND "reapplicationIntent"='BLOCKED')
      OR ("revokedAt" IS NOT NULL AND status='APPROVED'
        AND "revokedBy" IS NOT NULL AND length(btrim("revokedBy")) BETWEEN 1 AND 100
        AND "revocationReason" IS NOT NULL AND length(btrim("revocationReason")) BETWEEN 1 AND 500)));
  END IF;
END
$check$;
CREATE UNIQUE INDEX expected_breeder_applications_old ON expected_breeder_applications ("userId") WHERE status IN ('PENDING_CALL','FOLLOW_UP','APPROVED');
CREATE UNIQUE INDEX expected_breeder_applications_new ON expected_breeder_applications ("userId") WHERE status IN ('PENDING_CALL','FOLLOW_UP') OR (status='APPROVED' AND "revokedAt" IS NULL);
DO $index$
DECLARE actual text; previous text; intended text;
BEGIN
  SELECT pg_get_expr(indpred,indrelid) INTO previous FROM pg_index
    WHERE indexrelid='pg_temp.expected_breeder_applications_old'::regclass;
  SELECT pg_get_expr(indpred,indrelid) INTO intended FROM pg_index
    WHERE indexrelid='pg_temp.expected_breeder_applications_new'::regclass;
  IF to_regclass('public."UQ_breeder_applications_active_user"') IS NULL THEN
    RAISE EXCEPTION 'Required active-request index is missing';
  END IF;
  SELECT pg_get_expr(i.indpred,i.indrelid) INTO actual FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    WHERE i.indexrelid='public."UQ_breeder_applications_active_user"'::regclass
      AND i.indrelid='public.breeder_applications'::regclass AND am.amname='btree'
      AND i.indisunique AND i.indisvalid AND i.indisready AND NOT i.indisprimary
      AND NOT i.indisexclusion AND i.indexprs IS NULL AND i.indnatts=1 AND i.indnkeyatts=1
      AND a.attname='userId' AND i.indoption[0]=0
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=c.relam)
      AND i.indcollation[0]=0;
  IF actual IS NULL OR (actual<>previous AND actual<>intended) THEN
    RAISE EXCEPTION 'Incompatible active-request index contract';
  END IF;
  IF actual=previous THEN
    DROP INDEX public."UQ_breeder_applications_active_user";
    CREATE UNIQUE INDEX "UQ_breeder_applications_active_user" ON public.breeder_applications ("userId") WHERE status IN ('PENDING_CALL','FOLLOW_UP') OR (status='APPROVED' AND "revokedAt" IS NULL);
  END IF;
END
$index$;

CREATE TEMP TABLE expected_seller_reapplication_grant (
  status public.seller_verifications_status_enum, "revokedAt" timestamptz,
  "reapplicationIntent" varchar(32), "reapplicationGrantedAt" timestamptz,
  "reapplicationGrantedBy" varchar(100), "reapplicationGrantReason" varchar(500),
  CHECK (("reapplicationGrantedAt" IS NULL AND "reapplicationGrantedBy" IS NULL AND "reapplicationGrantReason" IS NULL)
    OR ("reapplicationGrantedAt" IS NOT NULL AND "reapplicationGrantedBy" IS NOT NULL AND "reapplicationGrantReason" IS NOT NULL
      AND status='APPROVED' AND "revokedAt" IS NOT NULL AND "reapplicationIntent"='BLOCKED'
      AND "reapplicationGrantedAt">="revokedAt"
      AND length(btrim("reapplicationGrantedBy")) BETWEEN 1 AND 100
      AND length(btrim("reapplicationGrantReason")) BETWEEN 1 AND 500))
) ON COMMIT DROP;
DO $grant_check$
DECLARE expected text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO expected FROM pg_constraint
    WHERE conrelid='pg_temp.expected_seller_reapplication_grant'::regclass AND contype='c';
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.seller_verifications'::regclass
    AND conname='CHK_seller_reapplication_grant') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.seller_verifications'::regclass
      AND conname='CHK_seller_reapplication_grant' AND contype='c' AND convalidated
      AND NOT connoinherit AND pg_get_expr(conbin,conrelid)=expected) THEN
      RAISE EXCEPTION 'Incompatible reapplication grant CHECK contract';
    END IF;
  ELSE
    EXECUTE 'ALTER TABLE public.seller_verifications ADD CONSTRAINT "CHK_seller_reapplication_grant" CHECK (' || expected || ')';
  END IF;
END
$grant_check$;

-- Approval/revocation history remains immutable. A blocked seller may receive
-- exactly one separately audited reapplication grant, never restored approval.
DO $function_contract$
DECLARE expected_source text := $source$
DECLARE blocked boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE "userId"=$1 AND "revokedAt" IS NOT NULL AND "reapplicationIntent"=''BLOCKED''%s)', TG_TABLE_NAME,
      CASE WHEN TG_TABLE_NAME='seller_verifications' THEN ' AND "reapplicationGrantedAt" IS NULL' ELSE '' END)
      INTO blocked USING NEW."userId";
    IF blocked THEN RAISE EXCEPTION 'Onboarding access is blocked' USING ERRCODE='23514'; END IF;
    NEW."createdAt"=clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.status::text='APPROVED' OR OLD."revokedAt" IS NOT NULL THEN
    IF TG_TABLE_NAME='seller_verifications' AND TG_OP='UPDATE' THEN
      IF OLD."revokedAt" IS NOT NULL AND OLD."reapplicationIntent"='BLOCKED'
        AND OLD."reapplicationGrantedAt" IS NULL AND NEW."reapplicationGrantedAt" IS NOT NULL
        AND (to_jsonb(OLD)-ARRAY['reapplicationGrantedAt','reapplicationGrantedBy','reapplicationGrantReason','updatedAt'])
          = (to_jsonb(NEW)-ARRAY['reapplicationGrantedAt','reapplicationGrantedBy','reapplicationGrantReason','updatedAt']) THEN
        RETURN NEW;
      END IF;
    END IF;
    IF TG_OP='UPDATE' AND OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL
      AND (to_jsonb(OLD)-ARRAY['revokedAt','revokedBy','revocationReason','reapplicationIntent','updatedAt'])
        = (to_jsonb(NEW)-ARRAY['revokedAt','revokedBy','revocationReason','reapplicationIntent','updatedAt']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Onboarding approval history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$source$;
BEGIN
  IF to_regprocedure('public.guard_onboarding_reverification_history_v1()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.guard_onboarding_reverification_history_v1()'::regprocedure
      AND prosrc=expected_source AND prorettype='trigger'::regtype
      AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND NOT prosecdef AND proconfig IS NULL AND provolatile='v') THEN
      RAISE EXCEPTION 'Incompatible onboarding history function';
    END IF;
  ELSE
    EXECUTE 'CREATE FUNCTION public.guard_onboarding_reverification_history_v1() RETURNS trigger LANGUAGE plpgsql AS '
      || quote_literal(expected_source);
  END IF;
END
$function_contract$;
DO $trigger$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.seller_verifications'::regclass
      AND tgname='TRG_onboarding_reverification_history') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.seller_verifications'::regclass
      AND tgname='TRG_onboarding_reverification_history' AND NOT tgisinternal
      AND tgfoid='public.guard_onboarding_reverification_history_v1()'::regprocedure
      AND tgtype=31 AND tgenabled='O' AND tgqual IS NULL AND tgnargs=0) THEN
      RAISE EXCEPTION 'Incompatible onboarding history trigger';
    END IF;
  ELSE
    CREATE TRIGGER "TRG_onboarding_reverification_history" BEFORE INSERT OR UPDATE OR DELETE
      ON public.seller_verifications FOR EACH ROW EXECUTE FUNCTION public.guard_onboarding_reverification_history_v1();
  END IF;
END
$trigger$;
DO $trigger$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.breeder_applications'::regclass
      AND tgname='TRG_onboarding_reverification_history') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.breeder_applications'::regclass
      AND tgname='TRG_onboarding_reverification_history' AND NOT tgisinternal
      AND tgfoid='public.guard_onboarding_reverification_history_v1()'::regprocedure
      AND tgtype=31 AND tgenabled='O' AND tgqual IS NULL AND tgnargs=0) THEN
      RAISE EXCEPTION 'Incompatible onboarding history trigger';
    END IF;
  ELSE
    CREATE TRIGGER "TRG_onboarding_reverification_history" BEFORE INSERT OR UPDATE OR DELETE
      ON public.breeder_applications FOR EACH ROW EXECUTE FUNCTION public.guard_onboarding_reverification_history_v1();
  END IF;
END
$trigger$;

COMMIT;
