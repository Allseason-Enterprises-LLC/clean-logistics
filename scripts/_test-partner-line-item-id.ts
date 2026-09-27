/**
 * partner_line_item_id must be <= 45 chars, unique per line, deterministic.
 * Run: npx tsx scripts/_test-partner-line-item-id.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildPartnerLineItemId } from '../lib/order-naming';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// the 5 REAL failures from the 2026-09-27 sync run
const REAL = ['AMZ_CN-GUM-THYROIDFOR-60CT_00483-2511060A', 'AMZ_CN-CAP-COLOSTRUMD-90CT_00482-0726246',
  'AMZ_CN-CAP-WILDYAMHOR-90BG_00481-2608015B', 'AMZ_CN-CAP-WOMENSNAD-90CT_00479-0826292', 'AMZ_CN-CAP-PROSTATE-120BG_00478-2607062A'];
for (const on of REAL) {
  const id = buildPartnerLineItemId(on, 0);
  ok(`${on} -> ${id} (${id.length} chars)`, id.length <= 45 && id.length > 0);
}
ok('old format really did overflow (regression proof)', `AMZ_CN-CAP-PROSTATE-120BG_00478-2607062A-line-1`.length > 45);
ok('lot suffix preserved: 00478-2607062A-L1', buildPartnerLineItemId('AMZ_CN-CAP-PROSTATE-120BG_00478-2607062A', 0) === '00478-2607062A-L1');
ok('no lot: 00477-L1', buildPartnerLineItemId('AMZ_CN-DRP-VAGINALPRO-2OZ_00477', 0) === '00477-L1');
ok('unique per line within an order', buildPartnerLineItemId('AMZ_X_00477', 0) !== buildPartnerLineItemId('AMZ_X_00477', 1));
ok('deterministic (idempotent re-create gets the same id)', buildPartnerLineItemId('AMZ_X_00477', 2) === buildPartnerLineItemId('AMZ_X_00477', 2));
ok('two lots of the SAME transfer get DIFFERENT ids (00459 had two lots)', buildPartnerLineItemId('AMZ_S_00459-2510014A', 0) !== buildPartnerLineItemId('AMZ_S_00459-2605021A', 0));
ok('legacy CIN7-TR-00477 (no _digits) -> still <=45 and non-empty', (() => { const id = buildPartnerLineItemId('CIN7-TR-00477', 0); return id.length <= 45 && id.length > 0; })());
ok('CIN7 Reference override with no TR digits -> truncated safely', buildPartnerLineItemId('A'.repeat(80), 0).length <= 45);
ok('empty order number -> still yields a valid id', buildPartnerLineItemId('', 0).length > 0);
// wiring
const src = fs.readFileSync(path.join(__dirname, '../lib/shiphero-orders.ts'), 'utf8');
ok('shiphero-orders uses buildPartnerLineItemId in BOTH order paths', (src.match(/buildPartnerLineItemId\(/g) || []).length === 2);
ok('no `-line-${idx` template left anywhere in shiphero-orders', !/-line-\$\{idx/.test(src));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
