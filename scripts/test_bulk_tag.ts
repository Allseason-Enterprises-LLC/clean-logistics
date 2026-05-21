// Test order_bulk_add_tags on a small set first
import { supabase } from '../lib/supabase';

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  // Pick 3 Shopify orders to test on
  const r0 = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `
      query { orders(order_date_from: "2026-04-25", shop_name: "clean-nutraceuticals.myshopify.com") {
        data(first: 3) { edges { node { id order_number tags } } }
      }}` }),
  });
  const j0: any = await r0.json();
  const samples = j0.data?.orders?.data?.edges || [];
  console.log('Test orders:');
  samples.forEach((e: any) => console.log(`  ${e.node.order_number}  current tags=${JSON.stringify(e.node.tags)}`));

  const orderIds = samples.map((e: any) => e.node.id);

  // Apply tags
  const m = `
    mutation($data: BulkUpdateTagsInput!) {
      order_bulk_add_tags(data: $data) { request_id }
    }`;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: m,
      variables: { data: { orders_ids: orderIds, tags: ['Website', 'Website-Shopify'] } },
    }),
  });
  const j: any = await r.json();
  console.log('\nMutation result:', JSON.stringify(j, null, 2));

  // Verify
  await new Promise(r => setTimeout(r, 2000));
  for (const oid of orderIds) {
    const v = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query { order(id: "${oid}") { data { order_number tags } } }` }),
    });
    const vj: any = await v.json();
    console.log(`  ${vj.data?.order?.data?.order_number}: tags=${JSON.stringify(vj.data?.order?.data?.tags)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
