import { supabase } from '../lib/supabase';
async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  for (const on of ['112-8956684-7682647']) {
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `
        query { orders(order_number: "${on}") {
          data(first: 5) {
            edges { node {
              order_number partner_order_id shop_name source partner_source_name tags
              line_items { edges { node { sku } } }
            } }
          }
        }}` }),
    });
    const j: any = await r.json();
    console.log(JSON.stringify(j, null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
