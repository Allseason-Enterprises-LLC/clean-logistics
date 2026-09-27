/**
 * Poller: release on COMPLETED, alert on CANCELED, nudge at 24h/48h, never fire, never auto-complete.
 * Run: npx tsx scripts/_test-work-order-poller.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { pollWorkOrders } from '../lib/work-order-poller';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const NOW = new Date('2026-09-28T15:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 36e5).toISOString();

function wo(over: any = {}) {
  return { type: 'CUSTOM', ids: ['171200'], status: 'IN_PROGRESS', created_at: hoursAgo(1), completed_at: null,
    last_nudge_at: null, kit_sku: 'CN-CAP-REJUVINOL-2OZ', kit_qty: 40, pack_count: 3, amazon_msku: 'CB-REJUVINOL-DRP-3', reason: 'amazon_msku:multipack_suffix', ...over };
}
function fakeDb(rows: any[]) {
  const updates: Array<{ id: string; patch: any }> = [];
  const q: any = {
    from() { return q; }, select() { return q; }, eq(k: string, v: any) { if (k === 'id') q._id = v; return q; },
    not() { return q; }, limit: async () => ({ data: rows, error: null }),
    update(p: any) { const id = null; q._pending = p; return { eq: async (_k: string, v: any) => { updates.push({ id: v, patch: q._pending }); return { data: null, error: null }; } }; },
  };
  return { db: q as any, updates };
}
async function run(rowsIn: any[], liveStatus: string | Record<string, string>, bulk = 0, sentTracker?: string[]) {
  const rows = rowsIn.map((w, i) => ({ id: `row-${i}`, cin7_transfer_number: `TR-0050${i}`, request_payload: { partnerLineItems: [{ sku: 'x' }], work_order: w } }));
  const { db, updates } = fakeDb(rows);
  const sent: string[] = sentTracker ?? [];
  const r = await pollWorkOrders({
    supabase: db, shipheroToken: 'tok',
    sendTelegram: async (m) => { sent.push(m); return true; },
    getWorkOrder: async (_t, id) => ({ id: 'g', legacyId: id, status: typeof liveStatus === 'string' ? liveStatus : liveStatus[String(id)], completedAt: '2026-09-28T14:00:00Z' }),
    getBulk: async () => ({ bulk, pickable: 0, rows: 1 }),
    now: () => NOW,
  });
  return { r, updates, sent };
}

async function main() {
  // ── RELEASE ──
  {
    const { r, updates, sent } = await run([wo()], 'COMPLETED');
    ok('COMPLETED -> released', r.released[0] === 'TR-00500' && r.scanned === 1);
    const p = updates[0].patch;
    ok('release flips work_order.status=COMPLETED + completed_at', p.request_payload.work_order.status === 'COMPLETED' && !!p.request_payload.work_order.completed_at);
    ok('release preserves partnerLineItems', p.request_payload.partnerLineItems.length === 1);
    ok('release sets last_fba_handoff_status=pending (reconciler-eligible, not fired here)', p.last_fba_handoff_status === 'pending');
    ok('release does NOT touch status column', !('status' in p));
    ok('release posts ✅ with 15-minute expectation', /✅/.test(sent[0]) && /15 minutes/.test(sent[0]) && /TR-00500/.test(sent[0]));
  }
  // ── FAILED ──
  {
    const { r, updates, sent } = await run([wo()], 'CANCELED');
    ok('CANCELED -> failed', r.failed[0] === 'TR-00500');
    ok('failed marks work_order_failed on the row', updates[0].patch.last_fba_handoff_status === 'work_order_failed' && updates[0].patch.request_payload.work_order.status === 'CANCELED');
    ok('failed posts ⚠️ saying shipment NOT created', /⚠️/.test(sent[0]) && /not<\/b> created/.test(sent[0]));
  }
  // ── WAIT (<24h) ──
  {
    const { r, updates, sent } = await run([wo({ created_at: hoursAgo(5) })], 'IN_PROGRESS');
    ok('5h open -> waiting, no Telegram', r.waiting.length === 1 && sent.length === 0);
    ok('waiting does not write when live status unchanged', updates.length === 0);
  }
  {
    const { updates } = await run([wo({ created_at: hoursAgo(5), status: 'IN_PROGRESS' })], 'READY_TO_PICK');
    ok('waiting DOES mirror a changed live status (IN_PROGRESS -> READY_TO_PICK)', updates[0]?.patch.request_payload.work_order.status === 'READY_TO_PICK');
  }
  // ── NUDGE (24h) ──
  {
    const { r, updates, sent } = await run([wo({ created_at: hoursAgo(26) })], 'IN_PROGRESS');
    ok('26h open, never nudged -> nudge', r.nudged[0] === 'TR-00500' && /⏳/.test(sent[0]) && /due today/.test(sent[0]));
    ok('nudge stamps last_nudge_at', updates[0].patch.request_payload.work_order.last_nudge_at === NOW.toISOString());
  }
  {
    const { r, sent } = await run([wo({ created_at: hoursAgo(30), last_nudge_at: hoursAgo(4) })], 'IN_PROGRESS');
    ok('30h open, nudged 4h ago -> wait (once a day, no spam)', r.waiting.length === 1 && sent.length === 0);
  }
  // ── 48h: stock-informed ESCALATION, never auto-complete ──
  {
    const { r, sent } = await run([wo({ created_at: hoursAgo(50) })], 'IN_PROGRESS', 12);
    ok('50h, bulk 12/40 -> escalate 🚨 with the shortfall', r.escalated[0] === 'TR-00500' && /🚨/.test(sent[0]) && /12 of 40/.test(sent[0]) && /28 short/.test(sent[0]));
  }
  {
    const { r, sent, updates } = await run([wo({ created_at: hoursAgo(50) })], 'IN_PROGRESS', 40);
    ok('50h, bulk 40/40 -> 🔔 "just mark it Complete" (NOT auto-completed)', r.escalated[0] === 'TR-00500' && /🔔/.test(sent[0]) && /mark it <b>Complete<\/b>/.test(sent[0]));
    ok('🔴 no work_order_complete call path exists in the poller', !fs.readFileSync(path.join(__dirname, '../lib/work-order-poller.ts'), 'utf8').includes('completeWorkOrder('));
    ok('row status stays IN_PROGRESS (we did not pretend it completed)', updates[0].patch.request_payload.work_order.status === 'IN_PROGRESS');
  }
  {
    const { r, sent } = await run([wo({ created_at: hoursAgo(70), last_nudge_at: hoursAgo(3) })], 'IN_PROGRESS', 0);
    ok('70h, escalated 3h ago -> wait (re-escalate daily)', r.waiting.length === 1 && sent.length === 0);
  }
  // ── multi-id: ALL must be COMPLETED ──
  {
    const { r } = await run([wo({ ids: ['1', '2'] })], { '1': 'COMPLETED', '2': 'IN_PROGRESS' });
    ok('2 WOs, one still open -> NOT released', r.released.length === 0 && r.waiting.length === 1);
    const { r: r2 } = await run([wo({ ids: ['1', '2'] })], { '1': 'COMPLETED', '2': 'COMPLETED' });
    ok('2 WOs both COMPLETED -> released', r2.released.length === 1);
  }
  // ── ledger balance + error isolation ──
  {
    const rows = [wo(), wo({ created_at: hoursAgo(26) }), wo({ created_at: hoursAgo(50) }), wo()];
    const rowsIn = rows.map((w, i) => ({ id: `row-${i}`, cin7_transfer_number: `TR-0050${i}`, request_payload: { work_order: w } }));
    const { db } = fakeDb(rowsIn);
    let n = 0;
    const r = await pollWorkOrders({ supabase: db, shipheroToken: 'tok', sendTelegram: async () => true,
      getWorkOrder: async () => { n++; if (n === 4) throw new Error('Token is expired'); return { id: 'g', legacyId: 1, status: n === 1 ? 'COMPLETED' : 'IN_PROGRESS', completedAt: null }; },
      getBulk: async () => ({ bulk: 0, pickable: 0, rows: 0 }), now: () => NOW });
    const sum = r.released.length + r.failed.length + r.nudged.length + r.escalated.length + r.waiting.length + r.errors.length;
    ok(`ledger balances: scanned ${r.scanned} == ${sum}`, r.scanned === 4 && sum === 4);
    ok('one row erroring (expired token) does not stop the others', r.errors.length === 1 && /Token is expired/.test(r.errors[0]) && r.released.length === 1);
  }
  // ── already-COMPLETED rows are not re-scanned ──
  {
    const { r } = await run([wo({ status: 'COMPLETED' })], 'COMPLETED');
    ok('a row already COMPLETED in the DB is filtered out (scanned 0)', r.scanned === 0);
  }
  // ── endpoint + schedule ──
  const ep = fs.readFileSync(path.join(__dirname, '../api/cron/poll-work-orders.ts'), 'utf8');
  ok('endpoint guarded by CRON_SECRET', /CRON_SECRET/.test(ep) && /401/.test(ep));
  ok('endpoint reports `balanced`', /balanced/.test(ep));
  const vj = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  ok('vercel.json schedules poll-work-orders every 30 min', vj.crons.some((c: any) => c.path === '/api/cron/poll-work-orders' && c.schedule === '*/30 * * * *'));

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
