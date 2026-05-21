/**
 * bulk_fix_bridge_orders.ts
 *
 * Fixes ALL bridge-imported TikTok orders (shop_name="TikTok Shop") by:
 *   1. Setting shop_name → "Clean Nutra"
 *   2. For any line item where barcode = SKU string (not a real UPC),
 *      looks up the real barcode from the product catalog and updates it
 *      via order_update_line_item.
 *
 * Handles ShipHero credit rate-limits automatically.
 * Safe to re-run — skips orders already fixed.
 *
 * Usage:
 *   npx tsx scripts/bulk_fix_bridge_orders.ts [--dry-run]
 */

import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const DRY_RUN = process.argv.includes('--dry-run');

// ─── ShipHero GQL with rate-limit retry ──────────────────────────────────────

async function getToken(): Promise<string> {
  if (process.env.SHIPHERO_ACCESS_TOKEN) return process.env.SHIPHERO_ACCESS_TOKEN;
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}

let _token: string | null = null;
async function token() { return (_token ??= await getToken()); }

async function shGql<T = any>(query: string, variables?: any): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.message && !json.data) throw new Error(`ShipHero: ${json.message}`);
    if (json.errors) {
      const creditErr = json.errors.find((e: any) => e.code === 30);
      if (creditErr) {
        const wait = (parseInt(creditErr.time_remaining) || 15) + 2;
        process.stdout.write(`\r  ⏳ Rate limited, waiting ${wait}s...    `);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error(`GQL: ${JSON.stringify(json.errors)}`);
    }
    return json.data as T;
  }
  throw new Error('Max rate-limit retries exceeded');
}

// ─── Product barcode cache ────────────────────────────────────────────────────

const barcodeCache = new Map<string, string | null>();

async function getProductBarcode(sku: string): Promise<string | null> {
  if (barcodeCache.has(sku)) return barcodeCache.get(sku)!;
  try {
    const d = await shGql<any>(`query($sku:String!){product(sku:$sku){data{barcode}}}`, { sku });
    const b = d?.product?.data?.barcode || null;
    barcodeCache.set(sku, b);
    return b;
  } catch {
    barcodeCache.set(sku, null);
    return null;
  }
}

// ─── Fetch all bridge orders (paginated) ─────────────────────────────────────

async function fetchBridgeOrders(cursor?: string): Promise<{ orders: any[]; nextCursor?: string }> {
  const q = `
    query($after: String) {
      orders(shop_name: "TikTok Shop", tag: "TikTok") {
        data(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id order_number fulfillment_status
              line_items(first: 50) {
                edges {
                  node { id sku barcode }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await shGql<any>(q, { after: cursor || null });
  const edges = data?.orders?.data?.edges || [];
  const pageInfo = data?.orders?.data?.pageInfo;
  return {
    orders: edges.map((e: any) => e.node),
    nextCursor: pageInfo?.hasNextPage ? pageInfo.endCursor : undefined,
  };
}

// ─── Mutations ────────────────────────────────────────────────────────────────

async function fixShopName(orderId: string): Promise<void> {
  await shGql(`
    mutation($d:OrderUpdateInput!){
      order_update(data:$d){ request_id order { shop_name } }
    }
  `, { d: { order_id: orderId, shop_name: 'Clean Nutra' } });
}

async function fixLineItemBarcode(orderId: string, lineItemId: string, barcode: string): Promise<void> {
  await shGql(`
    mutation($d:UpdateLineItemInput!){
      order_update_line_item(data:$d){ request_id line_item { id barcode } }
    }
  `, { d: { order_id: orderId, line_item_id: lineItemId, barcode } });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧 bulk_fix_bridge_orders.ts — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // 1. Collect all bridge orders
  let all: any[] = [];
  let cursor: string | undefined;
  process.stdout.write('Fetching bridge orders');
  do {
    const { orders, nextCursor } = await fetchBridgeOrders(cursor);
    all.push(...orders);
    process.stdout.write(`\rFetching bridge orders: ${all.length}...`);
    cursor = nextCursor;
  } while (cursor);
  console.log(`\nFound ${all.length} orders with shop_name="TikTok Shop"\n`);

  let shopFixed = 0, barcodeFixed = 0, shopErr = 0, barcodeErr = 0;
  let i = 0;

  for (const order of all) {
    i++;
    process.stdout.write(`\r[${i}/${all.length}] ${order.order_number}                    `);

    if (!DRY_RUN) {
      // Fix shop_name
      try {
        await fixShopName(order.id);
        shopFixed++;
      } catch (e) {
        console.error(`\n  ✗ shop_name fix failed for ${order.order_number}: ${e}`);
        shopErr++;
      }

      // Fix barcodes on line items where barcode = SKU
      for (const edge of order.line_items?.edges || []) {
        const li = edge.node;
        if (li.barcode && li.barcode !== li.sku) continue; // already a real barcode
        const realBarcode = await getProductBarcode(li.sku);
        if (!realBarcode || realBarcode === li.sku) continue; // no better barcode in catalog
        try {
          await fixLineItemBarcode(order.id, li.id, realBarcode);
          barcodeFixed++;
          await new Promise(r => setTimeout(r, 100)); // small delay between line item updates
        } catch (e) {
          console.error(`\n  ✗ barcode fix failed for ${order.order_number} / ${li.sku}: ${e}`);
          barcodeErr++;
        }
      }

      await new Promise(r => setTimeout(r, 100)); // throttle between orders
    }
  }

  console.log(`\n\n=== DONE ===`);
  console.log(`Orders processed:   ${all.length}`);
  if (!DRY_RUN) {
    console.log(`shop_name fixed:    ${shopFixed} (${shopErr} errors)`);
    console.log(`barcodes fixed:     ${barcodeFixed} (${barcodeErr} errors)`);
  } else {
    console.log(`(dry run — no changes made)`);
  }
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
