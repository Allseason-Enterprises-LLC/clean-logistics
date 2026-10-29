/**
 * Unresolved bridge rows older than STALE_UNRESOLVED_DAYS are retired, never worked.
 * WOs 173636-40 (10/15) and 179440 for TR-00331 (10/28) were raised for transfers that
 * shipped in June/August. Run: npx tsx scripts/_test-reconciler-stale-retire.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { isStaleUnresolved, STALE_UNRESOLVED_DAYS, UNRESOLVED_HANDOFF_STATUSES } from '../lib/fba-reconciler';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const NOW = Date.parse('2026-10-28T17:00:00Z');
const d = (days: number) => new Date(NOW - days * 86400000).toISOString();

ok('TR-00331 shape (synced 08-08, awaiting_work_order) is stale', isStaleUnresolved({ synced_at: '2026-08-08T00:20:28Z', last_fba_handoff_status: 'awaiting_work_order' }, NOW));
ok('9-day-old awaiting_work_order (Wendy\'s TR-00490 case) is NOT stale — still fires', !isStaleUnresolved({ synced_at: d(9), last_fba_handoff_status: 'awaiting_work_order' }, NOW));
ok('exactly at the boundary is not stale; one day past is', !isStaleUnresolved({ synced_at: d(STALE_UNRESOLVED_DAYS), last_fba_handoff_status: 'pending' }, NOW) && isStaleUnresolved({ synced_at: d(STALE_UNRESOLVED_DAYS + 1), last_fba_handoff_status: 'pending' }, NOW));
ok('every unresolved status is eligible', UNRESOLVED_HANDOFF_STATUSES.every((s) => isStaleUnresolved({ synced_at: d(60), last_fba_handoff_status: s }, NOW)));
ok('work_order_failed (WO cancelled, TR-00331 after 10/28) ages out too', isStaleUnresolved({ synced_at: d(80), last_fba_handoff_status: 'work_order_failed' }, NOW));
ok('resolved rows are never retired, however old', !isStaleUnresolved({ synced_at: d(400), last_fba_handoff_status: 'dispatched' }, NOW) && !isStaleUnresolved({ synced_at: d(400), last_fba_handoff_status: 'stale_retired' }, NOW));
ok('missing synced_at is never retired', !isStaleUnresolved({ synced_at: null, last_fba_handoff_status: 'pending' }, NOW));

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');
ok('🔴 findCandidates passes its result through retireStaleRows (retire BEFORE preflight/fire)', /return retireStaleRows\(db, all\.filter/.test(src));
ok('retire writes stale_retired with a revive instruction, guarded on the status it read', /last_fba_handoff_status: 'stale_retired'[\s\S]{0,400}\.eq\('last_fba_handoff_status', r\.last_fba_handoff_status\)/.test(src) && /pending' to revive/.test(src));
ok('retire notice goes through the ONE sender and says no work orders raised', /sendFbaTelegram\([\s\S]{0,300}No work orders raised/.test(src));
const fn = src.slice(src.indexOf('async function retireStaleRows'), src.indexOf('async function findCandidates'));
ok('retired rows are not returned as candidates (only kept on update error)', /if \(!isStaleUnresolved\(r\)\) \{ keep\.push\(r\); continue; \}/.test(fn) && /if \(error\) \{[^\n]*keep\.push\(r\); continue; \}/.test(fn) && /retired\.push\(/.test(fn) && /return keep;/.test(fn) && !/retired\.push[\s\S]*keep\.push\(r\)/.test(fn));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
