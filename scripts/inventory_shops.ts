/**
 * Inventory all shop_name + tag combinations in ShipHero so we can build
 * the channel-tag mapping rules.
 */
import { supabase } from '../lib/supabase';

interface OrderNode {
  id: string;
  order_number: string;
  partner_order_id: string;
  shop_name: string;
  tags: string[];
  source: string;
  partner_source_name?: string;
}

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  const all: OrderNode[] = [];
  let after: string | null = null;
  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "2026-04-25") {
          data(first: 100, after: $after) {
            edges { node { id order_number partner_order_id shop_name tags source partner_source_name } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { after } }),
    });
    const j: any = await r.json();
    if (j.errors) { console.error(JSON.stringify(j.errors)); return; }
    const data = j.data?.orders?.data;
    (data?.edges || []).forEach((e: any) => all.push(e.node));
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Total orders: ${all.length}\n`);

  // Group by shop_name
  const byShop = new Map<string, OrderNode[]>();
  for (const o of all) {
    const key = o.shop_name || '(null)';
    if (!byShop.has(key)) byShop.set(key, []);
    byShop.get(key)!.push(o);
  }

  console.log('=== shop_name distribution ===');
  for (const [shop, orders] of [...byShop.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${shop}: ${orders.length} orders`);
    // Sample 2 orders to see typical structure
    const samples = orders.slice(0, 2);
    samples.forEach(o => {
      console.log(`  • order_number=${o.order_number}  source=${o.source}  partner_source=${o.partner_source_name || '(none)'}`);
      console.log(`    tags=${JSON.stringify(o.tags || [])}`);
    });
    // Count distinct partner_source_name
    const partners = new Set(orders.map(o => o.partner_source_name || '(none)'));
    if (partners.size > 1) console.log(`  partner_source_names seen: ${[...partners].join(', ')}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
