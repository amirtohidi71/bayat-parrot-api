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

## Forward migration: availability replacement lifecycle

VET-D2-01B adds `scripts/migrations/20260907-enable-vet-availability-replacement.sql` after the immutable Day 1 migration. The preceding sections describe the historical Day 1 contract; this section describes the upgraded contract. Apply both SQL files in order on a new installation, and only the forward migration on an existing Day 1 installation. Do not rerun the baseline migration against the upgraded schema: its drift rejection is intentional. Vet entities remain `synchronize: false`. This change adds no endpoints or provider/payment functionality.

New windows must start `ACTIVE`. Window identity, doctor, time geometry, duration, timezone, creation identity and timestamps are immutable except for lifecycle status and `updatedAt`; replacement creates a new window. `CANCELLED` and `RETIRED` are terminal and cannot be reopened or exchanged.

- `CANCELLED` keeps its original meaning: every child slot is `CANCELLED`.
- `RETIRED` preserves the original window and appointment-linked slots, but removes the window envelope from ACTIVE-window overlap enforcement. Before retirement, every non-cancelled slot whose `endsAt > transaction_timestamp()` and which has no live occupant must be cancelled. This deliberately includes in-progress time and slots with only cancelled appointment history; it uses database state, not a client-provided cutoff. The check is a transition precondition, not a permanent assertion that would prevent later appointment cancellation.
- A live occupant is an appointment in `PAYMENT_PENDING`, `CONFIRMED`, `COMPLETED` or `NO_SHOW`, exactly matching the existing occupancy index. The Day 1 no-gateway check still prohibits paid holds; this migration does not enable `PAYMENT_PENDING` writes.

`UQ_vet_slots_doctor_start` is replaced by unique index `UQ_vet_slots_doctor_start_non_cancelled` on `(doctorId, startsAt) WHERE status <> 'CANCELLED'`. Multiple cancelled historical rows may share a start, but only one non-cancelled scheduling slot may use it. `UQ_vet_slots_id_doctor` and all foreign keys remain unchanged.

Both exclusion constraints remain unchanged, including their object identity and predicates:

- `EX_vet_windows_doctor_overlap` rejects overlapping ACTIVE envelopes for a doctor.
- `EX_vet_slots_doctor_overlap` rejects overlapping non-CANCELLED slot ranges for a doctor, **regardless of parent status**. Its half-open `[start, end)` ranges allow adjacency. This is the additional protection beyond equal-start uniqueness: shifted or changed-duration replacement slots cannot overlap retained occupied/historical slots.

Slot identity, parent, doctor and geometry cannot change. New/restored AVAILABLE or BLOCKED slots require an ACTIVE parent. A retained non-cancelled slot under RETIRED is immutable and unbookable (a true no-op update is harmless). An occupied slot cannot be blocked or cancelled. If its appointment later becomes CANCELLED, the safely unoccupied slot may be cancelled without deleting or detaching its appointment; replacement availability can then reuse that interval. Completed/no-show appointments retain both their slot protection and their consumed entitlement.

The deferred free-claim check now locks an AVAILABLE slot and then its ACTIVE parent using `FOR SHARE`. Only the new-appointment insertion eligibility branch changes; existing cancellation, completion, no-show and claim validation do not require an ACTIVE parent. Claims and audit events remain append-only, and payment, notification and video gates are unchanged.

Scheduling writes and new free confirmations require PostgreSQL `READ COMMITTED`; changed guards reject other isolation levels with SQLSTATE `25000`. This fail-closed restriction is needed because cross-table occupancy checks must take fresh snapshots after lock waits. Existing appointment lifecycle updates alone are not subject to this new restriction. Booking and slot updates use slot-before-window row locking. Retirement owns its parent update lock and checks child rows without acquiring child locks, avoiding the reverse lock order. Future multi-row availability endpoints must use a consistent doctor-scoped transaction/advisory lock, prelock affected slots in ID order before windows, and retry whole transactions on retryable lock/deadlock errors. No endpoint lock protocol is implemented here.

An unused window can be replaced with the same range or a changed duration after cancelling its slots. A window with history can be retired after cancelling safely unoccupied future slots, then replaced with an overlapping ACTIVE envelope; generated slots must omit retained non-cancelled ranges. Slot cancellation, parent retirement and replacement generation must be one transaction, so failed generation restores the original scheduling state. Retirement never deletes history or restores free entitlement.

The forward migration takes bounded exclusive locks on the nine vet tables and the Day 1 migration advisory lock. It constructs independent temporary catalog references, verifies all six function bodies and table/index/constraint/trigger definitions, and accepts only the complete baseline or complete upgraded contract. Mixed, missing, altered or disabled objects fail closed before public schema changes. It verifies the final contract again, is idempotent with populated replacement history, and performs no business-row rewrite. Plan deployment for the short exclusive-lock window; lock/statement timeout rolls back the whole migration rather than partially applying it.

Regression suites remain separate: the existing PostgreSQL suite verifies Day 1, with explicit assertions for the two metadata differences; the new replacement suite verifies baseline, upgrade, full current metadata, drift rejection and behavior/races, including the existing booking/payment/audit protections. Both require `VET_RUN_DB_TESTS=1`, `VET_TEST_DATABASE_CONFIRM=DISPOSABLE`, and `VET_TEST_DATABASE_URL` pointing to local `vet_appointments_disposable_test`. They never create/drop databases or connect to the main database. Identity is confirmed before cleanup of owned vet tables/functions; suites serialize their ownership of that database. Do not use this opt-in database for real data.

There is no automatic downgrade. Once replacement data exists, roll back the application while retaining the forward schema; disable availability writes if the older application does not understand RETIRED. Any separately reviewed manual downgrade must first prove: no RETIRED windows, no duplicate doctor/start across **all** slot rows, the original all-child-slots-cancelled rule for CANCELLED windows, and no overlap from any proposed reactivation. Never delete appointment, claim, event or slot history merely to satisfy downgrade preconditions.

## Day 2C: production admin availability API

Day 1 remains the immutable foundation, and Day 2B remains the forward replacement schema described above. Day 2C implements `VetAvailabilityService` and the following admin endpoints on that upgraded schema. It adds no migration or schema repair. Both migrations must already have been applied by the deployment process; the service never runs them. The historical statements above about endpoints not yet existing describe Day 1/Day 2B.

All routes reuse `AdminModule` and `AdminAuthGuard`, requiring the existing signed `admin-panel` token. Customer and doctor tokens do not authorize these routes. Doctor identity remains separate from customer `UserRole`. The creation identity comes from the authenticated admin username.

| Method | Path | Success response |
| --- | --- | --- |
| POST | `/admin/vet/availability-windows` | 201 `{ window, slots }` |
| GET | `/admin/vet/availability-windows` | 200 `{ items, total, limit, offset }` |
| GET | `/admin/vet/availability-windows/:id` | 200 window |
| GET | `/admin/vet/availability-windows/:id/slots` | 200 slot array, including cancelled history |
| POST | `/admin/vet/availability-windows/:id/cancel` | 200 CANCELLED window |
| POST | `/admin/vet/availability-windows/:id/retire` | 200 RETIRED window |
| POST | `/admin/vet/availability-windows/:id/replace` | 201 `{ previousWindow, window, slots, retainedSlots }` |

Create accepts `doctorId`, `startsAt`, `endsAt`, `slotDurationMinutes`, and optional `timeZone` (default and only accepted value: `Asia/Tehran`). Replace accepts the same geometry fields, using the original window's doctor. It creates a new identity; it never edits the old geometry. Create and replace require an existing active doctor. Cancel and retire remain available for inactive doctors.

Timestamps must be valid ISO instants with an explicit `Z` or numeric offset, at whole-minute precision. Fractional sub-minute input is rejected before JavaScript can round it. Ranges must be positive, at most 24 elapsed hours, and exactly divisible by the integer duration (1–1440 minutes), matching the database checks. Generation uses epoch milliseconds, with no local-machine or wall-clock timezone arithmetic. Normal creation fills every contiguous half-open grid cell in `[startsAt, endsAt)`; the final slot ends exactly at `endsAt`. The window and complete intended slot set commit together. Database checks, uniqueness, exclusions and triggers remain final authority.

List supports optional `doctorId`, `status`, `from`, and `to`. Time filtering means interval intersection (`endsAt > from`, `startsAt < to`), with `from < to` when both are supplied. Results sort by `startsAt`, then `id`. Pagination defaults to `limit=50`, `offset=0`, with limit 1–100. Slots sort by start and identity. Response DTOs explicitly allowlist scheduling fields, creation admin and timestamps; they never return doctor relations, credentials, appointment details or customer data.

Lifecycle actions require an ACTIVE source window; repeated or competing terminal actions return 409. There is no PATCH of geometry or status and no DELETE route.

- CANCEL attempts to cancel every non-cancelled child, including past slots. An occupied child makes the whole operation fail and roll back. The parent becomes CANCELLED only after every child is cancelled.
- RETIRE cancels non-cancelled slots whose `endsAt > transaction_timestamp()` and which have no occupant in PAYMENT_PENDING, CONFIRMED, COMPLETED or NO_SHOW. This includes in-progress AVAILABLE/BLOCKED slots and slots with only cancelled appointment history. Occupied slots and ended historical slots retain their identities, geometry and contents. The parent becomes RETIRED.
- REPLACE performs the same retirement, then creates a new ACTIVE envelope and generated slots in one transaction. The old parent always becomes RETIRED, including when unused. Cancelled starts can be reused. Retained non-cancelled source slots are returned separately and remain attached to their original parent. Replacement generation omits their protected intervals; intersecting retained boundaries must align with the replacement grid, otherwise the request returns 409. It never truncates slots or silently leaves partially protected cells unused. A completely protected replacement can have an empty generated set. The ACTIVE envelope still cannot overlap another ACTIVE envelope; generated slots cannot overlap any other non-cancelled slot. Generation or constraint failure restores all previous window/slot state.

Every scheduling write explicitly starts a `READ COMMITTED` transaction, regardless of the pooled session default. A transaction advisory lock keyed by canonical doctor UUID (`vet:availability:doctor:`) serializes service writes for that doctor. Lifecycle writes prelock source slots in UUID order, then lock and re-read the parent, and only then read occupancy in fresh commands. This follows the forward schema's slot-before-window protocol. Create/replace hold a shared doctor row lock while checking active status. All locks are transaction-scoped. Deadlock, serialization and lock-timeout failures retry the entire transaction up to three total attempts; exhausted retries fail with 409. Each attempt uses a 5-second lock timeout and 15-second statement timeout. Neither REPEATABLE READ nor SERIALIZABLE is used for scheduling transactions.

Invalid DTO/geometry/filter input returns 400; absent doctor/window returns 404; inactive doctor, terminal lifecycle, occupied cancellation, incompatible retained grid, overlap and other scheduling constraint conflicts return 409. Unexpected database/schema/isolation errors fail with a generic 500. Responses never include raw SQL, driver details or stack traces. An old or drifted schema is not repaired by the application.

Day 2C tests are `availability.spec.ts`, `availability.http.spec.ts`, and `availability.postgres.integration.spec.ts`. The PostgreSQL suite calls the production service, uses actual slot-insert fault injection to prove rollback, and uses observed advisory-lock wait barriers for concurrent create, replace and cancel races. It also verifies retained appointment/claim/event history and explicit READ COMMITTED behavior on a connection defaulting to REPEATABLE READ. It uses the same opt-in environment gate, local `vet_appointments_disposable_test` identity check and cross-suite ownership lock as Day 1/Day 2B. Test-only booking/history fixtures do not introduce a production booking or claim flow.

No payment, customer booking, video, notification, hold-expiry or free-consultation claim endpoint is included in Day 2C.
