/**
 * TR-00474 regression: never attach labels to a CANCELLED ShipHero order.
 * Run: npx tsx scripts/_test-live-order-resolution.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-post-process.ts'), 'utf8');

ok('isCancelledStatus helper exists', src.includes('function isCancelledStatus'));
ok('queries fulfillment_status in the exact lookup', /orders\(order_number[\s\S]{0,260}fulfillment_status/.test(src));
ok('queries fulfillment_status in the scan', /orders\(created_from[\s\S]{0,300}fulfillment_status/.test(src));
ok('scan does NOT use the invalid sort arg', !/orders\(sort:/.test(src));
ok('scan filters dead orders server-side', src.includes('fulfillment_status_not_in'));
ok('exact lookup filters out cancelled', /const live = nodes\.find\([\s\S]{0,120}!isCancelledStatus/.test(src));
ok('scan filters out cancelled', /extractTransferNumber\(e\?\.node\?\.order_number\) === tr &&[\s\S]{0,80}!isCancelledStatus/.test(src));

// Ordering matters: the TR scan must precede the legacy CIN7-<TR> fallback,
// because after a cancel+replace the legacy name IS the dead order.
const scanIdx = src.indexOf('by TR scan');
const legacyIdx = src.indexOf('last resort: the legacy name');
ok('TR scan runs BEFORE the legacy fallback', scanIdx > 0 && legacyIdx > scanIdx, `scan@${scanIdx} legacy@${legacyIdx}`);

// Behavioural: replicate the predicate against the real statuses seen.
const isCancelled = (s: string | null | undefined) => {
  const v = String(s || '').toLowerCase();
  return v.includes('cancel') || v.includes('void');
};
ok("detects ShipHero's 'canceled' (one L)", isCancelled('canceled'));
ok("detects 'cancelled' (two Ls)", isCancelled('cancelled'));
ok('detects CANCELED uppercase', isCancelled('CANCELED'));
ok('detects voided', isCancelled('voided'));
ok('pending is NOT cancelled', !isCancelled('pending'));
ok('fulfilled is NOT cancelled', !isCancelled('fulfilled'));
ok('null is NOT cancelled', !isCancelled(null));

// The exact TR-00474 scenario: two orders share the TR token; pick the live one.
const orders = [
  { order_number: 'CIN7-TR-00474', fulfillment_status: 'canceled' },
  { order_number: 'AMZ_CN-CAP-VBIOTIC-90CT_TR-00474', fulfillment_status: 'pending' },
];
const trOf = (s: string) => (s.match(/TR-\d{3,}/i) || [null])[0];
const picked = orders.find((o) => trOf(o.order_number) === 'TR-00474' && !isCancelled(o.fulfillment_status));
ok('TR-00474 scenario picks the LIVE replacement order',
   picked?.order_number === 'AMZ_CN-CAP-VBIOTIC-90CT_TR-00474', String(picked?.order_number));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
