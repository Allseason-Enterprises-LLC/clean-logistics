# Kit/Bundle Work-Order Gate — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** For FBA-bound CIN7 transfers whose lines are multi-pack kits/bundles, create a ShipHero **Work Order** first and hold the Amazon shipment until the warehouse marks it **COMPLETED** — so assembly problems surface *before* Amazon has an inbound plan we can't cancel.

**Architecture:** A new bridge-row state `awaiting_work_order` sits between "ShipHero order created" and "FBA handoff fired". `sync-cin7` detects kit lines, calls `work_order_create` (type `ASSEMBLY`) and parks the row. A new lightweight cron polls `work_order(id)` and, on `COMPLETED`, flips the row to `synced` — at which point the **existing** reconciler fires the FBA handoff through the **existing** duplicate gate. Nothing about shipment creation itself changes.

**Tech Stack:** TypeScript (strict, commonjs), ShipHero GraphQL (`work_order_create` / `work_order_complete` / `work_order`), Supabase REST, Vercel cron.

---

## Why this shape (thoughts before tasks)

**1. Gate the state, don't fork the pipeline.** The reconciler only fires rows at `status='synced'` (`lib/fba-reconciler.ts:234`). If a kit row is parked at `awaiting_work_order`, **every existing safety mechanism** — the `fbaRecordExists` dedup guard, `findLivePlanOnCancelledRows` last-moment gate, `skipped[]` ledger, credit-error fast retry — applies unchanged the moment we flip it to `synced`. We add one state and one poller; we do **not** write a second shipment path. That is the whole reason this is safe to build.

**2. Detection must be stock-truth, not string-truth.** SKU prefix (`CN-BDL-`, `CN-KIT-`) is a fine *fast path*, but the authoritative signal is ShipHero's `product.kit === true` — which `lib/shiphero-product-data.ts:190` already reads. Use **both**: prefix OR kit flag → gate. A kit mis-named without the prefix still gets gated; a plain SKU accidentally prefixed does not break (WO for a non-kit just completes trivially). Fail toward gating.

**3. The WO is the *only* thing that makes the components physically exist as the kit.** Today `lib/lot-allocation.ts` fails safe at fire time when bulk stock is short — for a kit that hasn't been built, it will *correctly* refuse. So the current failure mode isn't a duplicate, it's a **stall with an unhelpful error**. The WO gate converts that stall into an explicit, visible, warehouse-actionable step.

**4. The one hard constraint you named — "if there's a shipment error we can't cancel with the warehouse."** Ordering solves it: WO → (warehouse builds, days) → COMPLETED → *then* Amazon plan. If assembly fails, we never created an Amazon plan, so there's nothing to cancel. If the *Amazon* step later fails, the kits are already built and sitting in bulk — a re-fire is safe because the goods exist. The gate makes the irreversible step (Amazon) come **after** the fallible one (assembly).

**5. Poll, don't webhook.** ShipHero allows one webhook per event per account and we've hit that wall before (`SKILL.md` §webhooks). A `*/30` cron querying `work_orders(status:"COMPLETED", updated_at_from: <24h>)` is one cheap call and needs no new webhook. Revisit if latency matters.

**6a. ⚠️ Auto-complete at 48 h is the ONE duplicate-risk edge in this design — guard it.**
Marking a WO COMPLETED ourselves *releases the row and fires a real Amazon shipment*.
If the warehouse never actually built the kits, we would create an inbound plan
against goods that don't exist — a plan we then cannot cancel with the warehouse
(the exact thing this feature exists to prevent). So auto-complete must be
**stock-gated, never blind**:

```
at 48 h, WO still not COMPLETED:
  read kit SKU stock in NON-PICKABLE bulk (item_locations, the same query proven
  live on TR-00474 — DTC pick bins excluded, active lots only)
  ├─ bulk ≥ transfer qty  → the goods exist; they forgot the button.
  │                          work_order_complete(message: "auto-completed: N units
  │                          verified in bulk") → release → Telegram "we completed
  │                          WO X for you, labels incoming"
  └─ bulk <  transfer qty  → NOT built. Do NOT complete. Telegram escalation:
                             "WO X is 48 h old and only M of N kits are in bulk —
                             please build/move them and mark COMPLETED." Re-check
                             each tick; escalate again at 72 h / 96 h.
```
This turns "complete them after 48 h" into "complete them after 48 h **when the
kits are provably there**", which is what Weston actually wants — the point is to
unstick forgotten buttons, not to ship phantom inventory. The stock read costs
one ShipHero query per stuck row per tick; rows stuck at 48 h are rare.

**6. `lot_id` on the WO output.** `AssemblySKUType.lot_id` lets the warehouse assign the built kits to a lot. **We should set it** so FBA's FEFO/lot allocation later picks up the kit — otherwise built kits land lot-less and `lot-allocation.ts` reports `Eligible lots: none` (the TR-00408 failure class). Resolve the lot from the *component* with the earliest expiry (`shiphero-product-data.ts` already computes this).

---

## Current context / assumptions (verified 2026-09-22)

- ShipHero exposes `work_order_create(data: CreateWorkOrderInput)`, `work_order_complete`, `work_order(id: Int)`, `work_orders(status, updated_at_from, …)`. Introspected live.
- `CreateWorkOrderInput` required: `warehouse_id`, `requested_date`, `type: ASSEMBLY|CUSTOM`. Optional: `assembly_sku {sku, quantity, lot_id, receiving_location_id, staging_location_id}`, `priority`, `instructions`, `name`, `customer_account_id`.
- `WorkOrderStatus` = `PENDING_APPROVAL | IN_PROGRESS | READY_TO_PICK | ASSEMBLY_IN_PROGRESS | COMPLETED | CANCELED | CLOSED`.
- Fire gate today: `lib/cin7-transfer-sync.ts:750` — `if (result.created && isFbaDestination(...)) pendingFbaHandoffs.push(...)`.
- Reconciler eligibility: `lib/fba-reconciler.ts:234` `.eq('status','synced')`.
- Kit flag: `lib/shiphero-product-data.ts:190` `const isKit = product.kit === true || product.kit === 'true'`.
- Bundle SKU convention: `CN-BDL-<FORM>-<NAME>-<CT>-<N>PK` (from `lib/cc-sku-mapping.ts`). Kit convention `CN-KIT-…` (older; check `sku_master`).
- Bridge table `cin7_transfer_shiphero_orders` has no WO columns yet.
- Warehouse `22e17170-af72-4bf8-b77c-d73c86b06765`; customer account `95145`.

**Decisions from Weston (2026-09-22):**
1. `requested_date` = **today**; `priority` = **HIGH**; delivery expected within **1 business day**.
2. **One WO per transfer order.** Weston creates one TO per SKU, so this is also one WO per kit SKU in practice — but key the WO to the *transfer*, not the line.
3. Release signal = WO flips to **COMPLETED** in ShipHero. Nothing else is required. BUT we must **watch** WOs: nudge the warehouse to flip COMPLETED, and **auto-complete after 48 h** in case they built the kits and forgot to flip it.
4. `PENDING_APPROVAL` may exist on their side; we don't care — we create the WO, they complete it.

---

## State machine

```
CIN7 transfer (FBA dest, kit lines)
  └─ sync-cin7: create ShipHero wholesale order   (unchanged)
       └─ NEW: isKitTransfer? ──no──▶ status='synced' ──▶ reconciler fires FBA (unchanged)
                 │yes
                 ▼
            work_order_create (ASSEMBLY, per kit line)
            status='awaiting_work_order', work_order_id/ids saved
                 │
    NEW cron poll-work-orders (*/30)
                 ├─ COMPLETED ──▶ status='synced' ──▶ reconciler fires FBA (unchanged, all gates apply)
                 ├─ CANCELED/CLOSED ──▶ status='work_order_failed', Telegram alert, needs human
                 └─ >N days pending ──▶ Telegram nudge (still awaiting)
```

Rows at `awaiting_work_order` are **invisible to the reconciler** by construction (it filters `synced`). No code change there is needed for safety — only for the ledger (Task 7).

---

## Files likely to change

| file | change |
|---|---|
| `lib/shiphero-work-orders.ts` | **new** — `createAssemblyWorkOrder()`, `getWorkOrder()`, `listCompletedWorkOrdersSince()` |
| `lib/kit-detection.ts` | **new** — `isKitSku()` (prefix) + `isKitTransfer()` (prefix OR ShipHero kit flag) |
| `lib/cin7-transfer-sync.ts:750` | branch: kit → WO + park; non-kit → existing push |
| `api/cron/poll-work-orders.ts` | **new** cron endpoint |
| `vercel.json` | register `*/30 * * * *` |
| `lib/fba-reconciler.ts` | add `awaiting_work_order` to `skipped[]` ledger as its own reason (observability only) |
| `supabase/migrations/<ts>_work_order_gate.sql` | 4 columns on the bridge table |
| `scripts/_test-kit-detection.ts`, `scripts/_test-work-order-gate.ts` | new suites |
| `references/` in the skill | runbook + floor-facing notice |

---

## Step-by-step plan

### Task 1: Migration — bridge columns

**Files:** Create `supabase/migrations/20260922_work_order_gate.sql`

```sql
ALTER TABLE cin7_transfer_shiphero_orders
  ADD COLUMN IF NOT EXISTS work_order_ids        text[]      NULL,
  ADD COLUMN IF NOT EXISTS work_order_status     text        NULL,
  ADD COLUMN IF NOT EXISTS work_order_created_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS work_order_completed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS work_order_auto_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_order_last_nudge_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS kit_sku text NULL,
  ADD COLUMN IF NOT EXISTS kit_qty integer NULL;
-- status enum is free text today; 'awaiting_work_order' and 'work_order_failed' are new values.
CREATE INDEX IF NOT EXISTS idx_bridge_awaiting_wo
  ON cin7_transfer_shiphero_orders (status) WHERE status = 'awaiting_work_order';
```

Apply via the Supabase Management API (curl recipe in SKILL.md §`exec_sql`). Verify: `select column_name from information_schema.columns where table_name='cin7_transfer_shiphero_orders' and column_name like 'work_order%'` → 4 rows.

### Task 2: `lib/kit-detection.ts` (TDD)

**Step 1 — failing test** `scripts/_test-kit-detection.ts`:
```ts
ok('BDL prefix is a kit', isKitSku('CN-BDL-CAP-GINSENG-60CT-3PK'));
ok('KIT prefix is a kit', isKitSku('CN-KIT-IMMUNE-BUNDLE'));
ok('plain SKU is not', !isKitSku('CN-CAP-VBIOTIC-90CT'));
ok('multipack suffix alone does NOT gate (needs prefix or flag)', !isKitSku('CN-CAP-X-60CT-3PK'));
ok('case-insensitive', isKitSku('cn-bdl-x'));
```
**Step 2 — implement:**
```ts
const KIT_PREFIX = /^CN-(BDL|KIT)-/i;
export function isKitSku(sku: string): boolean { return KIT_PREFIX.test(sku || ''); }

/** prefix OR ShipHero `kit:true`. Fails toward gating. */
export async function isKitTransfer(
  lines: { sku: string }[],
  lookupKitFlag: (sku: string) => Promise<boolean>
): Promise<{ isKit: boolean; kitSkus: string[] }> {
  const kitSkus: string[] = [];
  for (const l of lines) {
    if (isKitSku(l.sku) || (await lookupKitFlag(l.sku))) kitSkus.push(l.sku);
  }
  return { isKit: kitSkus.length > 0, kitSkus };
}
```
`lookupKitFlag` reuses the product query in `shiphero-product-data.ts` (extract a tiny `getProductKitFlag(sku)` there rather than duplicating the GraphQL).

**Step 3** — run, all pass. **Commit** `feat(kits): kit/bundle detection (prefix OR ShipHero kit flag)`.

### Task 3: `lib/shiphero-work-orders.ts` (TDD against a mocked fetch)

```ts
export async function createAssemblyWorkOrder(token: string, input: {
  warehouseId: string; customerAccountId: string;
  sku: string; quantity: number; lotId?: string | null;
  name: string; instructions: string; requestedDate: string; priority?: 'HIGH'|'MEDIUM'|'LOW';
}): Promise<{ id: string; legacyId: number; status: string }> {
  const mutation = `mutation($data: CreateWorkOrderInput!) {
    work_order_create(data: $data) { request_id work_order { id legacy_id status } } }`;
  const data = {
    warehouse_id: input.warehouseId, customer_account_id: input.customerAccountId,
    requested_date: input.requestedDate, type: 'ASSEMBLY', priority: input.priority ?? 'MEDIUM',
    name: input.name, instructions: input.instructions,
    assembly_sku: { sku: input.sku, quantity: input.quantity, ...(input.lotId ? { lot_id: input.lotId } : {}) },
  };
  // …POST, throw on errors[], return work_order
}
export async function getWorkOrder(token: string, legacyId: number)  // work_order(id: Int) → status, completed_at
export async function listCompletedWorkOrdersSince(token: string, sinceIso: string) // work_orders(status:"COMPLETED", updated_at_from:…)
```
Tests assert: exact mutation variables shape (esp. `type:'ASSEMBLY'`, `assembly_sku.quantity`), `lot_id` omitted when null, GraphQL `errors[]` → throw. **Commit.**

**Live canary before Task 4:** one `work_order_create` for a real 3-pack against a tiny qty (e.g. 1), verify it appears in the ShipHero UI under Work Orders, then `work_order_complete` it. Record the `legacy_id` format we get back — the `work_order(id:Int)` query wants the **legacy** integer, not the base64 id.

### Task 4: Branch the fire gate in `cin7-transfer-sync.ts`

Replace lines ~750-758:
```ts
if (result.created && isFbaDestination(transfer.destinationName)) {
  const { isKit, kitSkus } = await isKitTransfer(transfer.lines, getProductKitFlag);
  if (isKit) {
    // GATE: build first, ship later. See lib/shiphero-work-orders.ts.
    const woIds: string[] = [];
    for (const line of transfer.lines.filter(l => kitSkus.includes(l.sku))) {
      const lotId = await resolveEarliestComponentLotId(line.sku); // from shiphero-product-data
      const wo = await createAssemblyWorkOrder(token, {
        warehouseId: SHIPHERO_WAREHOUSE_ID, customerAccountId: '95145',
        sku: line.sku, quantity: line.quantity, lotId,
        name: `${transfer.transferNumber} · build ${line.quantity} × ${line.sku}`,
        instructions: `CIN7 ${transfer.transferNumber} → Amazon FBA. Build ${line.quantity} kits of ${line.sku}. Do NOT ship — the FBA labels are generated automatically after you mark this work order COMPLETED.`,
        requestedDate: todayIso(),           // Weston: today, HIGH priority, 1 business day
        priority: 'HIGH',
      });
      woIds.push(String(wo.legacyId));
    }
    await supabase.from('cin7_transfer_shiphero_orders').update({
      status: 'awaiting_work_order', work_order_ids: woIds,
      work_order_status: 'PENDING_APPROVAL', work_order_created_at: new Date().toISOString(),
    }).eq('cin7_transfer_id', transfer.id).eq('cin7_destination', transfer.destinationName || '');
    workOrdersCreated++;
    continue;             // ← do NOT push to pendingFbaHandoffs
  }
  pendingFbaHandoffs.push({ … });   // unchanged for non-kits
}
```
**Test** `scripts/_test-work-order-gate.ts`: a kit transfer → row `awaiting_work_order`, `pendingFbaHandoffs` **empty**, one WO per kit line; a non-kit transfer → unchanged behaviour. **Regression:** the existing `_test-*` suites must stay green. **Commit.**

### Task 5: `api/cron/poll-work-orders.ts` + `vercel.json`

```ts
// every 30 min: for rows at awaiting_work_order, look up each WO
for (const row of awaitingRows) {
  const statuses = await Promise.all(row.work_order_ids.map(id => getWorkOrder(token, Number(id))));
  if (statuses.every(s => s.status === 'COMPLETED')) {
    await update(row, { status: 'synced', work_order_status: 'COMPLETED', work_order_completed_at: now });
    released.push(row.cin7_transfer_number);            // reconciler will fire it on its next tick
  } else if (statuses.some(s => ['CANCELED','CLOSED'].includes(s.status))) {
    await update(row, { status: 'work_order_failed', work_order_status: 'CANCELED' });
    await sendTelegram(`⚠️ ${row.cin7_transfer_number}: work order cancelled in ShipHero — FBA shipment NOT created. Needs a human.`);
  } else {
    const ageH = ageHours(row.work_order_created_at);
    if (ageH >= 48) {
      // STOCK-GATED auto-complete (see design note 6a). Never blind.
      const bulk = await getNonPickableBulkUnits(token, row.kit_sku);   // item_locations, active lots, pickable=false
      if (bulk >= row.kit_qty) {
        await completeWorkOrder(token, woId, `auto-completed by pipeline: ${bulk} units verified in non-pickable bulk after ${ageH}h`);
        await update(row, { status: 'synced', work_order_status: 'COMPLETED', work_order_completed_at: now, work_order_auto_completed: true });
        await sendTelegram(`✅ ${row.cin7_transfer_number}: work order ${woId} was still open after 48 h but all ${row.kit_qty} kits are in bulk, so we marked it COMPLETED for you. FBA labels will post within ~15 min.`);
        autoCompleted.push(row.cin7_transfer_number);
      } else if (!escalatedRecently(row)) {
        await sendTelegram(`🚨 ${row.cin7_transfer_number}: work order ${woId} is ${Math.floor(ageH)} h old and only ${bulk} of ${row.kit_qty} kits are in bulk. Please build/move the rest and mark it COMPLETED — the FBA shipment is waiting on this.`);
        escalated.push(row.cin7_transfer_number);
      }
    } else if (ageH >= 24 && !nudgedToday(row)) {
      await sendTelegram(`⏳ ${row.cin7_transfer_number}: work order ${woId} for ${row.kit_qty} × ${row.kit_sku} is due today. Once it's marked COMPLETED in ShipHero the FBA labels generate automatically.`);
    }
  }
}
return { scanned, released, autoCompleted, escalated, failed, stillWaiting };   // must balance: scanned == sum of the rest
```
`vercel.json`: `{ "path": "/api/cron/poll-work-orders", "schedule": "*/30 * * * *" }`.
**Verify live:** probe the endpoint after deploy; it must return `scanned` even at 0 rows.

### Task 6: Release → fire is the reconciler's job (no new code)

Flipping to `synced` makes the row eligible on the next `*/15` tick. `fbaRecordExists` + the last-moment Amazon gate run exactly as today. **Do not** call `fireFbaAutoSubmit` from the poller — keep one fire path.

### Task 7: Observability

- Reconciler: rows at `awaiting_work_order` are currently just "not synced". Add them to `skipped[]` as reason `awaiting_work_order` with detail `WO <ids> status <s>, created <n>d ago` so a "why isn't this firing?" question is answered in one call.
- Poller returns a balanced ledger (`scanned == released + failed + stillWaiting`) and the health check asserts it.

### Task 8: Floor-facing notice + skill

Post to the FBA channel (template in `references/telegram-fba-shipment-template.md` style, plain language): *"For multi-pack/bundle transfers you'll now get a Work Order in ShipHero first. Build it, mark it COMPLETED, and the FBA labels appear automatically — usually within 15 minutes. Don't ship anything from a Work Order."* Add `references/kit-work-order-gate.md` (runbook: stuck WO, cancelled WO, how to release by hand, how to verify the WO completed before questioning the shipment).

---

## Tests / validation

- `scripts/_test-kit-detection.ts` (5) · `scripts/_test-work-order-gate.ts` (≥6) · `scripts/_test-work-orders-client.ts` (≥5)
- All 10 existing suites green; `npx tsc --noEmit` clean
- **Canary sequence (one real kit, smallest qty):** sync creates WO → visible in ShipHero UI → row `awaiting_work_order` → reconciler ledger shows `awaiting_work_order` for it (not `throttled`) → mark COMPLETED in UI → poller releases it → reconciler fires → plan + labels → verify `units == kits × casepack` and attachments = destinations. Only then enable for all kits.
- Probe prod after each deploy for a field only the new commit has.

## Risks, tradeoffs, open questions

| risk | mitigation |
|---|---|
| Kit not detected (no prefix, `kit` flag false) → fires today's path, lot-allocation fails safe → stall with an unhelpful error | prefix OR flag; add `sku_master.is_kit` override later if needed |
| Warehouse completes WO but forgets to move kits to **non-pickable bulk** → FBA sees `Eligible lots: none` | WO `instructions` say where to put them; poller nudge text repeats it; `staging_location_id` can pin the bin |
| **Auto-complete fires against unbuilt kits** → Amazon plan with no goods, can't cancel with warehouse | **stock-gated**: only complete when non-pickable bulk ≥ qty; otherwise escalate, never complete. Tested with a mocked stock reader returning short → must NOT call `work_order_complete` |
| WO completed **partially** (built 8 of 10) | `work_order_complete` has no partial semantics — treat COMPLETED as full; FEFO/lot allocation at fire time is still the truth and will short-ship *loudly* once the shortfall assertion (open defect) ships. **Ship that assertion first or alongside.** |
| ShipHero credit cost of `work_order` polls | `work_orders(status:"COMPLETED", updated_at_from)` is one call per tick regardless of row count |
| Someone re-fires manually while `awaiting_work_order` | the reconciler filter blocks it; document that `awaiting_work_order` rows must **never** be hand-flipped to `synced` without checking the WO |
| `requested_date` semantics / approval step (`PENDING_APPROVAL`) — does someone have to approve WOs in the UI? | **confirm with the warehouse manager** before Task 4 |

**Resolved (see Decisions above).** Remaining open item: ship the **shortfall
assertion** alongside — it's what makes a partially-built kit fail loudly instead
of quietly short-shipping (the TR-00474 shape). Recommended, not blocking.

**Nudge cadence (final):** 24 h reminder · 48 h stock-gated auto-complete OR
escalation · re-escalate 72 h / 96 h · all posts to the FBA channel, plain language.
