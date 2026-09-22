/**
 * TR-00460 regression: attaching the same label twice must be impossible.
 * ShipHero has NO attachment-delete mutation, so duplicates are permanent.
 * Run: npx tsx scripts/_test-attach-idempotent.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-post-process.ts'), 'utf8');
// Include the doc comment: start from the idempotency warning that precedes it.
const docStart = src.indexOf('IDEMPOTENCY IS MANDATORY');
const fn = src.slice(docStart, src.indexOf('async function updatePackingNote'));

ok('pre-flight query runs before the mutation',
   fn.indexOf('attachments(first: 60)') < fn.indexOf('order_add_attachment(data: $d)'));
ok('uses order(id:) — a real Query field (verified by introspection)', fn.includes('order(id:'));
ok('compares by filename', /e\?\.node\?\.filename === filename/.test(fn));
ok('returns the EXISTING id instead of re-attaching', /return hit\.node\.id/.test(fn));
ok('logs the skip', fn.includes('already on order'));
ok('fails OPEN if the check errors (missing label is worse than a dup)',
   /catch[\s\S]{0,400}attaching "\$\{filename\}" anyway/.test(fn) || fn.includes('attaching "${filename}" anyway'));
ok('documents that ShipHero cannot delete attachments', fn.includes('no attachment-delete mutation'));
ok('cites the TR-00460 incident', fn.includes('TR-00460'));

// Behavioural: replicate the dedupe decision.
const existing = [
  { id: 'a1', filename: 'FBA19QPP4F64-GOODYEAR_AZ-5boxes.pdf' },
  { id: 'a2', filename: 'FBA19QPV8NXV-HOPEWELLJUNCTION_NY-9boxes.pdf' },
];
const decide = (filename: string) => {
  const hit = existing.find((e) => e.filename === filename);
  return hit ? `skip:${hit.id}` : 'attach';
};
ok('re-attach of an existing label -> skip', decide('FBA19QPP4F64-GOODYEAR_AZ-5boxes.pdf') === 'skip:a1');
ok('second existing label -> skip', decide('FBA19QPV8NXV-HOPEWELLJUNCTION_NY-9boxes.pdf') === 'skip:a2');
ok('a genuinely new label -> attach', decide('FBA19QQ0R8FF-KANSASCITY_MO-10boxes.pdf') === 'attach');
ok('near-miss filename still attaches (not over-matching)',
   decide('FBA19QPP4F64-GOODYEAR_AZ-6boxes.pdf') === 'attach');

// The exact incident: relabel over a fully-attached order must add nothing.
const labels = [
  'FBA19QPP4F64-GOODYEAR_AZ-5boxes.pdf',
  'FBA19QPV8NXV-HOPEWELLJUNCTION_NY-9boxes.pdf',
];
const added = labels.filter((l) => decide(l) === 'attach').length;
ok('relabel over an already-attached order adds 0', added === 0, String(added));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
