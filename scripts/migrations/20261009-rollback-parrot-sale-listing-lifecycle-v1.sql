\set ON_ERROR_STOP on

-- Guarded rollback refuses to erase deletion or revocation history.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:parrot-sale-listing-lifecycle-v1', 0));

DO $preflight$
DECLARE
  status_labels text[];
BEGIN
  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO status_labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
    AND t.typname = 'parrot_sale_listings_status_enum';

  IF status_labels IS DISTINCT FROM ARRAY['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DELETED_BY_USER']
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'seller_verifications' AND column_name = 'revokedAt'
     )
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'seller_verifications' AND column_name = 'revokedBy'
     )
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'seller_verifications' AND column_name = 'revocationReason'
     ) THEN
    RAISE EXCEPTION 'Listing lifecycle rollback requires a complete lifecycle schema';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.parrot_sale_listings
    WHERE status = 'DELETED_BY_USER'
       OR (
         status IN ('PENDING_REVIEW', 'REJECTED')
         AND "productId" IS NOT NULL
       )
  ) OR EXISTS (
    SELECT 1 FROM public.seller_verifications WHERE "revokedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Rollback refused: listing lifecycle or seller revocation history exists';
  END IF;
END
$preflight$;

ALTER TABLE public.parrot_sale_listings
  DROP CONSTRAINT "CHK_parrot_sale_listings_review_state";

ALTER TABLE public.parrot_sale_listings
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE text USING status::text;
DROP TYPE public.parrot_sale_listings_status_enum;
CREATE TYPE public.parrot_sale_listings_status_enum AS ENUM (
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED'
);
ALTER TABLE public.parrot_sale_listings
  ALTER COLUMN status TYPE public.parrot_sale_listings_status_enum
  USING status::public.parrot_sale_listings_status_enum,
  ALTER COLUMN status SET DEFAULT 'DRAFT';

ALTER TABLE public.parrot_sale_listings
  ADD CONSTRAINT "CHK_parrot_sale_listings_review_state" CHECK (
    (
      status IN ('DRAFT', 'PENDING_REVIEW')
      AND "approvedPrice" IS NULL
      AND "productId" IS NULL
      AND "rejectionReason" IS NULL
      AND "reviewedBy" IS NULL
      AND "reviewedAt" IS NULL
    )
    OR (
      status = 'APPROVED'
      AND "approvedPrice" IS NOT NULL
      AND "productId" IS NOT NULL
      AND "rejectionReason" IS NULL
      AND "reviewedBy" IS NOT NULL
      AND "reviewedAt" IS NOT NULL
    )
    OR (
      status = 'REJECTED'
      AND "approvedPrice" IS NULL
      AND "productId" IS NULL
      AND length(btrim("rejectionReason")) > 0
      AND "reviewedBy" IS NOT NULL
      AND "reviewedAt" IS NOT NULL
    )
  );

ALTER TABLE public.seller_verifications
  DROP CONSTRAINT "CHK_seller_verifications_revocation",
  DROP COLUMN "revocationReason",
  DROP COLUMN "revokedBy",
  DROP COLUMN "revokedAt";

COMMIT;
