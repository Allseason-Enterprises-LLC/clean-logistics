/**
 * A FAILED ShipHero read is UNKNOWN, not MISSING — it must never become a
 * "Product Data Needed" work order.
 *
 * 2026-10-24 → 2026-11-05: three false work orders with all four floor blockers
 * at once (MISSING_CASE_PACK + MISSING_BOX_DIMS + MISSING_BOX_WEIGHT + MISSING_LOT):
 *   WO 178407 TR-00330 CN-GUM-BLDSUGAR-60BG
 *   WO 178406 TR-00331 CN-CAP-METHYLATIO-90CT
 *   WO 182426 TR-00699 CN-KIT-CAP-GARLICOREG-60CT-2PK
 * Every one had complete ShipHero data (the floor showed screenshots). ShipHero
 * returned code:30 "not enough credits"; gatherPreflightFacts caught the throw,
 * logged "treating as missing" and left casePack/lotNumber null, and runPreflight
 * read null as "missing" → the floor was told to re-enter data that existed.
 *
 * Contract:
 *   - product read throws (any reason) → facts.shipheroReadFailed = true,
 *     runPreflight returns SHIPHERO_READ_FAILED (owner 'retry'), and NO
 *     MISSING_* floor blocker for fields that were never read.
 *   - the gate treats a retry blocker as gated-but-silent: NO work order, NO
 *     Telegram post, row not parked as awaiting_work_order → next tick re-reads.
 *   - one transient failure, then success on the internal retry → normal result.
 *   - genuinely missing data (read OK, note empty) still produces the WO.
 *
 * Run: npx tsx scripts/_test-shiphero-read-failure-not-missing.ts
 */
import { gatherPreflightFacts } from '../lib/fba-preflight-facts';
import { runPreflight } from '../lib/fba-preflight';
import { applyPreflightGate } from '../lib/fba-preflight-gate';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const SKU = 'CN-KIT-CAP-GARLICOREG-60CT-2PK';
const CODE30 = new Error('ShipHero query error: [{"code":30,"message":"There are not enough credits to perform the requested operation, which requires 1008 credits, but there are only 383 left."}]');
const goodProduct = {
  casePack: { caseQuantity: 50, boxLength: 12, boxWidth: 12, boxHeight: 18, boxWeightLbs: 22 },
  productNote: 'Box Weight: 22 Lbs\nBox Size: 12 x 12 x 18 inches\nQuantity per Case: 50 packs',
  barcode: 'X004H73TFL', lotNumber: '0426354', expirationDate: '2028-05-31', isKit: false,
};
const baseDeps = (getProductData: any) => ({
  shipheroToken: 't',
  getProductData,
  getLots: async () => [{ name: '0426354', availableQty: 200, expiresAt: '2028-05-31' }],
  resolveAmazonSku: async () => ({ amz_sku: 'CLN-OREGANO-02', amz_fnsku: 'X004H73TFL', amz_asin: 'B0DNYHN1M3' }),
  hasPriorShipmentRow: async () => true,
  probeReadiness: async () => ({ inboundReady: true, labelOwnerConstraint: 'SELLER_ONLY' }),
  amazonUpcForAsin: async () => null,
  shippedBeforeOnAmazon: async () => true,
  fnskuForMsku: null,
  retryDelayMs: 0,
} as any);

function fakeSupabase() {
  const row: any = { id: 'row-1', request_payload: { partnerLineItems: [{ sku: SKU, quantity: 200 }] } };
  const updates: any[] = [];
  const sb: any = { from: () => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
    update: (u: any) => ({ eq: async () => { updates.push(u); Object.assign(row, { request_payload: u.request_payload ?? row.request_payload }); return { error: null }; } }),
  }) };
  return { sb, row, updates };
}

async function main() {
  // 1. 🔴 the TR-00699 shape: every product read fails with code:30
  {
    let calls = 0;
    const facts = await gatherPreflightFacts(baseDeps(async () => { calls++; throw CODE30; }), SKU, 200);
    ok('🔴 failed read is flagged shipheroReadFailed, not left as silent nulls', (facts as any).shipheroReadFailed === true);
    ok('read was retried before giving up (≥2 attempts)', calls >= 2, `calls=${calls}`);
    const pf = runPreflight(facts);
    const codes = pf.blockers.map((b) => b.code);
    ok('🔴 NO MISSING_CASE_PACK / BOX_DIMS / BOX_WEIGHT / LOT from an unread product', !codes.some((c) => /^MISSING_/.test(c)), codes.join('+'));
    ok('SHIPHERO_READ_FAILED blocker present, owner=retry', pf.blockers.some((b) => b.code === 'SHIPHERO_READ_FAILED' && (b.owner as string) === 'retry'));
    ok('not ok (do NOT fire blind on unread data)', pf.ok === false);
    ok('no floor blockers → no work order material', pf.floor.length === 0);
  }
  // 2. 🔴 the gate: read failure → no WO, no post, row not parked as awaiting_work_order
  {
    const { sb, row, updates } = fakeSupabase(); let created = 0; const posts: string[] = [];
    const r = await applyPreflightGate({
      supabase: sb, shipheroToken: 't',
      gatherFacts: (s, q) => gatherPreflightFacts(baseDeps(async () => { throw CODE30; }), s, q),
      createWorkOrder: (async () => { created++; return { id: 'x', legacyId: 999, status: 'IN_PROGRESS' }; }) as any,
      sendTelegram: async (h) => { posts.push(h); return true; },
    }, { id: 'cin7-699', transferNumber: 'TR-00699', destinationName: 'Amazon FBA', lines: [{ sku: SKU, quantity: 200 }], shipheroOrderNumber: 'AMZ_GARLICOREG_00699' });
    ok('🔴 gate: ZERO work orders created on a read failure', created === 0, `created=${created}`);
    ok('🔴 gate: ZERO channel posts on a read failure', posts.length === 0, posts[0]?.slice(0, 80));
    ok('gate: still gated (do not fire this tick)', r.gated === true);
    ok('gate: row NOT parked awaiting_work_order / no work_order written', !row.request_payload.work_order && !updates.some((u) => u.last_fba_handoff_status === 'awaiting_work_order'));
  }
  // 3. transient: first read fails, retry succeeds → normal clean result
  {
    let calls = 0;
    const facts = await gatherPreflightFacts(baseDeps(async () => { calls++; if (calls === 1) throw CODE30; return goodProduct; }), SKU, 200);
    ok('transient failure then success → shipheroReadFailed not set', !(facts as any).shipheroReadFailed);
    ok('…and the real case pack / lot are read', facts.casePack?.caseQuantity === 50 && facts.lotNumber === '0426354');
    const pf = runPreflight(facts);
    ok('…and preflight has no ShipHero blockers', !pf.blockers.some((b) => /^MISSING_|SHIPHERO_READ_FAILED/.test(b.code)), pf.blockers.map((b) => b.code).join('+'));
  }
  // 4. regression guard: data GENUINELY missing (read OK, empty note, no lot) still → WO
  {
    const facts = await gatherPreflightFacts(baseDeps(async () => ({ ...goodProduct, casePack: null, productNote: null, lotNumber: null, expirationDate: null })), SKU, 200);
    const codes = runPreflight(facts).blockers.map((b) => b.code);
    ok('genuinely missing data still yields all 4 MISSING_* blockers', ['MISSING_CASE_PACK', 'MISSING_BOX_DIMS', 'MISSING_BOX_WEIGHT', 'MISSING_LOT'].every((c) => codes.includes(c as any)), codes.join('+'));
    ok('…and no SHIPHERO_READ_FAILED when the read succeeded', !codes.includes('SHIPHERO_READ_FAILED' as any));
  }
  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
