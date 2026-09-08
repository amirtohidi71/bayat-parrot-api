\set ON_ERROR_STOP on

-- Day 2E: internal paid-hold and expiry persistence only.
-- This does not enable a customer paid-booking route, payment records, gateway
-- work, paid confirmation, callbacks, notifications, or video provisioning.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:vet-day1-foundation', 0));

CREATE TEMP TABLE vet_paid_hold_function_spec (
  old_body text NOT NULL,
  new_body text NOT NULL
) ON COMMIT DROP;
INSERT INTO vet_paid_hold_function_spec VALUES ($old$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','completedAt','cancelledAt','cancelledByType','cancelledById','cancellationReason','updatedAt'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','completedAt','cancelledAt','cancelledByType','cancelledById','cancellationReason','updatedAt']) THEN
    RAISE EXCEPTION 'Vet booking identity, fee and confirmation snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'CONFIRMED' AND NEW.status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')) THEN
    RAISE EXCEPTION 'Invalid V1 vet appointment transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$old$, $new$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Vet appointment writes require READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','completedAt','cancelledAt','cancelledByType','cancelledById','cancellationReason','updatedAt'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','completedAt','cancelledAt','cancelledByType','cancelledById','cancellationReason','updatedAt']) THEN
    RAISE EXCEPTION 'Vet booking identity, fee and confirmation snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'CONFIRMED' AND NEW.status IN ('COMPLETED', 'CANCELLED', 'NO_SHOW'))
       OR (OLD.status = 'PAYMENT_PENDING' AND NEW.status = 'EXPIRED')
     ) THEN
    RAISE EXCEPTION 'Invalid vet appointment transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$new$);

DO $preflight$
DECLARE old_definition text; function_body text; expected_body text;
BEGIN
  IF to_regclass('public.vet_appointments') IS NULL
     OR to_regclass('public.vet_appointment_events') IS NULL THEN
    RAISE EXCEPTION 'Vet paid holds require the existing appointment and event tables';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO old_definition
  FROM pg_constraint
  WHERE conrelid = 'public.vet_appointments'::regclass
    AND conname = 'CHK_vet_appointments_v1_no_gateway';
  IF old_definition IS NOT NULL AND (
       old_definition NOT LIKE '%PAYMENT_UNAVAILABLE%'
       OR old_definition NOT LIKE '%pricingKind%'
       OR old_definition NOT LIKE '%slotId%'
       OR old_definition NOT LIKE '%holdExpiresAt%'
       OR old_definition NOT LIKE '%confirmedAt%'
     ) THEN
    RAISE EXCEPTION 'Unexpected V1 no-gateway constraint definition';
  END IF;
  IF (old_definition IS NULL) = NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vet_appointments'::regclass
      AND conname = 'CHK_vet_appointments_hold_lifecycle'
  ) THEN
    RAISE EXCEPTION 'Vet paid-hold constraint state is mixed or unknown';
  END IF;
  SELECT CASE WHEN old_definition IS NULL THEN new_body ELSE old_body END
    INTO STRICT expected_body FROM vet_paid_hold_function_spec;
  SELECT prosrc INTO function_body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'vet_guard_appointment_update'
    AND p.pronargs = 0;
  IF function_body IS NULL THEN
    RAISE EXCEPTION 'Vet appointment update guard is missing';
  END IF;
  IF btrim(replace(function_body, E'\r\n', E'\n'))
     IS DISTINCT FROM btrim(replace(expected_body, E'\r\n', E'\n')) THEN
    RAISE EXCEPTION 'Unexpected vet appointment update guard definition';
  END IF;
END
$preflight$;

LOCK TABLE public.vet_appointments IN ACCESS EXCLUSIVE MODE;

DO $upgrade$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vet_appointments'::regclass
      AND conname = 'CHK_vet_appointments_v1_no_gateway'
  ) THEN
    ALTER TABLE public.vet_appointments
      DROP CONSTRAINT "CHK_vet_appointments_v1_no_gateway";
    ALTER TABLE public.vet_appointments
      ADD CONSTRAINT "CHK_vet_appointments_hold_lifecycle" CHECK (
        ("pricingKind" = 'FREE'
          AND "slotId" IS NOT NULL
          AND "status" IN ('CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')
          AND "confirmedAt" IS NOT NULL
          AND "holdExpiresAt" IS NULL)
        OR
        ("pricingKind" = 'PAID' AND (
          ("status" = 'PAYMENT_UNAVAILABLE'
            AND "slotId" IS NULL
            AND "holdExpiresAt" IS NULL
            AND "confirmedAt" IS NULL)
          OR
          ("status" IN ('PAYMENT_PENDING', 'EXPIRED')
            AND "slotId" IS NOT NULL
            AND "holdExpiresAt" IS NOT NULL
            AND isfinite("holdExpiresAt")
            AND "holdExpiresAt" > "createdAt"
            AND "confirmedAt" IS NULL)
        ))
      );
  END IF;
END
$upgrade$;

DO $function$
DECLARE expected_body text;
BEGIN
  SELECT new_body INTO STRICT expected_body FROM vet_paid_hold_function_spec;
  EXECUTE 'CREATE OR REPLACE FUNCTION public.vet_guard_appointment_update() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS '
    || quote_literal(expected_body);
END
$function$;

DO $verify$
DECLARE definition text; actual record; expected_body text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vet_appointments'::regclass
      AND conname = 'CHK_vet_appointments_v1_no_gateway'
  ) THEN
    RAISE EXCEPTION 'Obsolete V1 no-gateway constraint remains';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.vet_appointments'::regclass
    AND conname = 'CHK_vet_appointments_hold_lifecycle';
  IF definition IS NULL
     OR definition NOT LIKE '%PAYMENT_PENDING%'
     OR definition NOT LIKE '%EXPIRED%'
     OR definition NOT LIKE '%holdExpiresAt%createdAt%'
     OR definition LIKE '%''PAYMENT_REVIEW''%'
     OR definition LIKE '%''PAID''%''CONFIRMED''%' THEN
    RAISE EXCEPTION 'Vet paid-hold lifecycle constraint verification failed';
  END IF;
  SELECT new_body INTO STRICT expected_body FROM vet_paid_hold_function_spec;
  SELECT p.*, l.lanname INTO actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'vet_guard_appointment_update'
    AND p.pronargs = 0;
  IF NOT FOUND
    OR btrim(replace(actual.prosrc, E'\r\n', E'\n'))
       IS DISTINCT FROM btrim(replace(expected_body, E'\r\n', E'\n'))
    OR actual.prorettype <> 'trigger'::regtype OR actual.lanname <> 'plpgsql'
    OR actual.prosecdef OR actual.provolatile <> 'v'
    OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
    RAISE EXCEPTION 'Vet appointment update guard verification failed';
  END IF;
END
$verify$;

COMMIT;
