/**
 * 2026-10-01 trio — every successful first-attempt run left its row at `draft`;
 * the handoff called HTTP 200 "dispatched" even when every item failed; the
 * reconciler retried unfixable data errors forever.
 * Run: npx tsx scripts/_test-row-status-and-handoff-verdict.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { classifyAutoSubmitResponse } from '../lib/cin7-fba-handoff';
import { isPermanentConfigError, configErrorHint } from '../lib/fba-reconciler';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// ───── 1. auto-submit: the reservation row must become THE record on the normal path ─────
const src = fs.readFileSync(path.join(__dirname, '../api/fba/auto-submit.ts'), 'utf8');
const normalBind = src.indexOf('// Normal path: bind the plan_id + dims to our reserved row.');
const fallbackEnd = src.indexOf('return;', src.indexOf('onPlanCreated fallback threw'));
const normalBlock = src.slice(normalBind, src.indexOf('};', normalBind));
ok('normal path exists after the fallback branch', normalBind > fallbackEnd && normalBind > 0);
ok('🔴 normal path assigns earlyRecordId = reservationId on successful bind', /else \{[\s\S]{0,1200}earlyRecordId = reservationId;/.test(normalBlock));
ok('assignment is inside the success branch (not on updErr)', normalBlock.indexOf('earlyRecordId = reservationId') > normalBlock.indexOf('Bind plan_id to reservation failed'));
const persist = src.slice(src.indexOf('let fbaRecordId: string | null = earlyRecordId;'), src.indexOf('let postProcess: any = null;'));
ok('persistence step still uses earlyRecordId → UPDATE to plan_created (not a fresh insert)', /if \(earlyRecordId\) \{[\s\S]{0,400}status: 'plan_created'/.test(persist));
ok('labels_ready write is still gated on fbaRecordId (now non-null on the normal path)', /if \(fbaRecordId\) \{[\s\S]{0,300}status: 'labels_ready'/.test(src));
ok('cites the incident', src.includes('TR-00502/00497..00501/00507'));

// ───── 2. handoff: HTTP 200 is a ledger, not a verdict ─────
const sixFails = { processed: 1, successful: 0, failed: 1, deferred: 0, results: [{ sku: 'CN-BDL-CAP-CARDIOZEN-60BG-2PK', status: 'failed', error: 'No Amazon SKU mapping found for CN-BDL-CAP-CARDIOZEN-60BG-2PK' }] };
let v = classifyAutoSubmitResponse(sixFails);
ok('🔴 all-failed 200 → handoff_failed', v.status === 'handoff_failed');
ok('…and the detail names the real error', v.detail.includes('No Amazon SKU mapping found'));
v = classifyAutoSubmitResponse({ processed: 1, successful: 1, failed: 0, deferred: 0, results: [{ status: 'success' }] });
ok('1 created → dispatched with counts', v.status === 'dispatched' && v.detail.includes('1 created'));
v = classifyAutoSubmitResponse({ processed: 3, successful: 2, failed: 0, deferred: 1, results: [] });
ok('deferred (self-chain) with nothing failed → dispatched', v.status === 'dispatched');
v = classifyAutoSubmitResponse({ processed: 3, successful: 1, failed: 2, deferred: 0, results: [{ status: 'failed', error: 'x' }] });
ok('partial success → dispatched (something was created; dedup guards the rest)', v.status === 'dispatched');
v = classifyAutoSubmitResponse({ processed: 2, successful: 0, failed: 0, deferred: 0, results: [{ status: 'skipped' }, { status: 'skipped' }] });
ok('all skipped (already in-flight) → dispatched, not failed', v.status === 'dispatched');
v = classifyAutoSubmitResponse(null);
ok('no body → dispatched (legacy / unknown ≠ bad)', v.status === 'dispatched' && v.detail === 'auto-submit returned 200');
v = classifyAutoSubmitResponse({ ok: true });
ok('body without a ledger → dispatched', v.status === 'dispatched');
const hsrc = fs.readFileSync(path.join(__dirname, '../lib/cin7-fba-handoff.ts'), 'utf8');
ok('fireFbaAutoSubmit records the verdict, not a constant', /const verdict = classifyAutoSubmitResponse\(json\);\s*await recordHandoffDispatch\(input\.cin7TransferNumber, verdict\.status, verdict\.detail\)/.test(hsrc));
ok("recordHandoffDispatch accepts 'handoff_failed'", /'dispatched' \| 'dispatch_failed' \| 'handoff_failed'/.test(hsrc));
ok("the constant 'auto-submit returned 200' is no longer written on the 200 path", !/recordHandoffDispatch\(input\.cin7TransferNumber, 'dispatched', 'auto-submit returned 200'\)/.test(hsrc));

// ───── 3. reconciler: data errors are permanent-until-human ─────
ok('🔴 "No Amazon SKU mapping" is a permanent error (capped + escalated)', isPermanentConfigError('auto-submit 200 but 1/1 item(s) FAILED: No Amazon SKU mapping found for X'));
ok('🔴 "not available for inbound" is a permanent error', isPermanentConfigError('createInboundPlan failed: MSKUs are not available for inbound. MSKUs: [X]'));
ok('HTTP 401 still permanent', isPermanentConfigError('HTTP 401: {"error":"Unauthorized"}'));
ok('transient errors are NOT permanent (keep retrying)', !isPermanentConfigError('aborted after 30s — auto-submit still running independently') && !isPermanentConfigError('fetch error: socket hang up') && !isPermanentConfigError('HTTP 500: createInboundPlan failed: ServiceUnavailable'));
ok('hint for mapping error points at sku_master + listings report', /sku_master/.test(configErrorHint('No Amazon SKU mapping found')) && /listings report/i.test(configErrorHint('No Amazon SKU mapping found')));
ok('hint for inbound-availability points at Seller Central barcode/offer', /Seller Central/.test(configErrorHint('not available for inbound')) && /barcode/i.test(configErrorHint('not available for inbound')));
ok('hint for 401 is unchanged in meaning', /CRON_SECRET/.test(configErrorHint('HTTP 401')));
const rsrc = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');
ok('capped alert uses configErrorHint (no hardcoded 401 text)', /configErrorHint\(row\.last_fba_handoff_detail\)/.test(rsrc) && !/A 401\/403 means the self-POST is hitting a Deployment-Protection-walled `\s*\+/.test(rsrc.slice(rsrc.indexOf('const msg ='))));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
