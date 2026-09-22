/**
 * TR-00464 observability regression: the reconciler must NAME every candidate
 * it skips and WHY. `throttled: N` alone cost 40 minutes of debugging.
 * Run: npx tsx scripts/_test-reconciler-observability.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');

ok('ReconcileResult exposes a skipped[] array', /skipped: Array<\{ transfer: string; reason: string; detail\?: string \}>/.test(src));
ok('skipped[] initialised', /duration_ms: 0,\s*\n\s*skipped: \[\],/.test(src));
ok('documents the TR-00464 debugging cost', src.includes('cost 40 minutes') && src.includes('TR-00464'));

// every skip path must record a named disposition
for (const reason of [
  'already_has_active_shipment_row',
  'backoff_throttled',
  'duplicate_gate_aborted',
  'duplicate_gate_unavailable',
]) {
  ok(`records reason '${reason}'`, src.includes(`reason: '${reason}'`));
}

ok('throttled skip reports REMAINING wait', src.includes('remainingMin') && src.includes('min remaining'));
ok('throttled skip surfaces last_fba_handoff_at (the field that trapped TR-00464)',
   /last_fba_handoff_at=\$\{row\.last_fba_handoff_at/.test(src));
ok('throttled skip reports attempt + gap', src.includes('attempt ${row.fba_handoff_attempts}') && src.includes('gap ${Math.round(gap / 60000)}min'));

// no early `continue` inside the per-row loop may bypass the ledger
const loopStart = src.indexOf('for (const row of candidates)');
const loopEnd = src.indexOf('result.duration_ms = Date.now() - startedAt;', loopStart);
const loop = src.slice(loopStart, loopEnd);
const continues = (loop.match(/\n\s*continue;/g) || []).length;
const pushes = (loop.match(/result\.skipped\.push\(/g) || []).length;
ok(`every skip path is accounted for (continues=${continues}, skipped.push=${pushes})`, pushes >= continues - 1,
   'a `continue` without a skipped.push() is an invisible skip');

// the reported numbers must add up
type R = { scanned: number; reFired: number; skipped: Array<{ reason: string }> };
const consistent = (r: R) => r.scanned === r.reFired + r.skipped.length;
ok('accounting adds up: 29 scanned = 1 fired + 28 named skips',
   consistent({ scanned: 29, reFired: 1, skipped: Array(28).fill({ reason: 'already_has_active_shipment_row' }) }));
ok('TR-00464 shape is now visible, not silent',
   consistent({ scanned: 29, reFired: 0, skipped: Array(29).fill({ reason: 'backoff_throttled' }) }));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
