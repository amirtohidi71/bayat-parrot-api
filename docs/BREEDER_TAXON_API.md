# Breeder taxon permission API

This additive API uses the three committed `20261020` foundation migrations;
there is no new migration or taxonomy seed. Authorization uses stable taxonomy
UUIDs, never Product labels or published-product options.

## Customer (JwtAuthGuard + CustomerCapabilityGuard)

- `GET /seller-onboarding/taxonomy`: array of `{id,key,displayName,subspecies:[{id,key,displayName}]}`; an unpopulated catalog returns `[]`.
- `GET /seller-onboarding/breeder-applications/:id/permissions`: ownership checked server-side, including historical applications.
- `POST /seller-onboarding/breeder-applications/:id/taxon-requests`: `{requestId:UUID,selections:[{speciesId:UUID,subspeciesIds:UUID[]}]}`.
- Existing `POST /seller-onboarding/breeder-application` accepts optional `taxonRequest` with that same shape. For structured submissions, legacy `species` labels are derived from the catalog; legacy callers may continue supplying `species:string[]` without `taxonRequest`. Legacy strings grant no taxon permissions.

Selections contain 1–20 distinct species and 1–100 distinct children per species.
Every child must belong to its selected parent. Later requests add new children
without changing application approval history. Existing children conflict;
retries must retain the original request ID. A revoked/rejected parent needs an
explicit admin regrant before additional children can be requested beneath it.

## Admin (AdminAuthGuard)

- `GET /admin-panel/seller-onboarding/taxonomy`
- `GET /admin-panel/seller-onboarding/breeder-applications/:id/permissions`
- `POST /admin-panel/seller-onboarding/breeder-applications/:id/species-permissions/:permissionId/{approve|reject|revoke|regrant}`
- The same four actions under `subspecies-permissions`.

All action bodies: `{requestId:UUID,expectedRevision:integer,reason:string}`.
Reason is required, trimmed, 1–500 characters. Revision must match the locked
projection. Actor identity comes exclusively from the authenticated admin.

Allowed transitions: REQUESTED → APPROVED/REJECTED, APPROVED → REVOKED,
REJECTED/REVOKED → APPROVED only through `regrant`. Approve/regrant requires the
current, unrevoked APPROVED application, successful recorded contact, live
BREEDER role and eligible seller/account. No approval promotes the account or
changes the existing application workflow. Reducing access remains possible
for the current application after account inactivity/application revocation.

Parent approval/regrant never grants children. Parent revocation atomically
revokes approved children with one event per changed revision. No operation
automatically republishes anything. Until the later unpublication phase,
revocation touching a published BREEDER Product fails closed with 409
`BREEDER_TAXON_UNPUBLISH_REQUIRED`; ordinary listings are unaffected.

## Responses and consistency

Permission responses contain `applicationId`, `applicationStatus`, `revoked`,
`isCurrent`, `canRequestTaxa`, and nested `speciesPermissions`. Each permission
contains its ID, stable taxon ID, `state`, `revision`, `effectiveApproved`; child
permissions also contain `subspeciesId`. Raw history is retained, while effective
flags also require current eligible application/account/seller state.

Only admin responses add audit `events` with IDs, subject IDs, revision, action,
states, actor type/identity, reason and timestamp. Neither response exposes
request hashes, application private notes, credentials, Product internals or files.

Mutations lock seller lifecycle advisory key → application → User → species
permissions (species UUID/id order) → child permissions (species/subspecies/id
order). Seller eligibility locks use the existing policy. All writes and events
share one transaction. Same request ID + canonical payload + actor is a no-op
retry returning current state; different payload/actor conflicts. Parent cascade
events share the request ID/hash. Customers cannot change status or actor fields.
Initial application creation retains the existing submission ordering: lifecycle
lock then User, followed by the new application and permission rows.

## Stable errors

Errors contain `{statusCode,code,message}` and never SQL details.

| HTTP | Code | Meaning |
|---|---|---|
| 400 | BREEDER_TAXON_INVALID_SELECTION | Missing/unknown/mismatched taxonomy |
| 404 | BREEDER_TAXON_NOT_FOUND | Missing resource or customer ownership mismatch |
| 403 | BREEDER_TAXON_APPLICATION_NOT_ELIGIBLE | Current live account/application cannot grant/request |
| 409 | BREEDER_TAXON_APPLICATION_NOT_CURRENT | Historical application mutation |
| 409 | BREEDER_TAXON_INVALID_TRANSITION | Illegal state transition/integrity conflict |
| 409 | BREEDER_TAXON_REVISION_CONFLICT | Stale expected revision |
| 409 | BREEDER_TAXON_IDEMPOTENCY_CONFLICT | Reused request ID with changed payload/actor |
| 409 | BREEDER_TAXON_REQUEST_CONFLICT | Already-requested child |
| 409 | BREEDER_TAXON_REGRANT_REQUIRED | Parent requires explicit regrant |
| 409 | BREEDER_TAXON_UNPUBLISH_REQUIRED | Published BREEDER Product prevents this phase's revocation |

Existing seller eligibility and onboarding error codes remain unchanged. DTO
failures return normal validation 400; guard failures retain existing 401/403.
