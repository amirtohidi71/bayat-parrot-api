\set ON_ERROR_STOP on

-- Permanent quota history. The listing table is locked during backfill so its
-- existing rows and their original timestamps form a consistent snapshot.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:parrot-listing-creation-ledger-v1', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.parrot_sale_listings') IS NULL THEN
    RAISE EXCEPTION 'Parrot listing creation ledger requires the listing table';
  END IF;
END
$preflight$;

LOCK TABLE public.parrot_sale_listings IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.parrot_sale_listing_creation_ledger (
  "listingId" uuid PRIMARY KEY,
  "sellerUserId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "deletedAt" timestamptz
);

DO $contract$
BEGIN
  IF (
    SELECT jsonb_object_agg(column_name, jsonb_build_object('type', data_type, 'nullable', is_nullable))
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'parrot_sale_listing_creation_ledger'
  ) IS DISTINCT FROM jsonb_build_object(
    'listingId', jsonb_build_object('type', 'uuid', 'nullable', 'NO'),
    'sellerUserId', jsonb_build_object('type', 'uuid', 'nullable', 'NO'),
    'createdAt', jsonb_build_object('type', 'timestamp with time zone', 'nullable', 'NO'),
    'deletedAt', jsonb_build_object('type', 'timestamp with time zone', 'nullable', 'YES')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY ("listingId")'
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'Parrot listing creation ledger schema differs from the expected contract';
  END IF;
END
$contract$;

CREATE INDEX IF NOT EXISTS "IDX_parrot_listing_creation_ledger_seller_created"
  ON public.parrot_sale_listing_creation_ledger ("sellerUserId", "createdAt" DESC);

DO $index_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class idx
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    JOIN pg_index i ON i.indexrelid = idx.oid
    JOIN pg_class ledger ON ledger.oid = i.indrelid
    JOIN pg_am access_method ON access_method.oid = idx.relam
    JOIN pg_attribute seller_column
      ON seller_column.attrelid = ledger.oid AND seller_column.attnum = i.indkey[0]
    JOIN pg_attribute created_column
      ON created_column.attrelid = ledger.oid AND created_column.attnum = i.indkey[1]
    WHERE ns.nspname = 'public'
      AND idx.relname = 'IDX_parrot_listing_creation_ledger_seller_created'
      AND i.indrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND access_method.amname = 'btree'
      AND i.indisvalid
      AND i.indisready
      AND NOT i.indisunique
      AND NOT i.indisprimary
      AND NOT i.indisexclusion
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND i.indnatts = 2
      AND seller_column.attname = 'sellerUserId'
      AND created_column.attname = 'createdAt'
      AND (i.indoption[0] & 1) = 0
      AND (i.indoption[1] & 1) = 1
  ) THEN
    RAISE EXCEPTION 'Parrot listing creation ledger index differs from the expected contract';
  END IF;
END
$index_contract$;

DO $backfill_contract$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.parrot_sale_listings listing
    JOIN public.parrot_sale_listing_creation_ledger ledger ON ledger."listingId" = listing.id
    WHERE ledger."sellerUserId" <> listing."sellerUserId"
       OR ledger."createdAt" <> listing."createdAt"
  ) THEN
    RAISE EXCEPTION 'Existing listing creation ledger rows disagree with listing history';
  END IF;
END
$backfill_contract$;

INSERT INTO public.parrot_sale_listing_creation_ledger
  ("listingId", "sellerUserId", "createdAt", "deletedAt")
SELECT id, "sellerUserId", "createdAt", NULL
FROM public.parrot_sale_listings
ON CONFLICT ("listingId") DO NOTHING;

DO $complete$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.parrot_sale_listings listing
    LEFT JOIN public.parrot_sale_listing_creation_ledger ledger ON ledger."listingId" = listing.id
    WHERE ledger."listingId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Parrot listing creation ledger backfill is incomplete';
  END IF;
END
$complete$;

-- Creation identity and time are immutable. A later cleanup phase may set
-- deletedAt once, but cannot rewrite or remove the quota event.
CREATE OR REPLACE FUNCTION public.reject_parrot_listing_creation_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $ledger_guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."deletedAt" IS NULL
       AND NEW."deletedAt" IS NOT NULL
       AND NEW."listingId" = OLD."listingId"
       AND NEW."sellerUserId" = OLD."sellerUserId"
       AND NEW."createdAt" = OLD."createdAt" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Parrot listing creation ledger history is immutable' USING ERRCODE = '23514';
END
$ledger_guard$;

DO $triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND tgname = 'TRG_parrot_listing_ledger_no_rewrite'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "TRG_parrot_listing_ledger_no_rewrite"
      BEFORE UPDATE OR DELETE ON public.parrot_sale_listing_creation_ledger
      FOR EACH ROW EXECUTE FUNCTION public.reject_parrot_listing_creation_ledger_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND tgname = 'TRG_parrot_listing_ledger_no_truncate'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "TRG_parrot_listing_ledger_no_truncate"
      BEFORE TRUNCATE ON public.parrot_sale_listing_creation_ledger
      FOR EACH STATEMENT EXECUTE FUNCTION public.reject_parrot_listing_creation_ledger_mutation();
  END IF;
END
$triggers$;

COMMIT;
