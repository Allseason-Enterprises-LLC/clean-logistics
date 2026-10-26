/**
 * Transfers go out AS WRITTEN (2026-10-26, Katherine Bravo):
 *   - the lots the office wrote on the CIN7 lines are the lots Amazon labels
 *     (TR-00664 was labelled 1638/252 against a transfer written 1512/378);
 *   - a transfer with a lot labelled and a lot LOST is topped up — only the
 *     missing written lot, never more than the transfer (TR-00678, 30 boxes).
 * Run: npx tsx scripts/_test-transfer-lots-as-written.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { readCin7LineLot, readCin7LineExpiry, toLotItems, allLinesHaveLots, missingLotItems, planTopUp, isPlaceholderLot } from '../lib/transfer-lots';
import { mergeSameSkuItems } from '../lib/lot-allocation';

let fails = 0;
const ok = (l: string, c: boolean, x: any = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + JSON.stringify(x)}`); };
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

const SKU = 'CN-DRP-BLOODSUGAR-2OZ';
const OLD = new Date(Date.now() - 3 * 3600e3).toISOString();
const NOW = new Date().toISOString();

// ---- reading the lot off a CIN7 line ----
ok('BatchSN is the lot', readCin7LineLot({ BatchSN: 'CN92572601' }) === 'CN92572601');
ok('trims', readCin7LineLot({ BatchSN: '  2512043A ' }) === '2512043A');
ok('no lot -> null', readCin7LineLot({ SKU: 'X' }) === null && readCin7LineLot(null) === null && readCin7LineLot({ BatchSN: '' }) === null);
ok('🔴 FEFO-CONV placeholder is NOT a lot (ShipHero has no such lot)', readCin7LineLot({ BatchSN: 'FEFO-CONV-20260910' }) === null && isPlaceholderLot('fefo-conv-x'));
ok('expiry read as YYYY-MM-DD', readCin7LineExpiry({ ExpiryDate: '2028-09-30T00:00:00' }) === '2028-09-30' && readCin7LineExpiry({}) === null);

// ---- lines -> items ----
const tr678 = [{ sku: SKU, quantity: 2700, lot: 'CN92572601' }, { sku: SKU, quantity: 7380, lot: 'TN080726-N19' }];
ok('TR-00678 lines keep BOTH lots (one item per lot)', eq(toLotItems(tr678), [{ sku: SKU, quantity: 2700, lot: 'CN92572601' }, { sku: SKU, quantity: 7380, lot: 'TN080726-N19' }]));
ok('same sku+lot lines are summed', eq(toLotItems([{ sku: 'A', quantity: 10, lot: 'L1' }, { sku: 'A', quantity: 5, lot: 'L1' }]), [{ sku: 'A', quantity: 15, lot: 'L1' }]));
ok('no lots at all -> plain items (FEFO fallback, old behaviour)', eq(toLotItems([{ sku: 'A', quantity: 10 }, { sku: 'A', quantity: 5 }]), [{ sku: 'A', quantity: 15 }]));
ok('🔴 a SKU with ANY un-lotted line is fully un-pinned (no FEFO/pinned collision -> TR-00566 drop)',
  eq(toLotItems([{ sku: 'A', quantity: 10, lot: 'L1' }, { sku: 'A', quantity: 5 }, { sku: 'B', quantity: 3, lot: 'L9' }]), [{ sku: 'A', quantity: 15 }, { sku: 'B', quantity: 3, lot: 'L9' }]));
ok('zero/negative lines dropped', eq(toLotItems([{ sku: 'A', quantity: 0, lot: 'L1' }, { sku: 'A', quantity: -3, lot: 'L1' }]), []));
ok('auto-submit keeps per-lot items apart (mergeSameSkuItems keys on sku+lot)', eq(mergeSameSkuItems(toLotItems(tr678)), toLotItems(tr678)));
ok('allLinesHaveLots', allLinesHaveLots(tr678) && !allLinesHaveLots([{ sku: 'A', quantity: 1 }]) && !allLinesHaveLots([]));

// ---- which written lots have no active row ----
ok('TR-00678: CN92572601 is the missing lot',
  eq(missingLotItems(toLotItems(tr678), [{ cin7_sku: SKU, cin7_lot: 'TN080726-N19' }]), [{ sku: SKU, quantity: 2700, lot: 'CN92572601' }]));

// ---- planTopUp: the decision ----
const row = (lot: string, units: number | null, status = 'labels_ready', updated_at = OLD) => ({ cin7_sku: SKU, cin7_lot: lot, status, units, updated_at });
const ordered = { [SKU]: 10080 };
const v678 = planTopUp(ordered, toLotItems(tr678), [row('TN080726-N19', 7380)]);
ok('🔴 TR-00678 shape -> top_up EXACTLY lot CN92572601 x 2700', v678.kind === 'top_up' && eq((v678 as any).items, [{ sku: SKU, quantity: 2700, lot: 'CN92572601' }]), v678);
ok('whole transfer -> whole (no fire)', planTopUp(ordered, toLotItems(tr678), [row('TN080726-N19', 7380), row('CN92572601', 2700)]).kind === 'whole');
ok('🔴 over-labelled -> over (never top up)', planTopUp(ordered, toLotItems(tr678), [row('TN080726-N19', 7380), row('CN92572601', 2790)]).kind === 'over');
ok('🔴 row still being built (<30 min, no units) -> in_flight (chained run may be on it)', planTopUp(ordered, toLotItems(tr678), [row('TN080726-N19', 7380), row('CN92572601', null, 'draft', NOW)]).kind === 'in_flight');
ok('🔴 stale unlabelled row holds the slot -> in_flight (frozen-draft sweep owns it), never fire over it', planTopUp(ordered, toLotItems(tr678), [row('TN080726-N19', 7380), row('CN92572601', null, 'needs_review', OLD)]).kind === 'in_flight');
ok('🔴 CIN7 lines name no lot -> unknown_lots (never guess with FEFO)', planTopUp(ordered, [{ sku: SKU, quantity: 10080 }], [row('TN080726-N19', 7380)]).kind === 'unknown_lots');
// TR-00664 shape: labelled on lots the office did not write the way it wrote them
const sku664 = 'CN-CAP-WILDYAMHOR-60CT';
const v664 = planTopUp({ [sku664]: 1890 }, [{ sku: sku664, quantity: 1512, lot: '2512043A' }, { sku: sku664, quantity: 378, lot: '2604120A' }],
  [{ cin7_sku: sku664, cin7_lot: '2512043A', status: 'labels_ready', units: 1638, updated_at: OLD }]);
ok('🔴 shortfall != missing written lots (TR-00664 1638 vs 1512) -> mismatch, human decides', v664.kind === 'mismatch', v664);
ok('missing lot units must equal the shortfall exactly', planTopUp(ordered, [{ sku: SKU, quantity: 2700, lot: 'CN92572601' }, { sku: SKU, quantity: 7380, lot: 'TN080726-N19' }], [row('TN080726-N19', 7290)]).kind === 'mismatch');

// ---- wiring (source assertions: the pieces are actually connected) ----
const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sync = src('lib/cin7-transfer-sync.ts');
ok('sync: both line extractors read the lot', (sync.match(/lot: readCin7LineLot\(line\)/g) || []).length === 2);
ok('sync: partnerLineItems carry the lot to the bridge row', /\.\.\.\(line\.lot \? \{ lot: line\.lot \} : \{\}\)/.test(sync));
ok('sync: FBA handoff items are toLotItems(transfer.lines)', /items: toLotItems\(transfer\.lines\)/.test(sync));
const ho = src('lib/cin7-fba-handoff.ts');
ok('handoff: lot forwarded to auto-submit', /\.\.\.\(i\.lot \? \{ lot: i\.lot \} : \{\}\)/.test(ho));
const sho = src('lib/shiphero-orders.ts');
ok('ShipHero order lines still map sku/qty only (lot never sent to ShipHero)', !/lot:\s*item\.lot/.test(sho));
const auto = src('api/fba/auto-submit.ts');
ok('auto-submit honours items[].lot (explicit-lot path exists)', /if \(item\.lot\) \{/.test(auto) && /lots = \[target\]/.test(auto));
const rec = src('lib/fba-reconciler.ts');
const loop = rec.indexOf('for (const row of candidates)');
const existsAt = rec.indexOf('fbaRecordExists(db, row.cin7_transfer_number)', loop);
const woAt = rec.indexOf('readWorkOrderState(row.request_payload)', loop);
const topAt = rec.indexOf('handlePartialTransfer(db, row, deps, result, options)', loop);
ok('reconciler: work-order gate runs BEFORE the top-up', woAt > loop && woAt < topAt);
ok('reconciler: top-up decided inside the "exists" branch', topAt > existsAt && topAt - existsAt < 200);
const fn = rec.slice(rec.indexOf('export async function planPartialTopUp('), rec.indexOf('async function alertPartialOnce('));
ok('top-up: live CIN7 status gate', /isCin7StatusFireable\(live\.status\)/.test(fn));
ok('top-up: CIN7 edited after sync -> mismatch', /edited after sync/.test(fn));
ok('top-up: per-lot duplicate gate (findLivePlanForMissingLots), fail-closed', /findLivePlanForMissingLots\(db, row\.cin7_transfer_number, verdict\.items\)/.test(fn) && /fail-closed/.test(fn));
ok('top-up: lots come from the LIVE CIN7 lines', /toLotItems\(live\.lines\)/.test(fn));
const branch = rec.slice(rec.indexOf('async function handlePartialTransfer('), rec.indexOf('/** Same rule as lookupSkuMapping'));
ok('top-up fire sends ONLY the missing items', /items: topUp\.items/.test(branch));
ok('top-up throttled by shouldRetryNow', /shouldRetryNow\(row\)/.test(branch));
ok('dry run never fires or alerts', /if \(!options\.dryRun\)/.test(branch) && /!options\.dryRun && \(topUp\.kind === 'over'/.test(branch));
ok('every non-whole partial outcome is ledgered (skipped.push) or counted as a fire', (branch.match(/result\.skipped\.push\(/g) || []).length >= 2 && /result\.reFired\+\+/.test(branch));
ok('first-time re-fire also carries lots', /const fbaItems = toLotItems\(items\.map/.test(rec));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
