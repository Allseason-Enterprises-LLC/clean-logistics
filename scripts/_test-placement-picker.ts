/**
 * Regression test for the placement picker (Step 7.5 in lib/fba-inbound.ts).
 *
 * Recreates the 2026-06-11 bug scenario where Amazon returned multiple placements
 * with the same fee, and the old picker chose the one with zero partnered SPD
 * because it tie-broke on array order. The new picker should choose the placement
 * that has partnered coverage on all shipments, even if it ties on fee.
 *
 * Run: npx tsx scripts/_test-placement-picker.ts
 */

// Pure logic copy of the picker — kept in sync with lib/fba-inbound.ts manually.
// If the real picker is refactored, mirror the changes here too.
type Placement = {
  placementOptionId: string;
  shipmentIds: string[];
  fees?: Array<{ value?: { amount?: number; code?: string } }>;
};
type ShipmentOpt = { shipmentId: string; shippingSolution: string; shippingMode: string; quote?: { cost?: { amount?: number } } };

function pickPlacement(placements: Placement[], optsByPlacement: Map<string, ShipmentOpt[]>): { chosen: Placement | null; viableCount: number } {
  type Probe = { placement: Placement; fee: number; optsByShipment: Map<string, ShipmentOpt[]>; partneredViable: boolean };
  const probes: Probe[] = placements.map((p) => {
    const fee = (p.fees ?? []).reduce((s, f) => s + (f?.value?.amount ?? 0), 0);
    const all = optsByPlacement.get(p.placementOptionId) ?? [];
    const optsByShipment = new Map<string, ShipmentOpt[]>();
    for (const sid of p.shipmentIds) optsByShipment.set(sid, all.filter((o) => o.shipmentId === sid));
    const partneredCounts = p.shipmentIds.map((sid) => (optsByShipment.get(sid) ?? []).filter((o) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER').length);
    return { placement: p, fee, optsByShipment, partneredViable: partneredCounts.every((n) => n > 0) };
  });
  const viable = probes.filter((pr) => pr.partneredViable);
  if (viable.length === 0) return { chosen: null, viableCount: 0 };
  viable.sort((a, b) => {
    if (a.fee !== b.fee) return a.fee - b.fee;
    const sA = a.placement.shipmentIds.length;
    const sB = b.placement.shipmentIds.length;
    if (sA !== sB) return sA - sB;
    const cheapestSum = (pr: Probe) => {
      let sum = 0;
      for (const sid of pr.placement.shipmentIds) {
        const partnered = (pr.optsByShipment.get(sid) ?? []).filter((o) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER');
        const costs = partnered.map((o) => (typeof o.quote?.cost?.amount === 'number' ? o.quote!.cost!.amount! : Number.POSITIVE_INFINITY));
        sum += Math.min(...(costs.length ? costs : [Number.POSITIVE_INFINITY]));
      }
      return sum;
    };
    return cheapestSum(a) - cheapestSum(b);
  });
  return { chosen: viable[0].placement, viableCount: viable.length };
}

// ============================================================
// TEST CASES
// ============================================================
let failed = 0;
function assertEq(name: string, got: any, want: any) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}\n    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(got)}`);
  }
}

// --- TEST 1: The TR-00129 bug scenario ---
// Two $0 placements with 5 shipments each. Old picker took array-order tiebreak
// and chose the one with zero partnered. New picker should prefer the viable one.
console.log('\n[1] TR-00129 reproducer (two $0 / 5-shipment placements; one viable, one not)');
{
  const placements: Placement[] = [
    { placementOptionId: 'pl_NOPARTNERED', shipmentIds: ['s1', 's2', 's3', 's4', 's5'], fees: [{ value: { amount: 0, code: 'USD' } }] },
    { placementOptionId: 'pl_VIABLE',      shipmentIds: ['t1', 't2', 't3', 't4', 't5'], fees: [{ value: { amount: 0, code: 'USD' } }] },
  ];
  const opts = new Map<string, ShipmentOpt[]>();
  opts.set('pl_NOPARTNERED', ['s1','s2','s3','s4','s5'].flatMap(sid => [
    { shipmentId: sid, shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' },
  ]));
  opts.set('pl_VIABLE', ['t1','t2','t3','t4','t5'].flatMap(sid => [
    { shipmentId: sid, shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', quote: { cost: { amount: 12.34 } } },
  ]));
  const { chosen, viableCount } = pickPlacement(placements, opts);
  assertEq('chooses the viable placement', chosen?.placementOptionId, 'pl_VIABLE');
  assertEq('reports 1 viable placement', viableCount, 1);
}

// --- TEST 2: Cheap-but-broken vs expensive-but-working ---
// Old picker took cheapest (broken). New picker correctly skips and takes expensive working one.
console.log('\n[2] Cheap-but-no-partnered vs expensive-with-partnered (TR-00121 reproducer)');
{
  const placements: Placement[] = [
    { placementOptionId: 'pl_CHEAP_BROKEN',     shipmentIds: ['a1'], fees: [{ value: { amount: 0,    code: 'USD' } }] },
    { placementOptionId: 'pl_EXPENSIVE_WORKING', shipmentIds: ['b1'], fees: [{ value: { amount: 756, code: 'USD' } }] },
  ];
  const opts = new Map<string, ShipmentOpt[]>();
  opts.set('pl_CHEAP_BROKEN',     [{ shipmentId: 'a1', shippingSolution: 'USE_YOUR_OWN_CARRIER',     shippingMode: 'GROUND_SMALL_PARCEL' }]);
  opts.set('pl_EXPENSIVE_WORKING', [{ shipmentId: 'b1', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', quote: { cost: { amount: 100 } } }]);
  const { chosen, viableCount } = pickPlacement(placements, opts);
  assertEq('skips cheap-broken, picks expensive-working', chosen?.placementOptionId, 'pl_EXPENSIVE_WORKING');
  assertEq('reports 1 viable placement', viableCount, 1);
}

// --- TEST 3: All placements broken — should return null (triggers PartneredUnavailableError) ---
console.log('\n[3] All placements have zero partnered → null verdict');
{
  const placements: Placement[] = [
    { placementOptionId: 'pl_A', shipmentIds: ['a1'], fees: [{ value: { amount: 0 } }] },
    { placementOptionId: 'pl_B', shipmentIds: ['b1'], fees: [{ value: { amount: 50 } }] },
  ];
  const opts = new Map<string, ShipmentOpt[]>();
  opts.set('pl_A', [{ shipmentId: 'a1', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' }]);
  opts.set('pl_B', [{ shipmentId: 'b1', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' }]);
  const { chosen, viableCount } = pickPlacement(placements, opts);
  assertEq('returns null when no viable placement', chosen, null);
  assertEq('reports 0 viable placements', viableCount, 0);
}

// --- TEST 4: Multiple viable placements → cheapest wins ---
console.log('\n[4] Multiple viable placements → pick lowest fee');
{
  const placements: Placement[] = [
    { placementOptionId: 'pl_EXPENSIVE', shipmentIds: ['e1'], fees: [{ value: { amount: 200 } }] },
    { placementOptionId: 'pl_CHEAP',     shipmentIds: ['c1'], fees: [{ value: { amount: 50 } }] },
  ];
  const opts = new Map<string, ShipmentOpt[]>();
  opts.set('pl_EXPENSIVE', [{ shipmentId: 'e1', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', quote: { cost: { amount: 20 } } }]);
  opts.set('pl_CHEAP',     [{ shipmentId: 'c1', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', quote: { cost: { amount: 25 } } }]);
  const { chosen, viableCount } = pickPlacement(placements, opts);
  assertEq('picks the cheapest viable', chosen?.placementOptionId, 'pl_CHEAP');
  assertEq('reports 2 viable', viableCount, 2);
}

// --- TEST 5: Partial coverage (only some shipments partnered) is NOT viable ---
console.log('\n[5] Placement with partial partnered coverage (2/5 shipments) is NOT viable');
{
  const placements: Placement[] = [
    { placementOptionId: 'pl_PARTIAL', shipmentIds: ['p1', 'p2', 'p3', 'p4', 'p5'], fees: [{ value: { amount: 0 } }] },
  ];
  const opts = new Map<string, ShipmentOpt[]>();
  opts.set('pl_PARTIAL', [
    { shipmentId: 'p1', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', quote: { cost: { amount: 10 } } },
    { shipmentId: 'p2', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', quote: { cost: { amount: 10 } } },
    { shipmentId: 'p3', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' },
    { shipmentId: 'p4', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' },
    { shipmentId: 'p5', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL' },
  ]);
  const { chosen, viableCount } = pickPlacement(placements, opts);
  assertEq('partial coverage → null', chosen, null);
  assertEq('partial coverage → 0 viable', viableCount, 0);
}

console.log(`\n${failed === 0 ? '✅ All tests passed' : `❌ ${failed} test(s) failed`}`);
if (failed > 0) process.exit(1);
