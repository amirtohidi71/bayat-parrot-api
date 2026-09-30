\set ON_ERROR_STOP on

-- Phase 1 seller onboarding. Run with psql as the migration owner before the artifact.
-- Runtime entities use synchronize:false. This migration does not create listings/products.
-- Existing users remain active and can keep logging in. Historical consumed OTP rows are
-- ambiguous (success, expiry, or failed-attempt lockout), so they are never trusted as proof.
-- phoneVerifiedAt is populated only by a successful OTP verification after this release.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:seller-onboarding-v1', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.otps') IS NULL
     OR to_regprocedure('public.uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Seller onboarding requires users, otps and uuid_generate_v4()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='users_role_enum'
  ) THEN RAISE EXCEPTION 'Expected public.users_role_enum'; END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='users_role_enum'
      AND e.enumlabel='breeder'
  ) OR to_regclass('public.seller_verifications') IS NOT NULL
     OR to_regclass('public.breeder_applications') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users'
         AND column_name IN ('isActive','phoneVerifiedAt')
     ) THEN
    RAISE EXCEPTION 'Seller onboarding migration is already or partially applied';
  END IF;
END
$preflight$;

ALTER TYPE public.users_role_enum ADD VALUE 'breeder';
ALTER TABLE public.users
  ADD COLUMN "isActive" boolean NOT NULL DEFAULT true,
  ADD COLUMN "phoneVerifiedAt" timestamptz NULL;

CREATE TYPE public.seller_verifications_status_enum AS ENUM ('PENDING','APPROVED','REJECTED');
CREATE TYPE public.breeder_applications_status_enum AS ENUM ('PENDING_CALL','FOLLOW_UP','APPROVED','REJECTED');
CREATE TYPE public.breeder_applications_call_outcome_enum AS ENUM ('SUCCESSFUL','NO_ANSWER','FOLLOW_UP_REQUIRED','NOT_ELIGIBLE');

CREATE TABLE public.seller_verifications (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  "userId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "firstName" varchar(100) NOT NULL,
  "lastName" varchar(100) NOT NULL,
  "birthDate" date NOT NULL,
  "consentAcceptedAt" timestamptz NOT NULL,
  "consentVersion" varchar(50) NOT NULL,
  status public.seller_verifications_status_enum NOT NULL,
  "rejectionReason" varchar(500),
  "internalAdminNote" varchar(2000),
  "reviewedBy" varchar(100),
  "reviewedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_seller_verifications_names" CHECK (length(btrim("firstName")) > 0 AND length(btrim("lastName")) > 0),
  CONSTRAINT "CHK_seller_verifications_birth" CHECK ("birthDate" <= CURRENT_DATE),
  CONSTRAINT "CHK_seller_verifications_review" CHECK (
    (status='PENDING' AND "reviewedAt" IS NULL AND "reviewedBy" IS NULL AND "rejectionReason" IS NULL)
    OR (status='APPROVED' AND "reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "rejectionReason" IS NULL)
    OR (status='REJECTED' AND "reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND length(btrim("rejectionReason")) > 0)
  )
);
CREATE INDEX "IDX_seller_verifications_user_created" ON public.seller_verifications ("userId", "createdAt" DESC);
CREATE INDEX "IDX_seller_verifications_status_created" ON public.seller_verifications (status, "createdAt" DESC);
CREATE UNIQUE INDEX "UQ_seller_verifications_active_user" ON public.seller_verifications ("userId") WHERE status IN ('PENDING','APPROVED');

CREATE TABLE public.breeder_applications (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  "userId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "breederName" varchar(150) NOT NULL,
  city varchar(100) NOT NULL,
  species jsonb NOT NULL,
  "experienceYears" smallint NOT NULL,
  "approximateBirdCount" integer NOT NULL,
  "preferredContactTime" varchar(200) NOT NULL,
  "instagramUrl" varchar(500),
  "websiteUrl" varchar(500),
  description varchar(2000),
  status public.breeder_applications_status_enum NOT NULL,
  "callOutcome" public.breeder_applications_call_outcome_enum,
  "contactedAt" timestamptz,
  "privateCallNote" varchar(2000),
  "rejectionReason" varchar(500),
  "reviewedBy" varchar(100),
  "reviewedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_breeder_applications_text" CHECK (length(btrim("breederName")) > 0 AND length(btrim(city)) > 0 AND length(btrim("preferredContactTime")) > 0),
  CONSTRAINT "CHK_breeder_applications_numbers" CHECK ("experienceYears" BETWEEN 0 AND 100 AND "approximateBirdCount" BETWEEN 0 AND 100000),
  CONSTRAINT "CHK_breeder_applications_species" CHECK (jsonb_typeof(species)='array' AND jsonb_array_length(species) BETWEEN 1 AND 20),
  CONSTRAINT "CHK_breeder_applications_contact" CHECK (("contactedAt" IS NULL AND "callOutcome" IS NULL) OR ("contactedAt" IS NOT NULL AND "callOutcome" IS NOT NULL)),
  CONSTRAINT "CHK_breeder_applications_review" CHECK (
    (status IN ('PENDING_CALL','FOLLOW_UP') AND "reviewedAt" IS NULL AND "rejectionReason" IS NULL)
    OR (status='APPROVED' AND "reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "callOutcome"='SUCCESSFUL' AND "contactedAt" IS NOT NULL AND "rejectionReason" IS NULL)
    OR (status='REJECTED' AND "reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND length(btrim("rejectionReason")) > 0)
  )
);
CREATE INDEX "IDX_breeder_applications_user_created" ON public.breeder_applications ("userId", "createdAt" DESC);
CREATE INDEX "IDX_breeder_applications_status_created" ON public.breeder_applications (status, "createdAt" DESC);
CREATE UNIQUE INDEX "UQ_breeder_applications_active_user" ON public.breeder_applications ("userId") WHERE status IN ('PENDING_CALL','FOLLOW_UP','APPROVED');

COMMIT;
