import { supabase } from '../lib/supabase';

async function main() {
  const { data } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', process.env.SHIPHERO_WAREHOUSE_ID!)
    .eq('provider', 'shiphero')
    .single();
  const token = (data?.api_credentials as any)?.accessToken;

  const query = `
    query {
      orders(shop_name: "Clean Nutra", order_date_from: "2026-05-01") {
        data(first: 200) {
          edges {
            node {
              order_number
              tags
              fulfillment_status
              ready_to_ship
              order_date
              shop_name
            }
          }
        }
      }
    }
  `;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) { console.log('GQL ERR', JSON.stringify(j.errors)); process.exit(1); }
  const orders = j.data?.orders?.data?.edges || [];
  const fbt = orders.filter((o: any) => (o.node.tags || []).includes('fulfilled_by_tiktok'));
  console.log(`Total Clean Nutra orders since May 1: ${orders.length}`);
  console.log(`  FBT: ${fbt.length}\n`);
  const counts: Record<string, number> = {};
  fbt.forEach((o: any) => {
    const key = `${o.node.fulfillment_status || 'null'}|ready=${o.node.ready_to_ship}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  console.log('FBT status x ready_to_ship:', counts);
  console.log('\nSample 5 FBT:');
  fbt.slice(0, 5).forEach((o: any) => console.log(`  ${o.node.order_number}  status=${o.node.fulfillment_status}  ready=${o.node.ready_to_ship}`));
}
main().catch(e => { console.error(e); process.exit(1); });
