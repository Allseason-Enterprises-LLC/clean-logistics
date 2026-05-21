import { supabase } from '../lib/supabase';
async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;
  const ids = ['136257', '136263', '136286'];
  for (const on of ids) {
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `
        query { orders(order_number: "${on}") {
          data(first: 5) {
            edges { node {
              order_number partner_order_id shop_name source partner_source_name tags
              email shipping_address { first_name last_name }
              line_items { edges { node { sku product_name } } }
            } }
          }
        }}` }),
    });
    const j: any = await r.json();
    const edges = j.data?.orders?.data?.edges || [];
    edges.forEach((e: any) => {
      const n = e.node;
      console.log(`${on}: shop="${n.shop_name}" source="${n.source}" partner="${n.partner_source_name}" partner_id="${n.partner_order_id}"`);
      console.log(`  email=${n.email}  name=${n.shipping_address?.first_name} ${n.shipping_address?.last_name}`);
      console.log(`  skus=${(n.line_items?.edges || []).map((x: any) => x.node.sku).join(',')}`);
    });
  }
}
main().catch(e => { console.error(e); process.exit(1); });
