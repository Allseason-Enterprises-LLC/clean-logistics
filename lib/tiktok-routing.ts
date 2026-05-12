/**
 * TikTok Order Routing - Routes incoming TikTok Shop orders to the correct warehouse
 * 
 * Logic:
 * - Orders with SKUs matching the Las Vegas list → Clean Nutra Las Vegas warehouse
 * - All other orders → ClearShip warehouse
 * 
 * The SKU routing table is stored in Supabase for easy updates without code changes.
 */

import { supabase } from './supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

// Warehouse IDs in ShipHero
const WAREHOUSES = {
  LAS_VEGAS: 'V2FyZWhvdXNlOjEzNTg3Mg==',     // Clean Nutra Las Vegas
} as const;

// Fallback SKU patterns if Supabase table isn't set up yet
export const DEFAULT_LAS_VEGAS_SKU_PATTERNS = [
  'WMNSNMNFOR',    // Juvanix (Women's NMN NAD+ Longevity Matrix)
  'UROLITHINFOR',  // Infinity One (Urolithin A) - aka "LongevityOne"
  'UROLINMNDUO',   // Infinity One + Juvanix Duo Bundle - aka "Longevity Duo"
];

export interface RoutingDecision {
  orderId: string;
  orderNumber: string;
  skus: string[];
  targetWarehouse: 'las_vegas' | 'clearship';
  targetWarehouseId: string;
  reason: string;
  matchedPattern?: string;
}

export interface OrderWebhookPayload {
  account_id?: string;
  order_id?: string;
  shop_name?: string;
  order_number?: string;
  line_items?: Array<{ sku: string; quantity: number }>;
}

/**
 * Get the active SKU patterns for Las Vegas routing from Supabase
 * Falls back to hardcoded patterns if table doesn't exist
 */
export async function getLasVegasSkuPatterns(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('tiktok_routing_rules')
      .select('sku_pattern')
      .eq('warehouse', 'las_vegas')
      .eq('active', true);

    if (error) {
      console.warn('Failed to fetch routing rules from Supabase, using defaults:', error.message);
      return DEFAULT_LAS_VEGAS_SKU_PATTERNS;
    }

    if (!data || data.length === 0) {
      console.warn('No routing rules in Supabase, using defaults');
      return DEFAULT_LAS_VEGAS_SKU_PATTERNS;
    }

    return data.map((r: any) => r.sku_pattern);
  } catch (err) {
    console.warn('Error fetching routing rules:', err);
    return DEFAULT_LAS_VEGAS_SKU_PATTERNS;
  }
}

/**
 * Determine which warehouse an order should be routed to based on its SKUs
 */
export function matchSkuToWarehouse(
  skus: string[],
  lasVegasPatterns: string[]
): { warehouse: 'las_vegas' | 'clearship'; matchedPattern?: string } {
  for (const sku of skus) {
    const upperSku = sku.toUpperCase();
    for (const pattern of lasVegasPatterns) {
      if (upperSku.includes(pattern.toUpperCase())) {
        return { warehouse: 'las_vegas', matchedPattern: pattern };
      }
    }
  }
  return { warehouse: 'clearship' };
}

/**
 * Get ShipHero access token from Supabase — the CLEAN NUTRA account specifically.
 *
 * ⚠️ There are TWO ShipHero warehouse rows in Supabase:
 *   - Clean Nutra (Las Vegas)  id=22e17170-...    ← we want THIS one for routing decisions
 *   - Clear Ship (3PL, Utah)    id=5ded469d-...   ← different account, would return wrong warehouses
 *
 * The TikTok-routing flow must use the Clean Nutra account token because routing
 * changes the order's warehouse to Clean Nutra's Las Vegas warehouse (legacy 135872),
 * which only exists on the Clean Nutra ShipHero account.
 *
 * Resolution order:
 *   1. SHIPHERO_ACCESS_TOKEN env var (Clean Nutra token if set explicitly)
 *   2. Supabase warehouses row matching "Clean Nutra" / "Las Vegas" / provider=shiphero
 */
async function getShipHeroToken(): Promise<string> {
  if (process.env.SHIPHERO_ACCESS_TOKEN) {
    return process.env.SHIPHERO_ACCESS_TOKEN;
  }

  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, api_credentials')
    .eq('provider', 'shiphero');

  if (error) throw new Error(`Failed to query ShipHero warehouses: ${error.message}`);

  // Prefer the Clean Nutra (Las Vegas) row by exact UUID; fall back to name match
  const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
  const row =
    (data || []).find((w: any) => w.id === CLEAN_NUTRA_LV_UUID) ||
    (data || []).find((w: any) => {
      const name = (w.name || '').toLowerCase();
      return name.includes('clean nutra') || name.includes('las vegas') || name.includes('lv');
    });

  if (!row) throw new Error('Could not find Clean Nutra ShipHero warehouse row in Supabase');
  const creds = row.api_credentials as any;
  if (!creds?.accessToken) throw new Error(`No accessToken on warehouses row ${row.id}`);
  return creds.accessToken;
}

/**
 * Execute ShipHero GraphQL query
 */
async function gql(query: string, variables?: Record<string, any>): Promise<any> {
  const token = await getShipHeroToken();

  const response = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json: any = await response.json();
  if (json.errors) {
    throw new Error(`ShipHero GQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/**
 * Fetch order details from ShipHero including line items
 *
 * Note: ShipHero's Order type does NOT have a top-level `warehouse_id` field.
 * The current warehouse is on `allocations[].warehouse_id`. Once we call
 * order_change_warehouse the old allocation is invalidated and a new one
 * is created at the target warehouse.
 */
export async function getOrderDetails(orderId: string): Promise<{
  id: string;
  orderNumber: string;
  shopName: string;
  skus: string[];
  warehouseId?: string;
  tags: string[];
}> {
  const query = `
    query($id: String!) {
      order(id: $id) {
        data {
          id
          order_number
          shop_name
          tags
          allocations {
            warehouse_id
          }
          line_items(first: 100) {
            edges {
              node {
                sku
                quantity
              }
            }
          }
        }
      }
    }
  `;

  const data = await gql(query, { id: orderId });
  const order = data.order.data;

  return {
    id: order.id,
    orderNumber: order.order_number,
    shopName: order.shop_name,
    skus: order.line_items.edges.map((e: any) => e.node.sku),
    warehouseId: order.allocations?.[0]?.warehouse_id,
    tags: order.tags || [],
  };
}

/**
 * Change the warehouse assignment for an order in ShipHero.
 *
 * Mutation input type is `ChangeOrderWarehouseInput` (not `OrderChangeWarehouseInput`).
 * Required fields: order_id, warehouse_id. customer_account_id is optional on
 * single-account tokens.
 */
export async function changeOrderWarehouse(
  orderId: string,
  newWarehouseId: string
): Promise<any> {
  const mutation = `
    mutation($data: ChangeOrderWarehouseInput!) {
      order_change_warehouse(data: $data) {
        request_id
        complexity
        order {
          id
          order_number
        }
      }
    }
  `;

  const data = await gql(mutation, {
    data: {
      order_id: orderId,
      warehouse_id: newWarehouseId,
    },
  });

  return data.order_change_warehouse;
}

/**
 * Put an order on operator_hold so the warehouse never picks it.
 * Used for FBT (Fulfilled-by-TikTok) orders that TikTok ships from their
 * own warehouse — picking them on our side would cause double-shipping.
 */
async function applyOperatorHold(orderId: string): Promise<void> {
  const mutation = `
    mutation($data: UpdateOrderHoldsInput!) {
      order_update_holds(data: $data) {
        request_id
        order { id holds { operator_hold } }
      }
    }
  `;
  await gql(mutation, {
    data: { order_id: orderId, operator_hold: true },
  });
}

/**
 * Main routing function: determines and executes warehouse routing for a TikTok order
 */
export async function routeTikTokOrder(orderId: string): Promise<RoutingDecision> {
  // 1. Get order details
  const order = await getOrderDetails(orderId);

  // 2. Only route TikTok orders. The custom bridge sets shop_name='TikTok Shop',
  // but the native ShipHero TikTok integration sets shop_name='Clean Nutra' and
  // adds tags like 'tiktok_delivery_option_name-...' or 'fulfilled_by_tiktok'.
  // We need to recognize both.
  const shop = order.shopName.toLowerCase();
  const tags = (order.tags || []).map((t) => t.toLowerCase());
  const isTikTokOrder =
    shop.includes('tiktok') ||
    tags.some((t) => t.startsWith('tiktok_') || t === 'tiktok' || t === 'fulfilled_by_tiktok');

  if (!isTikTokOrder) {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      skus: order.skus,
      targetWarehouse: 'clearship',
      targetWarehouseId: 'default',
      reason: `Not a TikTok order (shop: ${order.shopName}, tags: ${(order.tags || []).join(',')}), skipping`,
    };
  }

  // 3. Get active routing patterns
  const patterns = await getLasVegasSkuPatterns();

  // 4. Match SKUs
  const match = matchSkuToWarehouse(order.skus, patterns);

  // 5. Only change warehouse if it's a Las Vegas SKU match
  // Non-matching orders stay wherever ShipHero defaults them (ClearShip)
  if (match.warehouse === 'las_vegas') {
    if (order.warehouseId !== WAREHOUSES.LAS_VEGAS) {
      await changeOrderWarehouse(orderId, WAREHOUSES.LAS_VEGAS);
    }
  }

  // 5b. Auto-hold FBT (Fulfilled-by-TikTok) orders so the warehouse never picks
  // them. TikTok ships these from their own warehouse, so any pick on our side
  // would be a duplicate ship. We use operator_hold (NOT cancel) because cancel
  // could push back to TikTok and cancel the customer's actual order.
  const isFbt = tags.some((t) => t === 'fulfilled_by_tiktok');
  let fbtHeld = false;
  if (isFbt) {
    try {
      await applyOperatorHold(orderId);
      fbtHeld = true;
    } catch (err) {
      console.error(`[route-order] Failed to operator_hold FBT order ${order.orderNumber}:`, err);
    }
  }

  const decision: RoutingDecision = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    skus: order.skus,
    targetWarehouse: match.warehouse,
    targetWarehouseId: match.warehouse === 'las_vegas' ? WAREHOUSES.LAS_VEGAS : 'default',
    reason: fbtHeld
      ? `FBT order auto-held (operator_hold). ${match.matchedPattern ? `SKU matched "${match.matchedPattern}"` : 'No LV SKU match'}.`
      : match.matchedPattern
      ? `SKU matched pattern "${match.matchedPattern}" → Las Vegas`
      : 'No Las Vegas SKU match → left at default warehouse',
    matchedPattern: match.matchedPattern,
  };

  // 6. Log the routing decision to Supabase
  await logRoutingDecision(decision);

  return decision;
}

/**
 * Log routing decisions to Supabase for audit trail
 */
async function logRoutingDecision(decision: RoutingDecision): Promise<void> {
  try {
    await supabase.from('tiktok_routing_log').insert({
      order_id: decision.orderId,
      order_number: decision.orderNumber,
      skus: decision.skus,
      target_warehouse: decision.targetWarehouse,
      reason: decision.reason,
      matched_pattern: decision.matchedPattern || null,
      routed_at: new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal: don't fail the routing if logging fails
    console.error('Failed to log routing decision:', err);
  }
}
