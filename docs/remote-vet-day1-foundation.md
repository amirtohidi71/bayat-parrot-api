# Remote Vet Day 1 foundation — no gateway

Updated scope: first eligible consultation can be confirmed free; later consultations cannot reserve a slot while payment is unavailable. This is persistence/security foundation, **not a released booking feature**. There are no new HTTP endpoints, doctor-login handlers, payment handlers, video providers, notification workers, or production seeds.

## Security boundary

Previously, any normal authenticated customer could call GET /users or GET /users/:id and receive User entities, including another person's nationalId. Both directory routes now require the existing customer/admin JWT strategy **and** a persisted users.role of admin. The role is reloaded for every directory request, so a demoted admin's old JWT cannot retain access.

Directory/detail responses use an explicit allowlist: id, phone, firstName, lastName, email, profileCompleted, loyaltyPoints, role, createdAt, updatedAt. They omit nationalId and loaded relations. GET/PATCH /users/profile and POST /auth/register return only the current authenticated user's allowlisted profile, including their own nationalId to preserve the account form contract. Profile, registration, and directory responses are private/no-store. Loyalty reads and OTP behavior are unchanged.

Legacy database-admin directory access is preserved. Separately scoped admin-panel, sales-agent, passport and future doctor tokens are not accepted as customer tokens. No existing admin-panel routes or auth configuration were changed. Do not widen the legacy guard to accept arbitrary scoped tokens; a future staff directory needs its own explicit authorization and response policy.

The existing users.nationalId storage is not migrated/encrypted by this task. The fix closes cross-user directory disclosure, not every historical PII storage concern.

## Persistence and module boundaries

All nine entities use named SQL-owned tables with synchronize:false individually. The existing global development synchronization setting is unchanged; vet DDL must always run explicitly. AppModule imports VetAppointmentsModule, which registers repositories and VetBookingPolicy only.

| Table | TypeORM entity | Entity file under src/vet-appointments/entities |
| --- | --- | --- |
| vet_doctors | VetDoctor | doctor.entity.ts |
| vet_availability_windows | VetAvailabilityWindow | availability-window.entity.ts |
| vet_appointment_slots | VetAppointmentSlot | appointment-slot.entity.ts |
| vet_appointments | VetAppointment | appointment.entity.ts |
| vet_free_consultation_claims | VetFreeConsultationClaim | free-consultation-claim.entity.ts |
| vet_appointment_payments | VetAppointmentPayment | appointment-payment.entity.ts |
| vet_video_rooms | VetVideoRoom | video-room.entity.ts |
| vet_appointment_events | VetAppointmentEvent | appointment-event.entity.ts |
| vet_notification_outbox | VetNotificationOutbox | notification-outbox.entity.ts |

No eager relations are used. Foreign keys, including composite doctor/window and doctor/slot mappings, are explicit. Money is PostgreSQL bigint and a TypeScript string; do not coerce it through Number. All time columns are timestamptz; Asia/Tehran is the business timezone. Jalali belongs at validated input/display boundaries only.

Future customer booking, admin availability, doctor auth/operations, payments, video and notification services should remain separate consumers of this persistence module. None is prematurely stubbed as a live route in Day 1.

## Free entitlement and slot invariants

- Server policy defaults to VET_FIRST_FREE_SCOPE=OWNER and VET_FIRST_FREE_POLICY_VERSION=vet-first-free-v1. Invalid configuration fails closed. OWNER and PASSPORT are explicit supported values, not client-supplied booking fields.
- A unique partial claim index on (policyVersion, ownerUserId) for OWNER is the final race-safe entitlement limit. The corresponding PASSPORT index supports a later verified-passport policy.
- Deferrable, initially deferred constraint triggers require a free appointment and its matching claim to commit together. The policy version and owner/passport must match the appointment. A missing or mismatched claim rolls the transaction back.
- Free appointments require a slot and confirmedAt. Confirmation checks slot availability under a row lock. The unique occupied-slot index prevents concurrent double booking even without application advisory locks.
- Claims cannot be updated, deleted, or truncated. Cancellation and no-show retain the consumed entitlement; a future administrative correction requires a deliberate audited design, not deleting the claim.
- A bookingRequestId is unique per customer, independently of slot or policy. Day 2 must return the original result for a matching retry and reject reuse for a changed request.
- Active doctor windows cannot overlap. Non-cancelled slots for a doctor cannot overlap; every slot must fit its parent window's exact duration/grid. Geometry is frozen once slots exist.
- Occupied slots cannot be blocked/cancelled. Window cancellation requires its slots to be cancelled first. Cancelled appointments free their slot but do not restore the claim; completed/no-show slots remain occupied historical time.
- Slot status AVAILABLE alone does not prove bookability: read queries must also exclude occupied slots, inactive doctors and past times. Booking must repeat those checks inside its transaction.

## No-payment gate and payment-ready schema

VetBookingPolicy.paymentsAvailable is hardcoded false, not an environment switch. Its side-effect-free paymentUnavailableResult() returns:

```json
{
  "code": "VET_PAYMENT_COMING_SOON",
  "message": "پرداخت آنلاین به‌زودی فعال می‌شود",
  "paymentRequired": true,
  "paymentAvailable": false,
  "appointmentId": null,
  "holdExpiresAt": null
}
```

Day 2's paid branch must return that result **before any appointment, claim, payment, room or outbox insert**. It does not need an interest/waitlist record.

CHK_vet_appointments_v1_no_gateway also makes unsafe direct writes fail: a PAID row, if deliberately recorded outside that future booking branch, can only be PAYMENT_UNAVAILABLE with slotId, holdExpiresAt and confirmedAt all NULL. PAYMENT_PENDING, CONFIRMED, EXPIRED and PAYMENT_REVIEW are modeled for future lifecycle work but cannot bypass the current gate for paid visits. Free appointments have no payment holds.

TRG_vet_payments_disabled_v1 rejects all payment inserts/updates. Video/outbox inserts require a free CONFIRMED appointment; paid rows cannot create either. Existing free room/outbox rows may be updated after cancellation for cleanup; future workers must recheck appointment status and must not send stale confirmation notifications.

The payment table contains exactly: id, appointmentId, clientRequestId, provider, providerAuthority, providerReference, amountMinor, currency, status, failureCode, requestedAt, verifiedAt, verificationLeaseExpiresAt, createdAt, updatedAt. Authority/reference are nullable and excluded from default entity selection. Retry, provider-authority, provider-reference and successful-payment uniqueness are ready for future integration. There is no gateway client, callback, verification operation, credentials, fake success, or external request.

Enabling payments later requires an explicit reviewed migration replacing the no-gateway CHECK, the disabled-payment trigger and current lifecycle-transition logic, plus a real provider integration. An environment change alone is intentionally insufficient.

## Sensitive fields and optional passport

New appointment national IDs use AES-256-GCM envelopes (v1:nonce:tag:ciphertext) plus nationalIdLast4. Guest and host video URLs have separate encrypted columns; hashes, ciphertexts, provider IDs and outbox phone/payload fields are excluded from default selection where sensitive. Generic encryption functions accept a caller-supplied 32-byte key and appointment/field AAD; no key is read, generated for deployment, or stored in the database by module startup.

Before Day 2 launch: provision a protected key outside the database, validate a 10-digit national ID before encryption, bind ciphertext to appointmentId plus field name, decide authorized decryption and key rotation/recovery procedures. Ciphertext regex CHECKs enforce envelope shape, not cryptographic validity; the helper supplies authenticated encryption. No endpoint may serialize a raw entity. Query errors and logs must be sanitized, not include request bodies/SQL parameters or provider responses.

The outbox stores the delivery phone snapshot because a durable worker needs it. Mask logs; use allowlisted notification payloads without national ID, private URLs or credentials. JSON CHECKs reject obvious top-level sensitive keys only; they are not recursive PII detection and do not replace payload allowlisting.

birdPassportId is nullable. Linked records require snapshots of passport code, bird name/species and passport owner full name. Day 2 must accept a **code**, never a client UUID; resolve the passport server-side, lock/revalidate it, require ACTIVE status and exact normalized authenticated-user-mobile equality with passport.ownerMobile. Code knowledge is not ownership. These authorization checks are deliberately not invented from FK presence and are not yet implemented because there is no booking API. Existing public Bird Passport behavior remains untouched.

## Day 2 transaction contract and prerequisites

1. Authenticate the customer; accept an idempotency UUID, desired slot and optional passport code. Resolve the customer from the session, not from a DTO. Reject invalid/past times, inactive doctor and unauthorized passport.
2. Use a consistent lock order: entitlement advisory key (policy version + scope + subject), then slot FOR UPDATE; re-read state, doctor fee and entitlement under the lock. Database unique/exclusion/deferred constraints remain the final authority. Use bounded retries for serialization/deadlock conflicts.
3. If entitlement is already consumed, return VET_PAYMENT_COMING_SOON with no writes and no hold. Do not create payment rows or provider work.
4. Otherwise, in one transaction insert the FREE/CONFIRMED appointment, matching immutable claim, append-only events and any approved durable free-visit notification work. Snapshot authoritative values; fee is zero for the free visit. Commit before any external dispatch.
5. Only a separate later worker may provision video/send notifications for a still-eligible free confirmation. Implement leases, bounded retries, cancellation cleanup and deduplication; do not call providers inside the booking transaction.

No blocker prevents starting Day 2 implementation. Production booking remains blocked until the migration is deployed with least-privilege roles, an encryption key/rotation plan is configured, authoritative booking/passport validation and lock/idempotency handling are implemented, and doctor credentials/availability are provisioned through audited operations. There is deliberately no production doctor or availability seed. Provider credentials and a payment gateway are **not** prerequisites for developing the free booking transaction.

Scope/version changes can grant a new entitlement population; treat them as explicit product/policy changes, never rotate the version automatically on deployment.

## Deployment and rollback

Run scripts/migrations/20260907-create-vet-appointments-v1.sql using psql -X -v ON_ERROR_STOP=1 -f, as the migration owner, before deploying the backend. Existing public.users, public.bird_passports and public.uuid_generate_v4() are required. The migration transaction checks availability, installs/verifies btree_gist in public, and uses an advisory migration lock and bounded lock/statement timeouts. Extension or privilege failures abort rather than silently weakening protection.

Temporary reference tables mirror explicit DDL, with temporary FK parents. Catalog comparison checks exact columns/types/nullability/defaults/collations, PKs/uniques/CHECKs/exclusions/FK targets and actions, index definitions/predicates/validity, user triggers and trigger functions. Internal constraint triggers must remain enabled. Missing/replaced/extra/disabled objects cause a rollback rather than a silent repair. Reference tables are empty and dropped at transaction end.

Verified on a separately initialized PostgreSQL 17.4 cluster bound only to 127.0.0.1:55439, not the user's configured application database. Runtime SQL execution needs TEMP permission only for this migration's owner, not for the application.

Use a separate least-privilege application role without schema ownership, DDL, TRUNCATE, trigger disabling or superuser/BYPASSRLS. Do not use the disposable test superuser in production. A privileged database owner can bypass SQL protections; constraints are not a defense against that owner.

For rollback, disable/remove the new module in an application release but preserve populated tables, claims and history. Do not drop appointments or restore free eligibility automatically. Any future lifecycle/schema revision must update the expected strict migration/catalog strategy deliberately; rerunning historical strict DDL against an intentionally evolved schema will correctly flag drift.

## Validation (2026-09-07)

- Focused new suites: 59 passing tests (33 real PostgreSQL + 10 entity/policy/encryption + 16 real-JWT HTTP security), no skips.
- Real psql migration applied twice successfully. Concurrent overlapping-window, slot-occupation and OWNER-claim tests each had one winner; losing writes rolled back. Schema drift cases include altered columns/defaults/checks/FKs/indexes, disabled/missing triggers and function bodies.
- Full backend with all four PostgreSQL suites enabled: 49 passing suites, 1 failing suite; 626 passing tests, 1 failing test, 4 existing skips (631 total). Bird Passport: 290 pass / 1 fail / 3 skip; Sales Chat: 82 pass. Real PostgreSQL subsets: vet 33 pass, Bird Passport 10 pass / 1 fail, Sales Chat 11 pass, Product Review Video 4 pass. Tests use separate disposable databases.
- Known unchanged Bird Passport test failure: the extra-trigger drift test expects "user trigger set mismatch", but reruns the original 12-column migration after the later gender migration, so it first raises "column count mismatch: expected 12, found 13". Reproduced when running that test alone; its source and migrations match HEAD. No Bird Passport behavior/test/migration was changed.
- Full-tree ESLint: 498 errors and 8 warnings in 37 unchanged files; normalized file contents were compared with HEAD. Every new/changed TypeScript file is clean. No broad --fix was run.
- Typecheck, production build, and tracked/new-file diff whitespace validation pass.
- Existing skips are three Windows symlink/O_NOFOLLOW Bird Passport tests and one opt-in large-video HTTP test; none of the new suites is skipped.
- Disposable test evidence is in ignored .tmp/vet-day1-full-tests.json and .tmp/vet-day1-eslint-full.json. No real provider calls were made.

Reproduce focused tests in PowerShell with an already-created dedicated disposable database:

```powershell
$env:VET_RUN_DB_TESTS = '1'
$env:VET_TEST_DATABASE_CONFIRM = 'DISPOSABLE'
# Set VET_TEST_DATABASE_URL securely to a local vet_*test/disposable* database.
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/vet-appointments/vet-appointments.postgres.integration.spec.ts src/vet-appointments/vet-foundation.spec.ts src/users/users.security.http.spec.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm.cmd run build
git diff --check
```

The vet suite verifies the database identity/name/loopback URL before destructive test setup. It owns only its nine vet tables/functions and uses ID-only test parent tables for users/passports; existing subsystem regression suites independently exercise their real schemas. Never point it at a development or production database.

## Exact SQL constraint/index catalogue

Totals: 9 named UUID primary keys, 56 CHECK constraints, 11 UNIQUE constraints, 13 foreign keys (all ON DELETE RESTRICT, default ON UPDATE NO ACTION), 2 GiST exclusion constraints, and 21 additional indexes. Constraint-backed indexes are additional to the 21 explicitly declared indexes. Every listed name/expression is mirrored in the SQL migration and entity metadata (SQL also owns the trigger definitions).

### vet_doctors

```sql
PRIMARY KEY "vet_doctors_pkey" (id)
UNIQUE "UQ_vet_doctors_mobile" ("mobile")
CHECK "CHK_vet_doctors_username" ("username" ~ '^[A-Za-z0-9_]{3,50}$')
CHECK "CHK_vet_doctors_password_hash" ("passwordHash" ~ '^\$2[aby]\$(1[0-6])\$[./A-Za-z0-9]{53}$')
CHECK "CHK_vet_doctors_display_name" (length(btrim("displayName")) > 0)
CHECK "CHK_vet_doctors_mobile" ("mobile" ~ '^09[0-9]{9}$')
CHECK "CHK_vet_doctors_fee" ("consultationFeeMinor" >= 0)
CHECK "CHK_vet_doctors_currency" ("currency" ~ '^[A-Z]{3}$')
UNIQUE INDEX "UQ_vet_doctors_username_ci" (lower("username"))
INDEX "IDX_vet_doctors_active" ("active", "id")
```

### vet_availability_windows

```sql
PRIMARY KEY "vet_availability_windows_pkey" (id)
UNIQUE "UQ_vet_windows_id_doctor" ("id", "doctorId")
FOREIGN KEY "FK_vet_windows_doctor" ("doctorId") REFERENCES vet_doctors ("id") ON DELETE RESTRICT
CHECK "CHK_vet_windows_status" ("status" IN ('ACTIVE', 'CANCELLED'))
CHECK "CHK_vet_windows_time" (isfinite("startsAt") AND isfinite("endsAt") AND "startsAt" < "endsAt" AND "endsAt" - "startsAt" <= interval '1 day')
CHECK "CHK_vet_windows_timezone" ("timeZone" = 'Asia/Tehran')
CHECK "CHK_vet_windows_duration" ("slotDurationMinutes" BETWEEN 1 AND 1440 AND mod(extract(epoch FROM ("endsAt" - "startsAt")), "slotDurationMinutes" * 60) = 0)
CHECK "CHK_vet_windows_minutes" (extract(second FROM "startsAt") = 0 AND extract(second FROM "endsAt") = 0)
CHECK "CHK_vet_windows_admin" (length(btrim("createdByAdmin")) > 0)
EXCLUDE "EX_vet_windows_doctor_overlap" USING gist ("doctorId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("status" = 'ACTIVE')
INDEX "IDX_vet_windows_doctor_time" ("doctorId", "startsAt")
```

### vet_appointment_slots

```sql
PRIMARY KEY "vet_appointment_slots_pkey" (id)
UNIQUE "UQ_vet_slots_doctor_start" ("doctorId", "startsAt")
UNIQUE "UQ_vet_slots_id_doctor" ("id", "doctorId")
FOREIGN KEY "FK_vet_slots_window_doctor" ("availabilityWindowId", "doctorId") REFERENCES vet_availability_windows ("id", "doctorId") ON DELETE RESTRICT
CHECK "CHK_vet_slots_status" ("status" IN ('AVAILABLE', 'BLOCKED', 'CANCELLED'))
CHECK "CHK_vet_slots_time" (isfinite("startsAt") AND isfinite("endsAt") AND "startsAt" < "endsAt")
EXCLUDE "EX_vet_slots_doctor_overlap" USING gist ("doctorId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("status" <> 'CANCELLED')
INDEX "IDX_vet_slots_window" ("availabilityWindowId", "startsAt")
INDEX "IDX_vet_slots_available" ("startsAt", "doctorId") WHERE "status" = 'AVAILABLE'
```

### vet_appointments

```sql
PRIMARY KEY "vet_appointments_pkey" (id)
UNIQUE "UQ_vet_appointments_reference" ("publicReference")
UNIQUE "UQ_vet_appointments_booking_retry" ("customerUserId", "bookingRequestId")
FOREIGN KEY "FK_vet_appointments_customer" ("customerUserId") REFERENCES users ("id") ON DELETE RESTRICT
FOREIGN KEY "FK_vet_appointments_doctor" ("doctorId") REFERENCES vet_doctors ("id") ON DELETE RESTRICT
FOREIGN KEY "FK_vet_appointments_slot_doctor" ("slotId", "doctorId") REFERENCES vet_appointment_slots ("id", "doctorId") ON DELETE RESTRICT
FOREIGN KEY "FK_vet_appointments_passport" ("birdPassportId") REFERENCES bird_passports ("id") ON DELETE RESTRICT
CHECK "CHK_vet_appointments_status" ("status" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
CHECK "CHK_vet_appointments_pricing" ("pricingKind" IN ('FREE', 'PAID'))
CHECK "CHK_vet_appointments_cancel_actor" ("cancelledByType" IN ('CUSTOMER', 'DOCTOR', 'ADMIN', 'SYSTEM'))
CHECK "CHK_vet_appointments_reference" ("publicReference" ~ '^V[A-Z0-9]{12,39}$')
CHECK "CHK_vet_appointments_currency" ("currency" ~ '^[A-Z]{3}$')
CHECK "CHK_vet_appointments_rule" (length(btrim("pricingRuleVersion")) > 0)
CHECK "CHK_vet_appointments_names" (length(btrim("ownerFullNameSnapshot")) > 0 AND length(btrim("doctorNameSnapshot")) > 0)
CHECK "CHK_vet_appointments_mobile" ("ownerMobileSnapshot" ~ '^09[0-9]{9}$')
CHECK "CHK_vet_appointments_national_id" ("nationalIdLast4" ~ '^[0-9]{4}$' AND "nationalIdCiphertext" ~ '^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{14}$')
CHECK "CHK_vet_appointments_passport" (("birdPassportId" IS NULL AND "passportCodeSnapshot" IS NULL AND "birdNameSnapshot" IS NULL AND "birdSpeciesSnapshot" IS NULL AND "passportOwnerFullNameSnapshot" IS NULL) OR ("birdPassportId" IS NOT NULL AND "passportCodeSnapshot" IS NOT NULL AND "passportCodeSnapshot" ~ '^B[0-9]{8}$' AND "birdNameSnapshot" IS NOT NULL AND length(btrim("birdNameSnapshot")) > 0 AND "birdSpeciesSnapshot" IS NOT NULL AND length(btrim("birdSpeciesSnapshot")) > 0 AND "passportOwnerFullNameSnapshot" IS NOT NULL AND length(btrim("passportOwnerFullNameSnapshot")) > 0))
CHECK "CHK_vet_appointments_pricing_amount" (("pricingKind" = 'FREE' AND "feeAmountMinor" = 0) OR ("pricingKind" = 'PAID' AND "feeAmountMinor" > 0))
CHECK "CHK_vet_appointments_v1_no_gateway" (("pricingKind" = 'FREE' AND "slotId" IS NOT NULL AND "status" IN ('CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW') AND "confirmedAt" IS NOT NULL AND "holdExpiresAt" IS NULL) OR ("pricingKind" = 'PAID' AND "status" = 'PAYMENT_UNAVAILABLE' AND "slotId" IS NULL AND "holdExpiresAt" IS NULL AND "confirmedAt" IS NULL))
CHECK "CHK_vet_appointments_completion" (("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "completedAt" >= "confirmedAt") OR ("status" <> 'COMPLETED' AND "completedAt" IS NULL))
CHECK "CHK_vet_appointments_cancellation" (("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledByType" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) > 0) OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL))
UNIQUE INDEX "UQ_vet_appointments_slot_occupant" ("slotId") WHERE "status" IN ('PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
INDEX "IDX_vet_appointments_customer" ("customerUserId", "createdAt", "id")
INDEX "IDX_vet_appointments_doctor" ("doctorId", "status", "createdAt")
INDEX "IDX_vet_appointments_hold_expiry" ("holdExpiresAt") WHERE "status" = 'PAYMENT_PENDING'
INDEX "IDX_vet_appointments_passport" ("birdPassportId")
```

### vet_free_consultation_claims

```sql
PRIMARY KEY "vet_free_consultation_claims_pkey" (id)
UNIQUE "UQ_vet_claims_appointment" ("appointmentId")
FOREIGN KEY "FK_vet_claims_appointment" ("appointmentId") REFERENCES vet_appointments ("id") ON DELETE RESTRICT
FOREIGN KEY "FK_vet_claims_owner" ("ownerUserId") REFERENCES users ("id") ON DELETE RESTRICT
FOREIGN KEY "FK_vet_claims_passport" ("birdPassportId") REFERENCES bird_passports ("id") ON DELETE RESTRICT
CHECK "CHK_vet_claims_scope" ("subjectType" IN ('OWNER', 'PASSPORT'))
CHECK "CHK_vet_claims_policy" (length(btrim("policyVersion")) > 0)
CHECK "CHK_vet_claims_subject" (("subjectType" = 'OWNER' AND "ownerUserId" IS NOT NULL AND "birdPassportId" IS NULL) OR ("subjectType" = 'PASSPORT' AND "ownerUserId" IS NULL AND "birdPassportId" IS NOT NULL))
UNIQUE INDEX "UQ_vet_claims_owner_policy" ("policyVersion", "ownerUserId") WHERE "subjectType" = 'OWNER'
UNIQUE INDEX "UQ_vet_claims_passport_policy" ("policyVersion", "birdPassportId") WHERE "subjectType" = 'PASSPORT'
```

### vet_appointment_payments

```sql
PRIMARY KEY "vet_appointment_payments_pkey" (id)
UNIQUE "UQ_vet_payments_retry" ("appointmentId", "clientRequestId")
FOREIGN KEY "FK_vet_payments_appointment" ("appointmentId") REFERENCES vet_appointments ("id") ON DELETE RESTRICT
CHECK "CHK_vet_payments_status" ("status" IN ('CREATED', 'PENDING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'REFUND_REQUIRED', 'REFUNDED'))
CHECK "CHK_vet_payments_amount" ("amountMinor" > 0)
CHECK "CHK_vet_payments_currency" ("currency" ~ '^[A-Z]{3}$')
CHECK "CHK_vet_payments_provider" (length(btrim("provider")) > 0)
CHECK "CHK_vet_payments_verified" ("status" NOT IN ('SUCCEEDED', 'REFUND_REQUIRED', 'REFUNDED') OR ("verifiedAt" IS NOT NULL AND "providerReference" IS NOT NULL))
UNIQUE INDEX "UQ_vet_payments_authority" ("provider", "providerAuthority") WHERE "providerAuthority" IS NOT NULL
UNIQUE INDEX "UQ_vet_payments_reference" ("provider", "providerReference") WHERE "providerReference" IS NOT NULL
UNIQUE INDEX "UQ_vet_payments_success" ("appointmentId") WHERE "status" = 'SUCCEEDED'
INDEX "IDX_vet_payments_reconcile" ("status", "updatedAt")
```

### vet_video_rooms

```sql
PRIMARY KEY "vet_video_rooms_pkey" (id)
UNIQUE "UQ_vet_video_appointment" ("appointmentId")
FOREIGN KEY "FK_vet_video_appointment" ("appointmentId") REFERENCES vet_appointments ("id") ON DELETE RESTRICT
CHECK "CHK_vet_video_status" ("status" IN ('NOT_CREATED', 'CREATING', 'READY', 'FAILED', 'EXPIRED', 'DELETED'))
CHECK "CHK_vet_video_attempts" ("attemptCount" >= 0)
CHECK "CHK_vet_video_provider" ("provider" = 'WHEREBY')
CHECK "CHK_vet_video_ready" ("status" <> 'READY' OR ("providerMeetingId" IS NOT NULL AND "guestUrlCiphertext" IS NOT NULL AND "hostUrlCiphertext" IS NOT NULL AND "providerEndDate" IS NOT NULL))
CHECK "CHK_vet_video_ciphertexts" (("guestUrlCiphertext" IS NULL OR "guestUrlCiphertext" ~ '^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$') AND ("hostUrlCiphertext" IS NULL OR "hostUrlCiphertext" ~ '^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$'))
CHECK "CHK_vet_video_lease" ("status" <> 'CREATING' OR "creationLeaseExpiresAt" IS NOT NULL)
UNIQUE INDEX "UQ_vet_video_meeting" ("provider", "providerMeetingId") WHERE "providerMeetingId" IS NOT NULL
INDEX "IDX_vet_video_cleanup" ("status", "providerEndDate")
```

### vet_appointment_events

```sql
PRIMARY KEY "vet_appointment_events_pkey" (id)
UNIQUE "UQ_vet_events_key" ("appointmentId", "eventKey")
FOREIGN KEY "FK_vet_events_appointment" ("appointmentId") REFERENCES vet_appointments ("id") ON DELETE RESTRICT
CHECK "CHK_vet_events_actor" ("actorType" IN ('CUSTOMER', 'DOCTOR', 'ADMIN', 'SYSTEM'))
CHECK "CHK_vet_events_previous" ("previousStatus" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
CHECK "CHK_vet_events_new" ("newStatus" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
CHECK "CHK_vet_events_actor_id" (("actorType" = 'SYSTEM' AND "actorId" IS NULL) OR ("actorType" <> 'SYSTEM' AND "actorId" IS NOT NULL))
CHECK "CHK_vet_events_type" ("eventType" ~ '^[A-Z][A-Z0-9_]{1,63}$' AND length(btrim("eventKey")) > 0)
CHECK "CHK_vet_events_metadata" (jsonb_typeof("metadata") = 'object' AND NOT ("metadata" ?| ARRAY['nationalId', 'nationalIdCiphertext', 'password', 'passwordHash', 'guestUrl', 'hostUrl', 'roomUrl', 'token']))
INDEX "IDX_vet_events_timeline" ("appointmentId", "createdAt", "id")
```

### vet_notification_outbox

```sql
PRIMARY KEY "vet_notification_outbox_pkey" (id)
UNIQUE "UQ_vet_outbox_delivery" ("appointmentId", "notificationType", "recipientType", "recipientPhoneSnapshot")
FOREIGN KEY "FK_vet_outbox_appointment" ("appointmentId") REFERENCES vet_appointments ("id") ON DELETE RESTRICT
CHECK "CHK_vet_outbox_recipient" ("recipientType" IN ('CUSTOMER', 'DOCTOR', 'ADMIN'))
CHECK "CHK_vet_outbox_status" ("status" IN ('PENDING', 'SENDING', 'DELIVERED', 'FAILED'))
CHECK "CHK_vet_outbox_phone" ("recipientPhoneSnapshot" ~ '^09[0-9]{9}$')
CHECK "CHK_vet_outbox_attempts" ("attemptCount" >= 0)
CHECK "CHK_vet_outbox_type" (length(btrim("notificationType")) > 0 AND length(btrim("template")) > 0)
CHECK "CHK_vet_outbox_payload" (jsonb_typeof("payload") = 'object' AND NOT ("payload" ?| ARRAY['nationalId', 'nationalIdCiphertext', 'password', 'passwordHash', 'guestUrl', 'hostUrl', 'roomUrl', 'token']))
CHECK "CHK_vet_outbox_delivery" (("status" = 'DELIVERED' AND "deliveredAt" IS NOT NULL) OR ("status" <> 'DELIVERED' AND "deliveredAt" IS NULL))
CHECK "CHK_vet_outbox_lease" ("status" <> 'SENDING' OR "leaseExpiresAt" IS NOT NULL)
INDEX "IDX_vet_outbox_due" ("nextAttemptAt", "id") WHERE "status" IN ('PENDING', 'FAILED')
INDEX "IDX_vet_outbox_lease" ("leaseExpiresAt") WHERE "status" = 'SENDING'
```

## Exact trigger catalogue

| Name | Table | Timing | Function |
| --- | --- | --- | --- |
| TRG_vet_windows_geometry | vet_availability_windows | BEFORE UPDATE; row | vet_guard_window |
| TRG_vet_slots_geometry | vet_appointment_slots | BEFORE INSERT OR UPDATE; row | vet_guard_slot |
| TRG_vet_appointments_immutable | vet_appointments | BEFORE UPDATE; row | vet_guard_appointment_update |
| TRG_vet_appointments_free_claim | vet_appointments | AFTER INSERT OR UPDATE DEFERRABLE INITIALLY DEFERRED; row | vet_assert_free_claim |
| TRG_vet_claims_confirmation | vet_free_consultation_claims | AFTER INSERT DEFERRABLE INITIALLY DEFERRED; row | vet_assert_free_claim |
| TRG_vet_claims_append_only | vet_free_consultation_claims | BEFORE UPDATE OR DELETE; row | vet_reject_history_mutation |
| TRG_vet_events_append_only | vet_appointment_events | BEFORE UPDATE OR DELETE; row | vet_reject_history_mutation |
| TRG_vet_claims_no_truncate | vet_free_consultation_claims | BEFORE TRUNCATE; statement | vet_reject_history_mutation |
| TRG_vet_events_no_truncate | vet_appointment_events | BEFORE TRUNCATE; statement | vet_reject_history_mutation |
| TRG_vet_payments_disabled_v1 | vet_appointment_payments | BEFORE INSERT OR UPDATE; row | vet_guard_external_record |
| TRG_vet_video_confirmed_only | vet_video_rooms | BEFORE INSERT OR UPDATE; row | vet_guard_external_record |
| TRG_vet_outbox_confirmed_only | vet_notification_outbox | BEFORE INSERT OR UPDATE; row | vet_guard_external_record |

All six public vet_* trigger functions use SECURITY INVOKER with search_path=pg_catalog,public and are definition-verified on rerun.

## Exact files in this change

Modified:

- src/app.module.ts
- src/auth/auth.controller.ts
- src/users/users.controller.ts
- src/users/users.module.ts

New:

- docs/remote-vet-day1-foundation.md
- scripts/migrations/20260907-create-vet-appointments-v1.sql
- src/users/dto/user-response.dto.ts
- src/users/guards/user-directory-admin.guard.ts
- src/users/users.security.http.spec.ts
- src/vet-appointments/entities/doctor.entity.ts
- src/vet-appointments/entities/availability-window.entity.ts
- src/vet-appointments/entities/appointment-slot.entity.ts
- src/vet-appointments/entities/appointment.entity.ts
- src/vet-appointments/entities/free-consultation-claim.entity.ts
- src/vet-appointments/entities/appointment-payment.entity.ts
- src/vet-appointments/entities/video-room.entity.ts
- src/vet-appointments/entities/appointment-event.entity.ts
- src/vet-appointments/entities/notification-outbox.entity.ts
- src/vet-appointments/policies/vet-booking.policy.ts
- src/vet-appointments/security/vet-field-encryption.ts
- src/vet-appointments/vet-appointment.enums.ts
- src/vet-appointments/vet-appointments.module.ts
- src/vet-appointments/vet-appointments.postgres.integration.spec.ts
- src/vet-appointments/vet-foundation.spec.ts
- test/vet-test-entities.ts

No frontend files, Sales Chat behavior, Bird Passport behavior, SMS configuration, provider configuration, or dependency manifests were changed. No commit, push or staging operation was performed.
