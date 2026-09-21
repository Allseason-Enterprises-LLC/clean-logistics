/**
 * DRY RUN: what would recent real transfers be named under the new scheme?
 * Reads live Supabase bridge rows. Writes nothing.
 * Run: npx tsx scripts/_preview-order-naming.ts
 */
import { buildShipHeroOrderNumber } from '../lib/order-naming';

const U = process.env.SUPABASE_URL!;
const K = process.env.SUPABASE_SERVICE_ROLE_KEY!;

(async () => {
  const resp = await fetch(
    `${U}/rest/v1/cin7_transfer_shiphero_orders?select=cin7_transfer_number,cin7_destination,shiphero_order_number,request_payload&order=synced_at.desc&limit=25`,
    { headers: { apikey: K, Authorization: `Bearer ${K}` } }
  );
  const rows: any[] = await resp.json();
  const seen = new Map<string, string>();
  let collisions = 0;
  console.log('OLD NAME'.padEnd(20) + 'NEW NAME');
  for (const r of rows) {
    const pl = r.request_payload || {};
    const li = pl.partnerLineItems || pl.items || [];
    const next = buildShipHeroOrderNumber({
      transferNumber: r.cin7_transfer_number,
      destinationName: r.cin7_destination,
      skus: li.map((x: any) => x.sku),
    });
    if (seen.has(next)) {
      collisions++;
      console.log(`  !! COLLISION: ${next} already used by ${seen.get(next)}`);
    }
    seen.set(next, r.cin7_transfer_number);
    console.log(`  ${String(r.shiphero_order_number || '-').padEnd(18)} ${next}`);
  }
  console.log(`\n${rows.length} transfers -> ${seen.size} unique names, ${collisions} collisions`);
  const lens = [...seen.keys()].map((k) => k.length);
  console.log(`name length: min ${Math.min(...lens)}, max ${Math.max(...lens)}`);
  if (collisions) process.exitCode = 1;
})();
