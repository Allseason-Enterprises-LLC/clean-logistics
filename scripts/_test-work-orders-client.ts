/**
 * ShipHero work-order client + the poller decision table.
 * Run: npx tsx scripts/_test-work-orders-client.ts
 */
import {
  buildCreateWorkOrderData, createAssemblyWorkOrder, getWorkOrder, completeWorkOrder,
  getNonPickableBulkUnits, decideWorkOrder,
} from '../lib/shiphero-work-orders';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// a fetch double that records the request and returns a canned GraphQL body
function fakeFetch(reply: any) {
  const calls: any[] = [];
  const f = async (_url: string, init: any) => { calls.push(JSON.parse(init.body)); return { json: async () => reply }; };
  return { f, calls };
}

async function main() {
  // ---------- payload shape ----------
  const base = { warehouseId: 'W1', customerAccountId: '95145', sku: 'CN-BDL-CAP-GINSENG-60CT-3PK', quantity: 40,
    name: 'TR-00500 · build 40 × CN-BDL-CAP-GINSENG-60CT-3PK', instructions: 'Build. Do NOT ship.', requestedDate: '2026-09-22T00:00:00Z' };
  const d = buildCreateWorkOrderData(base);
  ok('🔴 type defaults to ASSEMBLY (warehouse mgr 2026-09-28: Assembly builds stock; CUSTOM does not)', d.type === 'ASSEMBLY');
  ok('type CUSTOM only when explicitly asked (the fallback path)', buildCreateWorkOrderData(base, 'CUSTOM').type === 'CUSTOM');
  ok('assembly_details carries a human build spec', /40 × CN-BDL-CAP-GINSENG-60CT-3PK/.test(d.assembly_details));
  const withComp = buildCreateWorkOrderData({ ...base, packCount: 3, component: { sku: 'CN-CAP-GINSENG-60CT', perKit: 3 } });
  ok('component spec: 40 kits = 120 singles (3 per kit)', /= 120 × CN-CAP-GINSENG-60CT \(3 per kit\)/.test(withComp.assembly_details));
  ok('priority defaults to HIGH (Weston)', d.priority === 'HIGH');
  ok('requested_date passed through', d.requested_date === '2026-09-22T00:00:00Z');
  ok('assembly_sku carries sku+quantity', d.assembly_sku.sku === base.sku && d.assembly_sku.quantity === 40);
  ok('lot_id OMITTED when not given (not null)', !('lot_id' in d.assembly_sku));
  ok('lot_id included when given', (buildCreateWorkOrderData({ ...base, lotId: 'L9' }).assembly_sku as any).lot_id === 'L9');
  ok('customer_account_id + warehouse_id set', d.customer_account_id === '95145' && d.warehouse_id === 'W1');
  let threw = false; try { buildCreateWorkOrderData({ ...base, quantity: 0 }); } catch { threw = true; }
  ok('quantity 0 rejected', threw);
  threw = false; try { buildCreateWorkOrderData({ ...base, quantity: 2.5 }); } catch { threw = true; }
  ok('fractional quantity rejected', threw);

  // ---------- create ----------
  const c1 = fakeFetch({ data: { work_order_create: { request_id: 'r', work_order: { id: 'V29ya09yZGVyOjEyMw==', legacy_id: 123, status: 'PENDING_APPROVAL' } } } });
  const wo = await createAssemblyWorkOrder('tok', base, c1.f);
  ok('create returns legacyId as a NUMBER (work_order(id:Int) needs it)', wo.legacyId === 123 && typeof wo.legacyId === 'number');
  ok('create sends ASSEMBLY first, ONE call when accepted', c1.calls.length === 1 && c1.calls[0].query.includes('work_order_create(data: $data)') && c1.calls[0].variables.data.type === 'ASSEMBLY');
  ok('returned type = ASSEMBLY when ShipHero accepted it', wo.type === 'ASSEMBLY' || wo.type === undefined);
  // ---------- ASSEMBLY rejected -> CUSTOM fallback ----------
  {
    let n = 0; const calls: any[] = [];
    const f = (async (_u: string, init: any) => { const body = JSON.parse(init.body); calls.push(body.variables.data); n++;
      if (n === 1) return { json: async () => ({ errors: [{ message: 'Invalid Product' }] }) };
      return { json: async () => ({ data: { work_order_create: { request_id: 'r', work_order: { id: 'g', legacy_id: 555, status: 'IN_PROGRESS', type: 'CUSTOM' } } } }) }; }) as any;
    const fb = await createAssemblyWorkOrder('tok', base, f);
    ok('🔴 "Invalid Product" on ASSEMBLY -> retries as CUSTOM (2 calls: ASSEMBLY then CUSTOM)', calls.length === 2 && calls[0].type === 'ASSEMBLY' && calls[1].type === 'CUSTOM');
    ok('fallback returns the CUSTOM WO and REPORTS type CUSTOM so the floor can be warned', fb.legacyId === 555 && fb.type === 'CUSTOM');
    ok('fallback payload identical apart from type', JSON.stringify({ ...calls[0], type: null }) === JSON.stringify({ ...calls[1], type: null }));
  }
  const cErr = fakeFetch({ errors: [{ message: 'Token is expired' }] });
  threw = false; try { await createAssemblyWorkOrder('tok', base, cErr.f); } catch (e: any) { threw = /Token is expired/.test(e.message); }
  ok('non-"Invalid Product" errors (expired token) -> throw, NO silent CUSTOM fallback', threw && cErr.calls.length === 1);
  const cNone = fakeFetch({ data: { work_order_create: { request_id: 'r', work_order: null } } });
  threw = false; try { await createAssemblyWorkOrder('tok', base, cNone.f); } catch { threw = true; }
  ok('missing work_order in response -> throws (never silently "created")', threw);

  // ---------- get ----------
  const g = fakeFetch({ data: { work_order: { data: { id: 'x', legacy_id: 123, status: 'COMPLETED', completed_at: '2026-09-23T10:00:00Z' } } } });
  const got = await getWorkOrder('tok', 123, g.f);
  ok('get queries by INTEGER id', g.calls[0].variables.id === 123 && g.calls[0].query.includes('work_order(id: $id)'));
  ok('get returns status + completed_at', got.status === 'COMPLETED' && got.completedAt === '2026-09-23T10:00:00Z');

  // ---------- complete ----------
  const cc = fakeFetch({ data: { work_order_complete: { request_id: 'r', work_order: { id: 'x', legacy_id: 123, status: 'COMPLETED' } } } });
  await completeWorkOrder('tok', 123, 'auto-completed: 40 units in bulk', cc.f);
  ok('complete sends work_order_id as STRING + message', cc.calls[0].variables.data.work_order_id === '123' && /40 units/.test(cc.calls[0].variables.data.message));

  // ---------- bulk stock (the auto-complete guard) ----------
  const stock = fakeFetch({ data: { item_locations: { data: { edges: [
    { node: { quantity: 600, location: { pickable: false }, expiration_lot: { is_active: true } } },   // bulk ✓
    { node: { quantity: 92,  location: { pickable: true  }, expiration_lot: { is_active: true } } },   // DTC ✗
    { node: { quantity: 500, location: { pickable: false }, expiration_lot: { is_active: false } } },  // inactive lot ✗
    { node: { quantity: 0,   location: { pickable: false }, expiration_lot: { is_active: true } } },
  ] } } } });
  const s = await getNonPickableBulkUnits('tok', 'CN-CAP-VBIOTIC-90CT', stock.f);
  ok('bulk counts ONLY non-pickable + active (TR-00474 real shape: 600)', s.bulk === 600, `got ${s.bulk}`);
  ok('pickable tracked separately (92), never added to bulk', s.pickable === 92);
  ok('inactive-lot stock excluded', s.bulk !== 1100);

  // ---------- decision table: the dangerous branch ----------
  const D = decideWorkOrder;
  ok('COMPLETED -> release', D({ status: 'COMPLETED', ageHours: 1, kitQty: 10 }).action === 'release');
  ok('CANCELED -> failed', D({ status: 'CANCELED', ageHours: 1, kitQty: 10 }).action === 'failed');
  ok('CLOSED -> failed', D({ status: 'CLOSED', ageHours: 100, kitQty: 10 }).action === 'failed');
  ok('open, 1h -> wait', D({ status: 'IN_PROGRESS', ageHours: 1, kitQty: 10 }).action === 'wait');
  ok('open, 24h, never nudged -> nudge', D({ status: 'IN_PROGRESS', ageHours: 24, kitQty: 10, lastNudgeAgeHours: null }).action === 'nudge');
  ok('open, 30h, nudged 3h ago -> wait (no spam)', D({ status: 'IN_PROGRESS', ageHours: 30, kitQty: 10, lastNudgeAgeHours: 3 }).action === 'wait');
  ok('open, 48h, bulk >= qty -> AUTO_COMPLETE (they forgot the button)',
     D({ status: 'ASSEMBLY_IN_PROGRESS', ageHours: 48, kitQty: 10, bulkUnits: 10 }).action === 'auto_complete');
  ok('open, 48h, bulk > qty -> auto_complete', D({ status: 'IN_PROGRESS', ageHours: 60, kitQty: 10, bulkUnits: 25 }).action === 'auto_complete');
  const short = D({ status: 'IN_PROGRESS', ageHours: 48, kitQty: 10, bulkUnits: 8 });
  ok('🔴 open, 48h, bulk < qty -> ESCALATE, NEVER auto_complete (phantom-inventory guard)', short.action === 'escalate' && (short as any).bulk === 8);
  ok('open, 48h, bulk 0 -> escalate', D({ status: 'PENDING_APPROVAL', ageHours: 72, kitQty: 10, bulkUnits: 0 }).action === 'escalate');
  ok('open, 72h, short, escalated 5h ago -> wait (re-escalate daily, not every tick)',
     D({ status: 'IN_PROGRESS', ageHours: 72, kitQty: 10, bulkUnits: 8, lastNudgeAgeHours: 5 }).action === 'wait');
  ok('open, 96h, short, escalated 26h ago -> escalate again',
     D({ status: 'IN_PROGRESS', ageHours: 96, kitQty: 10, bulkUnits: 8, lastNudgeAgeHours: 26 }).action === 'escalate');
  threw = false; try { D({ status: 'IN_PROGRESS', ageHours: 48, kitQty: 10 }); } catch { threw = true; }
  ok('48h without a stock read -> THROWS (cannot decide blind)', threw);
  ok('47.9h -> still the nudge path, no stock read needed', D({ status: 'IN_PROGRESS', ageHours: 47.9, kitQty: 10, lastNudgeAgeHours: 30 }).action === 'nudge');

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
