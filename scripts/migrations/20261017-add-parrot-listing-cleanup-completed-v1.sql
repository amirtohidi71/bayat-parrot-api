\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:parrot-listing-cleanup-completed-v1', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.parrot_sale_listing_creation_ledger') IS NULL THEN
    RAISE EXCEPTION 'Parrot listing creation ledger is required';
  END IF;
END
$preflight$;

ALTER TABLE public.parrot_sale_listing_creation_ledger
  ADD COLUMN IF NOT EXISTS "cleanupCompletedAt" timestamptz;

DO $contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute column_metadata
    WHERE column_metadata.attrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND column_metadata.attname = 'cleanupCompletedAt'
      AND column_metadata.atttypid = 'pg_catalog.timestamptz'::regtype
      AND NOT column_metadata.attnotnull
      AND NOT column_metadata.atthasdef
      AND NOT column_metadata.attisdropped
      AND column_metadata.attgenerated = ''
      AND column_metadata.attidentity = ''
  ) THEN
    RAISE EXCEPTION 'Parrot listing cleanup column differs from the expected contract';
  END IF;
END
$contract$;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND conname = 'CHK_parrot_listing_cleanup_after_delete'
  ) THEN
    ALTER TABLE public.parrot_sale_listing_creation_ledger
      ADD CONSTRAINT "CHK_parrot_listing_cleanup_after_delete"
      CHECK ("cleanupCompletedAt" IS NULL OR "deletedAt" IS NOT NULL);
  END IF;
END
$constraint$;

DO $constraint_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint constraint_metadata
    WHERE constraint_metadata.conrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND constraint_metadata.conname = 'CHK_parrot_listing_cleanup_after_delete'
      AND constraint_metadata.contype = 'c'
      AND constraint_metadata.convalidated
      AND NOT constraint_metadata.connoinherit
      AND pg_get_expr(constraint_metadata.conbin, constraint_metadata.conrelid) =
        '(("cleanupCompletedAt" IS NULL) OR ("deletedAt" IS NOT NULL))'
  ) THEN
    RAISE EXCEPTION 'Parrot listing cleanup constraint differs from the expected contract';
  END IF;
END
$constraint_contract$;

CREATE INDEX IF NOT EXISTS "IDX_parrot_listing_cleanup_pending"
  ON public.parrot_sale_listing_creation_ledger ("deletedAt", "listingId")
  WHERE "deletedAt" IS NOT NULL AND "cleanupCompletedAt" IS NULL;

DO $index_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class index_relation
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_index index_metadata ON index_metadata.indexrelid = index_relation.oid
    JOIN pg_class ledger ON ledger.oid = index_metadata.indrelid
    JOIN pg_am access_method ON access_method.oid = index_relation.relam
    JOIN pg_attribute deleted_column
      ON deleted_column.attrelid = ledger.oid AND deleted_column.attnum = index_metadata.indkey[0]
    JOIN pg_attribute listing_column
      ON listing_column.attrelid = ledger.oid AND listing_column.attnum = index_metadata.indkey[1]
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = 'IDX_parrot_listing_cleanup_pending'
      AND index_metadata.indrelid = 'public.parrot_sale_listing_creation_ledger'::regclass
      AND access_method.amname = 'btree'
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisunique
      AND NOT index_metadata.indisprimary
      AND NOT index_metadata.indisexclusion
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND deleted_column.attname = 'deletedAt'
      AND listing_column.attname = 'listingId'
      AND index_metadata.indoption[0] = 0 -- ASC NULLS LAST
      AND index_metadata.indoption[1] = 0 -- ASC NULLS LAST
      AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid) =
        '(("deletedAt" IS NOT NULL) AND ("cleanupCompletedAt" IS NULL))'
  ) THEN
    RAISE EXCEPTION 'Parrot listing cleanup index differs from the expected contract';
  END IF;
END
$index_contract$;

-- The previous migration's immutable-history trigger is extended to allow
-- each lifecycle timestamp exactly once, without changing creation history.
CREATE OR REPLACE FUNCTION public.reject_parrot_listing_creation_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $ledger_guard$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."listingId" = OLD."listingId"
     AND NEW."sellerUserId" = OLD."sellerUserId"
     AND NEW."createdAt" = OLD."createdAt"
     AND (OLD."deletedAt" IS NULL OR NEW."deletedAt" = OLD."deletedAt")
     AND (OLD."cleanupCompletedAt" IS NULL OR NEW."cleanupCompletedAt" = OLD."cleanupCompletedAt")
     AND (OLD."deletedAt" IS NOT NULL OR NEW."deletedAt" IS NOT NULL)
     AND (NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
          OR NEW."cleanupCompletedAt" IS DISTINCT FROM OLD."cleanupCompletedAt")
     AND (NEW."cleanupCompletedAt" IS NULL OR NEW."deletedAt" IS NOT NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Parrot listing creation ledger history is immutable' USING ERRCODE = '23514';
END
$ledger_guard$;

COMMIT;
