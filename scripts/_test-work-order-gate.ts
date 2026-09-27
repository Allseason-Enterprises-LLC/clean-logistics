/**
 * Kit work-order gate: kit transfers park + get a WO; non-kits pass through; failures are loud.
 * Run: npx tsx scripts/_test-work-order-gate.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { applyKitWorkOrderGate, isBlockedByWorkOrder, readWorkOrderState, buildWorkOrderText,
  SHIPHERO_LV_WAREHOUSE_GRAPH_ID } from '../lib/kit-work-order-gate';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// ── minimal Supabase double: one bridge row, records updates ──
function fakeDb(row: any) {
  const updates: any[] = [];
  const q: any = {
    _f: {} as any,
    from() { return q; }, select() { return q; }, update(v: any) { updates.push(v); return q; },
    eq(k: string, v: any) { q._f[k] = v; return q; },
    maybeSingle: async () => ({ data: row, error: null }),
    then(res: any) { res({ data: null, error: null }); }, // makes `await ...eq()` after update resolve
  };
  return { db: q as any, updates };
}
const TRANSFER = { id: 'cin7-uuid-1', transferNumber: 'TR-00500', destinationName: 'Amazon FBA Warehouse',
  shipheroOrderNumber: 'AMZ_CN-CAP-REJUVINOL-2OZ_00500',
  lines: [{ sku: 'CN-CAP-REJUVINOL-2OZ', quantity: 40 }] };
const ROW = { id: 'row-1', request_payload: { partnerLineItems: [{ sku: 'CN-CAP-REJUVINOL-2OZ', quantity: 40 }], tags: ['x'] } };

async function main() {
  // ---------- GATED: plain CIN7 sku, Amazon MSKU -3 ----------
  {
    const { db, updates } = fakeDb(ROW);
    const created: any[] = [];
    const r = await applyKitWorkOrderGate({
      supabase: db, shipheroToken: 'tok',
      resolveAmazonSku: async () => 'CB-REJUVINOL-DRP-3',
      createWorkOrder: async (_t, input) => { created.push(input); return { id: 'g', legacyId: 171200, status: 'IN_PROGRESS' }; },
      now: () => new Date('2026-09-26T15:00:00Z'),
    }, TRANSFER);
    ok('gated when Amazon MSKU ends -3', r.gated === true);
    ok('exactly ONE work order created (one per transfer)', created.length === 1);
    ok('WO uses the ShipHero GRAPH warehouse id, not our UUID', created[0].warehouseId === SHIPHERO_LV_WAREHOUSE_GRAPH_ID && created[0].warehouseId === 'V2FyZWhvdXNlOjEzNTg3Mg==');
    ok('WO qty = transfer line qty', created[0].quantity === 40 && created[0].sku === 'CN-CAP-REJUVINOL-2OZ');
    ok('WO requested_date = today (Weston), priority HIGH', created[0].requestedDate === '2026-09-26T00:00:00' && created[0].priority === 'HIGH');
    ok('WO packCount 3 flows into the spec', created[0].packCount === 3 && /3-pack/.test(created[0].name));
    ok('🔴 WO NAME = the ShipHero ORDER number the floor sees (AMZ_<SKU>_<NNNNN>), not the TR', created[0].name.startsWith('AMZ_CN-CAP-REJUVINOL-2OZ_00500 ·') && !created[0].name.startsWith('TR-'));
    ok('instructions still carry the TR for traceability', /CIN7 TR-00500/.test(created[0].instructions) && /AMZ_CN-CAP-REJUVINOL-2OZ_00500/.test(created[0].instructions));
    ok('state records order_number', updates[0].request_payload.work_order.order_number === 'AMZ_CN-CAP-REJUVINOL-2OZ_00500');
    ok('instructions say do NOT ship + labels auto after COMPLETED', /Do NOT ship/.test(created[0].instructions) && /COMPLETED/.test(created[0].instructions));
    const u = updates[0];
    ok('row parked: request_payload.work_order written', !!u?.request_payload?.work_order);
    ok('partnerLineItems + tags PRESERVED (merge, not clobber)', u.request_payload.partnerLineItems?.length === 1 && u.request_payload.tags?.[0] === 'x');
    const wo = u.request_payload.work_order;
    ok('state: ids=[legacy id as string], status IN_PROGRESS, type CUSTOM', wo.ids[0] === '171200' && wo.status === 'IN_PROGRESS' && wo.type === 'CUSTOM');
    ok('state: kit_sku/kit_qty/pack_count/amazon_msku recorded', wo.kit_sku === 'CN-CAP-REJUVINOL-2OZ' && wo.kit_qty === 40 && wo.pack_count === 3 && wo.amazon_msku === 'CB-REJUVINOL-DRP-3');
    ok('state: reason names the rule (amazon_msku:multipack_suffix)', wo.reason === 'amazon_msku:multipack_suffix');
    ok('row: last_fba_handoff_status = awaiting_work_order (ledger-visible)', u.last_fba_handoff_status === 'awaiting_work_order' && /171200/.test(u.last_fba_handoff_detail));
    ok('status column NOT touched (CHECK constraint)', !('status' in u));
    ok('isBlockedByWorkOrder -> true while IN_PROGRESS', isBlockedByWorkOrder(u.request_payload));
    ok('…and false once COMPLETED', !isBlockedByWorkOrder({ work_order: { ...wo, status: 'COMPLETED' } }));
  }

  // ---------- NOT GATED: single ----------
  {
    const { db, updates } = fakeDb(ROW);
    let creates = 0;
    const r = await applyKitWorkOrderGate({ supabase: db, shipheroToken: 'tok',
      resolveAmazonSku: async () => 'CNO-VBIOTIC-VEG-1',
      createWorkOrder: async () => { creates++; return { id: 'x', legacyId: 1, status: 'IN_PROGRESS' }; } },
      { ...TRANSFER, lines: [{ sku: 'CN-CAP-VBIOTIC-90CT', quantity: 600 }] });
    ok('single (-1 msku) -> NOT gated', r.gated === false);
    ok('single -> no WO created, no row update', creates === 0 && updates.length === 0);
    ok('isBlockedByWorkOrder(no work_order) -> false (all existing rows keep firing)', !isBlockedByWorkOrder(ROW.request_payload));
  }

  // ---------- NOT GATED: -R2 retry ----------
  {
    const { db, updates } = fakeDb(ROW);
    let creates = 0;
    const r = await applyKitWorkOrderGate({ supabase: db, shipheroToken: 'tok',
      resolveAmazonSku: async () => 'CN-CAP-NMNBEAUTY-60CT-R2',
      createWorkOrder: async () => { creates++; return { id: 'x', legacyId: 1, status: 'IN_PROGRESS' }; } },
      { ...TRANSFER, lines: [{ sku: 'CN-CAP-NMNBEAUTY-60CT', quantity: 100 }] });
    ok('🔴 -R2 retry -> NOT gated, ships straight through', r.gated === false && creates === 0 && updates.length === 0);
  }

  // ---------- GATED via CIN7 sku even when msku lookup FAILS ----------
  {
    const { db } = fakeDb(ROW);
    const r = await applyKitWorkOrderGate({ supabase: db, shipheroToken: 'tok',
      resolveAmazonSku: async () => { throw new Error('Token is expired'); },
      createWorkOrder: async () => ({ id: 'x', legacyId: 5, status: 'IN_PROGRESS' }) },
      { ...TRANSFER, lines: [{ sku: 'CN-KIT-SRM-SNAILANTIA-2OZ-3PK', quantity: 10 }] });
    ok('msku lookup throws but CIN7 -3PK still gates (fails toward gating)', r.gated === true && r.workOrder?.reason === 'cin7_sku:prefix');
  }

  // ---------- WO creation FAILS -> throws (caller records + does NOT fire) ----------
  {
    const { db, updates } = fakeDb(ROW);
    let threw = '';
    try {
      await applyKitWorkOrderGate({ supabase: db, shipheroToken: 'tok',
        resolveAmazonSku: async () => 'X-3',
        createWorkOrder: async () => { throw new Error('Invalid Product'); } }, TRANSFER);
    } catch (e: any) { threw = e.message; }
    ok('WO create failure -> throws (never silently un-gated)', /Invalid Product/.test(threw) && updates.length === 0);
  }

  // ---------- sync-cin7 wiring (static) ----------
  const sync = fs.readFileSync(path.join(__dirname, '../lib/cin7-transfer-sync.ts'), 'utf8');
  ok('sync imports the gate', sync.includes("from './kit-work-order-gate'"));
  ok('gate runs INSIDE the FBA branch, BEFORE pendingFbaHandoffs.push', (() => {
    const a = sync.indexOf('applyKitWorkOrderGate('); const b = sync.indexOf('if (!gated) {'); const c = sync.indexOf('pendingFbaHandoffs.push', b);
    return a > 0 && b > a && c > b; })());
  ok('gate failure path marks work_order_failed AND sets gated=true (no fire)', /work_order_failed[\s\S]{0,400}gated = true/.test(sync));
  ok('non-kit path pushes the SAME handoff shape as before', /pendingFbaHandoffs\.push\(\{\s*cin7TransferNumber: transfer\.transferNumber,\s*items: transfer\.lines\.map/.test(sync));
  ok('buildWorkOrderText is warehouse-facing (no engineering words)', !/reconciler|jsonb|PostgREST|bridge row/i.test(buildWorkOrderText({ transferNumber: 'TR-1', kitSku: 'S', qty: 1 }).instructions));
  ok('no order number -> falls back to TR (never a blank name)', buildWorkOrderText({ transferNumber: 'TR-1', orderNumber: null, kitSku: 'S', qty: 1 }).name.startsWith('TR-1 ·'));
  ok('CIN7 Reference override flows through verbatim (order-naming escape hatch)', buildWorkOrderText({ transferNumber: 'TR-1', orderNumber: 'AMZ_SPLIT-B_00001', kitSku: 'S', qty: 1 }).name.startsWith('AMZ_SPLIT-B_00001 ·'));
  const sync2 = fs.readFileSync(path.join(__dirname, '../lib/cin7-transfer-sync.ts'), 'utf8');
  ok('sync passes result.shipheroOrderNumber into the gate', /shipheroOrderNumber: result\.shipheroOrderNumber/.test(sync2));
  ok('readWorkOrderState(null payload) -> null', readWorkOrderState(null) === null && readWorkOrderState({}) === null);

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
