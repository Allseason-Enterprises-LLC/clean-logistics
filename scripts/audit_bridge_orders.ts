/**
 * audit_bridge_orders.ts
 *
 * 1. Queries ShipHero for all orders with source='api' AND tags containing 'TikTok'
 *    (these are bridge-imported orders)
 * 2. For each order, checks the line item barcode vs the product catalog barcode
 * 3. Reports: shop_name mismatch, missing/wrong barcode, source='api' vs 'tiktok'
 *
 * Usage:
 *   npx tsx scripts/audit_bridge_orders.ts [--fix]
 */

import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const FIX = process.argv.includes('--fix');

async function getToken(): Promise<string> {
  if (process.env.SHIPHERO_ACCESS_TOKEN) return process.env.SHIPHERO_ACCESS_TOKEN;
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}

async function shGql<T = any>(token: string, query: string, variables?: any): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.message && !json.data) throw new Error(`ShipHero: ${json.message}`);
    if (json.errors) {
      // Credit rate-limit: wait and retry
      const creditErr = json.errors.find((e: any) => e.code === 30);
      if (creditErr) {
        const wait = (creditErr.time_remaining ? parseInt(creditErr.time_remaining) : 15) + 2;
        console.log(`  ⏳ Rate limited, waiting ${wait}s...`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error(`GQL: ${JSON.stringify(json.errors)}`);
    }
    return json.data as T;
  }
  throw new Error('Too many rate limit retries');
}

async function fetchProductBarcode(token: string, sku: string): Promise<string | null> {
  const q = `
    query($sku: String!) {
      product(sku: $sku) {
        data { sku barcode }
      }
    }
  `;
  const data = await shGql<any>(token, q, { sku });
  return data?.product?.data?.barcode || null;
}

async function fetchBridgeOrders(token: string, cursor?: string): Promise<{ orders: any[]; nextCursor?: string }> {
  const q = `
    query($after: String) {
      orders(
        tag: "TikTok"
        shop_name: "TikTok Shop"
      ) {
        data(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              order_number
              shop_name
              fulfillment_status
              source
              tags
              line_items(first: 50) {
                edges {
                  node {
                    id
                    sku
                    quantity
                    barcode
                    product { barcode }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await shGql<any>(token, q, { after: cursor || null });
  const edges = data?.orders?.data?.edges || [];
  const pageInfo = data?.orders?.data?.pageInfo;
  return {
    orders: edges.map((e: any) => e.node),
    nextCursor: pageInfo?.hasNextPage ? pageInfo.endCursor : undefined,
  };
}

async function fixShopName(token: string, orderId: string): Promise<void> {
  const mutation = `
    mutation($data: OrderUpdateInput!) {
      order_update(data: $data) {
        request_id
        order { id shop_name }
      }
    }
  `;
  await shGql(token, mutation, { data: { order_id: orderId, shop_name: 'Clean Nutra' } });
}

async function main() {
  console.log(`\n🔍 audit_bridge_orders.ts — ${FIX ? 'FIX MODE' : 'AUDIT ONLY'}\n`);
  const token = await getToken();

  let allOrders: any[] = [];
  let cursor: string | undefined;
  do {
    const { orders, nextCursor } = await fetchBridgeOrders(token, cursor);
    allOrders.push(...orders);
    cursor = nextCursor;
    if (cursor) console.log(`  Fetched ${allOrders.length} so far...`);
  } while (cursor);

  console.log(`Found ${allOrders.length} bridge-imported TikTok orders (source=api, tag=TikTok)\n`);

  let wrongShopName = 0;
  let missingBarcode = 0;
  let barcodeIsSkuString = 0;
  let fixed = 0;

  for (const order of allOrders) {
    const issues: string[] = [];

    if (order.shop_name !== 'Clean Nutra') {
      issues.push(`shop_name="${order.shop_name}" (should be "Clean Nutra")`);
      wrongShopName++;
    }

    for (const e of order.line_items?.edges || []) {
      const li = e.node;
      const catalogBarcode = li.product?.barcode;
      if (!li.barcode) {
        issues.push(`line ${li.sku}: no barcode`);
        missingBarcode++;
      } else if (li.barcode === li.sku) {
        issues.push(`line ${li.sku}: barcode = SKU (packing station can't scan, catalog barcode=${catalogBarcode})`);
        barcodeIsSkuString++;
      }
    }

    if (issues.length > 0) {
      console.log(`⚠️  ${order.order_number} (${order.fulfillment_status})`);
      for (const i of issues) console.log(`     - ${i}`);

      if (FIX && order.shop_name !== 'Clean Nutra') {
        try {
          await fixShopName(token, order.id);
          console.log(`     ✓ shop_name fixed`);
          fixed++;
          await new Promise(r => setTimeout(r, 150));
        } catch (err) {
          console.error(`     ✗ fix failed: ${err}`);
        }
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total bridge orders:      ${allOrders.length}`);
  console.log(`Wrong shop_name:          ${wrongShopName}`);
  console.log(`Barcode missing:          ${missingBarcode}`);
  console.log(`Barcode = SKU (bad):      ${barcodeIsSkuString}`);
  if (FIX) console.log(`shop_name fixes applied:  ${fixed}`);
  
  if (barcodeIsSkuString > 0) {
    console.log(`\n⚠️  BARCODE BUG: The bridge is not sending real UPC barcodes.`);
    console.log(`   ShipHero falls back to using the SKU string as the barcode.`);
    console.log(`   The packing station can't scan a SKU string → "Error printing".`);
    console.log(`   Fix: look up product barcode from ShipHero catalog during order creation.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
