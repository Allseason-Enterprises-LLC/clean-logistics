/**
 * The wholesale_order_create SELECTION SET must match ShipHero's real schema.
 * Introspected 2026-09-27:
 *   WholesaleOrderMutationOutput { request_id, complexity, wholesale_order: WholesaleOrder }
 *   WholesaleOrder { id, legacy_id, status, order: Order, ... }   <- Order is NESTED here
 * Asking for `order` directly on the output = 400 "Cannot query field 'order'".
 * That silently killed every FBA order for ~5 days after e5a2f2d. Never again.
 * Run: npx tsx scripts/_test-wholesale-response-shape.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/shiphero-orders.ts'), 'utf8');
const start = src.indexOf('mutation WholesaleOrderCreate');
const end = src.indexOf('`;', start);
const sel = src.slice(start, end);

// The real output type's top-level fields, from introspection. Anything else selected there is a 400.
const OUTPUT_FIELDS = new Set(['request_id', 'complexity', 'wholesale_order']);

// crude but deterministic: top-level selections are the lines at indentation 8 inside wholesale_order_create { ... }
const body = sel.slice(sel.indexOf('wholesale_order_create(data: $data) {') + 'wholesale_order_create(data: $data) {'.length);
let depth = 0; const top: string[] = [];
for (const raw of body.split('\n')) {
  const line = raw.trim(); if (!line) continue;
  if (depth === 0 && line !== '}' && !line.endsWith('{')) top.push(line);
  if (depth === 0 && line.endsWith('{')) top.push(line.replace(/\s*\{$/, ''));
  if (line.endsWith('{')) depth++;
  if (line === '}') { depth--; if (depth < 0) break; }
}
ok(`top-level selections are all real output fields (${top.join(', ')})`, top.length > 0 && top.every((f) => OUTPUT_FIELDS.has(f)), `bad: ${top.filter((f) => !OUTPUT_FIELDS.has(f)).join(',')}`);
ok('🔴 does NOT select `order` directly on the mutation output (the 400 that killed FBA orders)', !/wholesale_order_create\(data: \$data\) \{\s*request_id\s*order\s*\{/.test(sel));
ok('selects wholesale_order { … order { … } } (Order is nested)', /wholesale_order\s*\{[\s\S]*?order\s*\{[\s\S]*?order_number/.test(sel));
ok('parser reads data.wholesale_order_create.wholesale_order.order', /wholesale_order_create\?\.wholesale_order/.test(src) && /wholesale\?\.order/.test(src));
ok('still throws when no order id comes back (never a silent "created")', /returned no order id/.test(src));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
