/**
 * A terminal work order must alert ONCE, not every tick.
 *
 * 2026-10-10 (Weston, with a screenshot of four identical alerts): TR-00146,
 * TR-00326, TR-00328, TR-00329 had their work orders CANCELED deliberately —
 * on my own instruction, because the stock to build them does not exist. The
 * poller re-sent the ⚠️ "was CANCELED ... someone needs to decide whether to
 * rebuild it" notice on EVERY tick, forever.
 *
 * Cause: the `failed` branch writes `work_order.status = 'CANCELED'`, and the
 * row filter is `status !== 'COMPLETED'`. CANCELED is not COMPLETED, so the row
 * stays in scope and re-fires. Only COMPLETED was ever an exit.
 *
 * The fix is `isTerminalWorkOrder()` + an `alerted_at` stamp: terminal states
 * leave the poller's scope, and a row that has already been alerted is never
 * alerted again even if it is re-selected.
 *
 * Run: npx tsx scripts/_test-terminal-work-orders.ts
 */
import { isTerminalWorkOrder, shouldPollWorkOrderRow } from '../lib/work-order-poller';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const wo = (status: string, extra: Record<string, unknown> = {}) => ({
  ids: ['173639'], status, kit_sku: 'CN-CAP-TARTCHERRY-120CT', kit_qty: 2100,
  created_at: '2026-10-08T10:00:00.000Z', ...extra,
});

// ── 1. which statuses are terminal ──────────────────────────────────────────
ok('COMPLETED is terminal', isTerminalWorkOrder('COMPLETED'));
ok('🔴 CANCELED is terminal (the bug: it was not)', isTerminalWorkOrder('CANCELED'));
ok('🔴 CLOSED is terminal', isTerminalWorkOrder('CLOSED'));
ok('CANCELLED (British spelling, in case ShipHero varies) is terminal', isTerminalWorkOrder('CANCELLED'));
ok('status is matched case-insensitively', isTerminalWorkOrder('canceled'));
ok('IN_PROGRESS is NOT terminal', !isTerminalWorkOrder('IN_PROGRESS'));
ok('READY_TO_PICK is NOT terminal', !isTerminalWorkOrder('READY_TO_PICK'));
ok('null/undefined status is NOT terminal (keep polling, do not strand)', !isTerminalWorkOrder(null) && !isTerminalWorkOrder(undefined));

// ── 2. 🔴 the live cohort must drop out of scope ─────────────────────────────
{
  ok('🔴 TR-00326 (CANCELED, already alerted) is NOT polled again',
    shouldPollWorkOrderRow({ work_order: wo('CANCELED', { alerted_at: '2026-10-10T10:30:00.000Z' }) }) === false);
  ok('🔴 CANCELED with NO alerted_at is still polled ONCE (so the first alert goes out)',
    shouldPollWorkOrderRow({ work_order: wo('CANCELED') }) === true);
  ok('COMPLETED row is not polled', shouldPollWorkOrderRow({ work_order: wo('COMPLETED') }) === false);
  ok('open WO is polled', shouldPollWorkOrderRow({ work_order: wo('IN_PROGRESS') }) === true);
  ok('row with no work_order at all is not polled', shouldPollWorkOrderRow({}) === false);
  ok('row with null payload is not polled', shouldPollWorkOrderRow(null) === false);
}

// ── 3. the alert-once invariant across repeated ticks ───────────────────────
{
  // Simulate three ticks over one row, mirroring the poller's write.
  let payload: any = { work_order: wo('IN_PROGRESS') };
  let alerts = 0;
  for (let tick = 0; tick < 3; tick++) {
    if (!shouldPollWorkOrderRow(payload)) continue;
    // live status comes back CANCELED every tick
    const live = 'CANCELED';
    if (isTerminalWorkOrder(live) && live !== 'COMPLETED') {
      if (!payload.work_order.alerted_at) { alerts++; payload = { work_order: { ...payload.work_order, status: live, alerted_at: '2026-10-10T10:30:00.000Z' } }; }
    }
  }
  ok('🔴 three ticks over a CANCELED WO produce exactly ONE alert', alerts === 1, `got ${alerts}`);
}

// ── 4. a re-opened WO must be able to alert again ───────────────────────────
{
  const reopened = { work_order: wo('IN_PROGRESS', { alerted_at: '2026-10-10T10:30:00.000Z' }) };
  ok('a WO that went back to IN_PROGRESS is polled again (alerted_at must not strand a live WO)',
    shouldPollWorkOrderRow(reopened) === true);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
