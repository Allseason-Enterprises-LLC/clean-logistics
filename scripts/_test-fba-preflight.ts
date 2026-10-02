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

// ── second stage: FNSKU labels — FIRST shipment only (Weston 2026-10-01) ──
const firstShip: PreflightFacts = { ...good, labelOwnerConstraint: 'SELLER_ONLY', fnsku: 'X004ABCDEF', shippedBefore: false };
ok('🔴 ready + SELLER_ONLY + never shipped → NEEDS_FNSKU_LABELS as a FLOOR blocker', runPreflight(firstShip).floor.map((b) => b.code).join() === 'NEEDS_FNSKU_LABELS');
ok('FNSKU checklist: print N labels, cover UPC, Transparency if enrolled', (() => { const c = runPreflight(firstShip).floor[0].checklist.join(' '); return c.includes('1920 FNSKU labels') && c.includes('X004ABCDEF') && /covering the UPC/.test(c) && /Transparency/.test(c) && /enrolled/.test(c); })());
ok('summary says FIRST FBA shipment', /FIRST FBA shipment/.test(runPreflight(firstShip).floor[0].summary));
ok('🔴 ADAPTACORE shape: SELLER_ONLY but shipped before → NO label WO (floor already labels as routine)', codes({ ...firstShip, shippedBefore: true }).length === 0);
ok('history unknown (probe failed) → NO label WO (needless WO on an established product is the worse error)', codes({ ...firstShip, shippedBefore: undefined }).length === 0);
ok('ready + NONE_ONLY (UPC) → no label WO even on first shipment', codes({ ...good, labelOwnerConstraint: 'NONE_ONLY', shippedBefore: false }).length === 0);
ok('not ready yet → no FNSKU WO even if SELLER_ONLY + first (stage 2 waits for stage 1)', !codes({ ...firstShip, inboundReady: false }).includes('NEEDS_FNSKU_LABELS'));

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
