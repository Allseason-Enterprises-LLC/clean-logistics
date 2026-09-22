/**
 * TR-00464 regression: the reconciler must NOT re-fire when a plan referenced by
 * a CANCELLED fba_shipments row has since gained live shipments.
 * Run: npx tsx scripts/_test-refire-dup-gate.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');

ok('helper exists', src.includes('async function findLivePlanOnCancelledRows'));
ok('gate runs BEFORE fireFbaAutoSubmit',
   src.indexOf('findLivePlanOnCancelledRows(db, row.cin7_transfer_number)') < src.indexOf('fireFbaAutoSubmit(')
   && src.indexOf('findLivePlanOnCancelledRows(db, row.cin7_transfer_number)') > -1);
ok('reuses the shared SP-API client', src.includes("callAmazonSpApi") && src.includes('/inboundPlans/${planId}'));
ok('queries BOTH transfer-number forms (CIN7- prefix quirk)',
   /startsWith\('CIN7-'\) \? transferNumber\.slice\(5\) : `CIN7-\$\{transferNumber\}`/.test(src));
ok('ignores VOIDED/CANCELLED plans (they commit nothing)',
   src.includes("planStatus === 'VOIDED'") && src.includes("planStatus === 'CANCELLED'"));
ok('ignores CANCELLED shipments inside a live plan',
   /String\(s\?\.status \|\| ''\)\.toUpperCase\(\) !== 'CANCELLED'/.test(src));
// Assert the BEHAVIOUR, not a byte distance: the catch block around the gate
// must end in `continue` (skip the row) and must never fall through to a fire.
// (The original /...{0,300}continue;/ window broke when a skipped.push() was
// added between the log and the continue — the behaviour was never broken.)
const gateCatch = (() => {
  const i = src.indexOf('duplicate gate failed');
  const j = src.indexOf('continue;', i);
  const k = src.indexOf('fireFbaAutoSubmit(', i);
  return { hasContinue: i > -1 && j > -1, continueBeforeFire: j > -1 && (k === -1 || j < k) };
})();
ok('FAILS CLOSED on verification error (skips rather than fires)',
   gateCatch.hasContinue && gateCatch.continueBeforeFire);
ok('escalates to Telegram when it aborts', /re-fire ABORTED/.test(src));
ok('cites the TR-00464 incident', src.includes('TR-00464'));

// Behavioural replica of the decision.
type Plan = { status: string; shipments: Array<{ status: string }> };
const decide = (plans: Plan[]) => {
  for (const p of plans) {
    const st = p.status.toUpperCase();
    if (st === 'VOIDED' || st === 'CANCELLED') continue;
    if (p.shipments.filter(s => s.status.toUpperCase() !== 'CANCELLED').length > 0) return 'ABORT';
  }
  return 'FIRE';
};

ok('TR-00464 exact shape: plan gained 5 live shipments -> ABORT',
   decide([{ status: 'ACTIVE', shipments: Array(5).fill({ status: 'WORKING' }) }]) === 'ABORT');
ok('one shipment IN_TRANSIT -> ABORT',
   decide([{ status: 'ACTIVE', shipments: [{ status: 'IN_TRANSIT' }] }]) === 'ABORT');
ok('genuinely empty plan -> FIRE',
   decide([{ status: 'ACTIVE', shipments: [] }]) === 'FIRE');
ok('voided plan with shipments -> FIRE (commits nothing)',
   decide([{ status: 'VOIDED', shipments: Array(5).fill({ status: 'CANCELLED' }) }]) === 'FIRE');
ok('active plan whose shipments are all CANCELLED -> FIRE',
   decide([{ status: 'ACTIVE', shipments: Array(5).fill({ status: 'CANCELLED' }) }]) === 'FIRE');
ok('mixed: one empty + one live -> ABORT',
   decide([
     { status: 'ACTIVE', shipments: [] },
     { status: 'ACTIVE', shipments: [{ status: 'WORKING' }] },
   ]) === 'ABORT');
ok('no plans at all -> FIRE', decide([]) === 'FIRE');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
