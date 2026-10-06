\set ON_ERROR_STOP on

-- Guarded rollback: preserve listing history and linked Product auditability.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:parrot-sale-listings-v1', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.parrot_sale_listings') IS NULL
     OR to_regclass('public.parrot_sale_listing_images') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'products'
         AND column_name = 'isSellerListing'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname = 'parrot_sale_listings_status_enum'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname = 'parrot_sale_listings_gender_enum'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname = 'parrot_sale_listings_age_stage_enum'
     ) THEN
    RAISE EXCEPTION 'Parrot sale listings rollback requires a complete v1 schema';
  END IF;

  IF EXISTS (SELECT 1 FROM public.parrot_sale_listing_images)
     OR EXISTS (SELECT 1 FROM public.parrot_sale_listings)
     OR EXISTS (SELECT 1 FROM public.products WHERE "isSellerListing" = true) THEN
    RAISE EXCEPTION 'Rollback refused: parrot sale listing history exists';
  END IF;
END
$preflight$;

DROP TABLE public.parrot_sale_listing_images;
DROP TABLE public.parrot_sale_listings;
ALTER TABLE public.products DROP COLUMN "isSellerListing";
DROP TYPE public.parrot_sale_listings_age_stage_enum;
DROP TYPE public.parrot_sale_listings_gender_enum;
DROP TYPE public.parrot_sale_listings_status_enum;

COMMIT;
