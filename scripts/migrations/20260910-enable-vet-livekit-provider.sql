\set ON_ERROR_STOP on

-- Day 3B: add LiveKit to the existing tokenless video-room persistence contract.
-- API credentials and participant tokens are never stored in the database.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:vet-day1-foundation', 0));

DO $preflight$
DECLARE provider_definition text; ready_definition text;
BEGIN
  IF to_regclass('public.vet_video_rooms') IS NULL THEN
    RAISE EXCEPTION 'Vet LiveKit integration requires the Day 3A video contract';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO STRICT provider_definition
  FROM pg_constraint WHERE conrelid='public.vet_video_rooms'::regclass
    AND conname='CHK_vet_video_provider';
  SELECT pg_get_constraintdef(oid) INTO STRICT ready_definition
  FROM pg_constraint WHERE conrelid='public.vet_video_rooms'::regclass
    AND conname='CHK_vet_video_ready';
  IF provider_definition NOT LIKE '%WHEREBY%INTERNAL%'
     OR ready_definition NOT LIKE '%providerMeetingId%providerEndDate%WHEREBY%INTERNAL%'
     OR ready_definition NOT LIKE '%guestUrlCiphertext%hostUrlCiphertext%' THEN
    RAISE EXCEPTION 'Vet Day 3A video constraint drift';
  END IF;
END
$preflight$;

LOCK TABLE public.vet_video_rooms IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.vet_video_rooms DROP CONSTRAINT "CHK_vet_video_provider";
ALTER TABLE public.vet_video_rooms DROP CONSTRAINT "CHK_vet_video_ready";
ALTER TABLE public.vet_video_rooms
  ADD CONSTRAINT "CHK_vet_video_provider"
  CHECK ("provider" IN ('WHEREBY', 'INTERNAL', 'LIVEKIT'));
ALTER TABLE public.vet_video_rooms
  ADD CONSTRAINT "CHK_vet_video_ready"
  CHECK (
    "status" <> 'READY' OR (
      "providerMeetingId" IS NOT NULL
      AND "providerEndDate" IS NOT NULL
      AND (
        ("provider" = 'WHEREBY' AND "guestUrlCiphertext" IS NOT NULL AND "hostUrlCiphertext" IS NOT NULL)
        OR ("provider" IN ('INTERNAL', 'LIVEKIT') AND "guestUrlCiphertext" IS NULL AND "hostUrlCiphertext" IS NULL)
      )
    )
  );

DO $verify$
DECLARE provider_definition text; ready_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT provider_definition
  FROM pg_constraint WHERE conrelid='public.vet_video_rooms'::regclass
    AND conname='CHK_vet_video_provider';
  SELECT pg_get_constraintdef(oid) INTO STRICT ready_definition
  FROM pg_constraint WHERE conrelid='public.vet_video_rooms'::regclass
    AND conname='CHK_vet_video_ready';
  IF provider_definition NOT LIKE '%WHEREBY%INTERNAL%LIVEKIT%'
     OR ready_definition NOT LIKE '%INTERNAL%LIVEKIT%'
     OR ready_definition NOT LIKE '%guestUrlCiphertext%IS NULL%hostUrlCiphertext%IS NULL%' THEN
    RAISE EXCEPTION 'Vet LiveKit constraint verification failed';
  END IF;
END
$verify$;

COMMIT;
