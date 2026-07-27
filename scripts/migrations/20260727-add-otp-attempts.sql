-- Run this migration before starting the backend version that reads otps.attempts.
-- This file is intentionally not executed by the application.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.otps') IS NULL THEN
    RAISE EXCEPTION 'Required table public.otps does not exist';
  END IF;
END
$$;

ALTER TABLE public.otps
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'otps'
      AND column_name = 'attempts'
      AND data_type = 'integer'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'public.otps.attempts verification failed';
  END IF;
END
$$;

COMMIT;
