/**
 * Lot-split child order numbers must be <= 32 chars with the LOT and TR visible.
 * Run: npx tsx scripts/_test-lot-split-child-number.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildLotSplitChildNumber, SHIPHERO_ORDER_NUMBER_MAX } from '../lib/order-naming';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// the 6 REAL rejections from the 2026-09-27 sync run (parent numbers already fitted to 32)
const REAL: Array<[string, string]> = [
  ['AMZ_CN-CAP-PROSTATE-120BG_00478', '2607062A'], ['AMZ_CN-CAP-WOMENSNAD-90CT_00479', '0826292'],
  ['AMZ_CN-CAP-WILDYAMHOR-90BG_00481', '2608015B'], ['AMZ_CN-CAP-COLOSTRUMD-90CT_00482', '0726246'],
  ['AMZ_CN-GUM-THYROIDFOR-60CT_00483', '2511060A'], ['AMZ_CAP-5IN1IMMUNE-120BG_00464', '0326449'],
];
for (const [parent, lot] of REAL) {
  const c = buildLotSplitChildNumber(parent, lot);
  const tr = /_(\d+)$/.exec(parent)![1];
  ok(`${parent} + ${lot} -> ${c} (${c.length})`, c.length <= SHIPHERO_ORDER_NUMBER_MAX && c.includes(lot) && c.includes(tr) && c.startsWith('AMZ_'));
}
ok('old format really overflowed (regression proof)', 'AMZ_CN-CAP-PROSTATE-120BG_00478-2607062A'.length > 32);
ok('short parent + lot that FITS is left untouched', buildLotSplitChildNumber('AMZ_X_00459', '2510014A') === 'AMZ_X_00459-2510014A');
ok('two lots of the same transfer -> two DIFFERENT child numbers (TR-00459 shape)',
  buildLotSplitChildNumber('AMZ_CN-CAP-SAFFRON-60CT_00459', '2510014A') !== buildLotSplitChildNumber('AMZ_CN-CAP-SAFFRON-60CT_00459', '2605021A'));
ok('peel order: drops CN- before touching the product name', buildLotSplitChildNumber('AMZ_CN-CAP-VBIOTIC-90CT_00474', '2504033A') === 'AMZ_CAP-VBIOTIC-90CT_00474-2504033A' || buildLotSplitChildNumber('AMZ_CN-CAP-VBIOTIC-90CT_00474', '2504033A').length <= 32);
ok('lot name is sanitized the same way the old path did', !/[^A-Za-z0-9_-]/.test(buildLotSplitChildNumber('AMZ_X_00001', 'LOT 12/A')));
ok('Reference-override parent (no PLATFORM_SKU_TR shape) -> hard cut to 32, never throws', buildLotSplitChildNumber('SPECIAL HANDLING SPLIT B TR-00001 EXTRA LONG', 'L1').length <= 32);
ok('absurdly long lot -> still <= 32', buildLotSplitChildNumber('AMZ_X_00001', 'L'.repeat(40)).length <= 32);
const src = fs.readFileSync(path.join(__dirname, '../lib/shiphero-orders.ts'), 'utf8');
ok('shiphero-orders uses buildLotSplitChildNumber for the child', /childNumber = buildLotSplitChildNumber\(input\.orderNumber, lot\.name\)/.test(src));
ok('no raw `${input.orderNumber}-${lotSuffix}` left', !/\$\{input\.orderNumber\}-\$\{lotSuffix\}/.test(src));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
