/**
 * compare_multiple.ts — pull subtotal/total_price across multiple shipped vs failing bridge orders
 */
import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}
let _tok: string | null = null;
async function tok() { return (_tok ??= await getToken()); }

async function shGql(query: string, variables?: any) {
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.errors?.find((e: any) => e.code === 30)) {
      await new Promise(r => setTimeout(r, 17000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
}

async function main() {
  // Get shipped bridge orders
  const shipped = await shGql(`{
    orders(shop_name: "TikTok Shop", fulfillment_status: "fulfilled") {
      data(first: 20) {
        edges { node { order_number subtotal total_price shipping_lines { title } shipments { id } } }
      }
    }
  }`);

  // Get failing bridge orders
  const failing = await shGql(`{
    orders(shop_name: "TikTok Shop", fulfillment_status: "TikTok URGENT") {
      data(first: 20) {
        edges { node { order_number subtotal total_price shipping_lines { title } } }
      }
    }
  }`);

  console.log('\n=== SHIPPED BRIDGE ORDERS ===');
  const shippedRows = (shipped?.orders?.data?.edges || []).filter((e:any) => e.node.shipments?.length > 0);
  for (const e of shippedRows.slice(0, 10)) {
    const n = e.node;
    console.log(`  ${n.order_number}: subtotal=${n.subtotal}, total=${n.total_price}, title="${n.shipping_lines.title}"`);
  }

  console.log('\n=== FAILING BRIDGE ORDERS (TikTok URGENT) ===');
  for (const e of (failing?.orders?.data?.edges || []).slice(0, 10)) {
    const n = e.node;
    console.log(`  ${n.order_number}: subtotal=${n.subtotal}, total=${n.total_price}, title="${n.shipping_lines.title}"`);
  }

  // Count shipped with subtotal=0 vs shipped with nonzero
  const zero = shippedRows.filter((e:any) => parseFloat(e.node.subtotal) === 0).length;
  const nonzero = shippedRows.filter((e:any) => parseFloat(e.node.subtotal) > 0).length;
  console.log(`\nShipped bridge orders: ${zero} with subtotal=0, ${nonzero} with subtotal>0`);
}

main().catch(e => { console.error(e); process.exit(1); });
