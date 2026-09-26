/**
 * Kit detection for the FBA work-order gate.
 * Run: npx tsx scripts/_test-kit-detection.ts
 */
import { isKitSku, isKitTransfer } from '../lib/kit-detection';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

async function main() {
  // --- prefix ---
  ok('BDL prefix is a kit', isKitSku('CN-BDL-CAP-GINSENG-60CT-3PK'));
  ok('KIT prefix is a kit', isKitSku('CN-KIT-IMMUNE-BUNDLE'));
  ok('plain SKU is NOT a kit', !isKitSku('CN-CAP-VBIOTIC-90CT'));
  ok('multipack SUFFIX alone does NOT gate (needs prefix or flag)', !isKitSku('CN-CAP-X-60CT-3PK'));
  ok('case-insensitive', isKitSku('cn-bdl-x'));
  ok('prefix must be at the START', !isKitSku('X-CN-BDL-Y'));
  ok('null/undefined/empty are safe', !isKitSku(null) && !isKitSku(undefined) && !isKitSku(''));
  ok('leading whitespace tolerated', isKitSku('  CN-BDL-X'));

  // --- transfer-level, ShipHero flag injected ---
  const flags: Record<string, boolean> = { 'CN-CAP-SECRETKIT-60CT': true };
  const lookup = async (sku: string) => flags[sku] === true;

  const a = await isKitTransfer([{ sku: 'CN-BDL-CAP-GINSENG-60CT-3PK' }], lookup);
  ok('prefix kit -> isKit', a.isKit && a.kitSkus.length === 1 && a.reasons['CN-BDL-CAP-GINSENG-60CT-3PK'] === 'prefix');

  const b = await isKitTransfer([{ sku: 'CN-CAP-SECRETKIT-60CT' }], lookup);
  ok('no prefix but ShipHero kit:true -> isKit (authoritative signal)', b.isKit && b.reasons['CN-CAP-SECRETKIT-60CT'] === 'shiphero_kit_flag');

  const c = await isKitTransfer([{ sku: 'CN-CAP-VBIOTIC-90CT' }], lookup);
  ok('plain SKU, flag false -> NOT a kit', !c.isKit && c.kitSkus.length === 0);

  const d = await isKitTransfer([{ sku: 'CN-CAP-VBIOTIC-90CT' }, { sku: 'CN-BDL-X-3PK' }], lookup);
  ok('mixed transfer -> isKit, only the kit line listed', d.isKit && d.kitSkus.join() === 'CN-BDL-X-3PK');

  // a flaky ShipHero lookup must not throw and must not gate on its own
  let called = 0;
  const flaky = async (_: string) => { called++; throw new Error('Token is expired'); };
  const e = await isKitTransfer([{ sku: 'CN-CAP-VBIOTIC-90CT' }], flaky);
  ok('lookup failure -> no throw, NOT gated (prefix still decides)', !e.isKit && called === 1);
  const f = await isKitTransfer([{ sku: 'CN-BDL-X-3PK' }], flaky);
  ok('lookup failure but prefix hit -> still gated, lookup skipped', f.isKit && called === 1);

  // prefix short-circuits: no network call for an obvious kit
  let n = 0;
  await isKitTransfer([{ sku: 'CN-BDL-A' }, { sku: 'CN-KIT-B' }], async () => { n++; return false; });
  ok('prefix hits do not call ShipHero at all', n === 0);

  ok('empty SKU lines are ignored', !(await isKitTransfer([{ sku: '' }], lookup)).isKit);

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
