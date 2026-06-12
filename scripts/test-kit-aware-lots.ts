/**
 * Unit tests for kit-aware ShipHero lot resolution.
 *
 * Regression test for TR-00146 (2026-06-12): the FBA auto-submit was reading
 * expiration_lots directly on a kit SKU (CN-BDL-DRP-BLOODSUGAR-2OZ-2PK), which
 * always returns 0 lots because ShipHero stores lots only on the underlying
 * component SKUs. Result: expirationDate=null, FBA workflow silent-fails on
 * setPackingInformation, no shipment created.
 *
 * This test stubs the global fetch and exercises `getShipHeroProductData` for
 * three cases:
 *   1. Single-component kit (the TR-00146 shape) — earliest component expiry wins
 *   2. Multi-component kit — earliest expiry across ALL components wins
 *   3. Non-kit SKU — uses lots on the SKU itself (no behavior change)
 *   4. Kit with no active lots on any component — throws (fail-loud)
 *
 * Run with: npx tsx scripts/test-kit-aware-lots.ts
 */

import { getShipHeroProductData } from '../lib/shiphero-product-data';

type Edge<T> = { node: T };
type LotNode = { name: string; sku: string; expires_at: string; is_active: boolean };

function makeProductResp(opts: {
  sku: string;
  name: string;
  kit: boolean;
  kit_components?: Array<{ sku: string; quantity: number }>;
  topLevelLots?: Edge<LotNode>[];
  product_note?: string;
  weight?: string;
}) {
  return {
    data: {
      products: {
        data: {
          edges: [
            {
              node: {
                sku: opts.sku,
                name: opts.name,
                kit: opts.kit,
                kit_components: opts.kit_components || [],
                product_note: opts.product_note || 'Box Weight: 22 Lbs\nBox Size: 16 x 20 x 5 inches\nQuantity per Case: 90 bottles',
                dimensions: { length: '6', width: '4', height: '2', weight: opts.weight || '0.5 lbs' },
              },
            },
          ],
        },
      },
      expiration_lots: {
        data: { edges: opts.topLevelLots || [] },
      },
    },
  };
}

function makeLotsResp(edges: Edge<LotNode>[]) {
  return { data: { expiration_lots: { data: { edges } } } };
}

function lot(name: string, expires_at: string, is_active = true): Edge<LotNode> {
  return { node: { name, sku: 'irrelevant', expires_at, is_active } };
}

/**
 * Install a fake `fetch` that responds based on the GraphQL query body.
 * Returns the list of queries we observed so the test can assert call patterns.
 */
function installFetch(
  responder: (body: string) => any
): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  // @ts-expect-error -- test-only override
  globalThis.fetch = async (_url: string, init: any) => {
    const body = init?.body as string;
    calls.push(body);
    const data = responder(body);
    return {
      ok: true,
      json: async () => data,
    } as any;
  };
  return { restore: () => { globalThis.fetch = original; }, calls };
}

async function run() {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`  ✅ ${name}`);
      pass++;
    } else {
      console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
      failures.push(name);
      fail++;
    }
  }

  // === Test 1: single-component kit (TR-00146 shape) ===
  console.log('\n[Test 1] Single-component kit picks earliest active lot from component');
  {
    const productResp = makeProductResp({
      sku: 'CN-BDL-DRP-BLOODSUGAR-2OZ-2PK',
      name: 'Gluco Tone 2 Bottles',
      kit: true,
      kit_components: [{ sku: 'CN-DRP-BLOODSUGAR-2OZ', quantity: 2 }],
      topLevelLots: [], // kit has no lots on itself
    });
    const componentLots = makeLotsResp([
      lot('2510011', '2027-10-31'),
      lot('2601011', '2028-02-28'),
      lot('CH41082601', '2028-04-30'),
      lot('STALE', '2025-01-01', false), // inactive should be ignored
    ]);

    const fetchStub = installFetch((body) => {
      if (body.includes('products(sku:')) return productResp;
      if (body.includes('CN-DRP-BLOODSUGAR-2OZ')) return componentLots;
      throw new Error(`unexpected query body: ${body.slice(0, 200)}`);
    });

    try {
      const result = await getShipHeroProductData('TEST_TOKEN', 'CN-BDL-DRP-BLOODSUGAR-2OZ-2PK');
      check('returns kit SKU and name', result.sku === 'CN-BDL-DRP-BLOODSUGAR-2OZ-2PK' && result.name === 'Gluco Tone 2 Bottles');
      check('picks earliest ACTIVE expiry (2027-10-31)', result.expirationDate === '2027-10-31', `got ${result.expirationDate}`);
      check('lot number matches earliest', result.lotNumber === '2510011', `got ${result.lotNumber}`);
      check('case pack parsed from kit note', !!result.casePack && result.casePack.caseQuantity === 90);
      check('made 2 fetch calls (product + 1 component)', fetchStub.calls.length === 2, `got ${fetchStub.calls.length}`);
    } catch (e: any) {
      check('does not throw', false, e.message);
    } finally {
      fetchStub.restore();
    }
  }

  // === Test 2: multi-component kit picks earliest across all components ===
  console.log('\n[Test 2] Multi-component kit picks earliest across ALL components');
  {
    const productResp = makeProductResp({
      sku: 'CN-BDL-MULTI',
      name: 'Combo Kit',
      kit: true,
      kit_components: [
        { sku: 'COMP-A', quantity: 1 },
        { sku: 'COMP-B', quantity: 1 },
      ],
    });
    const lotsA = makeLotsResp([lot('A1', '2028-12-31'), lot('A2', '2029-06-30')]);
    const lotsB = makeLotsResp([lot('B1', '2027-03-15'), lot('B2', '2028-01-01')]); // B1 is earliest globally

    const fetchStub = installFetch((body) => {
      if (body.includes('products(sku:')) return productResp;
      if (body.includes('COMP-A')) return lotsA;
      if (body.includes('COMP-B')) return lotsB;
      throw new Error(`unexpected query body: ${body.slice(0, 200)}`);
    });

    try {
      const result = await getShipHeroProductData('TEST_TOKEN', 'CN-BDL-MULTI');
      check('earliest expiry comes from COMP-B (2027-03-15)', result.expirationDate === '2027-03-15', `got ${result.expirationDate}`);
      check('lot number = B1', result.lotNumber === 'B1', `got ${result.lotNumber}`);
      check('made 3 fetch calls (product + 2 components)', fetchStub.calls.length === 3, `got ${fetchStub.calls.length}`);
    } catch (e: any) {
      check('does not throw', false, e.message);
    } finally {
      fetchStub.restore();
    }
  }

  // === Test 3: non-kit uses top-level lots (baseline / no regression) ===
  console.log('\n[Test 3] Non-kit SKU reads lots from itself (no behavior change)');
  {
    const productResp = makeProductResp({
      sku: 'CN-CAP-DAILYFIBER-90CT',
      name: 'Daily Fiber 90ct',
      kit: false,
      topLevelLots: [
        lot('LOT-X', '2028-05-31'),
        lot('LOT-OLD', '2027-01-01'), // active, but later checked: earliest wins
      ],
    });

    const fetchStub = installFetch((body) => {
      if (body.includes('products(sku:')) return productResp;
      throw new Error('non-kit should NOT make component lot calls');
    });

    try {
      const result = await getShipHeroProductData('TEST_TOKEN', 'CN-CAP-DAILYFIBER-90CT');
      check('picks earliest top-level lot (2027-01-01)', result.expirationDate === '2027-01-01', `got ${result.expirationDate}`);
      check('lot name = LOT-OLD', result.lotNumber === 'LOT-OLD', `got ${result.lotNumber}`);
      check('only 1 fetch call (no kit walk)', fetchStub.calls.length === 1, `got ${fetchStub.calls.length}`);
    } catch (e: any) {
      check('does not throw', false, e.message);
    } finally {
      fetchStub.restore();
    }
  }

  // === Test 4: kit with no active component lots → fail loud ===
  console.log('\n[Test 4] Kit with no active component lots throws explicit error');
  {
    const productResp = makeProductResp({
      sku: 'CN-BDL-EMPTY',
      name: 'Empty Kit',
      kit: true,
      kit_components: [{ sku: 'COMP-DRY', quantity: 1 }],
    });
    const noLots = makeLotsResp([lot('OLD', '2024-01-01', false)]); // inactive only

    const fetchStub = installFetch((body) => {
      if (body.includes('products(sku:')) return productResp;
      if (body.includes('COMP-DRY')) return noLots;
      throw new Error(`unexpected: ${body.slice(0, 100)}`);
    });

    try {
      await getShipHeroProductData('TEST_TOKEN', 'CN-BDL-EMPTY');
      check('throws on missing component lots', false, 'no error thrown');
    } catch (e: any) {
      const msg = e?.message || String(e);
      check('error mentions kit SKU', msg.includes('CN-BDL-EMPTY'), msg);
      check('error mentions FBA 105-day requirement', msg.includes('105'), msg);
      check('error mentions component SKU', msg.includes('COMP-DRY'), msg);
    } finally {
      fetchStub.restore();
    }
  }

  // === Test 5: non-kit with no active lots returns nulls (current behavior preserved) ===
  console.log('\n[Test 5] Non-kit with no active lots returns nulls (does not throw)');
  {
    const productResp = makeProductResp({
      sku: 'CN-PLAIN',
      name: 'Plain Product',
      kit: false,
      topLevelLots: [lot('OLD', '2024-01-01', false)],
    });

    const fetchStub = installFetch((body) => {
      if (body.includes('products(sku:')) return productResp;
      throw new Error('unexpected component query for non-kit');
    });

    try {
      const result = await getShipHeroProductData('TEST_TOKEN', 'CN-PLAIN');
      check('expirationDate is null', result.expirationDate === null);
      check('lotNumber is null', result.lotNumber === null);
    } catch (e: any) {
      check('does not throw on non-kit', false, e.message);
    } finally {
      fetchStub.restore();
    }
  }

  // === Summary ===
  console.log('\n=== summary ===');
  console.log(`  passed: ${pass}`);
  console.log(`  failed: ${fail}`);
  if (fail > 0) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('\n✅ all green');
}

run().catch((e) => {
  console.error('test runner crashed:', e);
  process.exit(1);
});
