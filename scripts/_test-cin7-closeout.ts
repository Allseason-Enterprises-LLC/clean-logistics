/**
 * CIN7 close-out gate: ShipHero fulfilled + Amazon shipped + coverage whole + quantities and
 * lots agree ⇒ complete; anything else waits or holds. Never completes a short transfer.
 * Run: npx tsx scripts/_test-cin7-closeout.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { decideCloseout, type CloseoutFacts } from '../lib/cin7-closeout';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const SKU = 'CN-KIT-CAP-GARLICOREG-60CT-2PK';
const base = (): CloseoutFacts => ({
  transfer: 'TR-00699', cin7Status: 'ORDERED', cin7CompletionDate: null,
  cin7Lines: [{ sku: SKU, qty: 200, productId: 'p1', comments: 'build 2PK kits, lot 0426354, expires 05/31/2028' }],
  shipheroFulfilled: true, shipheroShippedBySku: { [SKU]: 200 }, shipheroShipDate: '2026-11-06T18:02:00',
  coverageWhole: true,
  lots: [{ sku: SKU, lot: '0426354', expiry: '2028-05-31', units: 200, amazonStatus: 'IN_TRANSIT' }],
});

const good = decideCloseout(base());
ok('🔴 happy path completes with ship date and lot on the line', good.action === 'complete' && good.completionDate.startsWith('2026-11-06') && good.lines[0].lot === '0426354' && good.lines[0].expiry === '2028-05-31' && good.lines[0].qty === 200);

ok('already COMPLETED in CIN7 → already_complete (idempotent)', decideCloseout({ ...base(), cin7Status: 'COMPLETED', cin7CompletionDate: '2026-11-06' }).action === 'already_complete');
ok('VOIDED in CIN7 → hold, never written', decideCloseout({ ...base(), cin7Status: 'VOIDED' }).action === 'hold');
ok('ShipHero not fulfilled → wait', decideCloseout({ ...base(), shipheroFulfilled: false }).action === 'wait');
ok('Amazon WORKING → wait (freight not gone)', decideCloseout({ ...base(), lots: [{ ...base().lots[0], amazonStatus: 'WORKING' }] }).action === 'wait');
ok('no Amazon status recorded but ShipHero shipped >7d ago → completes (pre-status-sync rows)', decideCloseout({ ...base(), shipheroShipDate: '2026-09-01T10:00:00', lots: [{ ...base().lots[0], amazonStatus: null }] }).action === 'complete');
ok('no Amazon status recorded and shipped <7d ago → wait for status sync', decideCloseout({ ...base(), shipheroShipDate: new Date().toISOString(), lots: [{ ...base().lots[0], amazonStatus: null }] }).action === 'wait');
ok('Amazon RECEIVING counts as shipped', decideCloseout({ ...base(), lots: [{ ...base().lots[0], amazonStatus: 'RECEIVING' }] }).action === 'complete');
ok('🔴 coverage NOT whole (short) → hold, not complete', (() => { const d = decideCloseout({ ...base(), coverageWhole: false }); return d.action === 'hold' && /short/.test(d.reason); })());
ok('pre-lot-tracking row (null lot) → hold, not an endless wait', (() => { const d = decideCloseout({ ...base(), lots: [{ sku: SKU, lot: null as any, expiry: null, units: 0, amazonStatus: null }] }); return d.action === 'hold' && /pre-lot-tracking/.test(d.reason); })());
ok('🔴 coverage never computed (pre-10/15) → computed from facts, completes when units match', decideCloseout({ ...base(), coverageWhole: null }).action === 'complete');
ok('coverage never computed AND units mismatch → hold', decideCloseout({ ...base(), coverageWhole: null, lots: [{ ...base().lots[0], units: 150 }] }).action === 'hold');
ok('ShipHero shipped ≠ CIN7 ordered → hold', decideCloseout({ ...base(), shipheroShippedBySku: { [SKU]: 150 } }).action === 'hold');
ok('lot rows total ≠ CIN7 ordered → hold', decideCloseout({ ...base(), lots: [{ ...base().lots[0], units: 100 }] }).action === 'hold');
ok('missing expiry → hold (CIN7 requires ExpiryDate)', decideCloseout({ ...base(), lots: [{ ...base().lots[0], expiry: null }] }).action === 'hold');

// TR-00699 as found live: CIN7 comment names lot 0426355, shipment lot 0426354
const mismatch = decideCloseout({ ...base(), cin7Lines: [{ sku: SKU, qty: 200, productId: 'p1', comments: 'build 2PK kits from CN-CAP-GARLICOREG-60CT lot 0426355 (400 bottles), lot 0426355, expires 05/31/2028' }] });
ok('🔴 CIN7 line names a different lot than shipped → hold with both lots in the reason', mismatch.action === 'hold' && /0426355/.test(mismatch.reason) && /0426354/.test(mismatch.reason));
ok('CIN7 comment with no lot → no lot check, completes', decideCloseout({ ...base(), cin7Lines: [{ sku: SKU, qty: 200, productId: 'p1', comments: 'pick from A aisle' }] }).action === 'complete');

// two lots, one SKU
const two = decideCloseout({ ...base(), cin7Lines: [{ sku: SKU, qty: 500, productId: 'p1', comments: null }], shipheroShippedBySku: { [SKU]: 500 },
  lots: [{ sku: SKU, lot: 'A1', expiry: '2027-01-31', units: 300, amazonStatus: 'IN_TRANSIT' }, { sku: SKU, lot: 'B2', expiry: '2028-01-31', units: 200, amazonStatus: 'SHIPPED' }] });
ok('two lots → two CIN7 lines, each with its own BatchSN/Expiry', two.action === 'complete' && two.lines.length === 2 && two.lines.map((l) => l.lot).join() === 'A1,B2' && two.lines.reduce((s, l) => s + l.qty, 0) === 500);

// TR-00829: labels planned on one lot, floor shipped two → CIN7 lines follow ShipHero
const PF = 'CN-CAP-PHYTOFRESH-60CT';
const split = decideCloseout({ ...base(), cin7Lines: [{ sku: PF, qty: 4080, productId: 'p9', comments: 'lot 2609096A 2340 exp 09/30/2028 + lot 2610081A 1740 exp 10/31/2028' }], shipheroShippedBySku: { [PF]: 4080 },
  lots: [{ sku: PF, lot: '2609096A', expiry: '2028-09-30', units: 4080, amazonStatus: 'IN_TRANSIT' }],
  shipheroLots: [{ sku: PF, lot: '2609096A', expiry: '2028-09-30', qty: 2100 }, { sku: PF, lot: '2610081A', expiry: '2028-10-31', qty: 1980 }] });
ok('🔴 CIN7 lines use ShipHero shipped lots (TR-00829: 2100@2609096A + 1980@2610081A, not 4080@label lot)', split.action === 'complete' && split.lines.length === 2 && split.lines.find((l) => l.lot === '2610081A')?.qty === 1980 && split.lines.find((l) => l.lot === '2609096A')?.qty === 2100 && split.lines.find((l) => l.lot === '2610081A')?.expiry === '2028-10-31');
const partialSh = decideCloseout({ ...base(), shipheroLots: [{ sku: SKU, lot: '0426354', expiry: '2028-05-31', qty: 150 }] });
ok('ShipHero lot split that does not sum to ordered → falls back to label lots', partialSh.action === 'complete' && partialSh.lines[0].qty === 200);
const mm = decideCloseout({ ...base(), cin7Lines: [{ sku: SKU, qty: 200, productId: 'p1', comments: 'lot 0426355' }], shipheroLots: [{ sku: SKU, lot: '0426354', expiry: '2028-05-31', qty: 200 }] });
ok('comment names a lot neither labels nor ShipHero shipped → still holds (TR-00821)', mm.action === 'hold');

const conf = decideCloseout({ ...base(), cin7Lines: [{ sku: SKU, qty: 200, productId: 'p1', comments: 'lot 0426355' }], lotsConfirmed: ['0426354'] });
ok('human-confirmed shipped lot clears the lot-name hold (TR-00821)', conf.action === 'complete' && conf.lines[0].lot === '0426354');
const badConf = decideCloseout({ ...base(), cin7Lines: [{ sku: SKU, qty: 200, productId: 'p1', comments: 'lot 0426355' }], lotsConfirmed: ['0426355'] });
ok('🔴 confirmation naming a lot we did NOT ship does not clear the hold', badConf.action === 'hold');

const MS = 'CN-DRP-MENSSUPPOR-2OZ';
const hy = decideCloseout({ ...base(), cin7Lines: [{ sku: MS, qty: 1710, productId: 'p7', comments: 'pick from A-aisle bins only, do not allocate from B bins, lot TN061526-N19, expires 06/30/2028' }], shipheroShippedBySku: { [MS]: 1710 },
  lots: [{ sku: MS, lot: 'TN061526-N19', expiry: '2028-06-30', units: 1710, amazonStatus: 'IN_TRANSIT' }] });
ok('🔴 hyphenated lot in the CIN7 comment matches (TR-00843: TN061526-N19, not TN061526)', hy.action === 'complete' && hy.lines[0].lot === 'TN061526-N19');
const hyBad = decideCloseout({ ...base(), cin7Lines: [{ sku: MS, qty: 1710, productId: 'p7', comments: 'lot TN082526-N19' }], shipheroShippedBySku: { [MS]: 1710 },
  lots: [{ sku: MS, lot: 'TN061526-N19', expiry: '2028-06-30', units: 1710, amazonStatus: 'IN_TRANSIT' }] });
ok('a genuinely different hyphenated lot still holds', hyBad.action === 'hold');

const src = fs.readFileSync(path.join(__dirname, '../lib/cin7-closeout.ts'), 'utf8');
ok('🔴 holds NEVER post to the channel (log only — eleven 🗂 posts in one tick on 11/11)', !src.includes('await opts.notify') && src.includes("console.log(`[cin7-closeout] hold"));
ok('waiting rows are re-checked every 6h, not every tick (shared CIN7 budget)', src.includes("c.state === 'wait' && !opts.only && Date.now() - Date.parse(c.at) < WAIT_RECHECK_MS"));
ok('pre-10/15 rows get units from Amazon plan items and persist them (one read, then free)', src.includes("const fromAmazon = await unitsForPlan(r.plan_id)") && src.includes("source: 'amazon_plan_items'"));
const wfn = src.slice(src.indexOf('export async function completeInCin7'), src.indexOf('export interface CloseoutRunResult'));
ok('write path re-reads CIN7 AT the write and bails if no longer open', wfn.indexOf("executeCIN7Request('/stockTransfer'") < wfn.indexOf('if (!CIN7_OPEN_STATUSES.has') && wfn.indexOf('if (!CIN7_OPEN_STATUSES.has') < wfn.indexOf("cin7Write('PUT', 'stockTransfer'"));
ok('ONE write: header PUT carries Lines with BatchSN/ExpiryDate; /order is NOT written (locked once IN TRANSIT)', !src.includes("'stockTransfer/order'") && src.includes("hdr.Lines = lines") && src.includes("cin7Write('PUT', 'stockTransfer', hdr"));
ok('candidates are chosen by an ACTIVE labelled FBA row, not by handoff status (TR-00699 was work_order_failed yet shipped)', src.includes('labelledTrs.has(r.cin7_transfer_number)') && !src.includes(".in('last_fba_handoff_status', ['dispatched'"));
ok('held rows are not retried automatically (wait for a human or ?only=)', src.includes("if (c.state === 'hold' && !opts.only) return false;"));

const runFn = src.slice(src.indexOf('export async function runCin7Closeout'));
ok('🔴 candidate queries PAGINATE (11/13-11/17: .limit(500) on oldest-first rows → considered 0, silent 200 OK)', !runFn.includes('.limit(500)') && !runFn.includes('.limit(5000)') && runFn.split('.range(from, from + 999)').length - 1 >= 2);
ok('🔴 errored rows back off 6h like waits (11/17: 11 CIN7-400 rows starved TR-00799/00804/00812)', src.includes("c.state === 'error' && !opts.only && Date.now() - Date.parse(c.at) < WAIT_RECHECK_MS"));
ok('🔴 missing CIN7 creds fails the RUN before any row is marked (11/18 creds-less invocation stamped rows error)', runFn.indexOf('!process.env.CIN7_ACCOUNT_ID') > -1 && runFn.indexOf('!process.env.CIN7_ACCOUNT_ID') < runFn.indexOf('const mark = async'));
ok('429 defers the tick instead of hammering the shared key', src.includes('instanceof Cin7RateLimitError) { res.deferred = true; break; }'));
const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
const cron = vercel.crons.find((c: any) => c.path === '/api/cron/cin7-closeout');
ok('cron scheduled off the sync minutes (:10/:30/:50)', !!cron && cron.schedule === '10,30,50 * * * *');
ok('TikTok destinations excluded (tiktok-fbt-bridge owns them; never two writers on one TR)', src.includes("if (/tiktok/i.test(String(r.cin7_destination || ''))) return false;"));

console.log(`\\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
