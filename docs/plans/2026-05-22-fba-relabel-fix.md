# FBA Relabel Endpoint Fix — Implementation Plan

**Goal:** Fix `/api/fba/relabel` so it can regenerate correct label PDFs for the 5 already-shipped TOs (TR-00079, TR-00080, TR-00081, TR-00082, TR-00084) that received under-labeled PDFs from the original auto-submit run.

**Architecture:** The relabel endpoint currently calls `GET /inboundPlans/{planId}/shipments`, which Amazon returns 403 on (deprecated/restricted listing endpoint). Replace that with a call to `GET /inboundPlans/{planId}/placementOptions` — fetch the `ACCEPTED` placement, read its `shipmentIds[]` (internal sh... IDs), then call the existing `postProcessFbaShipment` flow which already iterates internal IDs correctly. The post-process pipeline already has the box-ID fix from commit `da2c95f`, so once it can resolve internal IDs it will produce correct labels.

**Tech Stack:** TypeScript, Vercel functions, Supabase, Amazon SP-API FBA Inbound 2024-03-20.

---

## Background

- 5 broken shipments are at status `labels_ready` in `fba_shipments` with valid `plan_id` and `amazon_shipment_ids` (FBA confirmation IDs).
- `amazon_internal_shipment_ids` is `null` for all 5 — we never persisted the `sh...` IDs.
- Existing `postProcessFbaShipment(input)` expects `input.fbaResult.shipmentIds = [internal sh... IDs]`.
- Amazon endpoint `GET /inbound/fba/2024-03-20/inboundPlans/{planId}/shipments` → **403 Unauthorized** (confirmed via Vercel logs 19:36 PDT).
- Amazon endpoint `GET /inbound/fba/2024-03-20/inboundPlans/{planId}/placementOptions` → **works** (used during the original auto-submit run; same auth, same token).

The plan is to swap the broken listing call for the working placement-options call, then re-run post-process.

---

## Task 1: Replace plan-shipments listing with placement-options lookup in `relabel.ts`

**Objective:** Resolve internal `sh...` IDs via `placementOptions` instead of the deprecated `/shipments` listing.

**Files:**
- Modify: `api/fba/relabel.ts:82-100` (the `shipmentsRes` block)

**Step 1: Replace the listing block**

Find this block in `api/fba/relabel.ts`:

```typescript
// 2) Resolve internal shipment IDs from Amazon (we may not have stored them)
const shipmentsRes = await callAmazonSpApi<any>({
  method: 'GET',
  path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments`,
});
const shipments = shipmentsRes.data?.shipments || [];
if (shipments.length === 0) {
  return res.status(500).json({ error: `Amazon returned 0 shipments for plan ${planId}` });
}
const internalShipmentIds: string[] = shipments
  .map((s: any) => s.shipmentId)
  .filter(Boolean);
const shipmentConfirmationIds: string[] = shipments
  .map((s: any) => s.shipmentConfirmationId)
  .filter(Boolean);
```

Replace with:

```typescript
// 2) Resolve internal shipment IDs via placementOptions (the /shipments listing
//    endpoint returns 403 with our current LWA scope — confirmed 2026-05-22).
//    The ACCEPTED placement option carries the same shipmentIds[] we got at
//    confirmPlacementOption time during auto-submit.
const placementRes = await callAmazonSpApi<any>({
  method: 'GET',
  path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/placementOptions`,
});
const placementOptions = placementRes.data?.placementOptions ?? [];
const accepted = placementOptions.find((p: any) => p.status === 'ACCEPTED');
if (!accepted) {
  return res.status(500).json({
    error: `No ACCEPTED placement option found for plan ${planId}`,
    placementOptionCount: placementOptions.length,
    statuses: placementOptions.map((p: any) => p.status),
  });
}
const internalShipmentIds: string[] = accepted.shipmentIds ?? [];
if (internalShipmentIds.length === 0) {
  return res.status(500).json({
    error: `ACCEPTED placement option has no shipmentIds for plan ${planId}`,
  });
}
// shipmentConfirmationIds are not on placementOptions — postProcessFbaShipment
// will fetch them per-shipment via getShipmentDetails (it reads
// d.shipmentConfirmationId from /shipments/{internalId}).
const shipmentConfirmationIds: string[] = [];
```

**Step 2: Persist the recovered internal IDs back to the DB**

Add immediately after the block above (still inside the handler, before `// 3) Resolve product metadata`):

```typescript
// Persist the recovered internal IDs so future relabel calls (or other tools)
// don't need to call placementOptions again. Best-effort — failure is non-fatal.
try {
  await supabase
    .from('fba_shipments')
    .update({ amazon_internal_shipment_ids: internalShipmentIds })
    .eq('id', row.id);
} catch (persistErr: any) {
  console.warn(`[relabel] Could not persist internal IDs: ${persistErr?.message}`);
}
```

**Step 3: Type check**

Run: `cd /home/wcorica/clean-logistics && npx tsc --noEmit`
Expected: clean (no errors)

**Step 4: Commit**

```bash
cd /home/wcorica/clean-logistics
git add api/fba/relabel.ts
git commit -m "fix(fba): use placementOptions to resolve internal shipment IDs in relabel

GET /inboundPlans/{id}/shipments returns 403 with our current LWA scope.
GET /inboundPlans/{id}/placementOptions works and the ACCEPTED option carries
shipmentIds[]. Also persist the recovered IDs to amazon_internal_shipment_ids
so future relabel/labels calls can skip the Amazon round-trip."
git push origin main
```

---

## Task 2: Wait for Vercel deploy and verify endpoint health

**Objective:** Confirm the fix landed in production.

**Step 1: Wait for READY state**

Run:
```bash
python3 /tmp/wait_deploy.py
```

Expected: `DEPLOYED: shiphero-shipstation-bridge-<hash>-wcoricas-projects.vercel.app` within ~60s.

**Step 2: Smoke-test relabel against TR-00079**

Run:
```bash
curl -s -m 290 -w "\nHTTP: %{http_code}\n" \
  -X POST "https://shiphero-shipstation-bridge.vercel.app/api/fba/relabel" \
  -H "Authorization: Bearer brandmind-api-cron-2024" \
  -H "Content-Type: application/json" \
  -d '{"cin7_transfer_number": "CIN7-TR-00079"}'
```

Expected JSON response: HTTP 200, with `labels: [...]` containing 5 entries (one per destination), each with `boxes`, `supabaseUrl`, `attachmentsCreated: 5`, `telegramSent: true`.

**If 500 again:** tail Vercel runtime logs to see the actual Amazon error and adjust before continuing.

---

## Task 3: Verify the regenerated TR-00079 PDFs have correct page counts

**Objective:** Confirm the box-ID fix actually produces multi-page label PDFs.

**Step 1: Download the new PDFs**

Run:
```bash
mkdir -p /tmp/fba_labels_relabel
cd /tmp/fba_labels_relabel
for fname in \
  "FBA19DT907D6-HUNTLEY_IL-2boxes.pdf" \
  "FBA19DTBKG6K-PHOENIX_AZ-2boxes.pdf" \
  "FBA19DTCLWM9-BLOOMINGTON_CA-1boxes.pdf" \
  "FBA19DT9LWRW-SOMERSET_NJ-2boxes.pdf" \
  "FBA19DTDBKX7-SMITHFIELD_NC-3boxes.pdf"; do
  curl -s -o "${fname}" "https://gvrwkjmmgohtovtcyjiu.supabase.co/storage/v1/object/public/shipment-labels/TR-00079/${fname}?cb=$(date +%s)"
done
```

**Step 2: Check page counts**

Run:
```python
from pypdf import PdfReader
import glob, re, os
for f in sorted(glob.glob("/tmp/fba_labels_relabel/*.pdf")):
    name = os.path.basename(f)
    expected_boxes = int(re.search(r"(\d+)boxes", name).group(1))
    pages = len(PdfReader(f).pages)
    status = "OK" if pages == expected_boxes * 2 else "MISMATCH"
    print(f"{status}: {name} — {pages} pages (expected {expected_boxes*2})")
```

Expected: every line prints `OK`. Each box = 2 pages (FBA box label + carrier label).

**If MISMATCH:** stop and investigate. Do NOT proceed to the other 4 TOs.

---

## Task 4: Relabel the remaining 4 TOs

**Objective:** Regenerate correct labels for TR-00080, TR-00081, TR-00082, TR-00084.

**Step 1: Run all four sequentially**

Run:
```bash
for tr in CIN7-TR-00080 CIN7-TR-00081 CIN7-TR-00082 CIN7-TR-00084; do
  echo "=== Relabeling $tr ==="
  curl -s -m 290 -w "\nHTTP: %{http_code}\n" \
    -X POST "https://shiphero-shipstation-bridge.vercel.app/api/fba/relabel" \
    -H "Authorization: Bearer brandmind-api-cron-2024" \
    -H "Content-Type: application/json" \
    -d "{\"cin7_transfer_number\": \"$tr\"}"
  echo
done
```

Expected: each returns HTTP 200 with `labels[].length` matching the destination count from the original Telegram messages (4, 5, 5, 5 respectively).

**Step 2: Spot-check page counts on TR-00081 (largest — 120 boxes total)**

Run:
```bash
curl -s -o /tmp/tr00081_huntley.pdf \
  "https://gvrwkjmmgohtovtcyjiu.supabase.co/storage/v1/object/public/shipment-labels/TR-00081/FBA19DTBVKQM-HUNTLEY_IL-23boxes.pdf?cb=$(date +%s)"
python3 -c "from pypdf import PdfReader; print(len(PdfReader('/tmp/tr00081_huntley.pdf').pages), 'pages (expected 46)')"
```

Expected: `46 pages (expected 46)`.

---

## Task 5: Confirm Telegram messages and ShipHero attachments updated

**Objective:** Verify the full post-process flow (not just label PDFs) ran for all 5 TOs.

**Step 1: Check Telegram channel**

Open the "Clean Nutra FBA Shipments 🚚" Telegram group. You should see 5 fresh `📦 FBA Shipment` messages — one per TO — posted in the last few minutes.

**Step 2: Spot-check ShipHero attachments**

Find ShipHero order `CIN7-TR-00079` in the dashboard. Confirm there are 10 attachments labeled `FBA Shipping Labels - FBA19...` (5 from the original broken run + 5 fresh ones). The new ones will be the most recent by timestamp.

**Acceptable outcomes:**
- ✅ 10 attachments with both old (broken) and new (correct) PDFs visible — warehouse uses the newest.
- ✅ If `attachToShipHero` deduplicates by filename, only 5 attachments but they point to the new Supabase URLs.

**Step 3: Final DB sanity check**

Run:
```bash
cd /home/wcorica/clean-logistics
npx supabase db query --linked --output json "SELECT cin7_transfer_number, status, amazon_internal_shipment_ids IS NOT NULL AS has_internal_ids, updated_at FROM fba_shipments WHERE cin7_transfer_number IN ('CIN7-TR-00079','CIN7-TR-00080','CIN7-TR-00081','CIN7-TR-00082','CIN7-TR-00084') ORDER BY cin7_transfer_number"
```

Expected: all 5 rows show `has_internal_ids: true` and `updated_at` within the last few minutes.

---

## Rollback

If any task fails irrecoverably:

1. Revert the relabel commit: `git revert <hash> && git push origin main`
2. The original broken PDFs remain in Supabase Storage under their existing URLs (Storage `upsert: true` would have overwritten them — see note below).

**Caveat about upsert:** the post-process uploads with `upsert: true`, so re-running relabel **overwrites** the original PDF at the same Storage path. If we need to keep the broken originals for forensics, copy them to a backup folder before Task 2:

```bash
# Optional pre-flight backup
for tr in TR-00079 TR-00080 TR-00081 TR-00082 TR-00084; do
  # Use Supabase Storage API to copy folder /TR-XXXXX/ → /backup-2026-05-22/TR-XXXXX/
  # (skipped by default; only do this if forensics needed)
  :
done
```

---

## Out of scope (do not do in this plan)

- Don't try to find/list shipments via the deprecated `/shipments` endpoint — it returns 403 with our scope.
- Don't modify `postProcessFbaShipment` — the box-ID fix from `da2c95f` is already in production.
- Don't touch the auto-submit pipeline — it works correctly going forward.
- Don't add Amazon LWA scopes for the listing endpoint — placementOptions covers our use case.
