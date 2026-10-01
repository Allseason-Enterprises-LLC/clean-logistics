/**
 * TR-00507 regression (2026-10-01): labels for a lot must attach to THAT lot's
 * ShipHero child order, resolved from the bridge's recorded child_orders —
 * never to the first lot's order by fallthrough.
 * Run: npx tsx scripts/_test-lot-child-attach.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { pickLotChild, resolveLotChildOrder } from '../lib/fba-post-process';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// the real TR-00507 payload shape
const rp = { lot_split: true, child_orders: [
  { orderId: 'T3JkZXI6OTAyNTQwODI4', orderNumber: 'AMZ_ADAPTACORE_00507-2510046A', lot: '2510046A', qty: 300 },
  { orderId: 'T3JkZXI6OTAyNTQwODQw', orderNumber: 'AMZ_ADAPTACORE_00507-2510096A', lot: '2510096A', qty: 120 },
  { orderId: 'T3JkZXI6OTAyNTQwODQ5', orderNumber: 'AMZ_ADAPTACORE_00507-2606060A', lot: '2606060A', qty: 1500 },
] };

async function main() {
  // ---- pure selection ----
  ok('🔴 third lot resolves to the THIRD order, not the first', pickLotChild(rp, '2606060A')?.orderNumber === 'AMZ_ADAPTACORE_00507-2606060A');
  ok('second lot resolves to its own order', pickLotChild(rp, '2510096A')?.orderId === 'T3JkZXI6OTAyNTQwODQw');
  ok('first lot still resolves', pickLotChild(rp, '2510046A')?.orderNumber === 'AMZ_ADAPTACORE_00507-2510046A');
  ok('lot match is case/whitespace tolerant', pickLotChild(rp, ' 2606060a ')?.lot === undefined && pickLotChild(rp, ' 2606060a ')?.orderNumber === 'AMZ_ADAPTACORE_00507-2606060A');
  ok('unknown lot → null (caller falls back, does not guess)', pickLotChild(rp, '9999999Z') === null);
  ok('non-lot-split payload → null', pickLotChild({ some: 'thing' }, '2606060A') === null && pickLotChild(null, 'x') === null && pickLotChild(undefined, 'x') === null);
  ok('child missing orderId → null (never attach to an unidentified order)', pickLotChild({ child_orders: [{ lot: 'L1', orderNumber: 'N' }] }, 'L1') === null);

  // ---- db-backed resolver with fake supabase ----
  const fakeDb = (payload: any, throws = false) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { if (throws) throw new Error('boom'); return { data: { response_payload: payload } }; } }) }) }) }) as any;
  ok('resolver reads response_payload and picks the lot', (await resolveLotChildOrder('CIN7-TR-00507', '2606060A', fakeDb(rp)))?.orderNumber === 'AMZ_ADAPTACORE_00507-2606060A');
  ok('resolver accepts bare TR-00507 too', (await resolveLotChildOrder('TR-00507', '2510096A', fakeDb(rp)))?.orderId === 'T3JkZXI6OTAyNTQwODQw');
  ok('resolver never throws (db error → null)', (await resolveLotChildOrder('TR-00507', '2606060A', fakeDb(rp, true))) === null);
  ok('resolver with no lot → null without touching db', (await resolveLotChildOrder('TR-00507', '', fakeDb(rp))) === null);

  // ---- wiring: child resolution runs FIRST, before the guessed override and the primary-order fallback ----
  const src = fs.readFileSync(path.join(__dirname, '../lib/fba-post-process.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function postProcessFbaShipment'));
  const childRes = fn.indexOf('resolveLotChildOrder(input.cin7TransferNumber, input.lot)');
  const override = fn.indexOf('findShipheroOrder(shToken, input.shipheroOrderNumberOverride)');
  const bridgePrimary = fn.indexOf("select('shiphero_order_number')");
  ok('child_orders resolution exists in post-process', childRes > 0);
  ok('🔴 it runs BEFORE the guessed override lookup', childRes < override);
  ok('it runs BEFORE the bridge primary-order fallback (the first-lot trap)', childRes < bridgePrimary);
  ok('resolved child goes through findShipheroOrder (live account_id + cancelled check), no bare id', /findShipheroOrder\(shToken, child\.orderNumber\)/.test(fn));
  ok('override lookup is now guarded by !shOrder (child wins when present)', /if \(!shOrder && input\.shipheroOrderNumberOverride\)/.test(fn));
  ok('cites the incident', src.includes('TR-00507') && src.includes('1,500-unit order had none'));

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
