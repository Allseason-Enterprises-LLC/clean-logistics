import { test } from 'node:test';
import assert from 'node:assert';
import { allocateFefoByLot, sanitizeLotName } from './lot-allocation';

const lots = [
  { name: 'L-JUN', expiresAt: '2028-06-30', availableQty: 500 },
  { name: 'L-APR', expiresAt: '2028-04-30', availableQty: 90 },
  { name: 'L-MAY', expiresAt: '2028-05-31', availableQty: 200 },
];

test('splits FEFO across lots in case multiples', () => {
  // caseQty 30; request 240 => 90 from APR (3 cases), 150 from MAY (5 cases)
  const out = allocateFefoByLot(lots, 240, 30, '2026-07-22');
  assert.deepStrictEqual(out, [
    { name: 'L-APR', expiresAt: '2028-04-30', qty: 90, cases: 3 },
    { name: 'L-MAY', expiresAt: '2028-05-31', qty: 150, cases: 5 },
  ]);
});

test('single lot covers everything => one allocation', () => {
  const out = allocateFefoByLot(lots, 60, 30, '2026-07-22');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'L-APR');
});

test('skips zero-qty lots and handles sub-case remainders', () => {
  // caseQty 40: APR floor(90/40)=2 cases=80. Remaining 80 from MAY (2 cases).
  const withZero = [...lots, { name: 'L-ZERO', expiresAt: '2028-01-31', availableQty: 0 }];
  const out = allocateFefoByLot(withZero, 160, 40, '2026-07-22');
  assert.deepStrictEqual(
    out.map((o) => [o.name, o.qty]),
    [['L-APR', 80], ['L-MAY', 80]],
  );
});

test('skips lots expiring within 105 days', () => {
  const nearExp = [{ name: 'SOON', expiresAt: '2026-09-01', availableQty: 999 }, ...lots];
  const out = allocateFefoByLot(nearExp, 90, 30, '2026-07-22');
  assert.strictEqual(out[0].name, 'L-APR');
});

test('exactly 105 days out is eligible', () => {
  const edge = [{ name: 'EDGE', expiresAt: '2026-11-04', availableQty: 300 }];
  const out = allocateFefoByLot(edge, 30, 30, '2026-07-22');
  assert.strictEqual(out[0].name, 'EDGE');
});

test('overshoot rounds up to full cases within one lot', () => {
  // request 100, caseQty 30 => 4 cases = 120 units from a single lot
  const out = allocateFefoByLot(lots, 100, 30, '2026-07-22');
  const total = out.reduce((s, o) => s + o.qty, 0);
  assert.ok(total >= 100);
  for (const o of out) assert.strictEqual(o.qty % 30, 0);
});

test('normalizes datetime expiries to date-only', () => {
  const dt = [{ name: 'DT', expiresAt: '2028-04-30T00:00:00+00:00', availableQty: 90 }];
  const out = allocateFefoByLot(dt, 30, 30, '2026-07-22');
  assert.strictEqual(out[0].expiresAt, '2028-04-30');
});

test('throws when insufficient stock across eligible lots', () => {
  assert.throws(() => allocateFefoByLot(lots, 999999, 30, '2026-07-22'), /insufficient/i);
});

test('throws on bad inputs', () => {
  assert.throws(() => allocateFefoByLot(lots, 0, 30));
  assert.throws(() => allocateFefoByLot(lots, 30, 0));
});

test('sanitizeLotName strips illegal chars', () => {
  assert.strictEqual(sanitizeLotName('CN61522602'), 'CN61522602');
  assert.strictEqual(sanitizeLotName('LOT #12/A B'), 'LOT12AB');
});
