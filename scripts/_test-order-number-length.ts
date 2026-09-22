/**
 * ShipHero caps order numbers at 32 chars. Verify EVERY name fits, the TR token
 * always survives, and truncation does not create collisions.
 * Run: npx tsx scripts/_test-order-number-length.ts
 */
import {
  buildShipHeroOrderNumber,
  extractTransferNumber,
  SHIPHERO_ORDER_NUMBER_MAX,
} from '../lib/order-naming';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const AMZ = 'Amazon FBA Warehouse';

// The 14 real transfers from the 2026-09-21 recovery (12 previously over limit).
const real: Array<[string, string]> = [
  ['TR-00448', 'CN-GUM-EYEHEALTH-60BG'],
  ['TR-00459', 'CN-CAP-SAFFRON-60CT'],
  ['TR-00460', 'CN-CAP-PHYTOFRESH-60CT'],
  ['TR-00462', 'CN-CAP-8IN1IMMUNE-60CT'],
  ['TR-00463', 'CN-CAP-SLIPPERYEL-90CT'],
  ['TR-00464', 'CN-CAP-5IN1IMMUNE-120BG'],
  ['TR-00465', 'CN-CAP-ASHWAMACAF-120BG'],
  ['TR-00466', 'CN-CAP-LUNGFLOW-90CT'],
  ['TR-00468', 'CN-CAP-NITRICOXID-120CT'],
  ['TR-00472', 'CN-CAP-MENSHAIRFO-60CT'],
  ['TR-00474', 'CN-CAP-VBIOTIC-90CT'],
  ['TR-00475', 'CN-DRP-SOURSOPDEF-4OZ'],
  ['TR-00476', 'CN-DRP-SLEEPFORMULA-4OZ'],
  ['TR-00477', 'CN-DRP-VAGINALPRO-2OZ'],
];

console.log('--- the 14 recovery transfers');
const names: string[] = [];
for (const [tr, sku] of real) {
  const n = buildShipHeroOrderNumber({ transferNumber: tr, destinationName: AMZ, skus: [sku] });
  names.push(n);
  const fits = n.length <= SHIPHERO_ORDER_NUMBER_MAX;
  const keepsTr = extractTransferNumber(n) === tr;
  ok(`${n.padEnd(34)} len=${String(n.length).padEnd(3)} fits & keeps TR`, fits && keepsTr,
     `fits=${fits} keepsTr=${keepsTr}`);
}

// Truncation must not collide: 14 distinct SKUs -> 14 distinct names.
ok('all 14 names are unique after truncation', new Set(names).size === 14,
   `${new Set(names).size} unique`);

console.log('\n--- pathological inputs');
const cases: Array<[string, any]> = [
  ['very long SKU', { transferNumber: 'TR-00999', destinationName: AMZ, skus: ['CN-CAP-SUPERCALIFRAGILISTIC-EXPIALIDOCIOUS-240CT'] }],
  ['multi-SKU', { transferNumber: 'TR-00045', destinationName: AMZ, skus: ['A-1', 'B-2', 'C-3'] }],
  ['no SKU', { transferNumber: 'TR-00100', destinationName: AMZ, skus: [] }],
  ['TikTok dest', { transferNumber: 'TR-00200', destinationName: 'TikTok Shop US Warehouse', skus: ['CN-CAP-ASHWAMACAF-120BG'] }],
  ['long ops reference', { transferNumber: 'TR-00300', destinationName: AMZ, reference: 'SPECIAL-HANDLING-BUNDLE-FOR-Q4-PROMO-2026' }],
  ['unknown dest', { transferNumber: 'TR-00400', destinationName: 'Some Brand New Place', skus: ['CN-DRP-SLEEPFORMULA-4OZ'] }],
];
for (const [label, input] of cases) {
  const n = buildShipHeroOrderNumber(input);
  const fits = n.length <= SHIPHERO_ORDER_NUMBER_MAX;
  const keepsTr = extractTransferNumber(n) === input.transferNumber;
  ok(`${label}: ${n} (len=${n.length})`, fits && keepsTr, `fits=${fits} keepsTr=${keepsTr}`);
}

// Regression: the two that already fit must be UNCHANGED (keep their TR-).
ok('TR-00459 name unchanged',
   buildShipHeroOrderNumber({ transferNumber: 'TR-00459', destinationName: AMZ, skus: ['CN-CAP-SAFFRON-60CT'] })
     === 'AMZ_CN-CAP-SAFFRON-60CT_TR-00459');
ok('TR-00474 name unchanged',
   buildShipHeroOrderNumber({ transferNumber: 'TR-00474', destinationName: AMZ, skus: ['CN-CAP-VBIOTIC-90CT'] })
     === 'AMZ_CN-CAP-VBIOTIC-90CT_TR-00474');

console.log('\n--- peel order: TR- dropped BEFORE any SKU trimming');
// Stage 2: dropping the constant "TR-" is enough, so the FULL SKU survives.
ok('TR-00460 keeps its full SKU (TR- dropped)',
   buildShipHeroOrderNumber({ transferNumber: 'TR-00460', destinationName: AMZ, skus: ['CN-CAP-PHYTOFRESH-60CT'] })
     === 'AMZ_CN-CAP-PHYTOFRESH-60CT_00460');
ok('TR-00463 keeps its full SKU (TR- dropped)',
   buildShipHeroOrderNumber({ transferNumber: 'TR-00463', destinationName: AMZ, skus: ['CN-CAP-SLIPPERYEL-90CT'] })
     === 'AMZ_CN-CAP-SLIPPERYEL-90CT_00463');
// Stage 3: only when dropping TR- alone is still too long does CN- go too.
ok('TR-00464 also drops CN- (still too long at stage 2)',
   buildShipHeroOrderNumber({ transferNumber: 'TR-00464', destinationName: AMZ, skus: ['CN-CAP-5IN1IMMUNE-120BG'] })
     === 'AMZ_CAP-5IN1IMMUNE-120BG_00464');
// No SKU should ever need character-level truncation on the live fleet.
const fullSkuKept = real.filter(([tr, sku]) =>
  buildShipHeroOrderNumber({ transferNumber: tr, destinationName: AMZ, skus: [sku] }).includes(sku)
).length;
ok(`${fullSkuKept}/14 keep their COMPLETE SKU (expect 10)`, fullSkuKept === 10, String(fullSkuKept));

console.log('\n--- extractTransferNumber must resolve ALL generations');
const resolves: Array<[string, string | null]> = [
  ['AMZ_CN-CAP-PHYTOFRESH-60CT_00460', 'TR-00460'],
  ['AMZ_CAP-5IN1IMMUNE-120BG_00464', 'TR-00464'],
  ['AMZ_CN-CAP-SAFFRON-60CT_TR-00459', 'TR-00459'],
  ['CIN7-TR-00460', 'TR-00460'],
  ['CIN7-TR-00459-2510014A', 'TR-00459'],
  ['TIK_GUM-SHILAJITGU-60CT_TR-00480', 'TR-00480'],
  ['AMZ_MULTI-3SKU_TR-00045', 'TR-00045'],
  // must NOT be mistaken for a transfer number
  ['FBA19QPCSL4C', null],
  ['2510014A', null],
  ['AMZ_CN-CAP-LUNGFLOW-90CT', null],
  ['AMZ_CN-CAP-OMEGA3-1000', null],
];
for (const [input, expected] of resolves) {
  const got = extractTransferNumber(input);
  ok(`extract("${input}") -> ${got}`, got === expected, `expected ${expected}`);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
