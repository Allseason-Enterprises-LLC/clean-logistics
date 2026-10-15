/**
 * Transfer-level coverage invariant: labelled units across ALL active rows (lots, runs, -S1)
 * must equal the CIN7 transfer. SHORT alerts; OVER alerts louder (dup risk). Run after every
 * completed auto-submit; verdict written to the bridge row.
 * Run: npx tsx scripts/_test-transfer-coverage.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { computeCoverage, describeCoverage } from '../lib/fba-coverage';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const SKU = 'CN-CAP-20IN1MUSHR-60CT';

// TR-00591 as it was this morning: 3,654 ordered (two CIN7 lines), two lots labelled 3,024
const short = computeCoverage({ ordered: { [SKU]: 3654 }, rows: [
  { sku: SKU, units: 2394, lot: '2605070A', transfer: 'CIN7-TR-00591' },
  { sku: SKU, units: 630, lot: '2511098A', transfer: 'CIN7-TR-00591' } ] });
ok('short transfer is NOT whole, delta −630', !short.whole && !short.over && short.bySku[0].delta === -630);
ok('short wording says SHORT 630', /SHORT 630/.test(describeCoverage('TR-00591', short)));

// after the -S1 top-up lands
const whole = computeCoverage({ ordered: { [SKU]: 3654 }, rows: [
  { sku: SKU, units: 2394, lot: '2605070A', transfer: 'CIN7-TR-00591' },
  { sku: SKU, units: 630, lot: '2511098A', transfer: 'CIN7-TR-00591' },
  { sku: SKU, units: 630, lot: '2511098A', transfer: 'CIN7-TR-00591-S1' } ] });
ok('top-up row counts toward the same transfer → whole', whole.whole && whole.rows === 3);
ok('whole wording is a ✅ with the unit total', /✅ TR-00591.*3,654/.test(describeCoverage('TR-00591', whole)));

// a duplicate plan (the thing we must never ship)
const over = computeCoverage({ ordered: { [SKU]: 3654 }, rows: [
  { sku: SKU, units: 3654, lot: '2605070A', transfer: 'CIN7-TR-00591' },
  { sku: SKU, units: 630, lot: '2511098A', transfer: 'CIN7-TR-00591' } ] });
ok('🔴 OVER is flagged separately (dup-shipment risk)', !over.whole && over.over && over.bySku[0].delta === 630);
ok('OVER wording says do not ship the extra', /OVER by 630[\s\S]*do not ship the extra/.test(describeCoverage('TR-00591', over)) && describeCoverage('TR-00591', over).startsWith('🛑'));

// two SKUs on one transfer; one whole, one short
const multi = computeCoverage({ ordered: { A: 100, B: 50 }, rows: [ { sku: 'A', units: 100, lot: null, transfer: 't' }, { sku: 'B', units: 25, lot: null, transfer: 't' } ] });
ok('per-SKU: only the short SKU is reported', !multi.whole && multi.bySku.find((s) => s.sku === 'A')!.delta === 0 && multi.bySku.find((s) => s.sku === 'B')!.delta === -25);

// an SKU labelled that is NOT on the transfer at all
const stray = computeCoverage({ ordered: { A: 100 }, rows: [ { sku: 'A', units: 100, lot: null, transfer: 't' }, { sku: 'Z', units: 10, lot: null, transfer: 't' } ] });
ok('a labelled SKU absent from the transfer is OVER, not ignored', stray.over && stray.bySku.find((s) => s.sku === 'Z')!.delta === 10);

const src = fs.readFileSync(path.join(__dirname, '../api/fba/auto-submit.ts'), 'utf8');
ok('🔴 auto-submit runs the transfer-level check after the run (not just the per-payload shortfall)', /readTransferCoverage\(supabase, cin7_transfer_number, unitsForPlan\)/.test(src));
ok('verdict is persisted to the bridge row', /recordCoverage\(supabase, cov\.transfer, cov\.coverage\)/.test(src));
ok('not-whole posts via the ONE HTML sender', /if \(!cov\.coverage\.whole\)[\s\S]{0,500}await sendTelegram\(text\)/.test(src));
ok('units come from Amazon plan items (authoritative), not the request payload', /inboundPlans\/\$\{planId\}\/items/.test(src));
const cov = fs.readFileSync(path.join(__dirname, '../lib/fba-coverage.ts'), 'utf8');
ok('LIKE %TR% match is re-checked with extractTransferNumber (TR-00591 must not absorb TR-005910)', /extractTransferNumber\(r\.cin7_transfer_number\) !== tr\) continue/.test(cov));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
