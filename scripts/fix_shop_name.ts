/**
 * fix_shop_name.ts
 *
 * One-shot script: find all ShipHero orders where shop_name = 'TikTok Shop'
 * (imported by the bridge before the 2026-05-14 fix) and update them to 'Clean Nutra'.
 *
 * ShipHero's order_update mutation accepts a `shop_name` field.
 *
 * Usage:
 *   npx tsx scripts/fix_shop_name.ts [--dry-run]
 */

import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const DRY_RUN = process.argv.includes('--dry-run');

async function getToken(): Promise<string> {
  if (process.env.SHIPHERO_ACCESS_TOKEN) return process.env.SHIPHERO_ACCESS_TOKEN;
  const { data, error } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID)
    .single();
  if (error) throw new Error(`Supabase error: ${error.message}`);
  const token = (data?.api_credentials as any)?.accessToken;
  if (!token) throw new Error('No accessToken found');
  return token;
}

async function shGql<T = any>(token: string, query: string, variables?: Record<string, any>): Promise<T> {
  const resp = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await resp.json();
  if (json.message && !json.data) throw new Error(`ShipHero: ${json.message}`);
  if (json.errors) throw new Error(`ShipHero GQL: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

async function fetchOrdersWithTikTokShopName(token: string, cursor?: string): Promise<{ orders: any[]; nextCursor?: string }> {
  const query = `
    query($filters: OrderFilters, $first: Int, $after: String) {
      orders(filters: $filters, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            order_number
            shop_name
          }
        }
      }
    }
  `;
  const data = await shGql<any>(token, query, {
    filters: { shop_name: 'TikTok Shop' },
    first: 100,
    after: cursor || null,
  });
  const edges = data.orders.edges || [];
  const orders = edges.map((e: any) => e.node);
  const pageInfo = data.orders.pageInfo;
  return {
    orders,
    nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : undefined,
  };
}

async function updateShopName(token: string, orderId: string, orderNumber: string): Promise<void> {
  const mutation = `
    mutation($data: OrderUpdateInput!) {
      order_update(data: $data) {
        request_id
        order {
          id
          shop_name
        }
      }
    }
  `;
  const data = await shGql<any>(token, mutation, {
    data: {
      order_id: orderId,
      shop_name: 'Clean Nutra',
    },
  });
  const updated = data.order_update.order;
  console.log(`  ✓ ${orderNumber} (${orderId}) → shop_name now: ${updated?.shop_name}`);
}

async function main() {
  console.log(`\n🔧 fix_shop_name.ts — ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE RUN'}`);
  console.log('Fetching orders with shop_name = "TikTok Shop" from ShipHero...\n');

  const token = await getToken();

  let allOrders: any[] = [];
  let cursor: string | undefined;
  do {
    const { orders, nextCursor } = await fetchOrdersWithTikTokShopName(token, cursor);
    allOrders.push(...orders);
    cursor = nextCursor;
    if (cursor) console.log(`  Fetched ${allOrders.length} so far, paginating...`);
  } while (cursor);

  console.log(`Found ${allOrders.length} orders with shop_name = "TikTok Shop"\n`);

  if (allOrders.length === 0) {
    console.log('Nothing to fix. ✅');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — would update these orders:');
    for (const o of allOrders) {
      console.log(`  ${o.order_number} (${o.id})`);
    }
    return;
  }

  let success = 0;
  let failed = 0;
  for (const o of allOrders) {
    try {
      await updateShopName(token, o.id, o.order_number);
      success++;
      // Small delay to avoid hammering ShipHero rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ✗ ${o.order_number}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\nDone. ${success} updated, ${failed} failed.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
