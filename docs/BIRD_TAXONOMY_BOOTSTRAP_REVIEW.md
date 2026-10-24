# Bird taxonomy v1: approved manifest and category compatibility review

Tasks 350?355; owner approval recorded in Task 355 (2026-10-24). Local validation only. Backend 6deea07, frontend d4ecc17. No Production or main-database access.

## Status: APPROVED manifest; not deployed or seeded outside disposable tests

The two explicit source declarations match: 14 species and 59 explicit children. All keys and display labels are preserved exactly. Each of the 73 UUID v4 identities was allocated once and stored in the proposed JSON manifest; generation never creates UUIDs. The owner approved these exact 14 parents, 59 explicit children and 73 fixed UUIDs in Task 355. Approval adopts the existing business catalog; it does not assert scientific taxonomy.

Four parents have no explicit child: alexandrine, senegal, rose-ringed and cockatiel. Passport-generated self-leaves are deliberately excluded. No aliases are merged. The existing business labels (including colour/variant/hybrid groupings) were explicitly approved without alias merging; similarity of labels is not proof of equivalence.

## Exact approved values and compatibility

Every one of the 14 displayName values differs from its existing species route/filter key; all 59 child labels differ from their existing catalog keys. The following table is a comparison, not an alias merge or a rewrite instruction.

| Species key / route value | Preserved displayName | Explicit child key = preserved displayName |
| --- | --- | --- |
| macaw | ماکائو | blue-gold = ماکائو آبی طلایی; red = ماکائو قرمز; scarlet = ماکائو اسکارلت; hahns = ماکائو هانس; harlequin = ماکائو هارلی کویین |
| cockatoo | کاکادو | sulphur-crested = کاکادو تاج زرد (باراتا); umbrella = کاکادو آمبرلا; moluccan = کاکادو مولوکان; goffin = کاکادو گوفین; bare-eyed = کاکادو چشم برهنه; ducorps = کاکادو دوکروپ; major-mitchell = کاکادو ماژورمیشل; galah = کاکادو گالارز |
| african-grey | کاسکو | red-tail = دم قرمز (کنگو); chocolate-tail = دم شکلاتی (تیمنه) |
| green-cheek | گرین چیک | normal = گرین‌چیک نرمال; ananasi-red = گرین‌چیک آناناسی رد; double-red = گرین‌چیک دبل رد; extreme-red = گرین‌چیک اکستریم رد; yellow-side-red = گرین‌چیک یلوساید رد; yellow-side-double-red = گرین‌چیک یلوساید دبل رد; yellow-side-extreme-red = گرین‌چیک یلوساید اکستریم رد; mint = گرین‌چیک مینت; moon-cheek = گرین‌چیک مونچیک; sun-cheek = گرین‌چیک سانچیک; ro-cheek = گرین‌چیک روچیک; pineapple = گرین‌چیک پاین‌اپل; turquoise = گرین‌چیک تراکوئیس; pied = گرین‌چیک پاید; american-dilute = گرین‌چیک امریکن دایلوت; violet = گرین‌چیک ویولت |
| quaker | راهب | blue = راهب آبی; green = راهب سبز; pistachio = راهب پسته‌ای; yellow = راهب زرد; white = راهب سفید; split = راهب اسپیلت; turquoise = راهب تراکوئیس; blue-sky = راهب بلواسکای; cross = راهب کراس; violet = راهب بنفش; gray = راهب خاکستری |
| alexandrine | شاه طوطی | No explicit child; do not invent a self-leaf |
| senegal | سنگال | No explicit child; do not invent a self-leaf |
| rose-ringed | ملنگو | No explicit child; do not invent a self-leaf |
| sun-conure | خورشیدی | sun-conure = سان کانور; jenday-conure = ژاندی کانور; nanday-conure = ناندی کانور |
| rosella | رزیلا | rosella = رزیلا; shakila = شکیلا |
| eclectus | اکلکتوس | salmon = سالمون; vosmaeri = وسماری |
| lorikeet | لوری‌کیت | black = لوریکیت بلک; rainbow = لوریکیت رنگین‌کمانی; black-capped = لوریکیت بلک کپد; red = لوریکیت رد; blue-strong = لوریکیت بلو استرانگ; perfect = لوریکیت پرفکت; yellow-collar = لوری یقه زرد; green-naped = لوری پالتو سبز |
| cockatiel | عروس هلندی | No explicit child; do not invent a self-leaf |
| lovebird | کوتوله برزیلی | fischer = فیشر; rosy-faced = رزیکولیس |

## Original Task 350 finding, resolved by Task 351

breeder-listing-eligibility.ts snapshots species.displayName/subspecies.displayName; parrot-sale-listing-approval.service.ts forwards them; SellerListingProductPublisherService stores those strings on Product. ProductsService filters product.species by exact IN values, while frontend species routes send the ASCII species slug. Thus publishing Persian display snapshots will not match the existing per-species category filter. The real PostgreSQL test proves this for all 14 species; it also proves keyed products match. This was the original Task 350 incompatibility; Task 351 resolves it for new breeder Products as detailed below.

Implemented Task 351 correction: only when creating a NEW BREEDER Product, resolve the already-authorized stable IDs in the same transaction and write the existing species/subspecies keys into the new Product. Keep the Listing display snapshots, immutable IDs, ordinary flow, public URLs/cards/badge and all historical Product/Listing records unchanged. The correction is included in this feature diff.

FindProductsDto currently has no independent subspecies filter. ProductsSection passes speciesFilter preferentially and otherwise selected child keys as species. Consequently a functional independent child filter cannot be certified by bootstrap alone. This pre-existing filter limitation needs an explicit separate contract/UI decision; no routes or filter semantics are changed here.

## Review-only normalization

For manual alias review only: NFC, trimmed/collapsed whitespace and Arabic Yeh/Kaf to Persian variants may identify candidates. ZWNJ, diacritics, spelling and similar names must never cause an automatic merge. Source values remain byte-preserved in the manifest. Keys are lower-case ASCII existing catalog keys, <=100 characters; child keys are parent-scoped. Labels are nonempty, <=100 Unicode characters. UUIDs are explicit lower-case v4 values and globally distinct across the two tables.

## Bootstrap mechanism

src/scripts/bird-taxonomy-bootstrap.ts is a developer-only SQL generator, excluded from the runtime build. It has no DB client and never executes SQL. CLI emits nothing until review.status is APPROVED. The manifest is now APPROVED by the owner. The approved-output gate validates the manifest before rendering; PROPOSED input remains rejected. SQL generation never connects to a database.

After approval, run locally from repository root: node -r ts-node/register src/scripts/bird-taxonomy-bootstrap.ts. Review the resulting SQL as a NEW forward-only migration artifact before any authorized deployment. Do not copy development source/scripts to Production and do not edit existing migrations.

SQL uses BEGIN/COMMIT, the existing migration:breeder-listing-foundation-v1 advisory key, bounded lock/statement timeouts, and deterministic species-then-subspecies table locking. It verifies schema columns, exact existing identity/key/parent/label matches and cross-level UUID collisions, then INSERTs only absent manifest rows. It never updates timestamps/labels on rerun, never deletes data, and never creates permissions, approvals or events. Mismatches roll back the whole transaction. Existing unrelated taxa remain untouched.

Prerequisites: the committed 20261020 taxonomy foundation with its constraints/triggers/defaults, and the existing onboarding dependencies. Use the authorized migration role with SELECT/INSERT on the two taxonomy tables and permission to take their locks; no new runtime grants or superuser requirement are introduced by the generated INSERT-only migration.

Task 353 explicitly qualifies EVERY staging table reference with pg_temp, including CREATE, INSERT and preflight reads. Compatible public sentinel tables remain unchanged on success, rerun and full rollback.

Targeted validation covers fixed identities, source/shape validation, no synthetic children, forbidden writes, rejected proposed input and exact approved CLI output, first run/rerun, concurrency, conflicting identity/key/parent/labels, late-failure rollback, no implicit grants/history changes and actual Product category filtering. Execution is restricted to the existing loopback disposable-PostgreSQL harness; main/Production databases are never used.

## Task 351 follow-up: new Product category compatibility

The Task 350 table and original audit evidence remain unchanged. The runtime
publication correction is now implemented for NEW breeder Products: approval
resolves the already-authorized stable species/subspecies IDs using its existing
transaction, retains Persian Listing snapshots, and passes immutable keys to
the existing Product publisher. Public Product schema, routes/cards/badge and
ordinary publication are unchanged. Existing frontend mapping renders those
keys using the original Persian catalog labels.

There is no bulk conversion of historical Products. On explicit breeder
re-review, an existing exact parent/child key pair may follow an authorized
taxon edit; an unmapped legacy display/free-text pair is retained verbatim,
including its original nullability. Stock preservation is unchanged. Lookup is
exact against stable taxonomy tables, not fuzzy aliases or Product labels.
No additional locks or caller-controlled authorization are introduced.

Independent public subspecies filtering remains outside the existing contract
and is NOT added or inferred. The four parents without children still cannot
create breeder listings without an explicitly authorized child. The manifest taxonomy records and identities remain unchanged and owner-approved;
only review metadata was finalized. Production execution still requires a separately
authorized deployment. No main/Production taxonomy seed has run.

New disposable-PostgreSQL coverage uses actual customer listing create/submit,
taxon request/approval, Admin publication, Product list/search/detail and ledger
services for all 59 explicit children. It also checks keyed re-review/taxon edits,
legacy taxonomy retention, ordinary compatibility and denial of invented children.

## Task 355 final contract

The historical filename bird-taxonomy-v1.proposed.json is retained to avoid changing consumers; review.status=APPROVED is authoritative. The four parents without explicit children remain childless. Exact reruns insert nothing and preserve timestamps; ID/key/parent/label conflicts fail closed transactionally. No permissions, breeder approvals, Product history or Listing history are created or rewritten by bootstrap. Generate SQL locally, review it as a new forward-only deployment artifact, and execute only under separate authorization after the committed foundation prerequisites. This task authorizes disposable PostgreSQL validation and Git publication only, not main-database or Production bootstrap.
