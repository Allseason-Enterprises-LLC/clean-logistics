/**
 * Guard test: same-SKU CIN7 lines must be merged BEFORE lot allocation, and a
 * run that covers fewer units than ordered must raise a shortfall.
 *
 * INCIDENTS (all one week, all found by the floor counting labels):
 *   TR-00533   8 of  10 boxes   lines  911 + 349
 *   TR-00535   5 of  64 boxes   lines  500 + 300 + 300 + 5300
 *   TR-00566  12 of  26 boxes   lines 1080 + 1080 + 180
 *   TR-00567 392 of 834 boxes   lines 8220 + 16800
 *
 * Mechanism: auto-submit ran FEFO once PER LINE. Every line landed on the same
 * oldest lot, and every line after the first hit the (transfer, sku, lot)
 * dedup index -> 23505 -> `skipped`. The run still reported success.
 *
 * Each case below replays the REAL lot data from the day it fired through the
 * REAL allocator, and simulates the dedup index exactly as Postgres applies it.
 *
 * Run: npx tsx scripts/_test-same-sku-line-merge.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { allocateFefoByLot, mergeSameSkuItems, findShortfalls, type LotAvailability } from '../lib/lot-allocation';

let fails = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  -> ' + detail}`);
};
const TODAY = '2026-10-08';

/**
 * Simulate one auto-submit run: allocate each item, reserve (transfer, sku, lot)
 * the way the unique index does, and count units on lots that got a fresh row.
 * Returns boxes created and units covered.
 */
function simulateRun(items: Array<{ sku: string; quantity: number; lot?: string }>, lots: LotAvailability[], casePack: number) {
  const reserved = new Set<string>();
  let units = 0, boxes = 0, skipped = 0;
  for (const it of items) {
    const pool = it.lot ? lots.filter((l) => l.name === it.lot) : lots;
    for (const a of allocateFefoByLot(pool, it.quantity, casePack, TODAY)) {
      const key = `${it.sku}|${a.name}`;
      if (reserved.has(key)) { skipped++; continue; }   // 23505 -> skipped
      reserved.add(key);
      units += a.qty;
      boxes += a.cases;
    }
  }
  return { units, boxes, skipped };
}

type Case = { tr: string; sku: string; casePack: number; lines: number[]; lots: LotAvailability[]; oldBoxes: number; wantBoxes: number };
const CASES: Case[] = [
  {
    tr: 'TR-00533', sku: 'CN-CAP-8IN1IMMUNE-60CT', casePack: 126, lines: [911, 349],
    lots: [{ name: '2609020A', expiresAt: '2028-09-08', availableQty: 9932 }],
    oldBoxes: 8, wantBoxes: 10,
  },
  {
    tr: 'TR-00566', sku: 'CN-DRP-MUSHROOM-2OZ', casePack: 90, lines: [1080, 1080, 180],
    lots: [
      { name: '2502005', expiresAt: '2027-03-31', availableQty: 1150 },
      { name: '2512016', expiresAt: '2027-12-31', availableQty: 1080 },
      { name: '2601001', expiresAt: '2028-01-31', availableQty: 2280 },
    ],
    oldBoxes: 12, wantBoxes: 26,
  },
  {
    tr: 'TR-00567', sku: 'CN-POW-WMNSCREATIORA-30SV', casePack: 30, lines: [8220, 16800],
    lots: [
      // 60u = what 5L0473 held when TR-00567 fired (Amazon labeled exactly 2
      // boxes from it). It held 134u by 10-13, after a later returns put-away.
      { name: '5L0473', expiresAt: '2028-02-28', availableQty: 60 },
      { name: '6G0221', expiresAt: '2028-09-22', availableQty: 13200 },
      { name: '6G0222', expiresAt: '2028-09-24', availableQty: 46800 },
    ],
    oldBoxes: 392, wantBoxes: 834,
  },
];

console.log('\n--- 1. 🔴 the real incidents reproduce on the OLD per-line loop ---');
for (const c of CASES) {
  const old = simulateRun(c.lines.map((q) => ({ sku: c.sku, quantity: q })), c.lots, c.casePack);
  ok(`${c.tr}: per-line loop makes ${c.oldBoxes} boxes (what the floor counted)`, old.boxes === c.oldBoxes, `got ${old.boxes}`);
  ok(`${c.tr}: per-line loop silently skips at least one lot slice`, old.skipped > 0, `skipped ${old.skipped}`);
}

console.log('\n--- 2. ✅ merging first makes every box ---');
for (const c of CASES) {
  const merged = mergeSameSkuItems(c.lines.map((q) => ({ sku: c.sku, quantity: q })));
  ok(`${c.tr}: ${c.lines.length} lines merge to 1 item`, merged.length === 1, `got ${merged.length}`);
  ok(`${c.tr}: merged quantity = ordered total`, merged[0]?.quantity === c.lines.reduce((a, b) => a + b, 0));
  const run = simulateRun(merged, c.lots, c.casePack);
  ok(`${c.tr}: merged run makes all ${c.wantBoxes} boxes`, run.boxes === c.wantBoxes, `got ${run.boxes}`);
  ok(`${c.tr}: merged run skips nothing`, run.skipped === 0, `skipped ${run.skipped}`);
}

console.log('\n--- 3. explicit-lot supplemental runs keep their pinned lot ---');
const pinned = mergeSameSkuItems([
  { sku: 'X', quantity: 100, lot: 'A' },
  { sku: 'X', quantity: 50, lot: 'A' },
  { sku: 'X', quantity: 30, lot: 'B' },
  { sku: 'X', quantity: 20 },
]);
ok('same sku+lot lines merge', pinned.find((i) => i.lot === 'A')?.quantity === 150);
ok('different lots stay separate', pinned.filter((i) => i.sku === 'X').length === 3);
ok('lot-less line is not folded into a pinned lot', pinned.find((i) => !i.lot)?.quantity === 20);
ok('first-appearance order preserved', pinned.map((i) => i.lot ?? '-').join(',') === 'A,B,-');
ok('zero / negative / junk quantities dropped',
  mergeSameSkuItems([{ sku: 'Y', quantity: 0 }, { sku: 'Y', quantity: -5 }, { sku: 'Y', quantity: 'abc' }]).length === 0);
ok('distinct SKUs are never merged together',
  mergeSameSkuItems([{ sku: 'P', quantity: 10 }, { sku: 'Q', quantity: 10 }]).length === 2);

console.log('\n--- 4. shortfall detection ---');
const req = new Map([['M', 2340], ['N', 500]]);
ok('TR-00566 shape (12 of 26 boxes) is flagged',
  JSON.stringify(findShortfalls(new Map([['M', 2340]]), new Map([['M', 1080]]))) ===
  JSON.stringify([{ sku: 'M', requested: 2340, covered: 1080, short: 1260 }]));
ok('fully covered = no shortfall', findShortfalls(req, new Map([['M', 2340], ['N', 500]])).length === 0);
ok('a SKU with zero coverage is flagged', findShortfalls(req, new Map([['M', 2340]]))[0]?.sku === 'N');
ok('over-coverage is not a shortfall', findShortfalls(new Map([['M', 100]]), new Map([['M', 120]])).length === 0);

console.log('\n--- 5. 🔴 wiring in api/fba/auto-submit.ts (a refactor must not undo this) ---');
const src = readFileSync(join(__dirname, '../api/fba/auto-submit.ts'), 'utf8');
ok('items are merged via mergeSameSkuItems', /const mergedItems = mergeSameSkuItems\(items\)/.test(src));
ok('🔴 the lot loop iterates mergedItems, NOT raw items', /for \(const item of mergedItems\)/.test(src) && !/for \(const item of items\)/.test(src));
ok('🔴 the self-chain forwards mergedItems, NOT raw items', /items: mergedItems, chain_depth/.test(src) && !/cin7_transfer_number, items, chain_depth/.test(src));
ok('successful lots count toward coverage', /cover\(item\.sku, totalQty\);\s*results\.push\(\{\s*sku: item\.sku,\s*amazon_sku/.test(src));
ok('dedup-skipped lots count toward coverage (no false alarm on a chained run)',
  /cover\(item\.sku, totalQty\);\s*results\.push\(\{\s*sku: item\.sku,\s*lot: lot\.name,\s*status: 'skipped'/.test(src));
ok('shortfall check is suppressed while lots are still deferred',
  /deferredLots\.length === 0 \? findShortfalls\(requestedBySku, coveredBySku\)/.test(src));
ok('🔴 a shortfall raises an alert through sendFbaAlert', /shortfalls\.length > 0\)[\s\S]{0,700}?await sendFbaAlert\(msg\)/.test(src));
ok('response exposes lines_merged and shortfalls', /lines_merged: linesMerged,\s*shortfalls,/.test(src));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
