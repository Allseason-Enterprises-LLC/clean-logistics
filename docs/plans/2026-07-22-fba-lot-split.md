# FBA Lot-Split Shipments Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Split FBA transfer shipments into one ShipHero wholesale order + one Amazon inbound plan **per lot number**, FEFO-ordered, with each Amazon plan carrying that specific lot's true expiration date from ShipHero.

**Architecture:** A new shared lot-allocation module queries ShipHero `warehouse_products → locations → expiration_lot` to get per-lot available quantities, allocates the requested quantity across lots FEFO in full-case multiples, and both order-creation paths (CIN7 bridge + FBA auto-submit) fan out per lot. Nothing downstream changes: FEFO allocation, picking, packing, labels, attach-labels all already operate per-order/per-shipment.

**Tech Stack:** TypeScript (Vercel serverless), ShipHero GraphQL public API, Amazon SP-API fulfillment-inbound 2024-03-20, Supabase.

---

## Verified API facts (probed live 2026-07-22)

1. `Lot` type has **NO quantity field** (`id, name, sku, expires_at, is_active, locations, ...`).
2. Per-lot quantity comes from `warehouse_products(sku){ data { edges { node {
   on_hand, locations(first:100){ edges { node { quantity, location { name pickable },
   expiration_lot { name expires_at is_active } } } } } } } }` — verified working query.
3. Live example, `CN-DRP-BLOODSUGAR-2OZ` (on_hand=98075):
   - CN41132603 exp 2028-04-30: 291
   - CN51472606 exp 2028-05-31: 29,474
   - CN51312607 exp 2028-05-31: 2,160
   - CN51282604 exp 2028-05-31: 0  ← active lots can have 0 units; must filter
   - CN61532604 exp 2028-06-30: 29,430
   - CN61522602 exp 2028-06-30: 38,880
4. Some ItemLocation rows have `expiration_lot: null` (untracked stock) — exclude from lot math.

## Design decisions (do not re-litigate during implementation)

- **Case-multiple allocation:** Amazon FBA shipments here are case-packed (`casePack`, `cases` in
  `createFbaInboundShipment`). Each lot's allocation MUST be a multiple of `casePack.caseQuantity`.
  Allocate `floor(lotAvailable / caseQty) * caseQty` max per lot, walking FEFO until the requested
  quantity is covered. If the tail lot can't fill remaining cases, keep walking to the next lot.
- **105-day gate:** skip lots with `expires_at < today + 105 days` (Amazon FBA_INB_0181). Log skipped lots.
- **Kits (v1 scope-out):** kit SKUs keep the CURRENT single-shipment behavior (earliest component
  expiry). Splitting kits by component lot permutations is out of scope. Log
  `[lot-split] kit SKU — using legacy single-shipment path`.
- **Order naming:** child ShipHero orders are `CIN7-TR-00XXX-<LOTNAME>` where LOTNAME is the raw lot
  name sanitized to `[A-Za-z0-9_-]` (lot names like `CN61522602` are already clean).
  `partner_order_id` = `cin7-transfer:<id>:<LOTNAME>`.
- **Sequential FEFO allocation:** create + auto-allocate child orders in FEFO order (earliest lot
  first), one at a time, so ShipHero's own FEFO allocator consumes lot N before order N+1 is
  allocated. This is what steers each order onto its intended lot.
- **Bridge-table idempotency:** `cin7_transfer_shiphero_orders` keeps ONE row per transfer
  (existing `onConflict: cin7_transfer_id,cin7_destination`). Child order ids/numbers are stored in
  `response_payload.child_orders`. The existing "already synced" short-circuit continues to work.
- **fba_shipments dedup:** add `cin7_lot` column; partial unique index becomes
  `(cin7_transfer_number, cin7_sku, cin7_lot)`. NULL lot = legacy rows; treated as distinct by
  Postgres, which is fine because new code always writes a lot.
- **Expiration correctness (the point of all this):** each Amazon plan's `expiration` = that lot's
  `expires_at` from ShipHero, date-only `YYYY-MM-DD`. Never the min across lots.

---

### Task 1: Supabase migration — `cin7_lot` on `fba_shipments`

**Objective:** Add lot column and lot-aware dedup index.

**Files:**
- Create: `migrations/2026-07-22-fba-lot-split.sql`

**Step 1: Write migration**

```sql
ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS cin7_lot text;
ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS lot_expiration date;

-- Replace the existing partial unique dedup index with a lot-aware one.
DROP INDEX IF EXISTS fba_shipments_transfer_sku_active_uniq;
CREATE UNIQUE INDEX fba_shipments_transfer_sku_lot_active_uniq
  ON fba_shipments (cin7_transfer_number, cin7_sku, cin7_lot)
  WHERE status NOT IN ('cancelled', 'failed', 'voided');
```

> NOTE: confirm the current index name first:
> `select indexname, indexdef from pg_indexes where tablename='fba_shipments';`
> via Supabase SQL editor or REST. Adjust `DROP INDEX` to the real name.
> Also note: the old index was `(cin7_transfer_number, cin7_sku)`; two NULL-lot rows for the same
> transfer+sku would now both be allowed. Acceptable — new code always sets `cin7_lot`.

**Step 2: Apply via Supabase SQL editor (manual step — flag to Weston before running).**

**Step 3: Verify**

```
select indexname from pg_indexes where tablename='fba_shipments';
-- expect fba_shipments_transfer_sku_lot_active_uniq present, old one gone
```

**Step 4: Commit migration file**

```bash
git add migrations/2026-07-22-fba-lot-split.sql
git commit -m "feat(fba): migration for lot-split dedup index + cin7_lot column"
```

---

### Task 2: Pure FEFO allocator — `allocateFefoByLot()`

**Objective:** Pure function that splits a requested quantity across lots FEFO in case multiples.

**Files:**
- Create: `lib/lot-allocation.ts`
- Test: `lib/lot-allocation.test.ts`

**Step 1: Write failing tests** (`node:test`, pure function, no network)

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { allocateFefoByLot } from './lot-allocation';

const lots = [
  { name: 'L-JUN', expiresAt: '2028-06-30', availableQty: 500 },
  { name: 'L-APR', expiresAt: '2028-04-30', availableQty: 90 },
  { name: 'L-MAY', expiresAt: '2028-05-31', availableQty: 200 },
];

test('splits FEFO across lots in case multiples', () => {
  // caseQty 30; request 240 => 90 from APR (3 cases), 150 from MAY (5 cases)
  const out = allocateFefoByLot(lots, 240, 30, '2026-07-22');
  assert.deepStrictEqual(out, [
    { name: 'L-APR', expiresAt: '2028-04-30', qty: 90, cases: 3 },
    { name: 'L-MAY', expiresAt: '2028-05-31', qty: 150, cases: 5 },
  ]);
});

test('single lot covers everything => one allocation', () => {
  const out = allocateFefoByLot(lots, 60, 30, '2026-07-22');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'L-APR');
});

test('skips zero-qty and sub-case-remainder lots', () => {
  // APR has 90 => 3 full cases of 40? floor(90/40)=2 cases=80. Remaining 10 unusable from APR.
  const out = allocateFefoByLot(lots, 160, 40, '2026-07-22');
  assert.deepStrictEqual(out.map(o => [o.name, o.qty]), [['L-APR', 80], ['L-MAY', 80]]);
});

test('skips lots expiring within 105 days', () => {
  const nearExp = [{ name: 'SOON', expiresAt: '2026-09-01', availableQty: 999 }, ...lots];
  const out = allocateFefoByLot(nearExp, 90, 30, '2026-07-22');
  assert.strictEqual(out[0].name, 'L-APR'); // SOON skipped (< 105 days out)
});

test('throws when insufficient stock across eligible lots', () => {
  assert.throws(() => allocateFefoByLot(lots, 999999, 30, '2026-07-22'), /insufficient/i);
});
```

**Step 2: Run to verify failure**

```bash
npx tsx --test lib/lot-allocation.test.ts   # expect: module not found / all fail
```
(If `tsx` unavailable: `npm i -D tsx`.)

**Step 3: Implement `lib/lot-allocation.ts`**

```ts
export interface LotAvailability {
  name: string;
  expiresAt: string;      // ISO date or datetime from ShipHero
  availableQty: number;
}

export interface LotAllocation {
  name: string;
  expiresAt: string;      // normalized YYYY-MM-DD
  qty: number;            // always a multiple of caseQty
  cases: number;
}

const FBA_MIN_DAYS = 105;

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * Split requestedQty across lots FEFO, in full-case multiples.
 * - Filters lots with qty <= 0 or expiring < 105 days from `today`.
 * - Sorts by expires_at asc, then name (stable tiebreak).
 * - Throws if eligible case-multiple capacity < requestedQty.
 */
export function allocateFefoByLot(
  lots: LotAvailability[],
  requestedQty: number,
  caseQty: number,
  today: string = new Date().toISOString().slice(0, 10),
): LotAllocation[] {
  if (caseQty <= 0) throw new Error('caseQty must be positive');
  if (requestedQty <= 0) throw new Error('requestedQty must be positive');

  const eligible = lots
    .filter((l) => l.availableQty > 0 && l.expiresAt)
    .filter((l) => daysBetween(today, toDateOnly(l.expiresAt)) >= FBA_MIN_DAYS)
    .sort((a, b) =>
      toDateOnly(a.expiresAt).localeCompare(toDateOnly(b.expiresAt)) ||
      a.name.localeCompare(b.name));

  const allocations: LotAllocation[] = [];
  let remaining = requestedQty;

  for (const lot of eligible) {
    if (remaining <= 0) break;
    const lotCases = Math.floor(lot.availableQty / caseQty);
    if (lotCases === 0) continue;
    const wantCases = Math.ceil(remaining / caseQty);
    const cases = Math.min(lotCases, wantCases);
    const qty = cases * caseQty;
    allocations.push({ name: lot.name, expiresAt: toDateOnly(lot.expiresAt), qty, cases });
    remaining -= qty;
  }

  if (remaining > 0) {
    throw new Error(
      `Insufficient lot-tracked stock: requested ${requestedQty}, ` +
      `short ${remaining} (case size ${caseQty}). Eligible lots: ` +
      eligible.map((l) => `${l.name}=${l.availableQty}`).join(', '));
  }
  return allocations;
}
```

**Step 4: Run tests — expect all pass**

```bash
npx tsx --test lib/lot-allocation.test.ts
```

**Step 5: Commit**

```bash
git add lib/lot-allocation.ts lib/lot-allocation.test.ts package.json package-lock.json
git commit -m "feat(fba): pure FEFO lot allocator with case-multiple + 105-day rules"
```

---

### Task 3: ShipHero per-lot availability — `getLotBreakdown()`

**Objective:** Fetch per-lot available quantities for a SKU from ShipHero.

**Files:**
- Modify: `lib/shiphero-product-data.ts` (append; do not touch existing exports)

**Step 1: Add function**

```ts
import type { LotAvailability } from './lot-allocation';

/**
 * Per-lot availability for a SKU, aggregated across warehouse locations.
 * Uses warehouse_products → locations → expiration_lot (Lot has no qty field).
 * Locations with expiration_lot: null (untracked stock) are excluded.
 * Inactive lots are excluded.
 */
export async function getLotBreakdown(
  shipheroToken: string,
  sku: string,
): Promise<LotAvailability[]> {
  const query = `{
    warehouse_products(sku: "${sku}") {
      data(first: 5) {
        edges {
          node {
            sku
            locations(first: 200) {
              edges {
                node {
                  quantity
                  expiration_lot { name expires_at is_active }
                }
              }
            }
          }
        }
      }
    }
  }`;

  const resp = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shipheroToken}` },
    body: JSON.stringify({ query }),
  });
  const json: any = await resp.json();
  if (json.errors) throw new Error(`ShipHero lot breakdown error for ${sku}: ${JSON.stringify(json.errors)}`);

  const byLot = new Map<string, LotAvailability>();
  for (const we of json.data?.warehouse_products?.data?.edges || []) {
    for (const le of we.node?.locations?.edges || []) {
      const n = le.node;
      const lot = n?.expiration_lot;
      if (!lot?.name || !lot.is_active || !lot.expires_at) continue;
      const cur = byLot.get(lot.name);
      if (cur) cur.availableQty += n.quantity || 0;
      else byLot.set(lot.name, { name: lot.name, expiresAt: lot.expires_at, availableQty: n.quantity || 0 });
    }
  }
  return [...byLot.values()];
}
```

**Step 2: Verify live** (script, not committed):

```bash
npx tsx -e "import('./lib/shiphero-product-data.js')" # or a scratch script scripts/_probe-lots.ts
# calling getLotBreakdown(token, 'CN-DRP-BLOODSUGAR-2OZ')
# Expected: 6 lots incl. CN41132603=291, CN51282604=0 excluded? NO — qty 0 rows survive here;
# allocator filters qty<=0. Both behaviors acceptable; assert CN61522602 ≈ 38880.
```

**Step 3: Commit**

```bash
git add lib/shiphero-product-data.ts
git commit -m "feat(fba): getLotBreakdown — per-lot availability from ShipHero locations"
```

---

### Task 4: Fan out CIN7 bridge wholesale orders per lot

**Objective:** `createWholesaleOrderViaGraphQL` creates N child wholesale orders (one per lot), FEFO-sequenced, instead of one.

**Files:**
- Modify: `lib/shiphero-orders.ts:184-303` (`createWholesaleOrderViaGraphQL`)

**Implementation notes (follow exactly):**

1. Extract the existing single-order create+allocate body into a private helper
   `createOneWholesaleOrder(credentials, input, { orderNumber, partnerOrderId, packingNote, lineItems })`
   that returns `{ orderId, orderNumber }`. The GraphQL mutations are IDENTICAL to today
   (including `sort_lots: 'EXPIRATION_FEFO'`, `location_type: 'NON_PICKABLE'`, tags, address).
2. New flow in `createWholesaleOrderViaGraphQL`:
   a. Get a ShipHero token — already have `credentials.accessToken`.
   b. For each line item, call `getShipHeroProductData(credentials.accessToken, item.sku)` to get
      `casePack` and kit status, and `getLotBreakdown(...)` for lots.
   c. **Kit or missing casePack or zero lot-tracked stock → legacy path**: create ONE order exactly
      as today and return. (Do not throw; do not change behavior for these SKUs.)
   d. Non-kit with lots: `allocateFefoByLot(lots, item.quantity, casePack.caseQuantity)`.
      - If it throws (insufficient), log `[lot-split]` warning and FALL BACK to legacy single
        order (stock math shouldn't block the bridge; auto-submit does its own gate).
   e. If allocation yields exactly 1 lot → still create the child order WITH the lot suffix
      (consistent naming; packing note carries the lot).
   f. Create child orders SEQUENTIALLY in FEFO order:
      - `order_number`: `${input.orderNumber}-${sanitize(lot.name)}`
      - `partner_order_id`: `${input.externalOrderId}:${sanitize(lot.name)}`
      - `packing_note`: `Lot ${lot.name} · Exp ${lot.expiresAt} · ${lot.qty} units (${lot.cases} cases) · SINGLE LOT — DO NOT MIX`
      - line item quantity = `lot.qty`
      - Auto-allocate (FEFO) immediately after each create, BEFORE creating the next child.
   g. Multi-SKU transfers: run steps b–f per SKU; a child order per (sku, lot). (Today's FBA
      transfers are single-SKU; keep the loop general but simple.)
3. Return shape: keep `{ shipheroOrderId, shipheroOrderNumber, responsePayload }` where
   `shipheroOrderId`/`Number` = FIRST child (earliest lot) and
   `responsePayload.child_orders = [{ orderId, orderNumber, sku, lot, expiresAt, qty, cases }]`.
   The bridge upsert in `createShipHeroOrderFromCIN7Transfer` persists this automatically via
   `response_payload` — verify it does; if it only stores the GraphQL json, extend it.
4. `sanitize(name)`: `name.replace(/[^A-Za-z0-9_-]/g, '')`.

**Verification:**

```bash
npx tsc --noEmit
```
Then a scratch script that calls `createShipHeroOrderFromCIN7Transfer` against a FAKE transfer
number (e.g. `CIN7-TR-TEST-LOTSPLIT`) with 60 units of a 2-lot SKU, confirms 1–2 child orders in
ShipHero UI, then CANCELS them (`order_update fulfillment_status:"canceled"`). Delete scratch after.

**Commit:** `feat(shiphero): fan out FBA wholesale orders per lot (FEFO, case multiples)`

---

### Task 5: Fan out Amazon plans per lot in `auto-submit.ts`

**Objective:** One Amazon inbound plan per lot, each with that lot's true expiration.

**Files:**
- Modify: `api/fba/auto-submit.ts` (the per-item loop, ~lines 120–540)

**Implementation notes:**

1. After step 2 ("Pull product data from ShipHero"), add:
   ```ts
   const lots = productData.casePack && !productData.isKit
     ? await getLotBreakdown(shipheroToken, item.sku) : [];
   let lotPlan: LotAllocation[];
   try {
     lotPlan = lots.length
       ? allocateFefoByLot(lots, item.quantity, productData.casePack.caseQuantity)
       : [{ name: productData.lotNumber ?? 'UNKNOWN', expiresAt: productData.expirationDate!, qty: item.quantity, cases: Math.ceil(item.quantity / productData.casePack.caseQuantity) }];
   } catch (e) { /* insufficient lot stock → fail the SKU with clear error, like existing failures */ }
   ```
   (`getShipHeroProductData` must also return `isKit: boolean` — add it in Task 3 or here; it
   already computes `isKit` internally at line 187.)
2. Wrap everything from "reservation insert" through "post-process" in `for (const lot of lotPlan)`:
   - Reservation row: include `cin7_lot: lot.name`, `lot_expiration: lot.expiresAt`, and name
     `CIN7-${cin7_transfer_number}-${item.sku}-${lot.name}`.
   - The unique-violation dedup check (`23505` handler) now naturally keys on (transfer, sku, lot).
   - `createFbaInboundShipment` items: `quantity: lot.qty`, `cases: lot.cases`,
     `casePack: unitsPerBox`, `expiration: lot.expiresAt`  ← **THE core correctness change.**
   - PartneredUnavailable retry loop stays per-lot (unchanged logic, just nested).
   - `postProcessFbaShipment` input: pass `lot: lot.name`, `expiration: lot.expiresAt`,
     `quantity: { totalUnits: lot.qty, boxes: lot.cases, unitsPerBox }`, and a NEW field
     `shipheroOrderNumberOverride: \`${cin7_transfer_number}-${sanitize(lot.name)}\`` (see Task 6).
   - `results.push` one entry per lot: `{ sku, lot: lot.name, expiration: lot.expiresAt, status, ... }`.
3. Do NOT parallelize lots — sequential, matching Amazon rate limits and existing retry structure.

**Verification:** `npx tsc --noEmit`; deploy preview; POST auto-submit for a REAL small transfer
(see Task 8) and confirm: N plans, each plan's items show the lot's own expiration in Seller
Central; `fba_shipments` has N rows with distinct `cin7_lot`.

**Commit:** `feat(fba): one Amazon inbound plan per lot with lot-true expiration dates`

---

### Task 6: Lot-aware ShipHero order lookup in post-process

**Objective:** Labels/notes attach to the correct per-lot ShipHero child order.

**Files:**
- Modify: `lib/fba-post-process.ts` (~line 267 `orders(order_number: ...)` lookup + `PostProcessInput`)

**Implementation notes:**

1. Add optional `shipheroOrderNumberOverride?: string` to `PostProcessInput`.
2. Lookup order: try `orders(order_number: override)` first when provided; fall back to the
   current `orders(order_number: cin7TransferNumber)` (covers legacy single orders + kits).
3. Packing note / Telegram text already receive `lot` + `expiration` — confirm they render the
   per-lot values (they take them from input; no change expected beyond passing correct values).
4. Supabase label folder naming (line ~399) keys off `cin7TransferNumber` — append lot:
   `${transferNumber}/${lot}/${filename}` when lot present, so per-lot label PDFs don't collide.

**Verification:** covered by Task 8 end-to-end run (labels attached to child order, correct note).

**Commit:** `feat(fba): route labels/notes to per-lot ShipHero child orders`

---

### Task 7: `full-pipeline.ts` manual fallback parity

**Objective:** The manual-create fallback (line ~200) produces the same per-lot fan-out.

**Files:**
- Modify: `api/fba/full-pipeline.ts:196-226`

**Implementation notes:** Replace the direct `createWholesaleOrder(...)` call with the SAME
shared fan-out used in Task 4. Simplest: export a `createLotSplitWholesaleOrders(input)` helper
from `lib/shiphero-orders.ts` and call it from both places. If refactoring `full-pipeline`'s
Step 3+ (single fbaResult) to multi-plan is too invasive, ACCEPTABLE v1: full-pipeline keeps
single-plan behavior for its own Amazon submission (it's a manual/rare path) but creates lot-split
ShipHero orders. Note this in code comment. The primary automated path is bridge→auto-submit.

**Verification:** `npx tsc --noEmit`.

**Commit:** `feat(fba): lot-split wholesale orders in full-pipeline manual fallback`

---

### Task 8: End-to-end staging test on ONE real transfer

**Objective:** Prove correctness on a 2+ lot SKU before merge.

**Steps:**

1. Pick SKU `CN-DRP-BLOODSUGAR-2OZ` (6 lots, 3 distinct expiries — verified above). Choose a
   quantity that MUST span two lots at their case size, but small (e.g. spans CN41132603's
   remaining 291 into CN51472606).
   ⚠️ Confirm case size first from ShipHero product_note; pick qty = (lot1_full_cases + 1 case).
2. Create a real CIN7 transfer TR-TEST (or coordinate with Weston to use the next scheduled one).
3. Watch the sync: expect 2 ShipHero wholesale orders `CIN7-TR-XXXXX-CN41132603` and
   `CIN7-TR-XXXXX-CN51472606`, each single-lot, FEFO-allocated.
4. Expect 2 Amazon plans; verify in Seller Central that plan 1 expiration = 2028-04-30 and
   plan 2 = 2028-05-31 **exactly matching ShipHero lot expiries**.
5. Verify `fba_shipments` rows carry `cin7_lot` + `lot_expiration`; verify Telegram notification
   fired per plan with lot in the message; verify label PDFs attached to the matching child order.
6. Re-POST the same auto-submit payload → expect ALL lots skipped via dedup (unique index works).
7. If anything is off: fix before merge. If lot steering in step 3 fails (both orders grab the
   same lot), escalate — mitigation is explicit lot pinning via ShipHero manual allocation API,
   a separate task.

---

### Task 9: PR + rollout

1. Branch off `main`: `feat/fba-lot-split` (NOT the current `fix/fba-cancel-stale-draft`).
2. PR with this plan linked; deploy to production only after Task 8 passes.
3. Update memory/skill notes: `clean-nutra-inventory-pipeline` skill gets a lot-split section
   (order naming convention, dedup index name, kit scope-out).

---

## Risks & mitigations

- **ShipHero FEFO steering across sibling orders (biggest risk):** sequential allocate should make
  order N consume lot N, but if ShipHero's allocator doesn't reserve inventory between calls, both
  children could allocate lot 1. Task 8 step 3 verifies; packing note ("SINGLE LOT — DO NOT MIX")
  is the human backstop for pickers regardless.
- **Case remainders:** allocator only ships full cases; partial-case units strand in a lot until
  a later transfer. This matches Amazon case-pack rules — expected, not a bug.
- **Legacy in-flight transfers:** rows with `cin7_lot IS NULL` predate the split; reconcilers and
  dashboards must not assume lot present.
- **Kits:** unchanged in v1 (single shipment, earliest component expiry) — explicitly logged.
- **More plans = more placement fees:** N lots → N Amazon plans, each with its own placement-fee
  roll. Business accepts this as the cost of lot separation (confirmed by Weston 2026-07-22).
