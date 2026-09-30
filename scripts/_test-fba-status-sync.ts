/**
 * Tests for lib/fba-status-sync.ts — the writer of Amazon truth onto fba_shipments.
 * Offline: fake supabase + fake amazonGet.
 */
import { aggregateAmazonStatus, syncFbaAmazonStatus, TERMINAL_AMAZON_STATUSES } from '../lib/fba-status-sync';

let fails = 0;
function ok(name: string, cond: boolean) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; }

// ---------- aggregation (pure) ----------
const A = aggregateAmazonStatus;
ok('plan VOIDED -> VOIDED regardless of shipments', A('VOIDED', ['IN_TRANSIT']) === 'VOIDED');
ok('plan CANCELLED -> VOIDED', A('CANCELLED', []) === 'VOIDED');
ok('all WORKING -> WORKING (still on our floor)', A('ACTIVE', ['WORKING', 'WORKING']) === 'WORKING');
ok('READY_TO_SHIP counts as still here', A('ACTIVE', ['READY_TO_SHIP']) === 'WORKING');
ok('🔴 all IN_TRANSIT -> IN_TRANSIT (THE 59h false-alarm case)', A('SHIPPED', ['IN_TRANSIT', 'IN_TRANSIT', 'IN_TRANSIT', 'IN_TRANSIT', 'IN_TRANSIT']) === 'IN_TRANSIT');
ok('mixed WORKING + IN_TRANSIT -> IN_TRANSIT (some boxes left)', A('ACTIVE', ['WORKING', 'IN_TRANSIT']) === 'IN_TRANSIT');
ok('DELIVERED / CHECKED_IN -> IN_TRANSIT bucket', A('SHIPPED', ['DELIVERED', 'CHECKED_IN']) === 'IN_TRANSIT');
ok('all RECEIVING -> RECEIVING', A('SHIPPED', ['RECEIVING', 'RECEIVING']) === 'RECEIVING');
ok('RECEIVING + CLOSED -> RECEIVING (not done until all closed)', A('SHIPPED', ['RECEIVING', 'CLOSED']) === 'RECEIVING');
ok('all CLOSED -> CLOSED', A('SHIPPED', ['CLOSED', 'CLOSED']) === 'CLOSED');
ok('CLOSED + CANCELLED -> CLOSED', A('SHIPPED', ['CLOSED', 'CANCELLED']) === 'CLOSED');
ok('all shipments CANCELLED (plan still ACTIVE) -> CANCELLED', A('ACTIVE', ['CANCELLED', 'CANCELLED']) === 'CANCELLED');
ok('plan ACTIVE with zero shipments -> WORKING', A('ACTIVE', []) === 'WORKING');
ok('no plan status, no shipments -> UNKNOWN', A(null, []) === 'UNKNOWN');
ok('case-insensitive', A('shipped', ['in_transit']) === 'IN_TRANSIT');
ok('terminal set = CLOSED/VOIDED/CANCELLED only', [...TERMINAL_AMAZON_STATUSES].sort().join(',') === 'CANCELLED,CLOSED,VOIDED');

// ---------- sync loop ----------
function fakeDb(rows: any[]) {
  const updates: Array<{ id: string; patch: any }> = [];
  const q: any = {
    _rows: rows,
    select() { return q; }, not() { return q; }, neq() { return q; }, order() { return q; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
    update(patch: any) { return { eq: (_c: string, id: string) => { updates.push({ id, patch }); return Promise.resolve({ error: null }); } }; },
  };
  return { db: { from: () => q } as any, updates };
}
const row = (o: any) => ({ id: 'r-' + Math.random().toString(36).slice(2, 6), cin7_transfer_number: 'CIN7-TR-00478', cin7_lot: 'L1', plan_id: 'wfA', status: 'plan_created', amazon_status: null, ...o });

async function main() {
  // 1. the false-alarm case: plan_created row, Amazon says SHIPPED/IN_TRANSIT
  {
    const rows = [row({ id: 'a' })];
    const { db, updates } = fakeDb(rows);
    const calls: string[] = [];
    const amazonGet = async (p: string) => { calls.push(p);
      if (p.endsWith('/inboundPlans/wfA')) return { status: 'SHIPPED', shipments: [{ shipmentId: 's1' }, { shipmentId: 's2' }] };
      return { status: 'IN_TRANSIT' }; };
    const r = await syncFbaAmazonStatus({ supabase: db, amazonGet, pauseMs: 0, now: () => new Date('2026-09-30T02:00:00Z') });
    ok('🔴 plan_created row + Amazon IN_TRANSIT -> amazon_status written IN_TRANSIT', updates.length === 1 && updates[0].id === 'a' && updates[0].patch.amazon_status === 'IN_TRANSIT');
    ok('amazon_status_updated_at stamped with now()', updates[0].patch.amazon_status_updated_at === '2026-09-30T02:00:00.000Z');
    ok('🔴 pipeline `status` column is NOT touched', !('status' in updates[0].patch));
    ok('ledger: scanned 1, updated 1 (from null)', r.scanned === 1 && r.updated.length === 1 && r.updated[0].from === null && r.updated[0].to === 'IN_TRANSIT');
    ok('one plan GET + one GET per shipment', calls.length === 3);
  }
  // 2. two lot rows on ONE plan -> Amazon polled once, both rows updated
  {
    const rows = [row({ id: 'a', cin7_lot: 'L1' }), row({ id: 'b', cin7_lot: 'L2' })];
    const { db, updates } = fakeDb(rows); let planGets = 0;
    const amazonGet = async (p: string) => { if (p.endsWith('/inboundPlans/wfA')) { planGets++; return { status: 'ACTIVE', shipments: [{ shipmentId: 's1' }] }; } return { status: 'WORKING' }; };
    const r = await syncFbaAmazonStatus({ supabase: db, amazonGet, pauseMs: 0 });
    ok('shared plan polled ONCE, both rows updated (quota guard)', planGets === 1 && updates.length === 2 && r.scanned === 2);
    ok('WORKING written when boxes still here', updates.every((u) => u.patch.amazon_status === 'WORKING'));
  }
  // 3. unchanged -> no write; terminal -> not even polled
  {
    const rows = [row({ id: 'a', amazon_status: 'IN_TRANSIT' }), row({ id: 'b', plan_id: 'wfB', amazon_status: 'CLOSED' }), row({ id: 'c', plan_id: 'wfC', amazon_status: 'VOIDED' })];
    const { db, updates } = fakeDb(rows); const polled: string[] = [];
    const amazonGet = async (p: string) => { polled.push(p); if (p.endsWith('/inboundPlans/wfA')) return { status: 'SHIPPED', shipments: [{ shipmentId: 's1' }] }; return { status: 'IN_TRANSIT' }; };
    const r = await syncFbaAmazonStatus({ supabase: db, amazonGet, pauseMs: 0 });
    ok('same status again -> unchanged, NO write', updates.length === 0 && r.unchanged === 1);
    ok('🔴 terminal rows (CLOSED/VOIDED) are skipped entirely — not polled', !polled.some((p) => p.includes('wfB') || p.includes('wfC')) && r.scanned === 1);
  }
  // 4. status progression IN_TRANSIT -> RECEIVING -> CLOSED gets written each time
  {
    const rows = [row({ id: 'a', amazon_status: 'IN_TRANSIT' })];
    const { db, updates } = fakeDb(rows);
    const amazonGet = async (p: string) => p.endsWith('/inboundPlans/wfA') ? { status: 'SHIPPED', shipments: [{ shipmentId: 's1' }] } : { status: 'CLOSED' };
    const r = await syncFbaAmazonStatus({ supabase: db, amazonGet, pauseMs: 0 });
    ok('IN_TRANSIT -> CLOSED transition written (from/to in ledger)', updates[0]?.patch.amazon_status === 'CLOSED' && r.updated[0].from === 'IN_TRANSIT' && r.updated[0].to === 'CLOSED');
  }
  // 5. one plan erroring (expired token) does not stop the others; error is LOUD
  {
    const rows = [row({ id: 'a', plan_id: 'wfBAD' }), row({ id: 'b', plan_id: 'wfA' })];
    const { db, updates } = fakeDb(rows);
    const amazonGet = async (p: string) => { if (p.includes('wfBAD')) throw new Error('403 The access token you provided has expired'); if (p.endsWith('/inboundPlans/wfA')) return { status: 'SHIPPED', shipments: [{ shipmentId: 's1' }] }; return { status: 'IN_TRANSIT' }; };
    const r = await syncFbaAmazonStatus({ supabase: db, amazonGet, pauseMs: 0 });
    ok('🔴 expired token -> error recorded with the message, other plan still synced', r.errors.length === 1 && /expired/.test(r.errors[0]) && updates.length === 1 && updates[0].id === 'b');
    ok('ledger balances: scanned == updated + unchanged + errored rows', r.scanned === 2 && r.updated.length + r.unchanged + 1 === 2);
  }
  // 6. cron wiring
  {
    const fs = await import('fs'); const path = await import('path');
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
    const cron = (vercel.crons || []).find((c: any) => c.path === '/api/cron/sync-fba-amazon-status');
    ok('vercel.json schedules /api/cron/sync-fba-amazon-status twice an hour, OFF the :00/:15/:20/:30 cluster (quota)', !!cron && cron.schedule === '7,37 * * * *');
    const src = fs.readFileSync(path.join(__dirname, '../api/cron/sync-fba-amazon-status.ts'), 'utf8');
    ok('endpoint is CRON_SECRET-guarded', /CRON_SECRET/.test(src) && /401/.test(src));
    ok('endpoint returns 207 when any plan errored (not a silent 200)', /207/.test(src));
  }
  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  process.exit(fails === 0 ? 0 : 1);
}
main();
