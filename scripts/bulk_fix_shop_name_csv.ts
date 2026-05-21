/**
 * bulk_fix_shop_name_csv.ts
 * Reads order numbers from stdin (one per line) and sets shop_name → "Clean Nutra"
 * Tests UpdateOrderInput first (from fba-post-process.ts pattern)
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}
let _tok: string | null = null;
async function tok() { return (_tok ??= await getToken()); }

async function shGql(query: string, variables?: any): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.errors?.find((e: any) => e.code === 30)) {
      const wait = (parseInt(json.errors[0]?.time_remaining) || 15) + 2;
      process.stdout.write(`\r  ⏳ rate-limited, waiting ${wait}s...   `);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
  throw new Error('Max retries exceeded');
}

async function getOrderId(orderNumber: string): Promise<string | null> {
  const data = await shGql(`
    query($n: String!) {
      orders(order_number: $n) {
        data(first: 1) { edges { node { id shop_name } } }
      }
    }
  `, { n: orderNumber });
  return data?.orders?.data?.edges?.[0]?.node?.id || null;
}

async function fixShopName(orderId: string): Promise<void> {
  // Use UpdateOrderInput — confirmed working in fba-post-process.ts
  await shGql(`
    mutation($d: UpdateOrderInput!) {
      order_update(data: $d) { request_id }
    }
  `, { d: { order_id: orderId, shop_name: 'Clean Nutra' } });
}

async function main() {
  const orderNumbers = fs.readFileSync('/tmp/order_numbers.txt', 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);

  console.log(`\nFixing shop_name on ${orderNumbers.length} orders...\n`);

  let ok = 0, skipped = 0, err = 0;

  for (let i = 0; i < orderNumbers.length; i++) {
    const orderNumber = orderNumbers[i];
    process.stdout.write(`\r  [${i+1}/${orderNumbers.length}] ${ok} fixed, ${err} errors...   `);

    try {
      const id = await getOrderId(orderNumber);
      if (!id) { skipped++; continue; }
      await fixShopName(id);
      ok++;
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      process.stdout.write(`\n  ✗ ${orderNumber}: ${e}\n`);
      err++;
    }
  }

  console.log(`\n\n✅ Done: ${ok} fixed, ${skipped} not found, ${err} errors.`);
}

main().catch(e => { console.error(e); process.exit(1); });
