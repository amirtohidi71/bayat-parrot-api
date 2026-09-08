\set ON_ERROR_STOP on

-- Day 2F: allow a directly confirmed, no-claim admin assignment only when
-- identified by both the immutable pricing rule and append-only admin event.
-- No payment, hold, notification, video, or customer booking path is enabled.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:vet-day1-foundation', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.vet_appointments') IS NULL
     OR to_regclass('public.vet_free_consultation_claims') IS NULL
     OR to_regclass('public.vet_appointment_events') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid='public.vet_appointments'::regclass
         AND conname='CHK_vet_appointments_hold_lifecycle'
     ) THEN
    RAISE EXCEPTION 'Vet admin assignment requires the complete Day 2E contract';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='vet_assert_free_claim' AND p.pronargs=0) <> 1 THEN
    RAISE EXCEPTION 'Vet free-claim guard is missing or overloaded';
  END IF;
END
$preflight$;

LOCK TABLE public.vet_appointments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.vet_free_consultation_claims IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.vet_appointment_events IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.vet_assert_free_claim()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $body$
DECLARE appointment_row public.vet_appointments%ROWTYPE;
claim_row public.vet_free_consultation_claims%ROWTYPE;
target_id uuid;
claim_found boolean;
manual_assignment boolean;
BEGIN
  IF TG_TABLE_NAME = 'vet_appointments' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW."appointmentId";
  END IF;
  SELECT * INTO appointment_row FROM public.vet_appointments WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO claim_row FROM public.vet_free_consultation_claims WHERE "appointmentId" = target_id;
  claim_found := FOUND;
  manual_assignment := appointment_row."pricingRuleVersion" = 'vet-admin-manual-v1';
  IF appointment_row."pricingKind" = 'FREE' THEN
    IF manual_assignment THEN
      IF claim_found
         OR appointment_row.status NOT IN ('CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')
         OR (TG_TABLE_NAME = 'vet_appointments' AND TG_OP = 'INSERT' AND appointment_row.status <> 'CONFIRMED')
         OR appointment_row."confirmedAt" IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.vet_appointment_events e
           WHERE e."appointmentId" = target_id
             AND e."eventType" = 'ADMIN_ASSIGNED'
             AND e."eventKey" = 'admin-manual-assignment'
             AND e."actorType" = 'ADMIN'
             AND e."actorId" IS NOT NULL
             AND e."previousStatus" IS NULL
             AND e."newStatus" = 'CONFIRMED'
             AND e.metadata = '{"source":"ADMIN_MANUAL"}'::jsonb
         ) THEN
        RAISE EXCEPTION 'An admin manual confirmation requires its audit event and no entitlement claim' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT claim_found OR appointment_row."confirmedAt" IS NULL
       OR appointment_row."pricingRuleVersion" IS DISTINCT FROM claim_row."policyVersion"
       OR (claim_row."subjectType" = 'OWNER' AND claim_row."ownerUserId" IS DISTINCT FROM appointment_row."customerUserId")
       OR (claim_row."subjectType" = 'PASSPORT' AND claim_row."birdPassportId" IS DISTINCT FROM appointment_row."birdPassportId") THEN
      RAISE EXCEPTION 'A free confirmation and matching entitlement must commit atomically' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'vet_appointments' AND TG_OP = 'INSERT' THEN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Vet scheduling writes require READ COMMITTED' USING ERRCODE = '25000';
      END IF;
      PERFORM 1 FROM public.vet_appointment_slots
        WHERE id = appointment_row."slotId" AND status = 'AVAILABLE' FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A free confirmation requires an available slot' USING ERRCODE = '23514';
      END IF;
      PERFORM 1 FROM public.vet_availability_windows w
        WHERE w.id = (SELECT s."availabilityWindowId" FROM public.vet_appointment_slots s
          WHERE s.id = appointment_row."slotId")
          AND w.status = 'ACTIVE' FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A free confirmation requires an active window' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF claim_found THEN
    RAISE EXCEPTION 'A paid appointment cannot consume a free entitlement' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$body$;

DO $verify$
DECLARE body text; actual record;
BEGIN
  SELECT p.*, l.lanname INTO actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname='public' AND p.proname='vet_assert_free_claim' AND p.pronargs=0;
  body := actual.prosrc;
  IF NOT FOUND OR body NOT LIKE '%vet-admin-manual-v1%'
     OR body NOT LIKE '%ADMIN_ASSIGNED%admin-manual-assignment%'
     OR body NOT LIKE '%ADMIN_MANUAL%'
     OR body NOT LIKE '%matching entitlement must commit atomically%'
     OR actual.prorettype <> 'trigger'::regtype OR actual.lanname <> 'plpgsql'
     OR actual.prosecdef OR actual.provolatile <> 'v'
     OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
    RAISE EXCEPTION 'Vet admin manual assignment guard verification failed';
  END IF;
END
$verify$;

COMMIT;
