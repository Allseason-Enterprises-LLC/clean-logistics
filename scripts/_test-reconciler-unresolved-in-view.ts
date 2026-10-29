/**
 * Reconciler must never lose sight of an unresolved FBA bridge because it aged
 * out of the lookback window (TR-00490/00491, 2026-10-06: WOs completed on day
 * 9, row invisible, nothing fired). Run: npx tsx scripts/_test-reconciler-unresolved-in-view.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { UNRESOLVED_HANDOFF_STATUSES } from '../lib/fba-reconciler';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');
const fn = src.slice(src.indexOf('async function findCandidates'), src.indexOf('\n}\n', src.indexOf('async function findCandidates')) + 3);

ok('🔴 findCandidates runs a SECOND query for rows OLDER than the lookback', /\.lt\('synced_at', since\)/.test(fn));
// 2026-10-29: widened to STALE_ELIGIBLE (= UNRESOLVED + work_order_failed/voided_by_user) so
// retireStaleRows can age those out too; the WO gate stops any of them from firing.
ok('…restricted to unresolved-or-stale-eligible handoff statuses (never resolved ones)', /\.in\('last_fba_handoff_status', \[\.\.\.STALE_ELIGIBLE_STATUSES\]\)/.test(fn));
ok('unresolved set covers the states a parked/released/failed row can be in', ['pending', 'awaiting_work_order', 'awaiting_listing', 'handoff_failed', 'dispatch_failed'].every((s) => (UNRESOLVED_HANDOFF_STATUSES as readonly string[]).includes(s)));
ok('unresolved set does NOT include dispatched/handoff_ok (resolved rows must age out normally)', !['dispatched', 'handoff_ok', 'ok'].some((s) => (UNRESOLVED_HANDOFF_STATUSES as readonly string[]).includes(s)));
ok('results are de-duplicated by row id before the FBA-destination filter', /seen\.has\(r\.id\)/.test(fn) && fn.indexOf('seen.has') < fn.indexOf('isFbaDestination'));
ok('old-but-unresolved rows are logged by transfer number (visible in the ledger)', /unresolved FBA bridge\(s\) older than/.test(fn));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
