/**
 * CIN7 Reference: a NOTE must not rename the order; only an order-number-shaped value is an override.
 * Run: npx tsx scripts/_test-reference-note-vs-override.ts
 */
import { buildShipHeroOrderNumber, isReferenceAnOverride } from '../lib/order-naming';
let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const base = { transferNumber: 'TR-00484', destinationName: 'Amazon FBA Warehouse', skus: ['CN-BDL-CAP-NMNSUPP-60CT-2PK'] };

// the real TR-00484 case
const n = buildShipHeroOrderNumber({ ...base, reference: 'FBA B0HJN6KKVK - Cellnova 2PK bundle' });
ok(`🔴 TR-00484 note -> derived AMZ_ name, not REF_  (${n})`, n.startsWith('AMZ_') && !n.startsWith('REF_') && n.endsWith('00484'));
ok('note is NOT an override', !isReferenceAnOverride('FBA B0HJN6KKVK - Cellnova 2PK bundle'));
ok('bare ASIN is NOT an override', !isReferenceAnOverride('B0HJN6KKVK'));
ok('prose is NOT an override', !isReferenceAnOverride('rush this one please'));
ok('"Amazon FBA" is NOT an override', !isReferenceAnOverride('Amazon FBA'));
ok('empty/whitespace is NOT an override', !isReferenceAnOverride('') && !isReferenceAnOverride('   ') && !isReferenceAnOverride(null));

// deliberate overrides still work (existing tests in _test-order-naming rely on these)
ok('AMZ_BUNDLE-Q4_TR-00477 IS an override', isReferenceAnOverride('AMZ_BUNDLE-Q4_TR-00477'));
ok('AMZ_HOLIDAY-BUNDLE IS an override', isReferenceAnOverride('AMZ_HOLIDAY-BUNDLE'));
ok('TIK_SPLIT-B IS an override', isReferenceAnOverride('TIK_SPLIT-B'));
const o = buildShipHeroOrderNumber({ ...base, reference: 'AMZ_HOLIDAY-BUNDLE' });
ok(`override still honoured + TR appended (${o})`, o === 'AMZ_HOLIDAY-BUNDLE_TR-00484');
ok('lowercase xxx_ is NOT an override (platform codes are upper)', !isReferenceAnOverride('abc_note'));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
