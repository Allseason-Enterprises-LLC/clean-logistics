import { supabase } from '../lib/supabase';
async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `
      query { orders(order_number: "577386720333172977") {
        data(first: 5) {
          edges { node {
            id order_number partner_order_id shop_name source partner_source_name tags
            fulfillment_status ready_to_ship order_date
            holds { operator_hold address_hold payment_hold fraud_hold client_hold }
          } }
        }
      }}` }),
  });
  const j: any = await r.json();
  console.log(JSON.stringify(j.data?.orders?.data?.edges, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
