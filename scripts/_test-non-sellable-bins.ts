/**
 * FBA may only plan against SELLABLE BULK stock.
 *
 * Two independent exclusions, and the second was the gap:
 *   1. pickable DTC bins (B-prefix) — `location.pickable === true`
 *   2. NON-SELLABLE bins — returns / quarantine / damaged / expired / recall
 *
 * 2026-10-12, Weston: "when have we ever picked from a returns bin? Never.
 * Do not pick from pickable DTC or returns."
 *
 * The `pickable` flag does NOT cover case 2. A `Returns` bin is NOT pickable,
 * so it passed the bulk filter and counted as FBA-eligible. Live proof on
 * CN-POW-WMNSCREATIORA-30SV: 134u of lot 5L0473 sat in a bin named `Returns`,
 * and 5L0473 is exactly the lot that produced the nonsense 60-unit / 2-box
 * shipments on TR-00564 and TR-00567 — customer returns being planned into
 * Amazon inbound.
 *
 * ShipHero's Location type exposes only `name` and `pickable`, so NAME MATCHING
 * is the only available signal. Patterns stay conservative and word-boundary
 * matched: a false positive HIDES real sellable stock and produces a phantom
 * shortfall, which is its own incident.
 *
 * Run: npx tsx scripts/_test-non-sellable-bins.ts
 */
import { isNonSellableBin, NON_SELLABLE_BIN_PATTERNS } from '../lib/shiphero-product-data';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

// ── 1. 🔴 the live incident bin ──────────────────────────────────────────────
ok('🔴 "Returns" (the live bin holding 134u of lot 5L0473) is excluded', isNonSellableBin('Returns'));
ok('case-insensitive: RETURNS', isNonSellableBin('RETURNS'));
ok('case-insensitive: returns', isNonSellableBin('returns'));
ok('singular "Return" is excluded', isNonSellableBin('Return'));
ok('"CUSTOMER RETURN" is excluded', isNonSellableBin('CUSTOMER RETURN'));
ok('"A01-RETURNED-GOODS-STAGING" is excluded', isNonSellableBin('A01-RETURNED-GOODS-STAGING'));

// ── 2. the other non-sellable classes ───────────────────────────────────────
ok('QUARANTINE-01 excluded', isNonSellableBin('QUARANTINE-01'));
ok('DAMAGED excluded', isNonSellableBin('DAMAGED'));
ok('"Damage" excluded', isNonSellableBin('Damage'));
ok('EXPIRED-HOLD excluded', isNonSellableBin('EXPIRED-HOLD'));
ok('RECALL-2026 excluded', isNonSellableBin('RECALL-2026'));
ok('RECALLED excluded', isNonSellableBin('RECALLED'));

// ── 3. 🔴 real bulk bins must NOT be excluded (false positives = phantom short)
ok('🔴 A01-01-03-A-02 (real bulk bin) is sellable', !isNonSellableBin('A01-01-03-A-02'));
ok('🔴 A01-01-02-E-01 (real bulk bin) is sellable', !isNonSellableBin('A01-01-02-E-01'));
ok('B02-PICK-01 is not flagged non-sellable (pickable flag handles DTC separately)', !isNonSellableBin('B02-PICK-01'));
ok('🔴 word boundary: "A-RETURNABLE-TOTE" is NOT a returns bin', !isNonSellableBin('A-RETURNABLE-TOTE'));
ok('🔴 word boundary: "PRERECALLIBRATION" is NOT a recall bin', !isNonSellableBin('PRERECALLIBRATION'));
ok('empty / null / undefined bin name is not non-sellable (fail open, do not hide stock)',
  !isNonSellableBin('') && !isNonSellableBin(null) && !isNonSellableBin(undefined));

// ── 4. the pattern list itself ──────────────────────────────────────────────
ok('every pattern is case-insensitive', NON_SELLABLE_BIN_PATTERNS.every((re) => re.flags.includes('i')));
ok('every pattern is word-boundary anchored', NON_SELLABLE_BIN_PATTERNS.every((re) => re.source.includes('\\b')));
ok('the list is non-empty and covers 6 classes', NON_SELLABLE_BIN_PATTERNS.length >= 6);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
