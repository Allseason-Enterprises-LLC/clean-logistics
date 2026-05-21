import { supabase } from '../lib/supabase';

async function main() {
  const { data: wh } = await supabase
    .from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  const tests = [
    '577381166555435563', 'TT-577381166555435563',
    '577386413093458572', 'TT-577386413093458572',
    '577386408838927312', 'TT-577386408838927312',
    '577386406759338573', 'TT-577386406759338573',
  ];

  for (const orderNum of tests) {
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `
        query { orders(order_number: "${orderNum}") {
          data(first: 5) {
            edges { node { id order_number partner_order_id shop_name tags } }
          }
        }}` }),
    });
    const j: any = await r.json();
    const found = j.data?.orders?.data?.edges || [];
    if (found.length === 0) {
      console.log(`${orderNum}  →  NOT FOUND`);
    } else {
      for (const e of found) {
        const n = e.node;
        console.log(`${orderNum}  →  on=${n.order_number} pid=${n.partner_order_id} shop="${n.shop_name}" tags=${JSON.stringify(n.tags)}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
