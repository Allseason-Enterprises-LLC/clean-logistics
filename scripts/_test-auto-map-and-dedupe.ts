/**
 * Auto-map + once-only notices. Run: npx tsx scripts/_test-auto-map-and-dedupe.ts
 */
import { acceptAutoMapping, fnskusMatch, autoResolveAmazonSku, fetchListingByMsku } from '../lib/amazon-auto-map';
import { gatherPreflightFacts } from '../lib/fba-preflight-facts';
import { applyPreflightGate, MARKETING_HANDLE } from '../lib/fba-preflight-gate';
import { runPreflight } from '../lib/fba-preflight';
import type { PreflightFacts } from '../lib/fba-preflight';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

async function main() {
  // ── acceptance rule ──
  ok('listing UPC == ShipHero barcode → accept', acceptAutoMapping('810197342292', null, '810197342292') === 'accept');
  ok('EAN-13 leading zero == UPC-A → accept', acceptAutoMapping('0810197342292', null, '810197342292') === 'accept');
  ok('🔴 different UPC → conflict (never auto-map a different product)', acceptAutoMapping('810197342124', null, '810197341394') === 'conflict');
  ok('no UPC on listing or no ShipHero barcode → unverifiable (no auto-map)', acceptAutoMapping(null, null, '810197342292') === 'unverifiable' && acceptAutoMapping('810197342292', null, null) === 'unverifiable');

  // ── 🔴 2026-10-07: ShipHero barcode holds the FNSKU, not the UPC ──
  //    Weston: "in many scenarios we're using FNSKU so if the FNSKU matches
  //    then we should be using that." This parked TR-00517/00518/00519 on a
  //    marketing hold for listings that were live and inbound-ready.
  ok('🔴 TR-00517 shape (2PK): barcode == listing FNSKU, UPC differs → ACCEPT (not conflict)',
    acceptAutoMapping('810197342322', 'X005CNC45Z', 'X005CNC45Z') === 'accept');
  ok('🔴 TR-00518 shape (3PK): barcode == FNSKU X005CO06SB → accept',
    acceptAutoMapping('810197342339', 'X005CO06SB', 'X005CO06SB') === 'accept');
  ok('🔴 TR-00519 shape (4PK): barcode == FNSKU X005CNC60D → accept',
    acceptAutoMapping('810197342346', 'X005CNC60D', 'X005CNC60D') === 'accept');
  ok('5PK/6PK shape: barcode == UPC while FNSKU differs → still accept (UPC path unbroken)',
    acceptAutoMapping('810197342353', 'X005CODE03', '810197342353') === 'accept');
  ok('🔴 barcode matches NEITHER UPC nor FNSKU → conflict (the real defect is still caught)',
    acceptAutoMapping('810197342322', 'X005CNC45Z', 'X009ZZZZZZ') === 'conflict');
  ok('FNSKU compare is case/whitespace tolerant', acceptAutoMapping(null, 'X005CNC45Z', ' x005cnc45z ') === 'accept');
  ok('🔴 FNSKU compare is EXACT, never digit-stripped (X005CNC45Z must NOT match X005CNC60D)',
    fnskusMatch('X005CNC45Z', 'X005CNC60D') === false && acceptAutoMapping(null, 'X005CNC45Z', 'X005CNC60D') === 'conflict');
  ok('🔴 two different FNSKUs that reduce to the same digits do NOT match (barcodesMatch trap)',
    fnskusMatch('X005A5Z', 'X5B') === false);
  ok('FNSKU missing on either side → undefined (no false accept, no false conflict)',
    fnskusMatch(null, 'X005CNC45Z') === undefined && fnskusMatch('X005CNC45Z', '') === undefined);

  // ── resolver: FNSKU-matched mapping is recorded and says so ──
  {
    const ins: any[] = [];
    const db2: any = { from: () => ({ insert: async (r: any) => { ins.push(r); return { error: null }; } }) };
    const listing = async (m: string) => ({ msku: m, asin: 'B0HJNGFHZ2', upc: '810197342322', fnsku: 'X005CNC45Z' });
    const r = await autoResolveAmazonSku({ cin7Sku: 'CN-BDL-CAP-WMNSNMNFOR-60CT-2PK', shipheroBarcode: 'X005CNC45Z', db: db2, fetchListing: listing as any });
    ok('🔴 2PK auto-maps via FNSKU and returns the FNSKU for labelling', r?.amz_sku === 'CN-BDL-CAP-WMNSNMNFOR-60CT-2PK' && r?.amz_fnsku === 'X005CNC45Z');
    ok('sku_master note records WHICH identifier matched (FNSKU, not UPC)', ins.length === 1 && /FNSKU X005CNC45Z == ShipHero barcode/.test(ins[0].notes));
  }

  // ── listing parse: FNSKU comes off summaries[0].fnSku ──
  {
    const apiShape = async () => ({
      status: 200,
      data: {
        summaries: [{ asin: 'B0HJNGFHZ2', fnSku: 'X005CNC45Z', status: ['DISCOVERABLE'] }],
        attributes: { externally_assigned_product_identifier: [{ value: '810197342322', type: 'upc' }] },
        // live shape: no fnSku key here — reading it from this array yields null
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA' }],
      },
    });
    const l = await fetchListingByMsku('CN-BDL-CAP-WMNSNMNFOR-60CT-2PK', apiShape as any);
    ok('🔴 FNSKU read from summaries[0].fnSku (fulfillmentAvailability has no fnSku key)', l?.fnsku === 'X005CNC45Z' && l?.upc === '810197342322');
  }

  // ── gate: an FNSKU-in-barcode product must NOT raise UPC_MISMATCH ──
  {
    const base: PreflightFacts = {
      cin7Sku: 'CN-BDL-CAP-WMNSNMNFOR-60CT-2PK', quantity: 50,
      casePack: { caseQuantity: 25, boxLength: 15, boxWidth: 13, boxHeight: 12, boxWeightLbs: 12 }, productNote: 'ok',
      lotNumber: '2606048A', expirationDate: '2028-06-30',
      amazonMsku: 'CN-BDL-CAP-WMNSNMNFOR-60CT-2PK', inboundReady: true,
      labelOwnerConstraint: 'NONE_ONLY', shippedBefore: true,
      shipheroBarcode: 'X005CNC45Z', amazonUpc: '810197342322', fnsku: 'X005CNC45Z',
      bulkLots: [{ name: '2606048A', availableQty: 50, expiresAt: '2028-06-30' }], pickableUnits: 0,
    };
    ok('🔴 UPC-type listing whose ShipHero barcode is the FNSKU → NO UPC_MISMATCH, would fire', runPreflight(base).ok);
    ok('🔴 barcode matching neither → UPC_MISMATCH still raised',
      runPreflight({ ...base, shipheroBarcode: 'X009ZZZZZZ', fnsku: 'X005CNC45Z' }).blockers.some((b) => b.code === 'UPC_MISMATCH'));
    ok('genuine UPC conflict (both numeric, different) → UPC_MISMATCH',
      runPreflight({ ...base, shipheroBarcode: '810197341394', fnsku: null }).blockers.some((b) => b.code === 'UPC_MISMATCH'));
  }

  // ── facts: FNSKU is backfilled from the listing when sku_master lacks it ──
  {
    const pdF = { sku: 'S', name: 'n', unitWeight: 0, casePack: null, expirationDate: null, lotNumber: null, isKit: false, productNote: null, barcode: 'X005CNC45Z' };
    let fnCalls = 0;
    const f = await gatherPreflightFacts({
      shipheroToken: 't', resolveAmazonSku: async () => ({ amz_sku: 'M', amz_fnsku: null }),
      getProductData: (async () => pdF) as any, getLots: (async () => []) as any,
      probeReadiness: async () => ({ inboundReady: true, labelOwnerConstraint: 'NONE_ONLY' }),
      fnskuForMsku: async () => { fnCalls++; return 'X005CNC45Z'; },
    }, 'S', 5);
    ok('🔴 sku_master has no FNSKU → backfilled from the listing so the barcode check can see it', fnCalls === 1 && f.fnsku === 'X005CNC45Z');
    const f2 = await gatherPreflightFacts({
      shipheroToken: 't', resolveAmazonSku: async () => ({ amz_sku: 'M', amz_fnsku: 'FROM-DB' }),
      getProductData: (async () => pdF) as any, getLots: (async () => []) as any,
      probeReadiness: async () => ({ inboundReady: true, labelOwnerConstraint: 'NONE_ONLY' }),
      fnskuForMsku: async () => { fnCalls++; return 'X'; },
    }, 'S', 5);
    ok('sku_master already has an FNSKU → no extra Listings call', fnCalls === 1 && f2.fnsku === 'FROM-DB');
    const f3 = await gatherPreflightFacts({
      shipheroToken: 't', resolveAmazonSku: async () => ({ amz_sku: 'M', amz_fnsku: null }),
      getProductData: (async () => pdF) as any, getLots: (async () => []) as any,
      probeReadiness: async () => ({ inboundReady: true, labelOwnerConstraint: 'NONE_ONLY' }),
      fnskuForMsku: (async () => { throw new Error('429'); }) as any,
    }, 'S', 5);
    ok('FNSKU lookup throws → fail open (fnsku null, no crash, no blocker invented)', f3.fnsku === null || f3.fnsku === undefined);
  }

  // ── resolver with fake Listings API + fake db ──
  const inserts: any[] = [];
  const db: any = { from: () => ({ insert: async (r: any) => { inserts.push(r); return { error: null }; } }) };
  const found = async (m: string) => m === 'CN-BDL-CAP-NMNSUPP-60CT-4PK' ? { msku: m, asin: 'B0HJNJ18M3', upc: '810197342292', fnsku: null } : null;
  const r1 = await autoResolveAmazonSku({ cin7Sku: 'CN-BDL-CAP-NMNSUPP-60CT-4PK', shipheroBarcode: '810197342292', db, fetchListing: found as any });
  ok('🔴 NMN 4PK shape: Amazon offer MSKU == CIN7 SKU, UPC matches → mapped + recorded in sku_master (verified=false, notes say auto)', r1?.amz_sku === 'CN-BDL-CAP-NMNSUPP-60CT-4PK' && r1.amz_asin === 'B0HJNJ18M3' && inserts.length === 1 && inserts[0].verified === false && /auto-mapped/.test(inserts[0].notes));
  const r2 = await autoResolveAmazonSku({ cin7Sku: 'CN-BDL-CAP-NMNSUPP-60CT-4PK', shipheroBarcode: '999999999999', db, fetchListing: found as any });
  ok('same offer but ShipHero barcode differs → NOT mapped (conflict), nothing inserted', r2 === null && inserts.length === 1);
  const r3 = await autoResolveAmazonSku({ cin7Sku: 'CN-KIT-CAP-SHILAJITPR-90CT-2PK', shipheroBarcode: 'x', db, fetchListing: found as any });
  ok('Shilajit shape: no offer with that MSKU (404) → null (marketing hold as before; no name guessing)', r3 === null);
  const r4 = await autoResolveAmazonSku({ cin7Sku: 'S', shipheroBarcode: '1', db, fetchListing: (async () => { throw new Error('429'); }) as any });
  ok('Listings API throws → null (fail open to the hold, never a crash)', r4 === null);
  const dbErr: any = { from: () => ({ insert: async () => { throw new Error('dup key'); } }) };
  const r5 = await autoResolveAmazonSku({ cin7Sku: 'CN-BDL-CAP-NMNSUPP-60CT-4PK', shipheroBarcode: '810197342292', db: dbErr, fetchListing: found as any });
  ok('sku_master insert fails → mapping still returned for THIS run (re-resolves next tick)', r5?.amz_sku === 'CN-BDL-CAP-NMNSUPP-60CT-4PK');

  // ── facts: autoResolve runs only when sku_master is empty ──
  const pd = { sku: 'S', name: 'n', unitWeight: 0, casePack: null, expirationDate: null, lotNumber: null, isKit: false, productNote: null, barcode: '810197342292' };
  let autoCalls = 0;
  const f1 = await gatherPreflightFacts({ shipheroToken: 't', resolveAmazonSku: async () => null, getProductData: (async () => pd) as any, getLots: (async () => []) as any, probeReadiness: async () => ({ inboundReady: true, labelOwnerConstraint: 'NONE_ONLY' }), autoResolve: async () => { autoCalls++; return { amz_sku: 'M', amz_asin: 'A', amz_fnsku: null }; } }, 'S', 5);
  ok('sku_master empty → autoResolve called and its MSKU used', autoCalls === 1 && f1.amazonMsku === 'M');
  const f2 = await gatherPreflightFacts({ shipheroToken: 't', resolveAmazonSku: async () => ({ amz_sku: 'X' }), getProductData: (async () => pd) as any, getLots: (async () => []) as any, probeReadiness: async () => ({ inboundReady: true, labelOwnerConstraint: 'NONE_ONLY' }), autoResolve: async () => { autoCalls++; return null; } }, 'S', 5);
  ok('sku_master has a row → autoResolve NOT called', autoCalls === 1 && f2.amazonMsku === 'X');

  // ── gate: once-only marketing notice ──
  function fakeSupabase() {
    const row: any = { id: 'row-1', request_payload: { partnerLineItems: [{ sku: 'X', quantity: 10 }] } };
    const sb: any = { from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
      update: (u: any) => ({ eq: async () => { Object.assign(row, { request_payload: u.request_payload ?? row.request_payload }); return { error: null }; } }),
    }) };
    return { sb, row };
  }
  const good: PreflightFacts = { cin7Sku: 'CN-BDL-CAP-NMNSUPP-60CT-3PK', quantity: 100, casePack: { caseQuantity: 20, boxLength: 15, boxWidth: 13, boxHeight: 12, boxWeightLbs: 14 }, productNote: 'ok', lotNumber: 'L', expirationDate: '2028-01-01', amazonMsku: null };
  const transfer = { id: 'cin7-1', transferNumber: 'TR-00489', destinationName: 'Amazon FBA', lines: [{ sku: good.cin7Sku, quantity: 100 }], shipheroOrderNumber: 'AMZ_NMNSUPP_00489' };
  { const { sb, row } = fakeSupabase(); const posts: string[] = [];
    const deps = { supabase: sb, shipheroToken: 't', gatherFacts: async () => good, sendTelegram: async (h: string) => { posts.push(h); return true; } };
    let t = 0; const clock = () => new Date(Date.UTC(2026, 9, 3, 18, t++));
    const a = await applyPreflightGate({ ...deps, now: clock }, transfer);
    const since0 = row.request_payload.preflight_hold.since;
    const b = await applyPreflightGate({ ...deps, now: clock }, { ...transfer, existingHold: row.request_payload.preflight_hold });
    const c = await applyPreflightGate({ ...deps, now: clock }, { ...transfer, existingHold: row.request_payload.preflight_hold });
    ok('🔴 same hold on three consecutive ticks → ONE ⏸ notice, not three', posts.length === 1 && posts[0].includes(MARKETING_HANDLE) && a.gated && b.gated && c.gated);
    ok('hold keeps its ORIGINAL since-time across refreshes', row.request_payload.preflight_hold.since === since0 && since0 === '2026-10-03T18:00:00.000Z');
    const d = await applyPreflightGate({ ...deps, now: clock, gatherFacts: async () => ({ ...good, amazonMsku: 'M', inboundReady: false }) }, { ...transfer, existingHold: row.request_payload.preflight_hold });
    ok('hold REASON changes (mapping found, now "not inbound-ready") → a new notice naming the new reason', posts.length === 2 && d.hold === 'marketing' && /will not accept M for inbound/.test(posts[1])); }

  // ── gate: no duplicate DATA FIX WO for the same reason ──
  { const { sb } = fakeSupabase(); let created = 0; const posts: string[] = [];
    const deps = { supabase: sb, shipheroToken: 't', gatherFacts: async () => ({ ...good, amazonMsku: 'M', inboundReady: true, labelOwnerConstraint: 'NONE_ONLY', lotNumber: null }), createWorkOrder: (async () => { created++; return { id: 'g', legacyId: 172999, status: 'IN_PROGRESS', type: 'CUSTOM' }; }) as any, sendTelegram: async (h: string) => { posts.push(h); return true; } };
    const a = await applyPreflightGate(deps, transfer);
    const b = await applyPreflightGate(deps, { ...transfer, existingWorkOrder: a.workOrder });
    ok('🔴 open DATA FIX WO for the same reason → no second WO, no second notice; existing WO returned', created === 1 && posts.length === 1 && b.gated && b.workOrder?.ids[0] === '172999');
    const c = await applyPreflightGate(deps, { ...transfer, existingWorkOrder: { ...a.workOrder!, status: 'COMPLETED' } });
    ok('that WO COMPLETED but lot still missing → NEW WO (ticked-but-unfixed re-parks)', created === 2 && c.workOrder?.ids[0] === '172999'); }

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
