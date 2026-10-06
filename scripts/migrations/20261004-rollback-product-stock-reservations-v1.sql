\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:product-stock-reservations-v1', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.product_stock_reservations') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname = 'product_stock_reservations_status_enum'
     ) THEN
    RAISE EXCEPTION 'Product stock reservations rollback requires a complete v1 schema';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_stock_reservations) THEN
    RAISE EXCEPTION 'Rollback refused: product stock reservation history exists';
  END IF;
END
$preflight$;

DROP TABLE public.product_stock_reservations;
DROP TYPE public.product_stock_reservations_status_enum;

COMMIT;
