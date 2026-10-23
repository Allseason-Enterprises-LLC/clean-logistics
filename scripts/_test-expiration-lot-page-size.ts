/**
 * Guard: ShipHero expiration_lots must be read with a page large enough to reach
 * the ACTIVE lot when many INACTIVE (quarantined/expired) lots are listed first.
 *
 * Incident TR-00594 (2026-10-20): CN-GUM-SEAMOSSBLA-60CT had 10 inactive lots
 * (moved to EXPIRED bins) + 1 active lot (2606P260364) listed 11th. The query used
 * `data(first: 10)`, so the active lot was never returned, expirationDate came back
 * null, and auto-submit failed "No expiration date found in ShipHero" for a SKU with
 * 222 sellable cases.
 *
 * Static check (no network): every expiration_lots query in the product-data lib
 * requests at least 100 rows.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

let failures = 0;
const fail = (m: string) => { failures++; console.log(`FAIL ${m}`); };
const pass = (m: string) => console.log(`ok   ${m}`);

const src = readFileSync(join(__dirname, '..', 'lib', 'shiphero-product-data.ts'), 'utf8');
const re = /expiration_lots\(sku:[^)]*\)\s*\{\s*data\(first:\s*(\d+)\)/g;
const sizes: number[] = [];
let m: RegExpExecArray | null;
while ((m = re.exec(src))) sizes.push(Number(m[1]));

if (sizes.length < 2) fail(`expected >=2 expiration_lots queries (product + kit component), found ${sizes.length}`);
else pass(`found ${sizes.length} expiration_lots queries`);
sizes.forEach((n, i) => (n >= 100 ? pass(`query ${i + 1}: first=${n} >= 100`) : fail(`query ${i + 1}: first=${n} < 100 — active lot can be paged out (TR-00594)`)));

// Behavioral: replicate the TR-00594 shape and confirm the picker finds the active lot
// only when it is inside the page.
const lots = [
  ...Array.from({ length: 10 }, (_, i) => ({ node: { name: `DEAD${i}`, expires_at: '2027-02-28', is_active: false } })),
  { node: { name: '2606P260364', expires_at: '2028-06-30', is_active: true } },
];
const pick = (edges: any[]) => edges.find((e) => e.node.is_active && e.node.expires_at)?.node.name ?? null;
const minSize = Math.min(...sizes);
const seen = pick(lots.slice(0, minSize));
if (seen === '2606P260364') pass(`TR-00594 shape: active lot found within first ${minSize}`);
else fail(`TR-00594 shape: active lot NOT found within first ${minSize}`);
if (pick(lots.slice(0, 10)) === null) pass('old page size 10 reproduces the incident (sanity)');
else fail('sanity: page size 10 unexpectedly found the active lot');

if (failures) { console.log(`FAILURE: ${failures} check(s) failed`); process.exit(1); }
console.log('ALL PASS');
