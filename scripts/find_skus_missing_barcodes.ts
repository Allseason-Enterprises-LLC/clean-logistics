/**
 * find_skus_missing_barcodes.ts
 * 
 * Finds all PENDING/unfulfilled bridge orders and lists SKUs that have
 * barcode = SKU string (no real UPC) — these are the ones blocking the packing station.
 */
import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const PENDING_STATUSES = ['pending', 'TikTok', 'TikTok URGENT'];

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
      const wait = (parseInt(json.errors[0].time_remaining) || 15) + 2;
      process.stdout.write(`\r  rate-limited, waiting ${wait}s...   `);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
}

async function main() {
  // SKUs with bad barcodes that we've already identified from the product catalog
  const badBarcodeSkus = new Set<string>();
  const skuToOrders = new Map<string, string[]>(); // sku → order numbers

  let cursor: string | undefined;
  let total = 0;

  process.stdout.write('Scanning pending bridge orders...');

  do {
    const data = await shGql(`
      query($after: String) {
        orders(shop_name: "TikTok Shop", tag: "TikTok") {
          data(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                order_number
                fulfillment_status
                line_items(first: 20) {
                  edges {
                    node { sku barcode }
                  }
                }
              }
            }
          }
        }
      }
    `, { after: cursor || null });

    const edges = data?.orders?.data?.edges || [];
    for (const e of edges) {
      const order = e.node;
      const status = order.fulfillment_status;
      if (!PENDING_STATUSES.includes(status)) continue;

      total++;
      for (const le of order.line_items?.edges || []) {
        const li = le.node;
        if (!li.barcode || li.barcode === li.sku) {
          badBarcodeSkus.add(li.sku);
          if (!skuToOrders.has(li.sku)) skuToOrders.set(li.sku, []);
          skuToOrders.get(li.sku)!.push(order.order_number);
        }
      }
    }

    cursor = data?.orders?.data?.pageInfo?.hasNextPage ? data.orders.data.pageInfo.endCursor : undefined;
    process.stdout.write(`\r  scanned ${total} pending orders, ${badBarcodeSkus.size} problem SKUs found...`);
  } while (cursor);

  console.log(`\n\n=== PENDING ORDERS WITH BARCODE PROBLEM ===`);
  console.log(`Total pending bridge orders: ${total}`);
  console.log(`SKUs missing real barcodes:  ${badBarcodeSkus.size}\n`);

  for (const [sku, orders] of skuToOrders.entries()) {
    console.log(`SKU: ${sku}`);
    console.log(`  Affects ${orders.length} pending order(s): ${orders.slice(0, 5).join(', ')}${orders.length > 5 ? ` ...+${orders.length - 5} more` : ''}`);
  }

  if (badBarcodeSkus.size === 0) {
    console.log('✅ No pending orders affected — all line items have real barcodes.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
