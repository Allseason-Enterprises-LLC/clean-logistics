import { supabase } from '../lib/supabase';

async function main() {
  const { data } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', process.env.SHIPHERO_WAREHOUSE_ID!)
    .eq('provider', 'shiphero')
    .single();
  const token = (data?.api_credentials as any)?.accessToken;

  // Get FBT orders
  const fetchQuery = `
    query {
      orders(shop_name: "Clean Nutra", order_date_from: "2026-05-01") {
        data(first: 200) {
          edges { node { id order_number tags } }
        }
      }
    }
  `;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: fetchQuery }),
  });
  const j = await r.json();
  const fbt = (j.data?.orders?.data?.edges || [])
    .filter((o: any) => (o.node.tags || []).includes('fulfilled_by_tiktok'));

  console.log(`Found ${fbt.length} FBT orders to put on hold\n`);

  for (const o of fbt) {
    const orderId = o.node.id;
    const orderNum = o.node.order_number;
    const mutation = `
      mutation {
        order_update_holds(data: {
          order_id: "${orderId}",
          operator_hold: true
        }) {
          request_id
          order { id order_number operator_hold }
        }
      }
    `;
    const resp = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: mutation }),
    });
    const respJ = await resp.json();
    if (respJ.errors) {
      console.log(`❌ ${orderNum}: ${JSON.stringify(respJ.errors)}`);
    } else {
      const updated = respJ.data?.order_update_holds?.order;
      console.log(`✅ ${orderNum}: operator_hold=${updated?.operator_hold}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
