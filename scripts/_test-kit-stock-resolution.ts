/**
 * Kit stock resolution: a kit holds no inventory of its own — its COMPONENTS do.
 * The stock verdict must see through to the core SKU.
 *
 * 2026-10-08, TR-00539: CN-CAP-LIPOGLUT-90CT-R2 (kit) read 0 units while its
 * core CN-CAP-LIPOGLUT-90CT held 21,924 in A-prefix bulk. The gate blocked a
 * transfer with 20k+ units available and sent the floor a MOVE STOCK work order
 * it could never satisfy. Weston: "the system needs to be able to be smart
 * enough to create a shipment when the core sku has the inventory even if the
 * kit doesn't."
 *
 * Run: npx tsx scripts/_test-kit-stock-resolution.ts
 */
import { resolveKitLotAvailability, type KitComponent } from '../lib/shiphero-product-data';
import { runPreflight, type PreflightFacts } from '../lib/fba-preflight';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const lot = (name: string, availableQty: number, expiresAt: string) => ({ name, availableQty, expiresAt });

async function main() {
  // ── 1. The live TR-00539 shape ────────────────────────────────────────────
  {
    const comps: KitComponent[] = [{ sku: 'CN-CAP-LIPOGLUT-90CT', quantity: 1 }];
    const byComp = { 'CN-CAP-LIPOGLUT-90CT': [lot('6J18041', 21924, '2028-09-30')] };
    const r = await resolveKitLotAvailability(comps, async (s) => (byComp as any)[s] ?? []);
    ok('🔴 TR-00539: kit reads 0 but core has 21,924 → kit availability 21,924 under lot 6J18041',
      r.length === 1 && r[0].name === '6J18041' && r[0].availableQty === 21924 && r[0].expiresAt === '2028-09-30');
    const cases = Math.floor(r[0].availableQty / 126);
    ok('TR-00539: 21,924 ÷ 126 = 174 full cases ≥ the 15 cases needed for 1,890 units', cases === 174 && cases >= 15);
  }

  // ── 2. multi-unit kits divide by units-per-kit ────────────────────────────
  {
    const comps: KitComponent[] = [{ sku: 'CORE', quantity: 3 }];
    const r = await resolveKitLotAvailability(comps, async () => [lot('L1', 1000, '2028-01-31')]);
    ok('🔴 3-packs: 1000 core units ÷ 3 per kit = 333 kits (NOT 1000)', r[0].availableQty === 333);
    const r2 = await resolveKitLotAvailability([{ sku: 'CORE', quantity: 6 }], async () => [lot('L1', 11, '2028-01-31')]);
    ok('partial kits never counted: 11 units ÷ 6 = 1 kit', r2[0].availableQty === 1);
    const r3 = await resolveKitLotAvailability([{ sku: 'CORE', quantity: 6 }], async () => [lot('L1', 5, '2028-01-31')]);
    ok('5 units ÷ 6 per kit = 0 kits → lot dropped, not reported as 0-qty noise', r3.length === 0);
  }

  // ── 3. per-lot granularity is preserved (auto-submit lot-splits on this) ──
  {
    const r = await resolveKitLotAvailability([{ sku: 'CORE', quantity: 2 }], async () => [
      lot('LOT-A', 100, '2027-06-30'), lot('LOT-B', 51, '2028-06-30'),
    ]);
    ok('single-component kit keeps per-lot rows (50 + 25), FEFO still works',
      r.length === 2 && r.find((l) => l.name === 'LOT-A')?.availableQty === 50 && r.find((l) => l.name === 'LOT-B')?.availableQty === 25);
  }

  // ── 4. multi-component kits bind on the SCARCEST component ───────────────
  {
    const comps: KitComponent[] = [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }];
    const byComp: any = {
      A: [lot('A1', 500, '2029-01-31')],
      B: [lot('B1', 80, '2027-03-31')],   // scarcer AND earlier-expiring
    };
    const r = await resolveKitLotAvailability(comps, async (s) => byComp[s] ?? []);
    const total = r.reduce((n, l) => n + l.availableQty, 0);
    ok('🔴 multi-component: 500 of A + 80 of B → 80 kits (min, never the sum or the max)', total === 80);
    ok('multi-component reports the EARLIEST expiry across components (worst case for FBA)',
      r.every((l) => l.expiresAt === '2027-03-31'));
    const r2 = await resolveKitLotAvailability(comps, async (s) => (s === 'A' ? byComp.A : []));
    ok('🔴 one component with ZERO stock → 0 kits buildable (cannot assemble)', r2.reduce((n, l) => n + l.availableQty, 0) === 0);
  }

  // ── 5. fail-safe behaviours ──────────────────────────────────────────────
  {
    const r = await resolveKitLotAvailability([{ sku: 'CORE', quantity: 1 }], async () => { throw new Error('ShipHero 429'); });
    ok('component read throws → empty (fail open to "unknown", never invents stock)', r.length === 0);
    const rz = await resolveKitLotAvailability([], async () => [lot('L', 999, '2028-01-01')]);
    ok('no components declared → empty (do not silently claim the kit has stock)', rz.length === 0);
    const rq = await resolveKitLotAvailability([{ sku: 'CORE', quantity: 0 }], async () => [lot('L', 100, '2028-01-01')]);
    ok('component quantity 0 or missing → treated as 1 per kit, not a divide-by-zero', rq[0]?.availableQty === 100);
  }

  // ── 6. the gate verdict flips for the real transfer ──────────────────────
  {
    const base: PreflightFacts = {
      cin7Sku: 'CN-CAP-LIPOGLUT-90CT-R2', quantity: 1890,
      casePack: { caseQuantity: 126, boxLength: 22, boxWidth: 17, boxHeight: 11, boxWeightLbs: 25 },
      productNote: 'Box Weight: 25 Lbs\nBox Size: 22 x 17 x 11 inches\nQuantity per Case: 126 Jars',
      lotNumber: '6J18041', expirationDate: '2028-09-30',
      amazonMsku: 'CN-CAP-LIPOGLUT-90CT-R2', inboundReady: true, labelOwnerConstraint: 'NONE_ONLY',
      shippedBefore: true, shipheroBarcode: '810197341981', amazonUpc: '810197341981',
      isKit: true, pickableUnits: 251,
    };
    ok('🔴 BEFORE (kit-blind, bulkLots=[]) → STOCK_NOT_IN_BULK blocks 1,890 units',
      runPreflight({ ...base, bulkLots: [] }).blockers.some((b) => b.code === 'STOCK_NOT_IN_BULK'));
    ok('🔴 AFTER (resolved through core) → OK, would fire',
      runPreflight({ ...base, bulkLots: [lot('6J18041', 21924, '2028-09-30')] }).ok);
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
