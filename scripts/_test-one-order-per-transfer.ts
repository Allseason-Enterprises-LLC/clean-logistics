/**
 * ONE ShipHero order per CIN7 transfer (Weston, 2026-10-15). Lot separation for Amazon is
 * auto-submit's job (one inbound plan per lot); the floor gets one order, N label PDFs and a
 * consolidated per-lot packing note. Sync-time lot-split children drifted from the fire-time
 * lot set and produced 0-label orders, name collisions and `failed` rows.
 * Run: npx tsx scripts/_test-one-order-per-transfer.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const root = path.join(__dirname, '..');
const orders = fs.readFileSync(path.join(root, 'lib/shiphero-orders.ts'), 'utf8');
const autosub = fs.readFileSync(path.join(root, 'api/fba/auto-submit.ts'), 'utf8');
const post = fs.readFileSync(path.join(root, 'lib/fba-post-process.ts'), 'utf8');

const fn = orders.slice(orders.indexOf('async function createWholesaleOrderViaGraphQL'), orders.indexOf('export async function createShipHeroOrderFromCIN7Transfer'));
ok('🔴 createWholesaleOrderViaGraphQL creates exactly ONE order (delegates to createOneWholesaleOrder, no loop)', /return createOneWholesaleOrder\(credentials, input\);/.test(fn) && !/for \(const/.test(fn));
ok('🔴 no sync-time FEFO: shiphero-orders no longer imports the lot allocator or lot breakdown', !/allocateFefoByLot|getLotBreakdown/.test(orders));
ok('no child_orders are written by sync any more', !/child_orders:/.test(orders) && !/lot_split: true/.test(orders));
ok('Amazon side still splits by lot: auto-submit allocates FEFO by lot and creates one plan per lot', /allocateFefoByLot\(/.test(autosub) && /LOT SPLIT: one Amazon plan per lot/.test(autosub));
ok('post-process still resolves legacy children for transfers synced before this change', /resolveLotChildOrder\(input\.cin7TransferNumber, input\.lot\)/.test(post));
ok('post-process prefers the bridge row\'s recorded order over the ambiguous TR scan', /resolveBridgeOrderNumber\(input\.cin7TransferNumber\)[\s\S]{0,400}findShipheroOrder\(shToken, bridged\)/.test(post) && post.indexOf('resolveBridgeOrderNumber(input.cin7TransferNumber)') < post.indexOf('shOrder = await findShipheroOrder(shToken, input.cin7TransferNumber)'));
ok('post-process falls back to the transfer-level order (the new normal)', /shOrder = await findShipheroOrder\(shToken, input\.cin7TransferNumber\)/.test(post));
ok('packing note is the consolidated per-lot note (Fix 4)', /buildConsolidatedPackingNote\(/.test(post));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
