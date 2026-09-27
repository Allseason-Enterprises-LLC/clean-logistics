/**
 * Kit / multi-pack detection — Weston's rules 2026-09-26.
 * Run: npx tsx scripts/_test-kit-detection.ts
 */
import { classifyKitSku, isKitSku, isKitTransfer } from '../lib/kit-detection';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const C = classifyKitSku;

// ── multi-pack suffixes, REAL shapes from sku_master ──
ok('CIN7  -3PK  -> kit (packCount 3)', C('CN-KIT-SRM-SNAILANTIA-2OZ-3PK').needsKitting && C('CN-KIT-SRM-SNAILANTIA-2OZ-3PK').packCount === 3);
ok('Amazon -2   -> kit', C('CB-REJUVINOL-DRP-2').needsKitting && C('CB-REJUVINOL-DRP-2').reason === 'multipack_suffix');
ok('Amazon -3   -> kit', C('CB-REJUVINOL-DRP-3').needsKitting);
ok('Amazon -5   -> kit', C('CB-REJUVINOL-DRP-5').needsKitting);
ok('Amazon -02  -> kit (zero-padded)', C('CLN-GINKSENG-02').needsKitting && C('CLN-GINKSENG-02').packCount === 2);
ok('Amazon -05  -> kit', C('CLN-CALM-05').needsKitting && C('CLN-CALM-05').packCount === 5);
ok('-4 / -6 (future packs) -> kit', C('X-4').needsKitting && C('X-6').needsKitting && C('X-06').needsKitting);
ok('-2Pk mixed case -> kit', C('CLN-AGEDEFEND-2Pk').needsKitting);

// ── the TRAPS: singles and counts that end in a digit ──
ok('Amazon -1  -> SINGLE, not a kit (82 real SKUs)', !C('CNO-ASHWAFENU-VEG-1').needsKitting && C('CNO-ASHWAFENU-VEG-1').reason === 'single');
ok('Amazon -01 -> SINGLE (104 real SKUs)', !C('CN-5IN1IMMUNE-BAG-01').needsKitting);
ok('-90 (a count, not a pack) -> single', !C('CP-SLEEPCHEWS-90').needsKitting);
ok('-60CT -> single', !C('CN-CAP-VBIOTIC-90CT').needsKitting);
ok('-120BG -> single', !C('CN-CAP-5IN1IMMUNE-120BG').needsKitting);
ok('plain sku -> single', !C('CN-SLEEPFORMULA-DRP').needsKitting);

// ── RETRY: -R<n> never needs kitting, R is the only difference ──
ok('-R1 -> retry, no kit', !C('CN-CAP-NMNSUPP-60CT-R1').needsKitting && C('CN-CAP-NMNSUPP-60CT-R1').reason === 'retry_suffix');
ok('-R2 -> retry, no kit (NOT a 2-pack!)', !C('CN-CAP-NMNBEAUTY-60CT-R2').needsKitting && C('CN-CAP-NMNBEAUTY-60CT-R2').reason === 'retry_suffix');
ok('-R3PK -> retry, no kit', !C('X-R3PK').needsKitting);
ok('-r2 lowercase -> retry', C('X-r2').reason === 'retry_suffix');
ok('🔴 kit PREFIX + -R2 -> retry WINS, no kit', !C('CN-BDL-CAP-X-60CT-R2').needsKitting && C('CN-BDL-CAP-X-60CT-R2').reason === 'retry_suffix');

// ── prefixes ──
ok('CN-BDL- prefix -> kit even with no suffix', C('CN-BDL-CAP-GLOWUPDUO-60CT').needsKitting && C('CN-BDL-CAP-GLOWUPDUO-60CT').reason === 'prefix');
ok('CN-KIT- prefix -> kit', C('CN-KIT-IMMUNE').needsKitting);
ok('prefix must be at START', !C('X-CN-BDL-Y').needsKitting);
ok('null/empty safe', !isKitSku(null) && !isKitSku('') && !isKitSku(undefined));

// ── transfer-level: suffix normally lives on the AMAZON msku ──
const t1 = isKitTransfer([{ sku: 'CN-CAP-REJUVINOL-2OZ', amazonSku: 'CB-REJUVINOL-DRP-3' }]);
ok('plain CIN7 sku but Amazon -3 -> GATED via amazon_msku', t1.isKit && t1.reasons['CN-CAP-REJUVINOL-2OZ'].via === 'amazon_msku' && t1.reasons['CN-CAP-REJUVINOL-2OZ'].packCount === 3);
const t2 = isKitTransfer([{ sku: 'CN-CAP-NMNBEAUTY-60CT', amazonSku: 'CN-CAP-NMNBEAUTY-60CT-R2' }]);
ok('Amazon -R2 -> NOT gated (retry)', !t2.isKit && t2.reasons['CN-CAP-NMNBEAUTY-60CT'].reason === 'retry_suffix');
const t3 = isKitTransfer([{ sku: 'CN-CAP-VBIOTIC-90CT', amazonSku: 'CNO-VBIOTIC-VEG-1' }]);
ok('single on both sides -> NOT gated (TR-00474 shape)', !t3.isKit);
const t4 = isKitTransfer([{ sku: 'CN-KIT-SRM-SNAILANTIA-2OZ-3PK', amazonSku: 'CB-SNAIL-3' }]);
ok('CIN7 -3PK -> gated via cin7_sku (checked first)', t4.isKit && t4.reasons['CN-KIT-SRM-SNAILANTIA-2OZ-3PK'].via === 'cin7_sku');
const t5 = isKitTransfer([{ sku: 'CN-CAP-A-60CT', amazonSku: 'A-1' }, { sku: 'CN-CAP-B-60CT', amazonSku: 'B-3' }]);
ok('mixed transfer -> gated, only the multipack line listed', t5.isKit && t5.kitSkus.join() === 'CN-CAP-B-60CT');
ok('no amazonSku provided -> falls back to cin7 sku only', !isKitTransfer([{ sku: 'CN-CAP-A-60CT' }]).isKit && isKitTransfer([{ sku: 'CN-CAP-A-60CT-3PK' }]).isKit);
const t6 = isKitTransfer([{ sku: 'CN-BDL-X-3PK', amazonSku: 'X-R3' }]);
ok('🔴 CIN7 says kit, Amazon says retry -> retry WINS, not gated', !t6.isKit);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
