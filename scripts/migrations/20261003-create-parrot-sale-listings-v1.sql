\set ON_ERROR_STOP on

-- Parrot sale listing schema foundation. Workflow routes and Product publication
-- are intentionally delivered separately. Runtime entities use synchronize:false.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:parrot-sale-listings-v1', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regprocedure('public.uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Parrot sale listings require users, products and uuid_generate_v4()';
  END IF;

  IF to_regclass('public.parrot_sale_listings') IS NOT NULL
     OR to_regclass('public.parrot_sale_listing_images') IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'products'
         AND column_name = 'isSellerListing'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname IN (
           'parrot_sale_listings_status_enum',
           'parrot_sale_listings_gender_enum',
           'parrot_sale_listings_age_stage_enum'
         )
     ) THEN
    RAISE EXCEPTION 'Parrot sale listings migration is already or partially applied';
  END IF;
END
$preflight$;

ALTER TABLE public.products
  ADD COLUMN "isSellerListing" boolean NOT NULL DEFAULT false;

CREATE TYPE public.parrot_sale_listings_status_enum AS ENUM (
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED'
);
CREATE TYPE public.parrot_sale_listings_gender_enum AS ENUM (
  'male',
  'female',
  'unknown'
);
CREATE TYPE public.parrot_sale_listings_age_stage_enum AS ENUM (
  'serlaki',
  'dane-khor',
  'pish-molid',
  'molid'
);

CREATE TABLE public.parrot_sale_listings (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  "sellerUserId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status public.parrot_sale_listings_status_enum NOT NULL DEFAULT 'DRAFT',
  name varchar(200) NOT NULL,
  description varchar(2000),
  species varchar(100) NOT NULL,
  subspecies varchar(100),
  gender public.parrot_sale_listings_gender_enum,
  "ageStage" public.parrot_sale_listings_age_stage_enum,
  colors text[],
  "tagPair" boolean NOT NULL DEFAULT false,
  "tagHandTame" boolean NOT NULL DEFAULT false,
  "requestedPrice" numeric(15,2) NOT NULL,
  "approvedPrice" numeric(15,2),
  quantity smallint NOT NULL DEFAULT 1,
  "productId" uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  "rejectionReason" varchar(500),
  "internalAdminNote" varchar(2000),
  "reviewedBy" varchar(100),
  "reviewedAt" timestamptz,
  "resubmissionOfId" uuid REFERENCES public.parrot_sale_listings(id) ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_parrot_sale_listings_text" CHECK (
    length(btrim(name)) > 0 AND length(btrim(species)) > 0
  ),
  CONSTRAINT "CHK_parrot_sale_listings_colors" CHECK (
    colors IS NULL OR cardinality(colors) <= 20
  ),
  CONSTRAINT "CHK_parrot_sale_listings_price" CHECK (
    "requestedPrice" > 0
    AND ("approvedPrice" IS NULL OR "approvedPrice" >= "requestedPrice")
  ),
  CONSTRAINT "CHK_parrot_sale_listings_quantity" CHECK (
    quantity BETWEEN 1 AND 100
  ),
  CONSTRAINT "CHK_parrot_sale_listings_resubmission" CHECK (
    "resubmissionOfId" IS NULL OR "resubmissionOfId" <> id
  ),
  CONSTRAINT "CHK_parrot_sale_listings_review_state" CHECK (
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
  )
);

CREATE INDEX "IDX_parrot_sale_listings_seller_created"
  ON public.parrot_sale_listings ("sellerUserId", "createdAt" DESC);
CREATE INDEX "IDX_parrot_sale_listings_status_created"
  ON public.parrot_sale_listings (status, "createdAt" DESC);
CREATE UNIQUE INDEX "UQ_parrot_sale_listings_product"
  ON public.parrot_sale_listings ("productId");

CREATE TABLE public.parrot_sale_listing_images (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  "listingId" uuid NOT NULL REFERENCES public.parrot_sale_listings(id) ON DELETE CASCADE,
  "storageKey" varchar(255) NOT NULL,
  position smallint NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_parrot_sale_listing_images_position" CHECK (
    position BETWEEN 0 AND 7
  ),
  CONSTRAINT "UQ_parrot_sale_listing_images_position" UNIQUE ("listingId", position),
  CONSTRAINT "UQ_parrot_sale_listing_images_storage_key" UNIQUE ("storageKey")
);

COMMIT;
