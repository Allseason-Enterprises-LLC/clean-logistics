/**
 * Find Walmart orders by scanning recent orders for source="walmart"
 * or shop_name patterns.
 */
import { supabase } from '../lib/supabase';

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  // Look at last 7 days for any walmart-shaped orders
  const all: any[] = [];
  let after: string | null = null;
  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "2026-05-04") {
          data(first: 100, after: $after) {
            edges { node {
              order_number partner_order_id shop_name source partner_source_name tags
            } }
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
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`Total orders since 2026-05-04: ${all.length}`);

  const sources = new Map<string, number>();
  for (const o of all) {
    const k = `source=${o.source || 'null'}`;
    sources.set(k, (sources.get(k) || 0) + 1);
  }
  console.log('\nsource distribution:');
  [...sources.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  // Walmart-like
  const walmart = all.filter(o => {
    const s = (o.source || '').toLowerCase();
    const shop = (o.shop_name || '').toLowerCase();
    const partner = (o.partner_source_name || '').toLowerCase();
    return s.includes('walmart') || shop.includes('walmart') || partner.includes('walmart')
      || /^\d{10}-/.test(o.order_number); // walmart order numbers tend to have a leading numeric prefix
  });
  console.log(`\nWalmart-like orders: ${walmart.length}`);
  walmart.slice(0, 5).forEach((o: any) => {
    console.log(`  ${o.order_number}  shop="${o.shop_name}"  source="${o.source}"  partner="${o.partner_source_name}"  tags=${JSON.stringify(o.tags)}`);
  });

  // Amazon for comparison
  const amazon = all.filter(o => (o.source || '').toLowerCase() === 'amazon');
  console.log(`\nAmazon orders (source=amazon): ${amazon.length}`);
  amazon.slice(0, 3).forEach((o: any) => {
    console.log(`  ${o.order_number}  shop="${o.shop_name}"  tags=${JSON.stringify(o.tags)}`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });
