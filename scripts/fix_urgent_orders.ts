/**
 * fix_urgent_orders.ts
 * 
 * Fixes shop_name on the specific urgent orders from the error CSV.
 * Sets shop_name → "Clean Nutra" so packing station can find the label config.
 */
import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

const URGENT_ORDER_NUMBERS = [
  'TT-577384782421791728',
  'TT-577384420966110010',
  'TT-577384407166062647',
  'TT-577384399236206609',
  'TT-577384374973862263',
  'TT-577384320933073670',
  'TT-577384320299340204',
  'TT-577384305517302665',
  'TT-577384288623825691',
  'TT-577384278580302469',
  'TT-577384258846822484',
  'TT-577384258278428733',
  'TT-577384253680226431',
  'TT-577384231020761455',
  'TT-577384205916017392',
  'TT-577384091095699558',
  'TT-577384061549122201',
  'TT-577384040042435351',
  'TT-577384039808405952',
  'TT-577384016941519778',
  'TT-577383950667911620',
  'TT-577383918885966236',
  'TT-577382521489690985',
  'TT-577386230508851975',
  'TT-577386203247841765',
];

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}

let _tok: string | null = null;
async function tok() { return (_tok ??= await getToken()); }

async function shGql(query: string, variables?: any): Promise<any> {
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.errors?.find((e: any) => e.code === 30)) {
      const wait = (parseInt(json.errors[0].time_remaining) || 15) + 2;
      console.log(`  rate-limited, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
}

async function getOrderId(orderNumber: string): Promise<string | null> {
  const data = await shGql(`
    query($n: String!) {
      orders(order_number: $n) {
        data(first: 1) {
          edges { node { id order_number shop_name } }
        }
      }
    }
  `, { n: orderNumber });
  return data?.orders?.data?.edges?.[0]?.node?.id || null;
}

async function fixShopName(orderId: string): Promise<string> {
  const data = await shGql(`
    mutation($d: OrderUpdateMutationInput!) {
      order_update(data: $d) {
        order { id shop_name }
      }
    }
  `, { d: { order_id: orderId, shop_name: 'Clean Nutra' } });
  return data?.order_update?.order?.shop_name;
}

async function main() {
  console.log(`\nFixing ${URGENT_ORDER_NUMBERS.length} urgent orders...\n`);
  let ok = 0, err = 0;

  for (const orderNumber of URGENT_ORDER_NUMBERS) {
    try {
      const id = await getOrderId(orderNumber);
      if (!id) { console.log(`  ⚠ ${orderNumber}: not found`); err++; continue; }
      const newShopName = await fixShopName(id);
      console.log(`  ✓ ${orderNumber} → shop_name="${newShopName}"`);
      ok++;
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.error(`  ✗ ${orderNumber}: ${e}`);
      err++;
    }
  }

  console.log(`\nDone: ${ok} fixed, ${err} errors.`);
}

main().catch(e => { console.error(e); process.exit(1); });
