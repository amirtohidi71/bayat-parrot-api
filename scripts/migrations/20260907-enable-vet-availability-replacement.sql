\set ON_ERROR_STOP on

-- VET-D2-01B: forward-only availability replacement. Run after immutable Day 1.
-- Reference DDL/body baseline: 5011def, SHA256
-- b502e3cdc6ed566b938b67485e5a3a9f1f370fe7d4d16eed973f9ae94c06df36.
-- Accept one COMPLETE known contract, never a per-object mixture.
-- No business rows are rewritten. No automatic downgrade is safe after reuse.
-- Table locks exclude concurrent writers/DDL during verification and upgrade.

BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:vet-day1-foundation', 0));

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.bird_passports') IS NULL
     OR to_regprocedure('public.uuid_generate_v4()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'btree_gist' AND n.nspname = 'public') THEN
    RAISE EXCEPTION 'Vet replacement prerequisite drift; apply Day 1 first';
  END IF;
END
$preflight$;
LOCK TABLE public.vet_doctors,
  public.vet_availability_windows,
  public.vet_appointment_slots,
  public.vet_appointments,
  public.vet_free_consultation_claims,
  public.vet_appointment_payments,
  public.vet_video_rooms,
  public.vet_appointment_events,
  public.vet_notification_outbox IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE vet_replacement_state (is_upgraded boolean NOT NULL) ON COMMIT DROP;
INSERT INTO vet_replacement_state SELECT NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.vet_appointment_slots'::regclass
    AND conname = 'UQ_vet_slots_doctor_start'
);

CREATE TEMP TABLE vet_replacement_functions (
  name text PRIMARY KEY, baseline_body text NOT NULL, upgraded_body text NOT NULL
) ON COMMIT DROP;
INSERT INTO vet_replacement_functions VALUES ('vet_guard_slot', $baseline$
DECLARE window_row public.vet_availability_windows%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW."availabilityWindowId", NEW."doctorId", NEW."startsAt", NEW."endsAt")
      IS DISTINCT FROM ROW(OLD."availabilityWindowId", OLD."doctorId", OLD."startsAt", OLD."endsAt") THEN
    RAISE EXCEPTION 'Vet slot identity and times are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT window_row FROM public.vet_availability_windows
    WHERE id = NEW."availabilityWindowId" FOR SHARE;
  IF NEW."doctorId" <> window_row."doctorId"
     OR NEW."startsAt" < window_row."startsAt" OR NEW."endsAt" > window_row."endsAt"
     OR NEW."endsAt" - NEW."startsAt" <> make_interval(mins => window_row."slotDurationMinutes")
     OR mod(extract(epoch FROM (NEW."startsAt" - window_row."startsAt")), window_row."slotDurationMinutes" * 60) <> 0
     OR (NEW.status <> 'CANCELLED' AND window_row.status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'Vet slot must match its doctor, active window and duration grid' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> 'AVAILABLE' AND EXISTS (
    SELECT 1 FROM public.vet_appointments WHERE "slotId" = NEW.id
      AND status IN ('PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
  ) THEN
    RAISE EXCEPTION 'An occupied vet slot cannot be blocked or cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$baseline$, $upgraded$
DECLARE window_row public.vet_availability_windows%ROWTYPE;
BEGIN
  -- Cross-table occupancy checks require fresh command snapshots after lock waits.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Vet scheduling writes require READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['status','updatedAt'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updatedAt']) THEN
    RAISE EXCEPTION 'Vet slot identity and times are immutable' USING ERRCODE = '23514';
  END IF;
  -- UPDATE already owns the slot row lock. Booking uses the same slot -> window order.
  SELECT * INTO STRICT window_row FROM public.vet_availability_windows
    WHERE id = NEW."availabilityWindowId" FOR SHARE;
  IF NEW."doctorId" <> window_row."doctorId"
     OR NEW."startsAt" < window_row."startsAt" OR NEW."endsAt" > window_row."endsAt"
     OR NEW."endsAt" - NEW."startsAt" <> make_interval(mins => window_row."slotDurationMinutes")
     OR mod(extract(epoch FROM (NEW."startsAt" - window_row."startsAt")), window_row."slotDurationMinutes" * 60) <> 0 THEN
    RAISE EXCEPTION 'Vet slot must match its doctor, window and duration grid' USING ERRCODE = '23514';
  END IF;
  IF window_row.status <> 'ACTIVE' AND NEW.status <> 'CANCELLED' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'New usable vet slots require an active window' USING ERRCODE = '23514';
    ELSIF window_row.status <> 'RETIRED' OR NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Retained vet slots are immutable; only safe cancellation is allowed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> 'AVAILABLE' AND EXISTS (
    SELECT 1 FROM public.vet_appointments WHERE "slotId" = NEW.id
      AND status IN ('PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
  ) THEN
    RAISE EXCEPTION 'An occupied vet slot cannot be blocked or cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$upgraded$);

INSERT INTO vet_replacement_functions VALUES ('vet_guard_window', $baseline$
BEGIN
  IF ROW(NEW."doctorId", NEW."startsAt", NEW."endsAt", NEW."slotDurationMinutes", NEW."timeZone")
      IS DISTINCT FROM ROW(OLD."doctorId", OLD."startsAt", OLD."endsAt", OLD."slotDurationMinutes", OLD."timeZone")
      AND EXISTS (SELECT 1 FROM public.vet_appointment_slots WHERE "availabilityWindowId" = OLD.id) THEN
    RAISE EXCEPTION 'A generated vet window cannot change geometry; create a new window' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'CANCELLED' AND EXISTS (
    SELECT 1 FROM public.vet_appointment_slots WHERE "availabilityWindowId" = OLD.id AND status <> 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Cancel all unused slots before cancelling a vet window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$baseline$, $upgraded$
BEGIN
  -- Cross-table occupancy checks require fresh command snapshots after lock waits.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Vet scheduling writes require READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'New vet windows must be active' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','updatedAt'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updatedAt']) THEN
    RAISE EXCEPTION 'Vet window identity and geometry are immutable; create a replacement' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Cancelled and retired vet windows are terminal' USING ERRCODE = '23514';
  END IF;
  -- The UPDATE owns the parent lock, conflicting with slot/booking FOR SHARE.
  -- Do not lock child rows here (would invert slot -> window order).
  IF NEW.status = 'CANCELLED' AND EXISTS (
    SELECT 1 FROM public.vet_appointment_slots WHERE "availabilityWindowId" = OLD.id AND status <> 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Cancel all unused slots before cancelling a vet window' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' AND EXISTS (
    SELECT 1 FROM public.vet_appointment_slots s
    WHERE s."availabilityWindowId" = OLD.id AND s.status <> 'CANCELLED'
      -- Includes in-progress time; never uses an application-supplied cutoff.
      AND s."endsAt" > transaction_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM public.vet_appointments a WHERE a."slotId" = s.id
          AND a.status IN ('PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
      )
  ) THEN
    RAISE EXCEPTION 'Cancel future unoccupied slots before retiring a vet window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$upgraded$);

INSERT INTO vet_replacement_functions VALUES ('vet_guard_appointment_update', $baseline$
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
END;$baseline$, $upgraded$
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
END;$upgraded$);

INSERT INTO vet_replacement_functions VALUES ('vet_reject_history_mutation', $baseline$
BEGIN
  RAISE EXCEPTION 'Vet entitlement claims and appointment events are append-only' USING ERRCODE = '23514';
END;$baseline$, $upgraded$
BEGIN
  RAISE EXCEPTION 'Vet entitlement claims and appointment events are append-only' USING ERRCODE = '23514';
END;$upgraded$);

INSERT INTO vet_replacement_functions VALUES ('vet_assert_free_claim', $baseline$
DECLARE appointment_row public.vet_appointments%ROWTYPE;
claim_row public.vet_free_consultation_claims%ROWTYPE;
target_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'vet_appointments' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW."appointmentId";
  END IF;
  SELECT * INTO appointment_row FROM public.vet_appointments WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO claim_row FROM public.vet_free_consultation_claims WHERE "appointmentId" = target_id;
  IF appointment_row."pricingKind" = 'FREE' THEN
    IF NOT FOUND OR appointment_row."confirmedAt" IS NULL
       OR appointment_row."pricingRuleVersion" IS DISTINCT FROM claim_row."policyVersion"
       OR (claim_row."subjectType" = 'OWNER' AND claim_row."ownerUserId" IS DISTINCT FROM appointment_row."customerUserId")
       OR (claim_row."subjectType" = 'PASSPORT' AND claim_row."birdPassportId" IS DISTINCT FROM appointment_row."birdPassportId") THEN
      RAISE EXCEPTION 'A free confirmation and matching entitlement must commit atomically' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'vet_appointments' AND TG_OP = 'INSERT' THEN
      PERFORM 1 FROM public.vet_appointment_slots
        WHERE id = appointment_row."slotId" AND status = 'AVAILABLE' FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A free confirmation requires an available slot' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'A paid appointment cannot consume a free entitlement' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;$baseline$, $upgraded$
DECLARE appointment_row public.vet_appointments%ROWTYPE;
claim_row public.vet_free_consultation_claims%ROWTYPE;
target_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'vet_appointments' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW."appointmentId";
  END IF;
  SELECT * INTO appointment_row FROM public.vet_appointments WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO claim_row FROM public.vet_free_consultation_claims WHERE "appointmentId" = target_id;
  IF appointment_row."pricingKind" = 'FREE' THEN
    IF NOT FOUND OR appointment_row."confirmedAt" IS NULL
       OR appointment_row."pricingRuleVersion" IS DISTINCT FROM claim_row."policyVersion"
       OR (claim_row."subjectType" = 'OWNER' AND claim_row."ownerUserId" IS DISTINCT FROM appointment_row."customerUserId")
       OR (claim_row."subjectType" = 'PASSPORT' AND claim_row."birdPassportId" IS DISTINCT FROM appointment_row."birdPassportId") THEN
      RAISE EXCEPTION 'A free confirmation and matching entitlement must commit atomically' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'vet_appointments' AND TG_OP = 'INSERT' THEN
      -- Cross-table occupancy checks require fresh command snapshots after lock waits.
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Vet scheduling writes require READ COMMITTED' USING ERRCODE = '25000';
      END IF;
      -- Match slot guard lock order. Geometry/parent identity cannot change.
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
  ELSIF FOUND THEN
    RAISE EXCEPTION 'A paid appointment cannot consume a free entitlement' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;$upgraded$);

INSERT INTO vet_replacement_functions VALUES ('vet_guard_external_record', $baseline$
DECLARE appointment_row public.vet_appointments%ROWTYPE;
BEGIN
  SELECT * INTO STRICT appointment_row FROM public.vet_appointments WHERE id = NEW."appointmentId" FOR SHARE;
  IF TG_TABLE_NAME = 'vet_appointment_payments' THEN
    -- Schema only until a gateway migration explicitly removes this fail-closed gate.
    RAISE EXCEPTION 'VET_PAYMENT_COMING_SOON: payment writes are disabled in V1' USING ERRCODE = '23514';
  ELSIF appointment_row."pricingKind" <> 'FREE' OR appointment_row."confirmedAt" IS NULL THEN
    RAISE EXCEPTION 'Unconfirmed/paid V1 appointments cannot create notifications or video rooms' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND appointment_row.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'Only a confirmed appointment may create notification/video work' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$baseline$, $upgraded$
DECLARE appointment_row public.vet_appointments%ROWTYPE;
BEGIN
  SELECT * INTO STRICT appointment_row FROM public.vet_appointments WHERE id = NEW."appointmentId" FOR SHARE;
  IF TG_TABLE_NAME = 'vet_appointment_payments' THEN
    -- Schema only until a gateway migration explicitly removes this fail-closed gate.
    RAISE EXCEPTION 'VET_PAYMENT_COMING_SOON: payment writes are disabled in V1' USING ERRCODE = '23514';
  ELSIF appointment_row."pricingKind" <> 'FREE' OR appointment_row."confirmedAt" IS NULL THEN
    RAISE EXCEPTION 'Unconfirmed/paid V1 appointments cannot create notifications or video rooms' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND appointment_row.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'Only a confirmed appointment may create notification/video work' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$upgraded$);

DO $functions$
DECLARE spec record; actual record; expected_body text; upgraded boolean;
BEGIN
  SELECT is_upgraded INTO STRICT upgraded FROM vet_replacement_state;
  FOR spec IN SELECT * FROM vet_replacement_functions ORDER BY name LOOP
    expected_body := CASE WHEN upgraded THEN spec.upgraded_body ELSE spec.baseline_body END;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = spec.name) <> 1 THEN
      RAISE EXCEPTION 'Vet function overload/missing drift: %', spec.name;
    END IF;
    SELECT p.*, l.lanname INTO actual FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = to_regprocedure('public.' || spec.name || '()');
    IF NOT FOUND OR btrim(replace(actual.prosrc, E'\r\n', E'\n')) IS DISTINCT FROM btrim(replace(expected_body, E'\r\n', E'\n'))
      OR actual.prorettype <> 'trigger'::regtype OR actual.lanname <> 'plpgsql'
      OR actual.prosecdef OR actual.proisstrict OR actual.proleakproof OR actual.provolatile <> 'v'
      OR actual.prokind <> 'f' OR actual.proparallel <> 'u' OR actual.procost <> 100 OR actual.prorows <> 0
      OR actual.pronargs <> 0 OR actual.pronargdefaults <> 0 OR actual.proretset
      OR actual.prosupport <> 0 OR actual.probin IS NOT NULL
      OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
      RAISE EXCEPTION 'Vet function definition drift: %', spec.name;
    END IF;
  END LOOP;
END
$functions$;

-- Frozen independent catalog reference: all nine tables, not a LIKE of live DDL.
CREATE TEMP TABLE users (id uuid PRIMARY KEY) ON COMMIT DROP;

CREATE TEMP TABLE bird_passports (id uuid PRIMARY KEY) ON COMMIT DROP;

CREATE TEMP TABLE vet_doctors (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "username" varchar(50) NOT NULL,
  "passwordHash" varchar(60) NOT NULL,
  "displayName" varchar(150) NOT NULL,
  "mobile" varchar(11) NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "consultationFeeMinor" bigint NOT NULL DEFAULT 0,
  "currency" varchar(3) NOT NULL DEFAULT 'IRR',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_doctors_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_doctors_mobile" UNIQUE ("mobile"),
  CONSTRAINT "CHK_vet_doctors_username" CHECK ("username" ~ '^[A-Za-z0-9_]{3,50}$'),
  CONSTRAINT "CHK_vet_doctors_password_hash" CHECK ("passwordHash" ~ '^\$2[aby]\$(1[0-6])\$[./A-Za-z0-9]{53}$'),
  CONSTRAINT "CHK_vet_doctors_display_name" CHECK (length(btrim("displayName")) > 0),
  CONSTRAINT "CHK_vet_doctors_mobile" CHECK ("mobile" ~ '^09[0-9]{9}$'),
  CONSTRAINT "CHK_vet_doctors_fee" CHECK ("consultationFeeMinor" >= 0),
  CONSTRAINT "CHK_vet_doctors_currency" CHECK ("currency" ~ '^[A-Z]{3}$')
) ON COMMIT DROP;

CREATE TEMP TABLE vet_availability_windows (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "doctorId" uuid NOT NULL,
  "startsAt" timestamptz NOT NULL,
  "endsAt" timestamptz NOT NULL,
  "timeZone" varchar(64) NOT NULL DEFAULT 'Asia/Tehran',
  "slotDurationMinutes" integer NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'ACTIVE',
  "createdByAdmin" varchar(50) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_availability_windows_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_windows_id_doctor" UNIQUE ("id", "doctorId"),
  CONSTRAINT "FK_vet_windows_doctor" FOREIGN KEY ("doctorId") REFERENCES pg_temp.vet_doctors ("id") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_windows_status" CHECK ("status" IN ('ACTIVE', 'CANCELLED')),
  CONSTRAINT "CHK_vet_windows_time" CHECK (isfinite("startsAt") AND isfinite("endsAt") AND "startsAt" < "endsAt" AND "endsAt" - "startsAt" <= interval '1 day'),
  CONSTRAINT "CHK_vet_windows_timezone" CHECK ("timeZone" = 'Asia/Tehran'),
  CONSTRAINT "CHK_vet_windows_duration" CHECK ("slotDurationMinutes" BETWEEN 1 AND 1440 AND mod(extract(epoch FROM ("endsAt" - "startsAt")), "slotDurationMinutes" * 60) = 0),
  CONSTRAINT "CHK_vet_windows_minutes" CHECK (extract(second FROM "startsAt") = 0 AND extract(second FROM "endsAt") = 0),
  CONSTRAINT "CHK_vet_windows_admin" CHECK (length(btrim("createdByAdmin")) > 0),
  CONSTRAINT "EX_vet_windows_doctor_overlap" EXCLUDE USING gist ("doctorId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("status" = 'ACTIVE')
) ON COMMIT DROP;

CREATE TEMP TABLE vet_appointment_slots (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "availabilityWindowId" uuid NOT NULL,
  "doctorId" uuid NOT NULL,
  "startsAt" timestamptz NOT NULL,
  "endsAt" timestamptz NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'AVAILABLE',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_appointment_slots_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_slots_doctor_start" UNIQUE ("doctorId", "startsAt"),
  CONSTRAINT "UQ_vet_slots_id_doctor" UNIQUE ("id", "doctorId"),
  CONSTRAINT "FK_vet_slots_window_doctor" FOREIGN KEY ("availabilityWindowId", "doctorId") REFERENCES pg_temp.vet_availability_windows ("id", "doctorId") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_slots_status" CHECK ("status" IN ('AVAILABLE', 'BLOCKED', 'CANCELLED')),
  CONSTRAINT "CHK_vet_slots_time" CHECK (isfinite("startsAt") AND isfinite("endsAt") AND "startsAt" < "endsAt"),
  CONSTRAINT "EX_vet_slots_doctor_overlap" EXCLUDE USING gist ("doctorId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("status" <> 'CANCELLED')
) ON COMMIT DROP;

CREATE TEMP TABLE vet_appointments (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "publicReference" varchar(40) NOT NULL,
  "bookingRequestId" uuid NOT NULL,
  "customerUserId" uuid NOT NULL,
  "slotId" uuid NULL,
  "doctorId" uuid NOT NULL,
  "birdPassportId" uuid NULL,
  "status" varchar(32) NOT NULL,
  "pricingKind" varchar(32) NOT NULL,
  "feeAmountMinor" bigint NOT NULL,
  "currency" varchar(3) NOT NULL,
  "pricingRuleVersion" varchar(64) NOT NULL,
  "holdExpiresAt" timestamptz NULL,
  "ownerFullNameSnapshot" varchar(150) NOT NULL,
  "ownerMobileSnapshot" varchar(11) NOT NULL,
  "doctorNameSnapshot" varchar(150) NOT NULL,
  "passportCodeSnapshot" varchar(9) NULL,
  "birdNameSnapshot" varchar(100) NULL,
  "birdSpeciesSnapshot" varchar(150) NULL,
  "passportOwnerFullNameSnapshot" varchar(150) NULL,
  "nationalIdCiphertext" varchar(500) NOT NULL,
  "nationalIdLast4" varchar(4) NOT NULL,
  "confirmedAt" timestamptz NULL,
  "completedAt" timestamptz NULL,
  "cancelledAt" timestamptz NULL,
  "cancelledByType" varchar(32) NULL,
  "cancelledById" varchar(100) NULL,
  "cancellationReason" varchar(500) NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_appointments_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_appointments_reference" UNIQUE ("publicReference"),
  CONSTRAINT "UQ_vet_appointments_booking_retry" UNIQUE ("customerUserId", "bookingRequestId"),
  CONSTRAINT "FK_vet_appointments_customer" FOREIGN KEY ("customerUserId") REFERENCES pg_temp.users ("id") ON DELETE RESTRICT,
  CONSTRAINT "FK_vet_appointments_doctor" FOREIGN KEY ("doctorId") REFERENCES pg_temp.vet_doctors ("id") ON DELETE RESTRICT,
  CONSTRAINT "FK_vet_appointments_slot_doctor" FOREIGN KEY ("slotId", "doctorId") REFERENCES pg_temp.vet_appointment_slots ("id", "doctorId") ON DELETE RESTRICT,
  CONSTRAINT "FK_vet_appointments_passport" FOREIGN KEY ("birdPassportId") REFERENCES pg_temp.bird_passports ("id") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_appointments_status" CHECK ("status" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  CONSTRAINT "CHK_vet_appointments_pricing" CHECK ("pricingKind" IN ('FREE', 'PAID')),
  CONSTRAINT "CHK_vet_appointments_cancel_actor" CHECK ("cancelledByType" IN ('CUSTOMER', 'DOCTOR', 'ADMIN', 'SYSTEM')),
  CONSTRAINT "CHK_vet_appointments_reference" CHECK ("publicReference" ~ '^V[A-Z0-9]{12,39}$'),
  CONSTRAINT "CHK_vet_appointments_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CHK_vet_appointments_rule" CHECK (length(btrim("pricingRuleVersion")) > 0),
  CONSTRAINT "CHK_vet_appointments_names" CHECK (length(btrim("ownerFullNameSnapshot")) > 0 AND length(btrim("doctorNameSnapshot")) > 0),
  CONSTRAINT "CHK_vet_appointments_mobile" CHECK ("ownerMobileSnapshot" ~ '^09[0-9]{9}$'),
  CONSTRAINT "CHK_vet_appointments_national_id" CHECK ("nationalIdLast4" ~ '^[0-9]{4}$' AND "nationalIdCiphertext" ~ '^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{14}$'),
  CONSTRAINT "CHK_vet_appointments_passport" CHECK (("birdPassportId" IS NULL AND "passportCodeSnapshot" IS NULL AND "birdNameSnapshot" IS NULL AND "birdSpeciesSnapshot" IS NULL AND "passportOwnerFullNameSnapshot" IS NULL) OR ("birdPassportId" IS NOT NULL AND "passportCodeSnapshot" IS NOT NULL AND "passportCodeSnapshot" ~ '^B[0-9]{8}$' AND "birdNameSnapshot" IS NOT NULL AND length(btrim("birdNameSnapshot")) > 0 AND "birdSpeciesSnapshot" IS NOT NULL AND length(btrim("birdSpeciesSnapshot")) > 0 AND "passportOwnerFullNameSnapshot" IS NOT NULL AND length(btrim("passportOwnerFullNameSnapshot")) > 0)),
  CONSTRAINT "CHK_vet_appointments_pricing_amount" CHECK (("pricingKind" = 'FREE' AND "feeAmountMinor" = 0) OR ("pricingKind" = 'PAID' AND "feeAmountMinor" > 0)),
  CONSTRAINT "CHK_vet_appointments_v1_no_gateway" CHECK (("pricingKind" = 'FREE' AND "slotId" IS NOT NULL AND "status" IN ('CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW') AND "confirmedAt" IS NOT NULL AND "holdExpiresAt" IS NULL) OR ("pricingKind" = 'PAID' AND "status" = 'PAYMENT_UNAVAILABLE' AND "slotId" IS NULL AND "holdExpiresAt" IS NULL AND "confirmedAt" IS NULL)),
  CONSTRAINT "CHK_vet_appointments_completion" CHECK (("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "completedAt" >= "confirmedAt") OR ("status" <> 'COMPLETED' AND "completedAt" IS NULL)),
  CONSTRAINT "CHK_vet_appointments_cancellation" CHECK (("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledByType" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) > 0) OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL))
) ON COMMIT DROP;

CREATE TEMP TABLE vet_free_consultation_claims (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "policyVersion" varchar(64) NOT NULL,
  "subjectType" varchar(32) NOT NULL DEFAULT 'OWNER',
  "ownerUserId" uuid NULL,
  "birdPassportId" uuid NULL,
  "appointmentId" uuid NOT NULL,
  "claimedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_free_consultation_claims_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_claims_appointment" UNIQUE ("appointmentId"),
  CONSTRAINT "FK_vet_claims_appointment" FOREIGN KEY ("appointmentId") REFERENCES pg_temp.vet_appointments ("id") ON DELETE RESTRICT,
  CONSTRAINT "FK_vet_claims_owner" FOREIGN KEY ("ownerUserId") REFERENCES pg_temp.users ("id") ON DELETE RESTRICT,
  CONSTRAINT "FK_vet_claims_passport" FOREIGN KEY ("birdPassportId") REFERENCES pg_temp.bird_passports ("id") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_claims_scope" CHECK ("subjectType" IN ('OWNER', 'PASSPORT')),
  CONSTRAINT "CHK_vet_claims_policy" CHECK (length(btrim("policyVersion")) > 0),
  CONSTRAINT "CHK_vet_claims_subject" CHECK (("subjectType" = 'OWNER' AND "ownerUserId" IS NOT NULL AND "birdPassportId" IS NULL) OR ("subjectType" = 'PASSPORT' AND "ownerUserId" IS NULL AND "birdPassportId" IS NOT NULL))
) ON COMMIT DROP;

CREATE TEMP TABLE vet_appointment_payments (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "appointmentId" uuid NOT NULL,
  "clientRequestId" uuid NOT NULL,
  "provider" varchar(50) NOT NULL,
  "providerAuthority" varchar(255) NULL,
  "providerReference" varchar(255) NULL,
  "amountMinor" bigint NOT NULL,
  "currency" varchar(3) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'CREATED',
  "failureCode" varchar(100) NULL,
  "requestedAt" timestamptz NULL,
  "verifiedAt" timestamptz NULL,
  "verificationLeaseExpiresAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_appointment_payments_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_payments_retry" UNIQUE ("appointmentId", "clientRequestId"),
  CONSTRAINT "FK_vet_payments_appointment" FOREIGN KEY ("appointmentId") REFERENCES pg_temp.vet_appointments ("id") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_payments_status" CHECK ("status" IN ('CREATED', 'PENDING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'REFUND_REQUIRED', 'REFUNDED')),
  CONSTRAINT "CHK_vet_payments_amount" CHECK ("amountMinor" > 0),
  CONSTRAINT "CHK_vet_payments_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CHK_vet_payments_provider" CHECK (length(btrim("provider")) > 0),
  CONSTRAINT "CHK_vet_payments_verified" CHECK ("status" NOT IN ('SUCCEEDED', 'REFUND_REQUIRED', 'REFUNDED') OR ("verifiedAt" IS NOT NULL AND "providerReference" IS NOT NULL))
) ON COMMIT DROP;

CREATE TEMP TABLE vet_video_rooms (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "appointmentId" uuid NOT NULL,
  "provider" varchar(50) NOT NULL DEFAULT 'WHEREBY',
  "providerMeetingId" varchar(255) NULL,
  "status" varchar(32) NOT NULL DEFAULT 'NOT_CREATED',
  "guestUrlCiphertext" text NULL,
  "hostUrlCiphertext" text NULL,
  "providerEndDate" timestamptz NULL,
  "creationLeaseExpiresAt" timestamptz NULL,
  "attemptCount" integer NOT NULL DEFAULT 0,
  "lastErrorCode" varchar(100) NULL,
  "deletedAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_video_rooms_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_video_appointment" UNIQUE ("appointmentId"),
  CONSTRAINT "FK_vet_video_appointment" FOREIGN KEY ("appointmentId") REFERENCES pg_temp.vet_appointments ("id") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_video_status" CHECK ("status" IN ('NOT_CREATED', 'CREATING', 'READY', 'FAILED', 'EXPIRED', 'DELETED')),
  CONSTRAINT "CHK_vet_video_attempts" CHECK ("attemptCount" >= 0),
  CONSTRAINT "CHK_vet_video_provider" CHECK ("provider" = 'WHEREBY'),
  CONSTRAINT "CHK_vet_video_ready" CHECK ("status" <> 'READY' OR ("providerMeetingId" IS NOT NULL AND "guestUrlCiphertext" IS NOT NULL AND "hostUrlCiphertext" IS NOT NULL AND "providerEndDate" IS NOT NULL)),
  CONSTRAINT "CHK_vet_video_ciphertexts" CHECK (("guestUrlCiphertext" IS NULL OR "guestUrlCiphertext" ~ '^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$') AND ("hostUrlCiphertext" IS NULL OR "hostUrlCiphertext" ~ '^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$')),
  CONSTRAINT "CHK_vet_video_lease" CHECK ("status" <> 'CREATING' OR "creationLeaseExpiresAt" IS NOT NULL)
) ON COMMIT DROP;

CREATE TEMP TABLE vet_appointment_events (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "appointmentId" uuid NOT NULL,
  "eventType" varchar(64) NOT NULL,
  "eventKey" varchar(100) NOT NULL,
  "actorType" varchar(32) NOT NULL,
  "actorId" varchar(100) NULL,
  "previousStatus" varchar(32) NULL,
  "newStatus" varchar(32) NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_appointment_events_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_events_key" UNIQUE ("appointmentId", "eventKey"),
  CONSTRAINT "FK_vet_events_appointment" FOREIGN KEY ("appointmentId") REFERENCES pg_temp.vet_appointments ("id") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_events_actor" CHECK ("actorType" IN ('CUSTOMER', 'DOCTOR', 'ADMIN', 'SYSTEM')),
  CONSTRAINT "CHK_vet_events_previous" CHECK ("previousStatus" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  CONSTRAINT "CHK_vet_events_new" CHECK ("newStatus" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  CONSTRAINT "CHK_vet_events_actor_id" CHECK (("actorType" = 'SYSTEM' AND "actorId" IS NULL) OR ("actorType" <> 'SYSTEM' AND "actorId" IS NOT NULL)),
  CONSTRAINT "CHK_vet_events_type" CHECK ("eventType" ~ '^[A-Z][A-Z0-9_]{1,63}$' AND length(btrim("eventKey")) > 0),
  CONSTRAINT "CHK_vet_events_metadata" CHECK (jsonb_typeof("metadata") = 'object' AND NOT ("metadata" ?| ARRAY['nationalId', 'nationalIdCiphertext', 'password', 'passwordHash', 'guestUrl', 'hostUrl', 'roomUrl', 'token']))
) ON COMMIT DROP;

CREATE TEMP TABLE vet_notification_outbox (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "appointmentId" uuid NOT NULL,
  "recipientType" varchar(32) NOT NULL,
  "recipientPhoneSnapshot" varchar(11) NOT NULL,
  "notificationType" varchar(64) NOT NULL,
  "template" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" varchar(32) NOT NULL DEFAULT 'PENDING',
  "attemptCount" integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
  "leaseExpiresAt" timestamptz NULL,
  "deliveredAt" timestamptz NULL,
  "lastErrorCode" varchar(100) NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vet_notification_outbox_pkey" PRIMARY KEY (id),
  CONSTRAINT "UQ_vet_outbox_delivery" UNIQUE ("appointmentId", "notificationType", "recipientType", "recipientPhoneSnapshot"),
  CONSTRAINT "FK_vet_outbox_appointment" FOREIGN KEY ("appointmentId") REFERENCES pg_temp.vet_appointments ("id") ON DELETE RESTRICT,
  CONSTRAINT "CHK_vet_outbox_recipient" CHECK ("recipientType" IN ('CUSTOMER', 'DOCTOR', 'ADMIN')),
  CONSTRAINT "CHK_vet_outbox_status" CHECK ("status" IN ('PENDING', 'SENDING', 'DELIVERED', 'FAILED')),
  CONSTRAINT "CHK_vet_outbox_phone" CHECK ("recipientPhoneSnapshot" ~ '^09[0-9]{9}$'),
  CONSTRAINT "CHK_vet_outbox_attempts" CHECK ("attemptCount" >= 0),
  CONSTRAINT "CHK_vet_outbox_type" CHECK (length(btrim("notificationType")) > 0 AND length(btrim("template")) > 0),
  CONSTRAINT "CHK_vet_outbox_payload" CHECK (jsonb_typeof("payload") = 'object' AND NOT ("payload" ?| ARRAY['nationalId', 'nationalIdCiphertext', 'password', 'passwordHash', 'guestUrl', 'hostUrl', 'roomUrl', 'token'])),
  CONSTRAINT "CHK_vet_outbox_delivery" CHECK (("status" = 'DELIVERED' AND "deliveredAt" IS NOT NULL) OR ("status" <> 'DELIVERED' AND "deliveredAt" IS NULL)),
  CONSTRAINT "CHK_vet_outbox_lease" CHECK ("status" <> 'SENDING' OR "leaseExpiresAt" IS NOT NULL)
) ON COMMIT DROP;
CREATE UNIQUE INDEX "UQ_vet_doctors_username_ci" ON pg_temp.vet_doctors USING btree (lower("username"));
CREATE INDEX "IDX_vet_doctors_active" ON pg_temp.vet_doctors USING btree ("active", "id");
CREATE INDEX "IDX_vet_windows_doctor_time" ON pg_temp.vet_availability_windows USING btree ("doctorId", "startsAt");
CREATE INDEX "IDX_vet_slots_window" ON pg_temp.vet_appointment_slots USING btree ("availabilityWindowId", "startsAt");
CREATE INDEX "IDX_vet_slots_available" ON pg_temp.vet_appointment_slots USING btree ("startsAt", "doctorId") WHERE "status" = 'AVAILABLE';
CREATE UNIQUE INDEX "UQ_vet_appointments_slot_occupant" ON pg_temp.vet_appointments USING btree ("slotId") WHERE "status" IN ('PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW');
CREATE INDEX "IDX_vet_appointments_customer" ON pg_temp.vet_appointments USING btree ("customerUserId", "createdAt", "id");
CREATE INDEX "IDX_vet_appointments_doctor" ON pg_temp.vet_appointments USING btree ("doctorId", "status", "createdAt");
CREATE INDEX "IDX_vet_appointments_hold_expiry" ON pg_temp.vet_appointments USING btree ("holdExpiresAt") WHERE "status" = 'PAYMENT_PENDING';
CREATE INDEX "IDX_vet_appointments_passport" ON pg_temp.vet_appointments USING btree ("birdPassportId");
CREATE UNIQUE INDEX "UQ_vet_claims_owner_policy" ON pg_temp.vet_free_consultation_claims USING btree ("policyVersion", "ownerUserId") WHERE "subjectType" = 'OWNER';
CREATE UNIQUE INDEX "UQ_vet_claims_passport_policy" ON pg_temp.vet_free_consultation_claims USING btree ("policyVersion", "birdPassportId") WHERE "subjectType" = 'PASSPORT';
CREATE UNIQUE INDEX "UQ_vet_payments_authority" ON pg_temp.vet_appointment_payments USING btree ("provider", "providerAuthority") WHERE "providerAuthority" IS NOT NULL;
CREATE UNIQUE INDEX "UQ_vet_payments_reference" ON pg_temp.vet_appointment_payments USING btree ("provider", "providerReference") WHERE "providerReference" IS NOT NULL;
CREATE UNIQUE INDEX "UQ_vet_payments_success" ON pg_temp.vet_appointment_payments USING btree ("appointmentId") WHERE "status" = 'SUCCEEDED';
CREATE INDEX "IDX_vet_payments_reconcile" ON pg_temp.vet_appointment_payments USING btree ("status", "updatedAt");
CREATE UNIQUE INDEX "UQ_vet_video_meeting" ON pg_temp.vet_video_rooms USING btree ("provider", "providerMeetingId") WHERE "providerMeetingId" IS NOT NULL;
CREATE INDEX "IDX_vet_video_cleanup" ON pg_temp.vet_video_rooms USING btree ("status", "providerEndDate");
CREATE INDEX "IDX_vet_events_timeline" ON pg_temp.vet_appointment_events USING btree ("appointmentId", "createdAt", "id");
CREATE INDEX "IDX_vet_outbox_due" ON pg_temp.vet_notification_outbox USING btree ("nextAttemptAt", "id") WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX "IDX_vet_outbox_lease" ON pg_temp.vet_notification_outbox USING btree ("leaseExpiresAt") WHERE "status" = 'SENDING';
CREATE TRIGGER "TRG_vet_windows_geometry" BEFORE UPDATE ON pg_temp.vet_availability_windows FOR EACH ROW EXECUTE FUNCTION public.vet_guard_window();
CREATE TRIGGER "TRG_vet_slots_geometry" BEFORE INSERT OR UPDATE ON pg_temp.vet_appointment_slots FOR EACH ROW EXECUTE FUNCTION public.vet_guard_slot();
CREATE TRIGGER "TRG_vet_appointments_immutable" BEFORE UPDATE ON pg_temp.vet_appointments FOR EACH ROW EXECUTE FUNCTION public.vet_guard_appointment_update();
CREATE CONSTRAINT TRIGGER "TRG_vet_appointments_free_claim" AFTER INSERT OR UPDATE ON pg_temp.vet_appointments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.vet_assert_free_claim();
CREATE CONSTRAINT TRIGGER "TRG_vet_claims_confirmation" AFTER INSERT ON pg_temp.vet_free_consultation_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.vet_assert_free_claim();
CREATE TRIGGER "TRG_vet_claims_append_only" BEFORE UPDATE OR DELETE ON pg_temp.vet_free_consultation_claims FOR EACH ROW EXECUTE FUNCTION public.vet_reject_history_mutation();
CREATE TRIGGER "TRG_vet_events_append_only" BEFORE UPDATE OR DELETE ON pg_temp.vet_appointment_events FOR EACH ROW EXECUTE FUNCTION public.vet_reject_history_mutation();
CREATE TRIGGER "TRG_vet_claims_no_truncate" BEFORE TRUNCATE ON pg_temp.vet_free_consultation_claims FOR EACH STATEMENT EXECUTE FUNCTION public.vet_reject_history_mutation();
CREATE TRIGGER "TRG_vet_events_no_truncate" BEFORE TRUNCATE ON pg_temp.vet_appointment_events FOR EACH STATEMENT EXECUTE FUNCTION public.vet_reject_history_mutation();
CREATE TRIGGER "TRG_vet_payments_disabled_v1" BEFORE INSERT OR UPDATE ON pg_temp.vet_appointment_payments FOR EACH ROW EXECUTE FUNCTION public.vet_guard_external_record();
CREATE TRIGGER "TRG_vet_video_confirmed_only" BEFORE INSERT OR UPDATE ON pg_temp.vet_video_rooms FOR EACH ROW EXECUTE FUNCTION public.vet_guard_external_record();
CREATE TRIGGER "TRG_vet_outbox_confirmed_only" BEFORE INSERT OR UPDATE ON pg_temp.vet_notification_outbox FOR EACH ROW EXECUTE FUNCTION public.vet_guard_external_record();

DO $reference$
BEGIN
  IF (SELECT is_upgraded FROM vet_replacement_state) THEN
    ALTER TABLE pg_temp.vet_availability_windows DROP CONSTRAINT "CHK_vet_windows_status";
    ALTER TABLE pg_temp.vet_availability_windows ADD CONSTRAINT "CHK_vet_windows_status" CHECK ("status" IN ('ACTIVE', 'CANCELLED', 'RETIRED'));
    ALTER TABLE pg_temp.vet_appointment_slots DROP CONSTRAINT "UQ_vet_slots_doctor_start";
    CREATE UNIQUE INDEX "UQ_vet_slots_doctor_start_non_cancelled" ON pg_temp.vet_appointment_slots ("doctorId", "startsAt") WHERE status <> 'CANCELLED';
    DROP TRIGGER "TRG_vet_windows_geometry" ON pg_temp.vet_availability_windows;
    CREATE TRIGGER "TRG_vet_windows_geometry" BEFORE INSERT OR UPDATE ON pg_temp.vet_availability_windows FOR EACH ROW EXECUTE FUNCTION public.vet_guard_window();
  END IF;
END
$reference$;

-- Verify the complete starting state BEFORE any public DDL.
DO $verify$
DECLARE table_name text; actual_oid oid; expected_oid oid; actual jsonb; expected jsonb;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['vet_doctors', 'vet_availability_windows', 'vet_appointment_slots', 'vet_appointments', 'vet_free_consultation_claims', 'vet_appointment_payments', 'vet_video_rooms', 'vet_appointment_events', 'vet_notification_outbox'] LOOP
    actual_oid := to_regclass('public.' || table_name);
    expected_oid := to_regclass('pg_temp.' || table_name);
    SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod, a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid), a.attcollation, a.attidentity, a.attgenerated) ORDER BY a.attnum)
    INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = actual_oid AND a.attnum > 0 AND NOT a.attisdropped;
    SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod, a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid), a.attcollation, a.attidentity, a.attgenerated) ORDER BY a.attnum)
    INTO expected FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = expected_oid AND a.attnum > 0 AND NOT a.attisdropped;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet columns drift: %', table_name; END IF;

    SELECT jsonb_agg(jsonb_build_array(conname, contype, regexp_replace(pg_get_constraintdef(oid), 'REFERENCES (public|pg_temp(_[0-9]+)?)\.', 'REFERENCES ', 'g'), convalidated,
      condeferrable, condeferred,
      (SELECT jsonb_build_array(c.relname, CASE WHEN c.relnamespace = pg_my_temp_schema() THEN 'public' ELSE n.nspname END)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = confrelid),
      confupdtype, confdeltype, confmatchtype) ORDER BY conname)
    INTO actual FROM pg_constraint WHERE conrelid = actual_oid;
    SELECT jsonb_agg(jsonb_build_array(conname, contype, regexp_replace(pg_get_constraintdef(oid), 'REFERENCES (public|pg_temp(_[0-9]+)?)\.', 'REFERENCES ', 'g'), convalidated,
      condeferrable, condeferred,
      (SELECT jsonb_build_array(c.relname, CASE WHEN c.relnamespace = pg_my_temp_schema() THEN 'public' ELSE n.nspname END)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = confrelid),
      confupdtype, confdeltype, confmatchtype) ORDER BY conname)
    INTO expected FROM pg_constraint WHERE conrelid = expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet constraints drift: %', table_name; END IF;

    SELECT jsonb_agg(jsonb_build_array(c.relname,
      regexp_replace(pg_get_indexdef(i.indexrelid), ' ON [^ ]+ USING ', ' ON target USING '),
      i.indisvalid, i.indisready, i.indislive, i.indisunique, i.indimmediate,
      i.indnullsnotdistinct, i.indclass::text, i.indcollation::text, i.indoption::text) ORDER BY c.relname)
    INTO actual FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = actual_oid;
    SELECT jsonb_agg(jsonb_build_array(c.relname,
      regexp_replace(pg_get_indexdef(i.indexrelid), ' ON [^ ]+ USING ', ' ON target USING '),
      i.indisvalid, i.indisready, i.indislive, i.indisunique, i.indimmediate,
      i.indnullsnotdistinct, i.indclass::text, i.indcollation::text, i.indoption::text) ORDER BY c.relname)
    INTO expected FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet indexes drift: %', table_name; END IF;

    SELECT jsonb_agg(jsonb_build_array(t.tgname, t.tgenabled, t.tgfoid, t.tgtype, t.tgattr::text,
      t.tgdeferrable, t.tginitdeferred, t.tgargs,
      pg_get_expr(t.tgqual, t.tgrelid), t.tgoldtable, t.tgnewtable) ORDER BY t.tgname)
    INTO actual FROM pg_trigger t WHERE t.tgrelid = actual_oid AND NOT t.tgisinternal;
    SELECT jsonb_agg(jsonb_build_array(t.tgname, t.tgenabled, t.tgfoid, t.tgtype, t.tgattr::text,
      t.tgdeferrable, t.tginitdeferred, t.tgargs,
      pg_get_expr(t.tgqual, t.tgrelid), t.tgoldtable, t.tgnewtable) ORDER BY t.tgname)
    INTO expected FROM pg_trigger t WHERE t.tgrelid = expected_oid AND NOT t.tgisinternal;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet triggers drift: %', table_name; END IF;
    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = actual_oid AND tgisinternal AND tgenabled <> 'O'
    ) THEN
      RAISE EXCEPTION 'Vet internal constraint trigger drift: %', table_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class = actual_oid) THEN
      RAISE EXCEPTION 'Unexpected vet table rule: %', table_name;
    END IF;
  END LOOP;
END
$verify$;


DO $upgrade$
DECLARE spec record;
BEGIN
  IF NOT (SELECT is_upgraded FROM vet_replacement_state) THEN
    ALTER TABLE public.vet_availability_windows DROP CONSTRAINT "CHK_vet_windows_status";
    ALTER TABLE public.vet_availability_windows ADD CONSTRAINT "CHK_vet_windows_status" CHECK ("status" IN ('ACTIVE', 'CANCELLED', 'RETIRED'));
    ALTER TABLE public.vet_appointment_slots DROP CONSTRAINT "UQ_vet_slots_doctor_start";
    CREATE UNIQUE INDEX "UQ_vet_slots_doctor_start_non_cancelled" ON public.vet_appointment_slots ("doctorId", "startsAt") WHERE status <> 'CANCELLED';
    DROP TRIGGER "TRG_vet_windows_geometry" ON public.vet_availability_windows;
    CREATE TRIGGER "TRG_vet_windows_geometry" BEFORE INSERT OR UPDATE ON public.vet_availability_windows FOR EACH ROW EXECUTE FUNCTION public.vet_guard_window();
    FOR spec IN SELECT * FROM vet_replacement_functions WHERE baseline_body <> upgraded_body ORDER BY name LOOP
      EXECUTE 'CREATE OR REPLACE FUNCTION public.' || quote_ident(spec.name) ||
        '() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS '
        || quote_literal(spec.upgraded_body);
    END LOOP;
    ALTER TABLE pg_temp.vet_availability_windows DROP CONSTRAINT "CHK_vet_windows_status";
    ALTER TABLE pg_temp.vet_availability_windows ADD CONSTRAINT "CHK_vet_windows_status" CHECK ("status" IN ('ACTIVE', 'CANCELLED', 'RETIRED'));
    ALTER TABLE pg_temp.vet_appointment_slots DROP CONSTRAINT "UQ_vet_slots_doctor_start";
    CREATE UNIQUE INDEX "UQ_vet_slots_doctor_start_non_cancelled" ON pg_temp.vet_appointment_slots ("doctorId", "startsAt") WHERE status <> 'CANCELLED';
    DROP TRIGGER "TRG_vet_windows_geometry" ON pg_temp.vet_availability_windows;
    CREATE TRIGGER "TRG_vet_windows_geometry" BEFORE INSERT OR UPDATE ON pg_temp.vet_availability_windows FOR EACH ROW EXECUTE FUNCTION public.vet_guard_window();
    UPDATE vet_replacement_state SET is_upgraded = true;
  END IF;
END
$upgrade$;

-- Verify the complete end state as well; any failure rolls back the whole upgrade.
DO $functions$
DECLARE spec record; actual record; expected_body text; upgraded boolean;
BEGIN
  SELECT is_upgraded INTO STRICT upgraded FROM vet_replacement_state;
  FOR spec IN SELECT * FROM vet_replacement_functions ORDER BY name LOOP
    expected_body := CASE WHEN upgraded THEN spec.upgraded_body ELSE spec.baseline_body END;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = spec.name) <> 1 THEN
      RAISE EXCEPTION 'Vet function overload/missing drift: %', spec.name;
    END IF;
    SELECT p.*, l.lanname INTO actual FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = to_regprocedure('public.' || spec.name || '()');
    IF NOT FOUND OR btrim(replace(actual.prosrc, E'\r\n', E'\n')) IS DISTINCT FROM btrim(replace(expected_body, E'\r\n', E'\n'))
      OR actual.prorettype <> 'trigger'::regtype OR actual.lanname <> 'plpgsql'
      OR actual.prosecdef OR actual.proisstrict OR actual.proleakproof OR actual.provolatile <> 'v'
      OR actual.prokind <> 'f' OR actual.proparallel <> 'u' OR actual.procost <> 100 OR actual.prorows <> 0
      OR actual.pronargs <> 0 OR actual.pronargdefaults <> 0 OR actual.proretset
      OR actual.prosupport <> 0 OR actual.probin IS NOT NULL
      OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
      RAISE EXCEPTION 'Vet function definition drift: %', spec.name;
    END IF;
  END LOOP;
END
$functions$;
DO $verify$
DECLARE table_name text; actual_oid oid; expected_oid oid; actual jsonb; expected jsonb;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['vet_doctors', 'vet_availability_windows', 'vet_appointment_slots', 'vet_appointments', 'vet_free_consultation_claims', 'vet_appointment_payments', 'vet_video_rooms', 'vet_appointment_events', 'vet_notification_outbox'] LOOP
    actual_oid := to_regclass('public.' || table_name);
    expected_oid := to_regclass('pg_temp.' || table_name);
    SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod, a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid), a.attcollation, a.attidentity, a.attgenerated) ORDER BY a.attnum)
    INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = actual_oid AND a.attnum > 0 AND NOT a.attisdropped;
    SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod, a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid), a.attcollation, a.attidentity, a.attgenerated) ORDER BY a.attnum)
    INTO expected FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = expected_oid AND a.attnum > 0 AND NOT a.attisdropped;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet columns drift: %', table_name; END IF;

    SELECT jsonb_agg(jsonb_build_array(conname, contype, regexp_replace(pg_get_constraintdef(oid), 'REFERENCES (public|pg_temp(_[0-9]+)?)\.', 'REFERENCES ', 'g'), convalidated,
      condeferrable, condeferred,
      (SELECT jsonb_build_array(c.relname, CASE WHEN c.relnamespace = pg_my_temp_schema() THEN 'public' ELSE n.nspname END)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = confrelid),
      confupdtype, confdeltype, confmatchtype) ORDER BY conname)
    INTO actual FROM pg_constraint WHERE conrelid = actual_oid;
    SELECT jsonb_agg(jsonb_build_array(conname, contype, regexp_replace(pg_get_constraintdef(oid), 'REFERENCES (public|pg_temp(_[0-9]+)?)\.', 'REFERENCES ', 'g'), convalidated,
      condeferrable, condeferred,
      (SELECT jsonb_build_array(c.relname, CASE WHEN c.relnamespace = pg_my_temp_schema() THEN 'public' ELSE n.nspname END)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = confrelid),
      confupdtype, confdeltype, confmatchtype) ORDER BY conname)
    INTO expected FROM pg_constraint WHERE conrelid = expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet constraints drift: %', table_name; END IF;

    SELECT jsonb_agg(jsonb_build_array(c.relname,
      regexp_replace(pg_get_indexdef(i.indexrelid), ' ON [^ ]+ USING ', ' ON target USING '),
      i.indisvalid, i.indisready, i.indislive, i.indisunique, i.indimmediate,
      i.indnullsnotdistinct, i.indclass::text, i.indcollation::text, i.indoption::text) ORDER BY c.relname)
    INTO actual FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = actual_oid;
    SELECT jsonb_agg(jsonb_build_array(c.relname,
      regexp_replace(pg_get_indexdef(i.indexrelid), ' ON [^ ]+ USING ', ' ON target USING '),
      i.indisvalid, i.indisready, i.indislive, i.indisunique, i.indimmediate,
      i.indnullsnotdistinct, i.indclass::text, i.indcollation::text, i.indoption::text) ORDER BY c.relname)
    INTO expected FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = expected_oid;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet indexes drift: %', table_name; END IF;

    SELECT jsonb_agg(jsonb_build_array(t.tgname, t.tgenabled, t.tgfoid, t.tgtype, t.tgattr::text,
      t.tgdeferrable, t.tginitdeferred, t.tgargs,
      pg_get_expr(t.tgqual, t.tgrelid), t.tgoldtable, t.tgnewtable) ORDER BY t.tgname)
    INTO actual FROM pg_trigger t WHERE t.tgrelid = actual_oid AND NOT t.tgisinternal;
    SELECT jsonb_agg(jsonb_build_array(t.tgname, t.tgenabled, t.tgfoid, t.tgtype, t.tgattr::text,
      t.tgdeferrable, t.tginitdeferred, t.tgargs,
      pg_get_expr(t.tgqual, t.tgrelid), t.tgoldtable, t.tgnewtable) ORDER BY t.tgname)
    INTO expected FROM pg_trigger t WHERE t.tgrelid = expected_oid AND NOT t.tgisinternal;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Vet triggers drift: %', table_name; END IF;
    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = actual_oid AND tgisinternal AND tgenabled <> 'O'
    ) THEN
      RAISE EXCEPTION 'Vet internal constraint trigger drift: %', table_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class = actual_oid) THEN
      RAISE EXCEPTION 'Unexpected vet table rule: %', table_name;
    END IF;
  END LOOP;
END
$verify$;


COMMIT;
