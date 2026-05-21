/**
 * Check the 6 TikTok URGENT orders with no warehouse allocation.
 */
import { supabase } from '../lib/supabase';

const ORDERS = [
  'TT-577385654830076285',
  'TT-577385637916676421',
  'TT-577385310433087861',
  'TT-577383985830138761',
  'TT-577383979429761317',
  'TT-577383197813085033',
];

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

async function getToken(): Promise<string> {
  const { data, error } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', process.env.SHIPHERO_WAREHOUSE_ID!)
    .eq('provider', 'shiphero')
    .single();
  if (error) throw new Error(`token: ${error.message}`);
  return (data!.api_credentials as any).accessToken;
}

async function gql(token: string, query: string, variables: any = {}) {
  const r = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const j: any = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function main() {
  const token = await getToken();
  for (const orderNum of ORDERS) {
    await new Promise(r => setTimeout(r, 12000)); // wait for credits
    const data = await gql(token, `
      query($n: String!) {
        orders(order_number: $n) {
          data {
            edges {
              node {
                id
                order_number
                fulfillment_status
                tags
                line_items(first: 25) {
                  edges {
                    node {
                      sku
                      quantity
                      backorder_quantity
                      quantity_allocated
                      quantity_shipped
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { n: orderNum });

    const node = data?.orders?.data?.edges?.[0]?.node;
    if (!node) { console.log(`\n${orderNum}: NOT FOUND`); continue; }
    console.log(`\n=== ${orderNum} (status=${node.fulfillment_status}) tags=${JSON.stringify(node.tags)} ===`);
    console.log(`  Line items:`);
    for (const li of node.line_items.edges) {
      const n = li.node;
      console.log(`    SKU=${n.sku} qty=${n.quantity} alloc=${n.quantity_allocated} bo=${n.backorder_quantity} shipped=${n.quantity_shipped}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
