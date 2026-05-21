/**
 * test_fix_shipping_title.ts
 * 
 * Updates ONE order's shipping_lines.title from "Standard" to "Standard Shipping"
 * to match what native TikTok orders use, then verifies the change.
 */
import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const TEST_ORDER = 'TT-577383290317148773';  // Powder Springs order

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}

async function shGql(query: string, variables?: any) {
  const tok = await getToken();
  const resp = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await resp.json();
  if (json.errors) console.log('GQL errors:', JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  // 1. BEFORE state
  console.log('\n=== BEFORE ===');
  let d = await shGql(`{ orders(order_number: "${TEST_ORDER}") { data(first:1) { edges { node { id order_number shipping_lines { title carrier method price } } } } } }`);
  const before = d?.orders?.data?.edges?.[0]?.node;
  if (!before) { console.log('Order not found'); return; }
  console.log('Order:', before.order_number);
  console.log('  shipping_lines:', JSON.stringify(before.shipping_lines));

  // 2. Update shipping_lines.title to match native pattern
  console.log('\n=== UPDATING shipping_lines.title from "Standard" → "Standard Shipping" ===');
  const updateResult = await shGql(`
    mutation($d: UpdateOrderInput!) {
      order_update(data: $d) {
        request_id
        order { id }
      }
    }
  `, {
    d: {
      order_id: before.id,
      shipping_lines: {
        title: 'Standard Shipping',
        carrier: before.shipping_lines.carrier,
        method: before.shipping_lines.method,
        price: before.shipping_lines.price || '0.00',
      },
    },
  });
  console.log('  result:', JSON.stringify(updateResult));

  // 3. AFTER state
  console.log('\n=== AFTER ===');
  d = await shGql(`{ orders(order_number: "${TEST_ORDER}") { data(first:1) { edges { node { id order_number shipping_lines { title carrier method price } } } } } }`);
  const after = d?.orders?.data?.edges?.[0]?.node;
  console.log('  shipping_lines:', JSON.stringify(after?.shipping_lines));

  console.log('\nNow have the warehouse try to print the label for ' + TEST_ORDER);
}

main().catch(e => { console.error(e); process.exit(1); });
