\set ON_ERROR_STOP on

-- Reversible only before seller onboarding data or BREEDER assignments exist.
-- Refusing a destructive rollback preserves verification/call audit history.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:seller-onboarding-v1', 0));

DO $safe$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE role::text='breeder') THEN
    RAISE EXCEPTION 'Rollback refused: BREEDER users exist';
  END IF;
  IF to_regclass('public.seller_verifications') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.seller_verifications) THEN
    RAISE EXCEPTION 'Rollback refused: seller verification history exists';
  END IF;
  IF to_regclass('public.breeder_applications') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.breeder_applications) THEN
    RAISE EXCEPTION 'Rollback refused: breeder application history exists';
  END IF;
END
$safe$;

DROP TABLE IF EXISTS public.breeder_applications;
DROP TABLE IF EXISTS public.seller_verifications;
DROP TYPE IF EXISTS public.breeder_applications_call_outcome_enum;
DROP TYPE IF EXISTS public.breeder_applications_status_enum;
DROP TYPE IF EXISTS public.seller_verifications_status_enum;
ALTER TABLE public.users DROP COLUMN IF EXISTS "phoneVerifiedAt", DROP COLUMN IF EXISTS "isActive";

ALTER TABLE public.users ALTER COLUMN role DROP DEFAULT;
ALTER TYPE public.users_role_enum RENAME TO users_role_enum_with_breeder;
CREATE TYPE public.users_role_enum AS ENUM ('admin','customer');
ALTER TABLE public.users ALTER COLUMN role TYPE public.users_role_enum USING role::text::public.users_role_enum;
ALTER TABLE public.users ALTER COLUMN role SET DEFAULT 'customer';
DROP TYPE public.users_role_enum_with_breeder;
COMMIT;