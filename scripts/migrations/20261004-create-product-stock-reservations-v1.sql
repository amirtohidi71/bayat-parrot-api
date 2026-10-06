\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:product-stock-reservations-v1', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.products') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.orders') IS NULL
     OR to_regprocedure('public.uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Product stock reservations require products, users, orders and uuid_generate_v4()';
  END IF;
  IF to_regclass('public.product_stock_reservations') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname = 'product_stock_reservations_status_enum'
     ) THEN
    RAISE EXCEPTION 'Product stock reservations migration is already or partially applied';
  END IF;
END
$preflight$;

CREATE TYPE public.product_stock_reservations_status_enum AS ENUM (
  'ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED'
);

CREATE TABLE public.product_stock_reservations (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  "productId" uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  "userId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "orderId" uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL,
  status public.product_stock_reservations_status_enum NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '15 minutes'),
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CHK_product_stock_reservations_quantity" CHECK (quantity > 0),
  CONSTRAINT "CHK_product_stock_reservations_key" CHECK (length(btrim("idempotencyKey")) > 0),
  CONSTRAINT "UQ_product_stock_reservations_user_key_product"
    UNIQUE ("userId", "idempotencyKey", "productId")
);

CREATE INDEX "IDX_product_stock_reservations_product_active_expiry"
  ON public.product_stock_reservations ("productId", status, "expiresAt");
CREATE INDEX "IDX_product_stock_reservations_expiry_active"
  ON public.product_stock_reservations ("expiresAt") WHERE status = 'ACTIVE';
CREATE INDEX "IDX_product_stock_reservations_user_created"
  ON public.product_stock_reservations ("userId", "createdAt" DESC);
CREATE INDEX "IDX_product_stock_reservations_order"
  ON public.product_stock_reservations ("orderId", "productId", id);

COMMIT;
