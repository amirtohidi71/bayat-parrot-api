\set ON_ERROR_STOP on

-- Day 3A: activate the existing video-room schema with an internal provider.
-- External provider credentials remain unsupported and payment writes stay disabled.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:vet-day1-foundation', 0));

DO $preflight$
DECLARE body text;
BEGIN
  IF to_regclass('public.vet_appointments') IS NULL
     OR to_regclass('public.vet_video_rooms') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid='public.vet_appointments'::regclass
         AND conname='CHK_vet_appointments_hold_lifecycle'
     ) THEN
    RAISE EXCEPTION 'Vet video consultation requires the complete Day 2F contract';
  END IF;
  SELECT p.prosrc INTO STRICT body
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='vet_guard_external_record' AND p.pronargs=0;
  IF body NOT LIKE '%payment writes are disabled%'
     OR NOT (
       body LIKE '%notification/video work%'
       OR body LIKE '%vet_video_rooms%confirmed appointment%'
     ) THEN
    RAISE EXCEPTION 'Vet external-record guard drift';
  END IF;
END
$preflight$;

LOCK TABLE public.vet_appointments IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.vet_video_rooms IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.vet_video_rooms DROP CONSTRAINT "CHK_vet_video_provider";
ALTER TABLE public.vet_video_rooms DROP CONSTRAINT "CHK_vet_video_ready";
ALTER TABLE public.vet_video_rooms
  ADD CONSTRAINT "CHK_vet_video_provider"
  CHECK ("provider" IN ('WHEREBY', 'INTERNAL'));
ALTER TABLE public.vet_video_rooms
  ADD CONSTRAINT "CHK_vet_video_ready"
  CHECK (
    "status" <> 'READY' OR (
      "providerMeetingId" IS NOT NULL
      AND "providerEndDate" IS NOT NULL
      AND (
        ("provider" = 'WHEREBY' AND "guestUrlCiphertext" IS NOT NULL AND "hostUrlCiphertext" IS NOT NULL)
        OR ("provider" = 'INTERNAL' AND "guestUrlCiphertext" IS NULL AND "hostUrlCiphertext" IS NULL)
      )
    )
  );

CREATE OR REPLACE FUNCTION public.vet_guard_external_record()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $body$
DECLARE appointment_row public.vet_appointments%ROWTYPE;
BEGIN
  SELECT * INTO STRICT appointment_row
  FROM public.vet_appointments
  WHERE id = NEW."appointmentId"
  FOR SHARE;

  IF TG_TABLE_NAME = 'vet_appointment_payments' THEN
    RAISE EXCEPTION 'VET_PAYMENT_COMING_SOON: payment writes are disabled in V1' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'vet_video_rooms' THEN
    IF TG_OP = 'INSERT'
       AND (appointment_row.status <> 'CONFIRMED' OR appointment_row."confirmedAt" IS NULL) THEN
      RAISE EXCEPTION 'Only a confirmed appointment may create a video room' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId" THEN
      RAISE EXCEPTION 'A video room cannot change appointment' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
       AND NOT (
         (OLD.status = 'NOT_CREATED' AND NEW.status IN ('CREATING', 'READY', 'FAILED', 'EXPIRED', 'DELETED'))
         OR (OLD.status = 'CREATING' AND NEW.status IN ('READY', 'FAILED', 'EXPIRED', 'DELETED'))
         OR (OLD.status = 'READY' AND NEW.status IN ('EXPIRED', 'DELETED'))
         OR (OLD.status = 'FAILED' AND NEW.status IN ('CREATING', 'READY', 'EXPIRED', 'DELETED'))
       ) THEN
      RAISE EXCEPTION 'Invalid video room lifecycle transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.status NOT IN ('EXPIRED', 'DELETED')
       AND (appointment_row.status <> 'CONFIRMED' OR appointment_row."confirmedAt" IS NULL) THEN
      RAISE EXCEPTION 'Only a confirmed appointment may have an active video room' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF appointment_row."pricingKind" <> 'FREE' OR appointment_row."confirmedAt" IS NULL THEN
      RAISE EXCEPTION 'Unconfirmed/paid V1 appointments cannot create notifications' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND appointment_row.status <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'Only a confirmed appointment may create notification work' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION public.vet_expire_video_room_on_appointment_change()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $body$
BEGIN
  IF OLD.status = 'CONFIRMED' AND NEW.status <> 'CONFIRMED' THEN
    UPDATE public.vet_video_rooms
    SET status='EXPIRED', "deletedAt"=COALESCE("deletedAt", statement_timestamp()),
        "updatedAt"=statement_timestamp()
    WHERE "appointmentId"=NEW.id AND status NOT IN ('EXPIRED', 'DELETED');
  END IF;
  RETURN NEW;
END;
$body$;

DROP TRIGGER IF EXISTS "TRG_vet_appointments_expire_video" ON public.vet_appointments;
CREATE TRIGGER "TRG_vet_appointments_expire_video"
AFTER UPDATE OF status ON public.vet_appointments
FOR EACH ROW EXECUTE FUNCTION public.vet_expire_video_room_on_appointment_change();

DO $verify$
DECLARE guard_body text; expiry_body text;
BEGIN
  SELECT p.prosrc INTO STRICT guard_body FROM pg_proc p
  WHERE p.oid=to_regprocedure('public.vet_guard_external_record()');
  SELECT p.prosrc INTO STRICT expiry_body FROM pg_proc p
  WHERE p.oid=to_regprocedure('public.vet_expire_video_room_on_appointment_change()');
  IF guard_body NOT LIKE '%vet_video_rooms%confirmed appointment%'
     OR guard_body NOT LIKE '%payment writes are disabled%'
     OR expiry_body NOT LIKE '%OLD.status = ''CONFIRMED''%NEW.status <> ''CONFIRMED''%'
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.vet_appointments'::regclass
         AND tgname='TRG_vet_appointments_expire_video' AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'Vet video consultation contract verification failed';
  END IF;
END
$verify$;

COMMIT;
