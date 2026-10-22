\set ON_ERROR_STOP on
-- Forward only. Stop/drain old writers before activation of hold-aware runtime.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:breeder-listing-publication-hold-v1',0));
DO $preflight$ BEGIN
  IF to_regclass('public.parrot_sale_listings') IS NULL OR NOT EXISTS(
    SELECT 1 FROM pg_attribute WHERE attrelid='public.parrot_sale_listings'::regclass
      AND attname='submissionKind' AND NOT attisdropped
      AND format_type(atttypid,atttypmod)='character varying(16)' AND attnotnull
  ) THEN RAISE EXCEPTION 'Breeder listing foundation is required'; END IF;
END $preflight$;
LOCK TABLE public.parrot_sale_listings IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.parrot_sale_listings ADD COLUMN IF NOT EXISTS "publicationHeldAt" timestamptz;
DO $column$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.parrot_sale_listings'::regclass AND a.attname='publicationHeldAt'
      AND NOT a.attisdropped AND a.atttypid='timestamptz'::regtype AND a.atttypmod=-1
      AND NOT a.attnotnull AND a.attidentity='' AND a.attgenerated='' AND d.oid IS NULL
  ) THEN RAISE EXCEPTION 'Incompatible breeder publication hold column'; END IF;
END $column$;
CREATE TEMP TABLE expected_breeder_publication_hold (
  "publicationHeldAt" timestamptz, "submissionKind" varchar(16),
  CONSTRAINT "CHK_breeder_listing_publication_hold"
    CHECK ("publicationHeldAt" IS NULL OR "submissionKind"='BREEDER')
) ON COMMIT DROP;
DO $constraint$
DECLARE expected text; actual record;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO expected FROM pg_constraint
    WHERE conrelid='pg_temp.expected_breeder_publication_hold'::regclass
      AND conname='CHK_breeder_listing_publication_hold';
  SELECT * INTO actual FROM pg_constraint WHERE conrelid='public.parrot_sale_listings'::regclass
    AND conname='CHK_breeder_listing_publication_hold';
  IF FOUND THEN
    IF actual.contype<>'c' OR NOT actual.convalidated OR actual.condeferrable OR actual.condeferred
      OR actual.connoinherit OR pg_get_constraintdef(actual.oid)<>expected
      THEN RAISE EXCEPTION 'Incompatible breeder publication hold constraint'; END IF;
  ELSE
    EXECUTE 'ALTER TABLE public.parrot_sale_listings ADD CONSTRAINT "CHK_breeder_listing_publication_hold" '||expected;
  END IF;
END $constraint$;
-- Runtime needs row-lock/update privileges for atomic holds and unpublication.
-- No destructive privilege or ownership is granted. Missing role fails closed.
GRANT SELECT, UPDATE ON public.parrot_sale_listings, public.products TO bayat_app;
-- Listing identity triggers read permanent creation history at commit.
GRANT SELECT ON public.parrot_sale_listing_creation_ledger TO bayat_app;
COMMIT;
