\set ON_ERROR_STOP on

-- Adds seller-access revocation and the customer-deleted listing audit state.
-- The enum value is committed before it is referenced by a new CHECK constraint,
-- as required by PostgreSQL.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:parrot-sale-listing-lifecycle-v1', 0));

DO $preflight$
DECLARE
  status_labels text[];
BEGIN
  IF to_regclass('public.parrot_sale_listings') IS NULL
     OR to_regclass('public.seller_verifications') IS NULL THEN
    RAISE EXCEPTION 'Listing lifecycle migration requires seller onboarding and listing schemas';
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO status_labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
    AND t.typname = 'parrot_sale_listings_status_enum';

  IF status_labels IS DISTINCT FROM ARRAY['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'] THEN
    RAISE EXCEPTION 'Unexpected parrot sale listing status enum contract';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'seller_verifications'
      AND column_name IN ('revokedAt', 'revokedBy', 'revocationReason')
  ) THEN
    RAISE EXCEPTION 'Listing lifecycle migration is already or partially applied';
  END IF;
END
$preflight$;

ALTER TYPE public.parrot_sale_listings_status_enum ADD VALUE 'DELETED_BY_USER';
COMMIT;

BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:parrot-sale-listing-lifecycle-v1', 0));

ALTER TABLE public.seller_verifications
  ADD COLUMN "revokedAt" timestamptz,
  ADD COLUMN "revokedBy" varchar(100),
  ADD COLUMN "revocationReason" varchar(500),
  ADD CONSTRAINT "CHK_seller_verifications_revocation" CHECK (
    ("revokedAt" IS NULL AND "revokedBy" IS NULL AND "revocationReason" IS NULL)
    OR
    ("revokedAt" IS NOT NULL AND length(btrim("revokedBy")) > 0
      AND length(btrim("revocationReason")) > 0)
  );

ALTER TABLE public.parrot_sale_listings
  DROP CONSTRAINT "CHK_parrot_sale_listings_review_state";

ALTER TABLE public.parrot_sale_listings
  ADD CONSTRAINT "CHK_parrot_sale_listings_review_state" CHECK (
    (
      status = 'DRAFT'
      AND "approvedPrice" IS NULL
      AND "productId" IS NULL
      AND "rejectionReason" IS NULL
      AND "reviewedBy" IS NULL
      AND "reviewedAt" IS NULL
    )
    OR (
      status = 'PENDING_REVIEW'
      AND "approvedPrice" IS NULL
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
      AND length(btrim("rejectionReason")) > 0
      AND "reviewedBy" IS NOT NULL
      AND "reviewedAt" IS NOT NULL
    )
    OR (
      status = 'DELETED_BY_USER'
      AND ("approvedPrice" IS NULL OR "productId" IS NOT NULL)
    )
  );

COMMIT;
