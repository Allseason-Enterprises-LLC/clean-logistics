import { supabase } from '../lib/supabase';

async function main() {
  const { data } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', process.env.SHIPHERO_WAREHOUSE_ID!)
    .eq('provider', 'shiphero')
    .single();
  const token = (data?.api_credentials as any)?.accessToken;

  const q = `
    query {
      orders(shop_name: "Clean Nutra", order_date_from: "2026-05-01") {
        data(first: 200) {
          edges { node {
            id order_number tags
            holds { fraud_hold operator_hold address_hold payment_hold shipping_method_hold client_hold }
            ready_to_ship
          }}
        }
      }
    }
  `;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j = await r.json();
  if (j.errors) { console.log(JSON.stringify(j.errors)); process.exit(1); }
  const fbt = (j.data?.orders?.data?.edges || []).filter((o: any) => (o.node.tags || []).includes('fulfilled_by_tiktok'));
  console.log(`FBT orders (${fbt.length}):`);
  fbt.forEach((o: any) => {
    console.log(`  ${o.node.order_number}  op_hold=${o.node.holds?.operator_hold}  ready=${o.node.ready_to_ship}`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });
