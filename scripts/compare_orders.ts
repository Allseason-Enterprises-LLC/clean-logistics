/**
 * compare_orders.ts — compare a bridge-imported order vs a native TikTok order
 * to identify structural differences causing print failures.
 */
import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken(): Promise<string> {
  if (process.env.SHIPHERO_ACCESS_TOKEN) return process.env.SHIPHERO_ACCESS_TOKEN;
  const { data } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID)
    .single();
  return (data?.api_credentials as any)?.accessToken;
}

async function shGql(token: string, query: string, variables?: any) {
  const resp = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await resp.json();
  if (json.message && !json.data) throw new Error(`ShipHero: ${json.message}`);
  if (json.errors) throw new Error(`GQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchOrder(token: string, orderNumber: string) {
  const q = `
    query($orderNumber: String!) {
      orders(order_number: $orderNumber) {
        data(first: 5) {
          edges {
            node {
              id
              order_number
              shop_name
              fulfillment_status
              tags
              email
              packing_note
              required_ship_date
              source
              profile
              shipping_lines { title carrier method price }
              shipping_address {
                first_name last_name address1 address2
                city state zip country phone email
              }
              line_items(first: 50) {
                edges {
                  node {
                    id
                    sku
                    quantity
                    partner_line_item_id
                    barcode
                    product {
                      name
                      barcode
                      images { src }
                    }
                  }
                }
              }
              allocations {
                warehouse_id
              }
            }
          }
        }
      }
    }
  `;
  const data = await shGql(token, q, { orderNumber });
  return data?.orders?.data?.edges?.[0]?.node;
}

async function main() {
  const token = await getToken();
  console.log('Token fetched ✓\n');

  const [bridge, native] = await Promise.all([
    fetchOrder(token, 'TT-577383277829919446'),
    fetchOrder(token, '577389911757853417'),
  ]);

  console.log('=== BRIDGE ORDER (TT-577383277829919446) ===');
  console.log(JSON.stringify(bridge, null, 2));

  console.log('\n=== NATIVE ORDER (577389911757853417) ===');
  console.log(JSON.stringify(native, null, 2));

  // Quick diff summary
  console.log('\n=== KEY FIELD COMPARISON ===');
  const fields = ['shop_name', 'fulfillment_status', 'tags', 'email', 'source', 'profile'] as const;
  for (const f of fields) {
    const b = (bridge as any)?.[f];
    const n = (native as any)?.[f];
    const diff = JSON.stringify(b) !== JSON.stringify(n) ? ' ← DIFF' : '';
    console.log(`${f}: bridge=${JSON.stringify(b)} | native=${JSON.stringify(n)}${diff}`);
  }

  console.log('\nBridge line items:');
  for (const e of bridge?.line_items?.edges || []) {
    const li = e.node;
    console.log(`  sku=${li.sku} qty=${li.quantity} partner_line_item_id=${li.partner_line_item_id} barcode=${li.barcode}`);
    console.log(`    product.name=${li.product?.name} product.barcode=${li.product?.barcode}`);
  }

  console.log('\nNative line items:');
  for (const e of native?.line_items?.edges || []) {
    const li = e.node;
    console.log(`  sku=${li.sku} qty=${li.quantity} partner_line_item_id=${li.partner_line_item_id} barcode=${li.barcode}`);
    console.log(`    product.name=${li.product?.name} product.barcode=${li.product?.barcode}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
