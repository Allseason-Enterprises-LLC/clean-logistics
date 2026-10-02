/**
 * fba-preflight: pure decision tests. Run: npx tsx scripts/_test-fba-preflight.ts
 */
import { runPreflight, buildPreflightWorkOrderText, preflightReason, type PreflightFacts } from '../lib/fba-preflight';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const codes = (f: PreflightFacts) => runPreflight(f).blockers.map((b) => b.code);

const good: PreflightFacts = {
  cin7Sku: 'CN-CAP-ADAPTACORE-90CT', quantity: 1920,
  casePack: { caseQuantity: 60, boxLength: 15, boxWidth: 13, boxHeight: 12, boxWeightLbs: 16 },
  productNote: 'Box Weight: 16 Lbs\nBox Size: 15 x 13 x 12 inches\nQuantity per Case: 60 bottles',
  lotNumber: '2606060A', expirationDate: '2028-06-30',
  amazonMsku: 'CN-ADAPTACORE-VEG', inboundReady: true, labelOwnerConstraint: 'NONE_ONLY',
};

// ── happy path ──
ok('complete facts → ok, no blockers', runPreflight(good).ok && codes(good).length === 0);

// ── ShipHero data (floor, fail closed) ──
ok('🔴 no product note at all → case pack + dims + weight (3 floor blockers)',
  JSON.stringify(codes({ ...good, casePack: null, productNote: null })) === JSON.stringify(['MISSING_CASE_PACK', 'MISSING_BOX_DIMS', 'MISSING_BOX_WEIGHT']));
ok('weight only missing → just MISSING_BOX_WEIGHT', JSON.stringify(codes({ ...good, casePack: { ...good.casePack!, boxWeightLbs: 0 } })) === JSON.stringify(['MISSING_BOX_WEIGHT']));
ok('one dimension zero → MISSING_BOX_DIMS', codes({ ...good, casePack: { ...good.casePack!, boxHeight: 0 } }).includes('MISSING_BOX_DIMS'));
ok('no lot → MISSING_LOT (not expiration — lot comes first)', JSON.stringify(codes({ ...good, lotNumber: null, expirationDate: null })) === JSON.stringify(['MISSING_LOT']));
ok('lot present, no expiry → MISSING_EXPIRATION naming the lot', (() => { const r = runPreflight({ ...good, expirationDate: null }); return r.blockers.length === 1 && r.blockers[0].code === 'MISSING_EXPIRATION' && r.blockers[0].summary.includes('2606060A'); })());
ok('floor blockers are owner=floor', runPreflight({ ...good, casePack: null, lotNumber: null }).floor.length === 4 && runPreflight({ ...good, casePack: null, lotNumber: null }).marketing.length === 0);
ok('checklists quote the exact ShipHero note line format', runPreflight({ ...good, casePack: null }).blockers.every((b) => b.checklist.some((s) => /ShipHero → Products → .* → Notes/.test(s))));
ok('checklist quotes what the note currently says (so the floor sees the gap)', runPreflight({ ...good, casePack: { ...good.casePack!, boxWeightLbs: 0 }, productNote: 'Box Size: 15 x 13 x 12 inches' }).blockers[0].checklist.some((s) => s.includes('Current note reads')));

// ── Amazon side (marketing, no floor WO) ──
ok('🔴 no MSKU mapping → NO_AMAZON_MAPPING owner=marketing, zero floor blockers', (() => { const r = runPreflight({ ...good, amazonMsku: null }); return r.marketing.length === 1 && r.marketing[0].code === 'NO_AMAZON_MAPPING' && r.floor.length === 0; })());
ok('🔴 Wild Yam shape: mapped but not inbound-ready → OFFER_NOT_INBOUND_READY (marketing)', (() => { const r = runPreflight({ ...good, amazonMsku: 'CN-CAP-WILDYAMHOR-90BG-R1', inboundReady: false }); return r.marketing.map((b) => b.code).join() === 'OFFER_NOT_INBOUND_READY' && r.floor.length === 0; })());
ok('not-ready checklist points at Seller Central Offer tab + barcode type', runPreflight({ ...good, inboundReady: false }).marketing[0].checklist.join(' ').includes('barcode type'));
ok('inboundReady undefined (not checked) → does NOT block (fail open on the unknown)', runPreflight({ ...good, inboundReady: undefined }).ok);
ok('mapping missing AND not ready → only the mapping blocker (fix order matters)', codes({ ...good, amazonMsku: null, inboundReady: false }).join() === 'NO_AMAZON_MAPPING');

// ── barcode: verify-and-branch on FIRST shipment (Weston 2026-10-01: "sometimes preconfigured, sometimes not") ──
const firstFnsku: PreflightFacts = { ...good, labelOwnerConstraint: 'SELLER_ONLY', fnsku: 'X004ABCDEF', shippedBefore: false };
const firstUpc: PreflightFacts = { ...good, labelOwnerConstraint: 'NONE_ONLY', shippedBefore: false, shipheroBarcode: '810197341394', amazonUpc: '810197341394' };
ok('🔴 first shipment + FNSKU listing → VERIFY_BARCODE_FIRST_SHIPMENT (floor)', runPreflight(firstFnsku).floor.map((b) => b.code).join() === 'VERIFY_BARCODE_FIRST_SHIPMENT');
ok('FNSKU verify checklist: pull ONE unit → if already FNSKU, nothing → else print N, cover, Transparency if enrolled', (() => { const c = runPreflight(firstFnsku).floor[0].checklist; const s = c.join(' '); return /Pull ONE unit/.test(s) && /already shows exactly that FNSKU: nothing to apply/.test(s) && s.includes('1920 FNSKU labels') && s.includes('X004ABCDEF') && /covering the existing barcode/.test(s) && /Transparency/.test(s) && /enrolled/.test(s) && c.findIndex((x) => /nothing to apply/.test(x)) < c.findIndex((x) => /Print 1920/.test(x)); })());
ok('🔴 first shipment + UPC listing → ALSO verify (UPC must scan right), with the "do NOT ship, switch to FNSKU" branch', (() => { const r = runPreflight(firstUpc); const s = r.floor[0]?.checklist.join(' ') ?? ''; return r.floor.map((b) => b.code).join() === 'VERIFY_BARCODE_FIRST_SHIPMENT' && /810197341394/.test(s) && /no FNSKU stickers/.test(s) && /do NOT ship/.test(s); })());
ok('summary names what Amazon requires', /FNSKU X004ABCDEF/.test(runPreflight(firstFnsku).floor[0].summary) && /UPC 810197341394/.test(runPreflight(firstUpc).floor[0].summary));
ok('🔴 ADAPTACORE shape: SELLER_ONLY but shipped before → NO WO (floor already labels as routine)', codes({ ...firstFnsku, shippedBefore: true }).length === 0);
ok('history unknown (probe failed) → NO WO', codes({ ...firstFnsku, shippedBefore: undefined }).length === 0);
ok('not ready yet → no verify WO (stage 2 waits for stage 1)', !codes({ ...firstFnsku, inboundReady: false }).includes('VERIFY_BARCODE_FIRST_SHIPMENT'));

// ── barcode conflict: ShipHero UPC ≠ Amazon UPC on a UPC listing → fires on EVERY shipment ──
const wildYam: PreflightFacts = { ...good, labelOwnerConstraint: 'NONE_ONLY', shippedBefore: true, shipheroBarcode: '810197341394', amazonUpc: '810197342124' };
ok('🔴 Wild Yam shape: UPC listing, ShipHero 810197341394 vs Amazon 810197342124 → UPC_MISMATCH even though shipped before', runPreflight(wildYam).floor.map((b) => b.code).join() === 'UPC_MISMATCH');
ok('mismatch checklist: both numbers named, both branches (fix ShipHero / switch to FNSKU), office confirms before Complete', (() => { const s = runPreflight(wildYam).floor[0].checklist.join(' '); return s.includes('810197341394') && s.includes('810197342124') && /ShipHero record is wrong/.test(s) && /WRONG product/.test(s) && /switched to FNSKU/.test(s) && /office confirms/.test(s); })());
ok('mismatch takes precedence over first-shipment verify (one WO, not two)', codes({ ...wildYam, shippedBefore: false }).join() === 'UPC_MISMATCH');
ok('FNSKU listing ignores UPC mismatch (FNSKU covers the UPC anyway)', codes({ ...wildYam, labelOwnerConstraint: 'SELLER_ONLY' }).length === 0);
ok('matching UPCs → no conflict', codes({ ...wildYam, amazonUpc: '810197341394' }).length === 0);
ok('EAN-13 with leading 0 == UPC-A (no false conflict)', codes({ ...wildYam, amazonUpc: '0810197341394' }).length === 0);
ok('either barcode unknown → no comparison, no conflict (fail open)', codes({ ...wildYam, amazonUpc: null }).length === 0 && codes({ ...wildYam, shipheroBarcode: null }).length === 0);
ok('WO name for a barcode-only task is VERIFY BARCODE, not DATA FIX', buildPreflightWorkOrderText({ transferNumber: 'TR-00481', orderNumber: 'AMZ_WY_00481', sku: 's', quantity: 2016, blockers: runPreflight(wildYam).blockers }).name.startsWith('VERIFY BARCODE AMZ_WY_00481'));
ok('WO name stays DATA FIX when data is also missing', buildPreflightWorkOrderText({ transferNumber: 'T', orderNumber: 'O', sku: 's', quantity: 1, blockers: runPreflight({ ...wildYam, lotNumber: null }).blockers }).name.startsWith('DATA FIX O'));

// ── WO text ──
const r = runPreflight({ ...good, casePack: null, productNote: null, lotNumber: null });
const wo = buildPreflightWorkOrderText({ transferNumber: 'TR-00999', orderNumber: 'AMZ_ADAPTACORE_00999', sku: good.cin7Sku, quantity: 1920, blockers: r.blockers });
ok('WO name starts DATA FIX + order number', wo.name.startsWith('DATA FIX AMZ_ADAPTACORE_00999'));
ok('WO instructions list every floor blocker with numbered steps', /1\. .*\n.*2\. /.test(wo.instructions) && wo.instructions.includes('CASE QUANTITY') && wo.instructions.includes('NO LOT'));
ok('WO instructions end with the completion contract (re-check, re-WO if still missing)', /mark this work order COMPLETE/.test(wo.instructions) && /new work order will say exactly what/.test(wo.instructions));
ok('WO text excludes marketing blockers', !buildPreflightWorkOrderText({ transferNumber: 'T', orderNumber: null, sku: 's', quantity: 1, blockers: runPreflight({ ...good, amazonMsku: null, casePack: null }).blockers }).instructions.includes('Seller Central'));
ok('reason key is deterministic and floor-only', preflightReason(r) === 'preflight:MISSING_CASE_PACK+MISSING_BOX_DIMS+MISSING_BOX_WEIGHT+MISSING_LOT');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
