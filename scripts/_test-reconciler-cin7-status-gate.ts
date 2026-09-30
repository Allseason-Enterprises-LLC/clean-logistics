/**
 * The reconciler must NEVER fire a transfer whose LIVE CIN7 status is not
 * fireable (DRAFT / VOIDED / COMPLETED / unreadable). 2026-09-30: TR-00479
 * was pulled back to DRAFT in CIN7; the reconciler trusted its cached
 * `synced` row and fired 2,040 units Amazon expected and CIN7 never authorised.
 * Run: npx tsx scripts/_test-reconciler-cin7-status-gate.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { isCin7StatusFireable, readLiveCin7Status, CIN7_FIREABLE_STATUSES } from '../lib/fba-reconciler';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

async function main() {
  // --- predicate ---
  for (const s of ['IN TRANSIT', 'in transit', 'AUTHORISED', 'AUTHORIZED', 'ORDERED', 'PICKING', 'PACKED', 'NOT RECEIVED', ' In Transit ']) {
    ok(`CIN7 ${JSON.stringify(s)} -> fireable`, isCin7StatusFireable(s));
  }
  for (const s of ['DRAFT', 'Draft', 'VOIDED', 'VOID', 'COMPLETED', 'RECEIVED', 'CANCELLED', '', null, undefined, 'UNREADABLE']) {
    ok(`🔴 CIN7 ${JSON.stringify(s)} -> NOT fireable`, !isCin7StatusFireable(s as any));
  }
  ok('fireable set mirrors the sync eligibility list exactly', [...CIN7_FIREABLE_STATUSES].sort().join('|') === ['AUTHORISED', 'AUTHORIZED', 'ORDERED', 'PICKING', 'PACKED', 'IN TRANSIT', 'NOT RECEIVED'].sort().join('|'));

  // --- live read: uses TaskID from rawTransfer, falls back to cin7_transfer_id, fails CLOSED ---
  const asked: string[] = [];
  const fake = async (id: string) => { asked.push(id); if (id === 'bad') throw new Error('CIN7 500'); return { Status: id === 'draft-id' ? 'DRAFT' : 'IN TRANSIT' }; };
  ok('reads Status via rawTransfer.TaskID', (await readLiveCin7Status({ request_payload: { rawTransfer: { TaskID: 'tid-1' } } }, fake)) === 'IN TRANSIT' && asked[0] === 'tid-1');
  ok('falls back to cin7_transfer_id when rawTransfer missing', (await readLiveCin7Status({ request_payload: {}, cin7_transfer_id: 'tid-2' }, fake)) === 'IN TRANSIT' && asked[1] === 'tid-2');
  ok('🔴 DRAFT comes back as DRAFT (the TR-00479 shape)', (await readLiveCin7Status({ cin7_transfer_id: 'draft-id' }, fake)) === 'DRAFT');
  ok('🔴 CIN7 error -> null (fail CLOSED, never throws into the loop)', (await readLiveCin7Status({ cin7_transfer_id: 'bad' }, fake)) === null);
  const before = asked.length;
  ok('no id at all -> null without calling CIN7', (await readLiveCin7Status({ request_payload: {} }, fake)) === null && asked.length === before);

  // --- placement in the reconciler loop: AFTER the zero-I/O gates, BEFORE any fire path ---
  const src = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');
  const loopStart = src.indexOf('for (const row of candidates)');
  const gate = src.indexOf('isCin7StatusFireable(liveCin7)', loopStart);
  const existsCheck = src.indexOf('fbaRecordExists(db, row.cin7_transfer_number)', loopStart);
  const retryDecision = src.indexOf('shouldRetryNow(row)', loopStart);
  const fire = src.indexOf('fireFbaAutoSubmit(', loopStart);
  ok('CIN7 gate is inside the row loop', gate > loopStart);
  ok('CIN7 gate runs AFTER the dedup check (no CIN7 call for rows that already shipped)', gate > existsCheck);
  ok('🔴 CIN7 gate runs BEFORE shouldRetryNow / any fire path', gate < retryDecision && gate < fire);
  const block = src.slice(gate, retryDecision);
  ok('gate pushes to skipped[] with reason cin7_status_not_fireable and the live status', /cin7_status_not_fireable/.test(block) && /liveCin7 \?\? 'UNREADABLE'/.test(block));
  ok('gate ends with continue', /continue;\s*\}/.test(block));
  ok('candidate select includes cin7_transfer_id (fallback id for the live read)', /select\(\s*'id, cin7_transfer_number, cin7_transfer_id,/.test(src));
  ok('readCin7Status is injectable via options (tests stay offline)', /readCin7Status\?: \(row: any\) => Promise<string \| null>/.test(src));

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
