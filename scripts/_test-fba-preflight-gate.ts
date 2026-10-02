/**
 * fba-preflight-gate: actions from blockers, offline.
 * Run: npx tsx scripts/_test-fba-preflight-gate.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { applyPreflightGate, buildMarketingHoldNotice, MARKETING_HANDLE, isOnMarketingHold } from '../lib/fba-preflight-gate';
import { gatherPreflightFacts, probeAmazonReadiness } from '../lib/fba-preflight-facts';
import { SpApiError } from '../lib/amazon-sp-api-client';
import type { PreflightFacts } from '../lib/fba-preflight';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// ── fakes ──
function fakeSupabase() {
  const row: any = { id: 'row-1', request_payload: { partnerLineItems: [{ sku: 'X', quantity: 10 }] } };
  const updates: any[] = [];
  const sb: any = { from: () => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
    update: (u: any) => ({ eq: async () => { updates.push(u); Object.assign(row, { request_payload: u.request_payload ?? row.request_payload }); return { error: null }; } }),
  }) };
  return { sb, row, updates };
}
const good: PreflightFacts = {
  cin7Sku: 'CN-CAP-TEST-90CT', quantity: 500,
  casePack: { caseQuantity: 50, boxLength: 15, boxWidth: 13, boxHeight: 12, boxWeightLbs: 16 }, productNote: 'ok',
  lotNumber: 'L1', expirationDate: '2028-01-01', amazonMsku: 'CN-TEST-VEG', inboundReady: true, labelOwnerConstraint: 'NONE_ONLY',
};
const transfer = { id: 'cin7-1', transferNumber: 'TR-00999', destinationName: 'Amazon FBA', lines: [{ sku: good.cin7Sku, quantity: 500 }], shipheroOrderNumber: 'AMZ_TEST_00999' };

async function main() {
  // 1. clean facts → not gated, nothing created, nothing posted
  {
    const { sb, updates } = fakeSupabase(); let created = 0; const posts: string[] = [];
    const r = await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => good, createWorkOrder: (async () => { created++; return { id: 'x', legacyId: 1, status: 'IN_PROGRESS' }; }) as any, sendTelegram: async (h) => { posts.push(h); return true; } }, transfer);
    ok('clean → gated=false, 0 WOs, 0 posts, 0 row writes', !r.gated && created === 0 && posts.length === 0 && updates.length === 0);
  }
  // 2. missing ShipHero data → ONE custom WO, row parked as work_order, one floor notice
  {
    const { sb, row, updates } = fakeSupabase(); const woInputs: any[] = []; const posts: string[] = [];
    const r = await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => ({ ...good, casePack: null, productNote: null, lotNumber: null, expirationDate: null }), createWorkOrder: (async (_t: string, input: any) => { woInputs.push(input); return { id: 'g', legacyId: 172001, status: 'IN_PROGRESS', type: 'CUSTOM' }; }) as any, sendTelegram: async (h) => { posts.push(h); return true; } }, transfer);
    ok('🔴 4 floor blockers → gated, hold=floor, exactly ONE work order', r.gated && r.hold === 'floor' && woInputs.length === 1);
    ok('WO is HIGH, named DATA FIX <order>, instructions carry all 4 checklists', woInputs[0].priority === 'HIGH' && woInputs[0].name.startsWith('DATA FIX AMZ_TEST_00999') && /CASE QUANTITY/.test(woInputs[0].instructions) && /NO LOT/.test(woInputs[0].instructions) && /DIMENSIONS/.test(woInputs[0].instructions) && /WEIGHT/.test(woInputs[0].instructions));
    ok('row parked: request_payload.work_order with CUSTOM + ids + preflight reason, status awaiting_work_order', row.request_payload.work_order?.type === 'CUSTOM' && row.request_payload.work_order.ids[0] === '172001' && /^preflight:/.test(row.request_payload.work_order.reason) && updates.some((u) => u.last_fba_handoff_status === 'awaiting_work_order'));
    ok('park preserved partnerLineItems (no clobber)', Array.isArray(row.request_payload.partnerLineItems));
    ok('exactly one Telegram post, floor-voiced, lists the 4 gaps, no marketing tag', posts.length === 1 && /Product Data Needed/.test(posts[0]) && (posts[0].match(/^\d\. /gm) || []).length === 4 && !posts[0].includes(MARKETING_HANDLE));
    ok('floor notice says what happens on Complete (re-check, new WO if still missing)', /marked <b>Complete<\/b>/.test(posts[0]) && /new work order will say what/.test(posts[0]));
  }
  // 3. Wild Yam shape: mapped, NOT inbound-ready, ShipHero data fine → marketing hold, NO WO
  {
    const { sb, row, updates } = fakeSupabase(); let created = 0; const posts: string[] = [];
    const r = await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => ({ ...good, amazonMsku: 'CN-CAP-WILDYAMHOR-90BG-R1', inboundReady: false }), createWorkOrder: (async () => { created++; return { id: 'x', legacyId: 1, status: 'IN_PROGRESS' }; }) as any, sendTelegram: async (h) => { posts.push(h); return true; } }, transfer);
    ok('🔴 listing blocker → gated, hold=marketing, ZERO work orders', r.gated && r.hold === 'marketing' && created === 0);
    ok('one post tagging ' + MARKETING_HANDLE + ', with Seller Central Offer-tab steps, warehouse told "no action"', posts.length === 1 && posts[0].includes(MARKETING_HANDLE) && /Offer tab/.test(posts[0]) && /barcode type/.test(posts[0]) && /Warehouse:<\/b> no action/.test(posts[0]));
    ok('row carries preflight_hold (not work_order), status awaiting_listing', isOnMarketingHold(row.request_payload) && !row.request_payload.work_order && updates.some((u) => u.last_fba_handoff_status === 'awaiting_listing'));
    ok('notice promises the FNSKU follow-up WO if labels are needed', /FNSKU labels are then required, a work order will follow/.test(posts[0]));
  }
  // 4. stage 2: Amazon ready, SELLER_ONLY → floor WO for FNSKU labels with the unit count
  {
    const { sb } = fakeSupabase(); const woInputs: any[] = []; const posts: string[] = [];
    const r = await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => ({ ...good, labelOwnerConstraint: 'SELLER_ONLY', fnsku: 'X004WILDYAM' }), createWorkOrder: (async (_t: string, input: any) => { woInputs.push(input); return { id: 'g', legacyId: 172002, status: 'IN_PROGRESS', type: 'CUSTOM' }; }) as any, sendTelegram: async (h) => { posts.push(h); return true; } }, transfer);
    ok('🔴 FNSKU stage → floor WO: print 500 labels, cover UPC, Transparency if enrolled', r.hold === 'floor' && woInputs.length === 1 && /500 FNSKU labels/.test(woInputs[0].instructions) && /X004WILDYAM/.test(woInputs[0].instructions) && /covering the UPC/.test(woInputs[0].instructions) && /Transparency/.test(woInputs[0].instructions));
  }
  // 5. mapping missing AND data missing → marketing notice AND a floor WO (both owners act in parallel)
  {
    const { sb } = fakeSupabase(); let created = 0; const posts: string[] = [];
    const r = await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => ({ ...good, amazonMsku: null, casePack: null }), createWorkOrder: (async () => { created++; return { id: 'x', legacyId: 3, status: 'IN_PROGRESS', type: 'CUSTOM' }; }) as any, sendTelegram: async (h) => { posts.push(h); return true; } }, transfer);
    ok('both → 1 WO + 2 posts (marketing tag + floor), hold=floor', r.hold === 'floor' && created === 1 && posts.length === 2 && posts[0].includes(MARKETING_HANDLE) && !posts[1].includes(MARKETING_HANDLE));
  }
  // 6. Telegram failure never un-gates
  {
    const { sb, row } = fakeSupabase();
    const r = await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => ({ ...good, lotNumber: null }), createWorkOrder: (async () => ({ id: 'x', legacyId: 4, status: 'IN_PROGRESS', type: 'CUSTOM' })) as any, sendTelegram: async () => { throw new Error('tg down'); } }, transfer);
    ok('Telegram throws → still gated + parked (fail open on notification only)', r.gated && row.request_payload.work_order?.ids[0] === '4');
  }
  // 7. WO creation failure propagates (caller records work_order_failed and does NOT fire)
  {
    const { sb } = fakeSupabase(); let threw = false;
    try { await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => ({ ...good, lotNumber: null }), createWorkOrder: (async () => { throw new Error('ShipHero 500'); }) as any }, transfer); } catch { threw = true; }
    ok('WO create throws → gate throws (sync marks work_order_failed, never fires)', threw);
  }

  // ── facts: readiness probe semantics ──
  const notAvail = new SpApiError('createInboundPlan failed', 400, [{ code: 'BadRequest', message: 'ERROR: The following MSKUs are not available for inbound. MSKUs: [X]' }]);
  ok('probe: 400 "not available for inbound" → inboundReady=false', (await probeAmazonReadiness('X', (async () => { throw notAvail; }) as any)).inboundReady === false);
  ok('probe: 429 → undefined (fail open, not a marketing post)', (await probeAmazonReadiness('X', (async () => { throw new SpApiError('quota', 429); }) as any)).inboundReady === undefined);
  ok('probe: other 400 → undefined (only the explicit message blocks)', (await probeAmazonReadiness('X', (async () => { throw new SpApiError('bad', 400, [{ message: 'something else' }]); }) as any)).inboundReady === undefined);
  const okProbe = await probeAmazonReadiness('X', (async () => ({ data: { mskuPrepDetails: [{ msku: 'X', labelOwnerConstraint: 'SELLER_ONLY' }] } })) as any);
  ok('probe: success → ready + labelOwnerConstraint', okProbe.inboundReady === true && okProbe.labelOwnerConstraint === 'SELLER_ONLY');
  const facts = await gatherPreflightFacts({ shipheroToken: 't', resolveAmazonSku: async () => ({ amz_sku: 'M', amz_fnsku: 'F' }), getProductData: (async () => ({ sku: 'S', name: 'n', unitWeight: 0, casePack: null, expirationDate: null, lotNumber: null, isKit: false, productNote: null })) as any, probeReadiness: async () => ({ inboundReady: true, labelOwnerConstraint: 'NONE_ONLY' }) }, 'S', 5);
  ok('gather: null casePack + null lot flow through as missing; msku + fnsku bound', facts.casePack === null && facts.lotNumber === null && facts.amazonMsku === 'M' && facts.fnsku === 'F' && facts.inboundReady === true);
  const factsErr = await gatherPreflightFacts({ shipheroToken: 't', resolveAmazonSku: async () => { throw new Error('db'); }, getProductData: (async () => { throw new Error('sh down'); }) as any }, 'S', 5);
  ok('gather: ShipHero read fails → facts missing (fail closed); sku_master fails → amazonMsku undefined (NOT null → no marketing post)', factsErr.casePack === null && factsErr.amazonMsku === undefined);

  // ── wiring ──
  const sync = fs.readFileSync(path.join(__dirname, '../lib/cin7-transfer-sync.ts'), 'utf8');
  const rec = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');
  ok('sync: preflight runs after the kit gate and before pendingFbaHandoffs.push', sync.indexOf('applyPreflightGate(') > sync.indexOf('applyKitWorkOrderGate(') && sync.indexOf('applyPreflightGate(') < sync.lastIndexOf('pendingFbaHandoffs.push('));
  ok('sync: a preflight error marks work_order_failed and sets gated=true (fail closed)', /preflight could not run[\s\S]{0,300}gated = true/.test(sync));
  ok('reconciler: preflight re-runs at the fire decision, before shouldRetryNow', rec.indexOf('deps?.preflight') > 0 && rec.indexOf('deps?.preflight') < rec.indexOf('const decision = shouldRetryNow(row)'));
  ok('reconciler: a cleared hold is removed from the row', /clearMarketingHold\(db, row\.id, row\.request_payload\)/.test(rec));
  ok('reconciler: live preflight failing → synthetic gated result (never fires blind)', /preflight threw for[\s\S]{0,200}return \{ gated: true, hold: 'floor'/.test(rec));
  ok('marketing notice helper tags Prime', buildMarketingHoldNotice({ transferNumber: 'T', orderNumber: null, sku: 's', quantity: 1, blockers: [] }).includes('@primeaiagentbm_bot'));

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
