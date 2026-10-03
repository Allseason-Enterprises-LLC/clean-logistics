/**
 * 2026-10-03: five ✅ "labels within ~15 minutes" messages, then silence for
 * 1–2 days. Three gaps: reconciler-side hold notice went to the wrong sender;
 * stock-not-in-bulk wasn't a preflight check; the poller promised labels
 * without checking. Run: npx tsx scripts/_test-release-truth.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { runPreflight, buildPreflightWorkOrderText, type PreflightFacts } from '../lib/fba-preflight';
import { gatherPreflightFacts } from '../lib/fba-preflight-facts';
import { pollWorkOrders } from '../lib/work-order-poller';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const codes = (f: PreflightFacts) => runPreflight(f).blockers.map((b) => b.code);

async function main() {
  const good: PreflightFacts = {
    cin7Sku: 'CN-CAP-SEATOXSPIRULINA-90CT', quantity: 300,
    casePack: { caseQuantity: 60, boxLength: 15, boxWidth: 13, boxHeight: 12, boxWeightLbs: 16 }, productNote: 'ok',
    lotNumber: '2603015C', expirationDate: '2028-03-31', amazonMsku: 'CNO-SEATOXSPIRULINA-VEG', inboundReady: true, labelOwnerConstraint: 'SELLER_ONLY', shippedBefore: true,
    bulkLots: [{ name: '2502070A', availableQty: 60, expiresAt: '2027-02-28' }, { name: '2510028A', availableQty: 120, expiresAt: '2027-10-31' }, { name: '2603015C', availableQty: 28, expiresAt: '2028-03-31' }],
    pickableUnits: 168,
  };

  // ── 2. stock not in bulk ──
  const r510 = runPreflight(good);
  ok('🔴 TR-00510 shape: bulk 60+120+28 (3 full cases) vs 300 needed (5 cases) → STOCK_NOT_IN_BULK (floor)', r510.floor.map((b) => b.code).join() === 'STOCK_NOT_IN_BULK');
  ok('checklist: names the lots in bulk, says move 2 cases (120 units) from pick bins, keep lot, confirm in ShipHero', (() => { const s = r510.floor[0].checklist.join(' '); return /2502070A=60/.test(s) && /Move 2 full case\(s\) \(120 units\)/.test(s) && /168 units are sitting in pickable/.test(s) && /keeping the lot/.test(s) && /confirm the bulk bin/.test(s); })());
  ok('TR-00509 shape: zero in bulk, 189 pickable → blocker says move 11 cases of 12', (() => { const r = runPreflight({ ...good, cin7Sku: 'CN-CAP-CRANFLOW-60CT', quantity: 126, casePack: { ...good.casePack!, caseQuantity: 12 }, bulkLots: [], pickableUnits: 189 }); return r.floor[0]?.code === 'STOCK_NOT_IN_BULK' && /Move 11 full case\(s\) \(132 units\)/.test(r.floor[0].checklist.join(' ')); })());
  ok('no pickable stock either → "bring cases in / tell the office the order must be reduced"', /no more stock, tell the office/.test(runPreflight({ ...good, bulkLots: [], pickableUnits: 0 }).floor[0].checklist.join(' ')));
  ok('enough in bulk → no blocker', codes({ ...good, bulkLots: [{ name: 'L', availableQty: 300, expiresAt: '2028-01-01' }] }).length === 0);
  ok('partial cases do not count (299 in bulk, case 60 → 4 cases < 5 → blocked)', codes({ ...good, bulkLots: [{ name: 'L', availableQty: 299, expiresAt: '2028-01-01' }] }).includes('STOCK_NOT_IN_BULK'));
  ok('bulkLots undefined (read failed) → no stock blocker (fail open; allocator decides)', !codes({ ...good, bulkLots: undefined }).includes('STOCK_NOT_IN_BULK'));
  ok('no case pack → MISSING_CASE_PACK, not a stock verdict (can\'t count cases)', (() => { const c = codes({ ...good, casePack: null }); return c.includes('MISSING_CASE_PACK') && !c.includes('STOCK_NOT_IN_BULK'); })());
  ok('TR-00516 shape: "Quantity per Case:" with NO number → caseQuantity 0 → MISSING_CASE_PACK', codes({ ...good, casePack: { ...good.casePack!, caseQuantity: 0 }, productNote: 'Box Weight: 42 Lbs\nBox Size: 15 x 13 x 14 inches\nQuantity per Case:' }).includes('MISSING_CASE_PACK'));
  ok('WO name for stock-only task is MOVE STOCK', buildPreflightWorkOrderText({ transferNumber: 'TR-00510', orderNumber: 'AMZ_SEATOXSPIRULINA_00510', sku: good.cin7Sku, quantity: 300, blockers: r510.blockers }).name.startsWith('MOVE STOCK AMZ_SEATOXSPIRULINA_00510'));

  // gather: bulk vs all → pickableUnits
  const pd = { sku: 'S', name: 'n', unitWeight: 0, casePack: good.casePack, expirationDate: '2028-03-31', lotNumber: 'L', isKit: false, productNote: 'x', barcode: null };
  const f = await gatherPreflightFacts({ shipheroToken: 't', resolveAmazonSku: async () => null, getProductData: (async () => pd) as any,
    getLots: (async (_t: string, _s: string, opts?: any) => opts?.includePickable ? [{ name: 'L', availableQty: 376, expiresAt: '2028-03-31' }] : [{ name: 'L', availableQty: 208, expiresAt: '2028-03-31' }]) as any }, 'S', 300);
  ok('gather: bulkLots from non-pickable read; pickableUnits = all − bulk (376−208=168)', f.bulkLots?.[0].availableQty === 208 && f.pickableUnits === 168);
  const fErr = await gatherPreflightFacts({ shipheroToken: 't', resolveAmazonSku: async () => null, getProductData: (async () => pd) as any, getLots: (async () => { throw new Error('sh'); }) as any }, 'S', 300);
  ok('gather: lot read fails → bulkLots undefined (fail open)', fErr.bulkLots === undefined);

  // ── 3. poller says the true thing ──
  const mkDeps = (pf: any) => {
    const sent: string[] = []; const row = { id: 'r1', cin7_transfer_number: 'TR-00509', request_payload: { work_order: { type: 'CUSTOM', ids: ['172630'], status: 'IN_PROGRESS', created_at: '2026-10-02T00:00:00Z', kit_sku: 'CN-CAP-CRANFLOW-60CT', kit_qty: 126, order_number: 'AMZ_CN-CAP-CRANFLOW-60CT_00509', reason: 'x' } } };
    const sb: any = { from: () => ({ select: () => ({ eq: () => ({ not: () => ({ limit: async () => ({ data: [row], error: null }) }) }) }), update: () => ({ eq: async () => ({ error: null }) }) }) };
    return { sent, deps: { supabase: sb, shipheroToken: 't', sendTelegram: async (h: string) => { sent.push(h); return true; }, getWorkOrder: (async () => ({ status: 'COMPLETED', completedAt: '2026-10-02T19:43:00Z' })) as any, preflight: pf } };
  };
  { const { sent, deps } = mkDeps(async () => ({ gated: false, hold: null, blockers: [] })); await pollWorkOrders(deps as any);
    ok('release + preflight clear → the classic "labels within ~15 minutes" promise', sent.length === 1 && /✅/.test(sent[0]) && /within ~15 minutes/.test(sent[0])); }
  { const { sent, deps } = mkDeps(async () => ({ gated: true, hold: 'floor', blockers: [{ code: 'STOCK_NOT_IN_BULK', summary: 'Only 0 units (0 full cases) are in bulk bins; the order needs 126 (11 cases)' }], workOrderIds: ['172999'] })); await pollWorkOrders(deps as any);
    ok('🔴 release + floor blocker → NO 15-min promise; names the blocker + the new WO id', sent.length === 1 && !/within ~15 minutes/.test(sent[0]) && /One more thing is needed/.test(sent[0]) && /172999/.test(sent[0]) && /0 full cases/.test(sent[0])); }
  { const { sent, deps } = mkDeps(async () => ({ gated: true, hold: 'marketing', blockers: [{ code: 'NO_AMAZON_MAPPING', summary: 'No Amazon MSKU mapped for CN-BDL-CAP-NMNSUPP-60CT-2PK' }] })); await pollWorkOrders(deps as any);
    ok('🔴 release + marketing hold → "on hold for an Amazon listing fix", warehouse no action, no promise', sent.length === 1 && !/within ~15 minutes/.test(sent[0]) && /on hold for an Amazon listing fix/.test(sent[0]) && /Warehouse: no action/.test(sent[0])); }
  { const { sent, deps } = mkDeps(async () => { throw new Error('boom'); }); await pollWorkOrders(deps as any);
    ok('preflight throws → does NOT promise labels (fail closed on the promise)', sent.length === 1 && !/within ~15 minutes/.test(sent[0]) && /could not run/.test(sent[0])); }
  { const { sent, deps } = mkDeps(undefined); await pollWorkOrders(deps as any);
    ok('no preflight dep (legacy/tests) → classic message', sent.length === 1 && /within ~15 minutes/.test(sent[0])); }

  // ── 1. reconciler-side hold notice goes to the FBA channel sender ──
  const rec = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');
  const lp = rec.slice(rec.indexOf('export async function livePreflight'), rec.indexOf('export async function reconcileFbaHandoffs'));
  const lpCode = lp.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // ignore comments that mention the old sender by name
  ok('🔴 livePreflight posts via fba-post-process sendTelegram (FBA channel, HTML), not sendTelegramAlert', /sendTelegram: \(html\) => sendFbaTelegram\(html\)/.test(lpCode) && !/sendTelegramAlert\(/.test(lpCode));
  ok('livePreflight is exported (shared by reconciler + poller cron)', /export async function livePreflight/.test(rec));
  const ep = fs.readFileSync(path.join(__dirname, '../api/cron/poll-work-orders.ts'), 'utf8');
  ok('poll-work-orders cron wires preflight via livePreflight and passes blockers + WO ids through', /livePreflight\(supabase/.test(ep) && /workOrderIds: pf\.workOrder\?\.ids/.test(ep));

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
