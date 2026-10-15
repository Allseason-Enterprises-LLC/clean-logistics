/**
 * A sync that fails must (a) adopt an existing live order when the only problem is
 * the name, and (b) otherwise post a notice — never a silent `failed` row.
 * 2026-10-15: TR-00595/00597/00504 — 6,000+ units, days, no signal.
 * Run: npx tsx scripts/_test-sync-failed-is-loud.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { isOrderAlreadyExists, buildSyncFailedNotice } from '../lib/shiphero-orders';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

ok('recognises ShipHero duplicate-name refusal', isOrderAlreadyExists("ShipHero GraphQL errors: A order for the shop 'public-api' with order number 'AMZ_CN-CAP-SAFFRON-60CT_TR-00595' already exists"));
ok('does not treat other errors as duplicates', !isOrderAlreadyExists('not enough credits') && !isOrderAlreadyExists('Invalid Product'));

const n = buildSyncFailedNotice('TR-00595', 'AMZ_CN-CAP-SAFFRON-60CT_TR-00595', 'boom <x> & y');
ok('notice names the transfer and the order', n.includes('TR-00595') && n.includes('AMZ_CN-CAP-SAFFRON-60CT_TR-00595'));
ok('notice tells the warehouse there is nothing for them to do', /Warehouse: no action/.test(n));
ok('notice is HTML-escaped (Telegram HTML rejects raw < &)', n.includes('&lt;x&gt; &amp; y') && !/<x>/.test(n));

const src = fs.readFileSync(path.join(path.join(__dirname, '..'), 'lib/shiphero-orders.ts'), 'utf8');
const catchBlock = src.slice(src.indexOf("status: 'failed'") - 2500, src.indexOf("status: 'failed'") + 1200);
ok('🔴 on "already exists" the LIVE existing order is adopted (status synced, order id bound) before any failed write', /isOrderAlreadyExists\(message\)[\s\S]*findLiveOrderByNumber[\s\S]*status: 'synced'[\s\S]*shipheroOrderId: existing\.orderId[\s\S]*status: 'failed'/.test(catchBlock));
ok('🔴 a failed row is followed by a notice call, not just a throw', /status: 'failed'[\s\S]{0,600}notifySyncFailed\(cin7TransferNumber/.test(catchBlock));
ok('only non-cancelled orders are adopted', /fulfillment_status[\s\S]{0,400}!\/cancel\/i\.test/.test(src));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
