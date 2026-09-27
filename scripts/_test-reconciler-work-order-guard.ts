/**
 * The reconciler must NEVER fire a row whose work order is not COMPLETED.
 * Run: npx tsx scripts/_test-reconciler-work-order-guard.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { isBlockedByWorkOrder, readWorkOrderState } from '../lib/kit-work-order-gate';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');

// --- placement: the WO check must be the FIRST thing in the per-row try block ---
const loopStart = src.indexOf('for (const row of candidates)');
const tryStart = src.indexOf('try {', loopStart);
const woCheck = src.indexOf('readWorkOrderState(row.request_payload)', tryStart);
const existsCheck = src.indexOf('fbaRecordExists(db, row.cin7_transfer_number)', tryStart);
const retryDecision = src.indexOf('shouldRetryNow(row)', tryStart);
const fire = src.indexOf('fireFbaAutoSubmit(', tryStart);
ok('WO check exists inside the row loop', woCheck > tryStart);
ok('WO check runs BEFORE fbaRecordExists (zero I/O gate first)', woCheck < existsCheck);
ok('WO check runs BEFORE shouldRetryNow', woCheck < retryDecision);
ok('WO check runs BEFORE fireFbaAutoSubmit', woCheck < fire);

// --- the guard must `continue`, and must push to the ledger (scanned == fired + skipped) ---
const guardBlock = src.slice(woCheck, existsCheck);
ok('guard pushes to skipped[] (ledger stays balanced)', /result\.skipped\.push\(/.test(guardBlock));
ok('guard ends with continue (never falls through to fire)', /continue;\s*\}/.test(guardBlock));
ok('guard names the transfer + reason awaiting_work_order', /reason:[^\n]*awaiting_work_order/.test(guardBlock));
ok('guard distinguishes a CANCELED/CLOSED WO as work_order_failed', /work_order_failed/.test(guardBlock));
ok('guard detail carries WO ids, status, age, and the kit spec', /wo\.ids\.join/.test(guardBlock) && /wo\.status/.test(guardBlock) && /wo\.kit_qty/.test(guardBlock));
ok('guard only blocks when status !== COMPLETED', /wo\.status !== 'COMPLETED'/.test(guardBlock));

// --- behaviour of the shared predicate the guard relies on ---
const base = { type: 'CUSTOM', ids: ['171200'], created_at: '2026-09-26T15:00:00Z', kit_sku: 'S', kit_qty: 10, reason: 'r' };
for (const s of ['PENDING_APPROVAL', 'IN_PROGRESS', 'READY_TO_PICK', 'ASSEMBLY_IN_PROGRESS']) {
  ok(`WO ${s} -> BLOCKED`, isBlockedByWorkOrder({ work_order: { ...base, status: s } }));
}
ok('WO CANCELED -> BLOCKED (never fire a cancelled build)', isBlockedByWorkOrder({ work_order: { ...base, status: 'CANCELED' } }));
ok('WO COMPLETED -> released', !isBlockedByWorkOrder({ work_order: { ...base, status: 'COMPLETED' } }));
ok('no work_order key -> released (every pre-existing row unaffected)', !isBlockedByWorkOrder({ partnerLineItems: [] }));
ok('null payload -> released', !isBlockedByWorkOrder(null) && !isBlockedByWorkOrder(undefined));
ok('malformed work_order (no ids array) -> treated as absent, NOT as blocked forever', readWorkOrderState({ work_order: { status: 'IN_PROGRESS' } }) === null);

// --- the observability test's ledger invariant must still hold: every `continue` in the loop has a push ---
const loopBody = src.slice(loopStart, src.indexOf('\n  }\n', fire));
const continues = (loopBody.match(/continue;/g) || []).length;
const pushes = (loopBody.match(/result\.skipped\.push\(/g) || []).length;
ok(`every continue in the loop is ledgered (${continues} continues, ${pushes} pushes)`, pushes >= continues, `continues=${continues} pushes=${pushes}`);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
