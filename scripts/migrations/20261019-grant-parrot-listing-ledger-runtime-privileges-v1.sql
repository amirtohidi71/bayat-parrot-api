\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'parrot_sale_listing_creation_ledger'
      AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'Parrot listing creation ledger table is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'bayat_app') THEN
    RAISE EXCEPTION 'Required ledger runtime role is missing';
  END IF;
END
$preflight$;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.parrot_sale_listing_creation_ledger TO bayat_app;

COMMIT;
