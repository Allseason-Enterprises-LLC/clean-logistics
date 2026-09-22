/**
 * Tests for the descriptive ShipHero order-number scheme.
 * Run: npx tsx scripts/_test-order-naming.ts
 */
import {
  buildShipHeroOrderNumber,
  resolvePlatformCode,
  extractTransferNumber,
  bareTransferNumber,
  UNKNOWN_PLATFORM_CODE,
} from '../lib/order-naming';

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got:  ${got}\n        want: ${want}`}`);
}

console.log('--- platform codes (real CIN7 destination strings) ---');
eq('Amazon FBA Warehouse -> AMZ', resolvePlatformCode('Amazon FBA Warehouse'), 'AMZ');
eq('TikTok Warehouse -> TIK', resolvePlatformCode('TikTok Warehouse'), 'TIK');
eq('TikTok Warehouse - FC36_ONT10 -> TIK', resolvePlatformCode('TikTok Warehouse - FC36_ONT10'), 'TIK');
eq('iHerb -> HRB', resolvePlatformCode('iHerb Distribution'), 'HRB');
eq('Target -> TAR', resolvePlatformCode('Target DC'), 'TAR');
eq('Walmart -> WMT', resolvePlatformCode('Walmart Fulfillment'), 'WMT');
eq('unknown -> XXX', resolvePlatformCode('Some New Partner'), UNKNOWN_PLATFORM_CODE);
eq('null -> XXX', resolvePlatformCode(null), UNKNOWN_PLATFORM_CODE);
// The reason we don't use slice(0,3):
eq('slice(0,3) would be wrong for Amazon', 'Amazon FBA Warehouse'.slice(0, 3).toUpperCase() === 'AMZ', false);

console.log('\n--- the requested format ---');
eq(
  'AMZ_CN-CAP-SAFFRON-60CT_TR-00477',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00477',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['CN-CAP-SAFFRON-60CT'],
  }),
  'AMZ_CN-CAP-SAFFRON-60CT_TR-00477'
);
eq(
  'tolerates a CIN7- prefixed input',
  buildShipHeroOrderNumber({
    transferNumber: 'CIN7-TR-00477',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['CN-CAP-SAFFRON-60CT'],
  }),
  'AMZ_CN-CAP-SAFFRON-60CT_TR-00477'
);
eq(
  'TikTok transfer',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00480',
    destinationName: 'TikTok Warehouse - FC02_ORD1',
    skus: ['CN-GUM-SHILAJITGU-60CT'],
  }),
  // 35 chars with everything, so the constant `TR-` is dropped first — which
  // keeps the full SKU readable. Only if that were still >32 would `CN-` go too.
  'TIK_CN-GUM-SHILAJITGU-60CT_00480'
);

console.log('\n--- COLLISION SAFETY (the reason the TR suffix exists) ---');
// CN-POW-WMNSCREATIORA-30SV really shipped on 5 different transfers.
const repeats = ['TR-00266', 'TR-00272', 'TR-00340', 'TR-00370', 'TR-00458'].map((tr) =>
  buildShipHeroOrderNumber({
    transferNumber: tr,
    destinationName: 'Amazon FBA Warehouse',
    skus: ['CN-POW-WMNSCREATIORA-30SV'],
  })
);
eq('5 transfers of the same SKU -> 5 distinct names', new Set(repeats).size, 5);

console.log('\n--- multi-SKU + edge cases ---');
eq(
  'multi-SKU is labelled, not truncated to one SKU',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00045',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['A-1', 'B-2', 'C-3'],
  }),
  'AMZ_MULTI-3SKU_TR-00045'
);
eq(
  'duplicate SKUs across lines collapse to single-SKU',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00100',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['CN-X-1', 'CN-X-1', 'CN-X-1'],
  }),
  'AMZ_CN-X-1_TR-00100'
);
eq(
  'no SKUs -> platform + TR',
  buildShipHeroOrderNumber({ transferNumber: 'TR-00101', destinationName: 'Amazon FBA Warehouse', skus: [] }),
  'AMZ_TR-00101'
);
eq(
  'null/empty SKU entries ignored',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00102',
    destinationName: 'Amazon FBA Warehouse',
    skus: [null, '', undefined, 'CN-Y-2'],
  }),
  'AMZ_CN-Y-2_TR-00102'
);

console.log('\n--- CIN7 Reference override ---');
eq(
  'reference wins verbatim when it already carries the TR',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00477',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['CN-CAP-SAFFRON-60CT'],
    reference: 'AMZ_BUNDLE-Q4_TR-00477',
  }),
  'AMZ_BUNDLE-Q4_TR-00477'
);
eq(
  'reference without a TR gets one appended (traceability)',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00477',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['CN-CAP-SAFFRON-60CT'],
    reference: 'AMZ_HOLIDAY-BUNDLE',
  }),
  'AMZ_HOLIDAY-BUNDLE_TR-00477'
);
eq(
  'whitespace-only reference is ignored, falls back to derived',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00477',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['CN-CAP-SAFFRON-60CT'],
    reference: '   ',
  }),
  'AMZ_CN-CAP-SAFFRON-60CT_TR-00477'
);
eq(
  'unsafe characters in reference are sanitized',
  buildShipHeroOrderNumber({
    transferNumber: 'TR-00477',
    destinationName: 'Amazon FBA Warehouse',
    skus: ['X'],
    reference: 'AMZ Rush!! /special\\ order',
  }),
  'AMZ-Rush-special-order_TR-00477'
);

console.log('\n--- backward compatibility: resolving old AND new names ---');
eq('legacy CIN7-TR-00477', extractTransferNumber('CIN7-TR-00477'), 'TR-00477');
eq('new descriptive name', extractTransferNumber('AMZ_CN-CAP-SAFFRON-60CT_TR-00477'), 'TR-00477');
eq('per-lot child order', extractTransferNumber('CIN7-TR-00477-2509027'), 'TR-00477');
eq('custom reference containing TR', extractTransferNumber('AMZ_BUNDLE-Q4_TR-00477'), 'TR-00477');
eq('bare TR', extractTransferNumber('TR-00477'), 'TR-00477');
eq('unrelated order number -> null', extractTransferNumber('MANUAL-ORDER-9'), null);
eq('null -> null', extractTransferNumber(null), null);
eq('bareTransferNumber strips prefix', bareTransferNumber('CIN7-TR-00477'), 'TR-00477');
eq('bareTransferNumber idempotent', bareTransferNumber('TR-00477'), 'TR-00477');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
