/**
 * TikTok → ShipHero Bridge
 *
 * The core orchestration layer. Two entry points:
 *
 *   1. syncTikTokOrders()        — called by cron, pulls AWAITING_SHIPMENT orders
 *                                   from TikTok, filters by Clean Nutra SKU allowlist,
 *                                   creates matching orders in Clean Nutra ShipHero.
 *
 *   2. handleShipHeroShipment()   — called by webhook when ShipHero ships a tracked
 *                                   order, posts tracking back to TikTok.
 *
 * Idempotency: every insert into tiktok_shiphero_orders uses tiktok_order_id as
 * the unique key, so re-running the cron is always safe.
 *
 * Warehouse: all orders land in the Las Vegas Clean Nutra warehouse
 * (ShipHero ID V2FyZWhvdXNlOjEzNTg3Mg==).
 */

import { supabase } from './supabase';
import {
  getTikTokCredentials,
  searchOrders,
  getOrderDetail,
  declarePackage,
  shipPackage,
  getShippingProviders,
  type TikTokCredentials,
} from './tiktok-api';
import { getLasVegasSkuPatterns, matchSkuToWarehouse } from './tiktok-routing';
import { normalizeCarrier, resolveProviderId } from './tiktok-carriers';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_WAREHOUSE = 'V2FyZWhvdXNlOjEzNTg3Mg==';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const CLEAN_NUTRA_CUSTOMER_ACCOUNT = '95145';

/**
 * Build a ShipHero partner_line_item_id that fits the 45-char limit.
 * Format: TT-{last12 of orderId}-{sku[..20]}-{idx}
 * Must be deterministic + unique within an order.
 */
function buildShortLineItemId(orderId: string, sku: string, idx: number): string {
  const shortOrder = String(orderId).slice(-12);
  const shortSku = String(sku).replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const candidate = `TT-${shortOrder}-${shortSku}-${idx}`;
  return candidate.slice(0, 45);
}

// ============================================================================
// ShipHero GQL helpers (scoped to Clean Nutra token)
// ============================================================================

async function getCleanNutraShipHeroToken(): Promise<string> {
  if (process.env.SHIPHERO_ACCESS_TOKEN) return process.env.SHIPHERO_ACCESS_TOKEN;

  const { data, error } = await supabase
    .from('warehouses')
    .select('id, api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID)
    .eq('provider', 'shiphero')
    .single();

  if (error) throw new Error(`Failed to fetch Clean Nutra ShipHero creds: ${error.message}`);
  const token = (data?.api_credentials as any)?.accessToken;
  if (!token) throw new Error('No accessToken on Clean Nutra warehouses row');
  return token;
}

async function shGql<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const token = await getCleanNutraShipHeroToken();
  const resp = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await resp.json();
  if (json.errors) {
    throw new Error(`ShipHero GQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

// ============================================================================
// Sync: TikTok → ShipHero
// ============================================================================

export interface SyncResult {
  scanned: number;
  imported: number;
  skipped_already_present: number;
  skipped_no_match: number;
  errors: Array<{ tiktokOrderId: string; message: string }>;
}

/**
 * Poll TikTok for recent AWAITING_SHIPMENT orders and import matching ones into ShipHero.
 *
 * @param lookbackMinutes  Minutes of order-update history to scan (default: 15)
 */
export async function syncTikTokOrders(lookbackMinutes = 15): Promise<SyncResult> {
  const result: SyncResult = {
    scanned: 0,
    imported: 0,
    skipped_already_present: 0,
    skipped_no_match: 0,
    errors: [],
  };

  const creds = await getTikTokCredentials();
  const patterns = await getLasVegasSkuPatterns();

  const updateTimeGe = Math.floor(Date.now() / 1000) - lookbackMinutes * 60;

  console.log(
    `[tiktok-bridge] Polling TikTok orders updated since ${new Date(updateTimeGe * 1000).toISOString()}`
  );

  const summaries = await searchOrders(creds, {
    updateTimeGe,
    orderStatus: 'AWAITING_SHIPMENT',
    maxPages: 5,
  });

  result.scanned = summaries.length;
  console.log(`[tiktok-bridge] Found ${summaries.length} AWAITING_SHIPMENT orders`);

  if (summaries.length === 0) return result;

  // Filter out orders we've already imported (idempotency check)
  const candidateIds = summaries.map((o) => o.id);
  const { data: existing } = await supabase
    .from('tiktok_shiphero_orders')
    .select('tiktok_order_id')
    .in('tiktok_order_id', candidateIds);

  const existingSet = new Set((existing || []).map((r: any) => r.tiktok_order_id));
  const fresh = summaries.filter((o) => !existingSet.has(o.id));
  result.skipped_already_present = summaries.length - fresh.length;

  if (fresh.length === 0) {
    console.log('[tiktok-bridge] All orders already imported, nothing to do');
    return result;
  }

  // Fetch full details for fresh orders (line items, addresses, quantities).
  // TikTok limits /orders detail calls to 50 ids per request.
  const details: any[] = [];
  const freshIds = fresh.map((o) => o.id);
  for (let i = 0; i < freshIds.length; i += 50) {
    const chunk = freshIds.slice(i, i + 50);
    const batch = await getOrderDetail(creds, chunk);
    details.push(...batch);
  }
  const detailById = new Map(details.map((d: any) => [d.id, d]));

  for (const summary of fresh) {
    const detail = detailById.get(summary.id) || summary;
    try {
      const outcome = await importOrder(creds, detail, patterns);
      if (outcome === 'imported') result.imported++;
      else if (outcome === 'skipped_no_match') result.skipped_no_match++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tiktok-bridge] Failed to import ${summary.id}:`, msg);
      result.errors.push({ tiktokOrderId: summary.id, message: msg });

      // Persist failure so we can retry / investigate
      await supabase
        .from('tiktok_shiphero_orders')
        .upsert(
          {
            tiktok_order_id: summary.id,
            status: 'error',
            error_message: msg,
          },
          { onConflict: 'tiktok_order_id' }
        );
    }
  }

  return result;
}

/**
 * Import a single TikTok order into ShipHero if any line item matches our SKU allowlist.
 * Returns 'imported' | 'skipped_no_match'.
 */
async function importOrder(
  _creds: TikTokCredentials,
  detail: any,
  patterns: string[]
): Promise<'imported' | 'skipped_no_match'> {
  const lineItems = detail.line_items || detail.order_line_list || [];
  const skus: string[] = lineItems
    .map((li: any) => li.seller_sku || li.sku_id || li.sku || '')
    .filter(Boolean);

  if (skus.length === 0) {
    await logSkipped(detail, [], 'no SKUs on order');
    return 'skipped_no_match';
  }

  const match = matchSkuToWarehouse(skus, patterns);
  if (match.warehouse !== 'las_vegas') {
    await logSkipped(detail, skus, 'no Clean Nutra SKU match');
    return 'skipped_no_match';
  }

  // Skip Fulfillment-by-TikTok (FBT) orders — TikTok ships those from their own
  // warehouse. If we pull them into Clean Nutra LV we'd double-ship, and the
  // recipient PII is masked by TikTok anyway ("72* ***** ***** *** *** **").
  // Only FULFILLMENT_BY_SELLER orders are ours to ship.
  const fulfillmentType = detail.fulfillment_type || detail.shipping_type;
  const isFbt =
    fulfillmentType === 'FULFILLMENT_BY_TIKTOK' ||
    fulfillmentType === 'TIKTOK' ||
    String(detail.delivery_option_name || '').toLowerCase().includes('fulfilled by tiktok');
  if (isFbt) {
    console.log(
      `[tiktok-bridge] Skipping FBT order ${detail.id} (fulfillment_type=${detail.fulfillment_type}, shipping_type=${detail.shipping_type})`
    );
    await logSkipped(detail, skus, `Fulfilled by TikTok (fulfillment_type=${detail.fulfillment_type || detail.shipping_type}) — not ours to ship`);
    return 'skipped_no_match';
  }

  console.log(
    `[tiktok-bridge] Importing TikTok order ${detail.id} → ShipHero (matched "${match.matchedPattern}")`
  );

  // Aggregate quantities per seller_sku (TikTok sends one line per unit for multi-qty)
  const qtyBySku = new Map<string, { qty: number; name: string; price: string; ids: string[] }>();
  for (const li of lineItems) {
    const sku = li.seller_sku || li.sku_id || li.sku;
    if (!sku) continue;
    const name = li.product_name || li.sku_name || sku;
    const price = li.sale_price?.amount || li.sale_price || li.original_price?.amount || '0.00';
    const lineId = li.id || li.order_line_item_id;
    const existing = qtyBySku.get(sku);
    if (existing) {
      existing.qty += 1;
      if (lineId) existing.ids.push(lineId);
    } else {
      qtyBySku.set(sku, {
        qty: 1,
        name,
        price: String(price),
        ids: lineId ? [lineId] : [],
      });
    }
  }

  const shipheroLineItems = Array.from(qtyBySku.entries()).map(([sku, info], idx) => ({
    sku,
    // partner_line_item_id must be <= 45 chars.
    // Use a short deterministic id: last 12 of order id + last 8 of sku + idx.
    partner_line_item_id: buildShortLineItemId(detail.order_id || detail.id, sku, idx),
    quantity: info.qty,
    price: info.price || '0.00',
    product_name: info.name,
    warehouse_id: CLEAN_NUTRA_LV_WAREHOUSE,
  }));

  const address = detail.recipient_address || detail.shipping_address || {};

  // TikTok 202309 US orders return geography in district_info[] rather than
  // flat city/state strings. Parse the array first, fall back to flat fields.
  //
  // district_info levels:
  //   L0 = Country, L1 = State, L2 = County, L3 = City
  //
  // Some orders return flat fields (city, state) — keep those as fallback.
  function extractFromDistrictInfo(di: any[], level: string): string {
    if (!Array.isArray(di)) return '';
    const entry = di.find((x: any) => x.address_level === level);
    return entry?.iso_code || entry?.address_name || '';
  }
  const di = address.district_info || [];
  const cityFromDi  = extractFromDistrictInfo(di, 'L3');
  const stateFromDi = extractFromDistrictInfo(di, 'L1'); // iso_code = 'FL', 'CA', etc.

  const fullName = address.full_name || address.name || '';
  // TikTok sometimes provides first_name/last_name separately
  const resolvedFirstName = address.first_name || fullName.split(' ')[0] || 'TikTok';
  const resolvedLastName  = address.last_name  || fullName.split(' ').slice(1).join(' ') || 'Customer';

  const shipheroOrder = await createShipHeroOrder({
    orderNumber: `TT-${detail.order_id || detail.id}`,
    partnerOrderId: detail.order_id || detail.id,
    customerAccountId: CLEAN_NUTRA_CUSTOMER_ACCOUNT,
    warehouseId: CLEAN_NUTRA_LV_WAREHOUSE,
    lineItems: shipheroLineItems,
    shippingAddress: {
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      address1: address.address_line1 || address.address_detail || '',
      address2: address.address_line2 || address.address_line3 || '',
      city:  cityFromDi  || address.city  || '',
      state: stateFromDi || address.state || address.province || '',
      zip:   address.postal_code || address.zip_code || address.zipcode || '',
      country: address.region_code || address.region || address.country_code || 'US',
      phone: address.phone_number || address.phone || '',
      email: detail.buyer_email || address.email || '',
    },
    shopName: 'TikTok Shop',
  });

  // Store the import record, remembering which line ids belong to which sku
  // (needed when we later POST tracking back to TikTok).
  const skusJson = Array.from(qtyBySku.entries()).map(([sku, info]) => ({
    sku,
    qty: info.qty,
    tiktok_line_item_ids: info.ids,
    matched_pattern: patterns.find((p) => sku.toUpperCase().includes(p.toUpperCase())) || null,
  }));

  await supabase.from('tiktok_shiphero_orders').upsert(
    {
      tiktok_order_id: detail.order_id || detail.id,
      tiktok_order_number: detail.order_id || detail.id,
      tiktok_shop_id: detail.shop_id || null,
      shiphero_order_id: shipheroOrder.id,
      shiphero_order_number: shipheroOrder.order_number,
      skus: skusJson,
      matched_patterns: match.matchedPattern ? [match.matchedPattern] : [],
      status: 'imported',
    },
    { onConflict: 'tiktok_order_id' }
  );

  return 'imported';
}

async function logSkipped(detail: any, skus: string[], reason: string) {
  const tiktokOrderId = detail.order_id || detail.id;
  console.log(`[tiktok-bridge] Skipping ${tiktokOrderId}: ${reason} (skus=${skus.join(',')})`);
  await supabase.from('tiktok_shiphero_orders').upsert(
    {
      tiktok_order_id: tiktokOrderId,
      tiktok_order_number: tiktokOrderId,
      skus: skus.map((sku) => ({ sku, matched_pattern: null })),
      status: 'skipped',
      error_message: reason,
    },
    { onConflict: 'tiktok_order_id' }
  );
}

// ============================================================================
// ShipHero order create
// ============================================================================

interface CreateShipHeroOrderInput {
  orderNumber: string;
  partnerOrderId: string;
  customerAccountId: string;
  warehouseId: string;
  lineItems: Array<{
    sku: string;
    partner_line_item_id: string;
    quantity: number;
    price: string;
    product_name: string;
    warehouse_id: string;
  }>;
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone?: string;
    email?: string;
  };
  shopName: string;
}

async function createShipHeroOrder(
  input: CreateShipHeroOrderInput
): Promise<{ id: string; order_number: string }> {
  const mutation = `
    mutation order_create($data: CreateOrderInput!) {
      order_create(data: $data) {
        request_id
        complexity
        order {
          id
          order_number
        }
      }
    }
  `;

  const data = await shGql<any>(mutation, {
    data: {
      order_number: input.orderNumber,
      partner_order_id: input.partnerOrderId,
      customer_account_id: input.customerAccountId,
      shop_name: input.shopName,
      fulfillment_status: 'pending',
      order_date: new Date().toISOString(),
      total_tax: '0.00',
      subtotal: input.lineItems
        .reduce((s, li) => s + parseFloat(li.price || '0') * li.quantity, 0)
        .toFixed(2),
      total_discounts: '0.00',
      total_price: input.lineItems
        .reduce((s, li) => s + parseFloat(li.price || '0') * li.quantity, 0)
        .toFixed(2),
      shipping_lines: { title: 'Standard', price: '0.00', carrier: '', method: '' },
      shipping_address: {
        first_name: input.shippingAddress.firstName,
        last_name: input.shippingAddress.lastName,
        address1: input.shippingAddress.address1,
        address2: input.shippingAddress.address2 || '',
        city: input.shippingAddress.city,
        state: input.shippingAddress.state,
        state_code: input.shippingAddress.state,
        zip: input.shippingAddress.zip,
        country: input.shippingAddress.country,
        country_code: input.shippingAddress.country,
        phone: input.shippingAddress.phone || '',
        email: input.shippingAddress.email || '',
      },
      billing_address: {
        first_name: input.shippingAddress.firstName,
        last_name: input.shippingAddress.lastName,
        address1: input.shippingAddress.address1,
        address2: input.shippingAddress.address2 || '',
        city: input.shippingAddress.city,
        state: input.shippingAddress.state,
        state_code: input.shippingAddress.state,
        zip: input.shippingAddress.zip,
        country: input.shippingAddress.country,
        country_code: input.shippingAddress.country,
        phone: input.shippingAddress.phone || '',
        email: input.shippingAddress.email || '',
      },
      line_items: input.lineItems,
      required_ship_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      skip_address_validation: true,
      ignore_address_validation_errors: true,
    },
  });

  return data.order_create.order;
}

// ============================================================================
// Shipment: ShipHero webhook → TikTok
// ============================================================================

export interface ShipHeroShipmentPayload {
  // ShipHero's shipment_update webhook delivers a variable shape. We extract what
  // we need defensively. Common fields:
  order_id?: string;
  order_number?: string;
  tracking_number?: string;
  carrier?: string;
  shipment?: {
    id?: string;
    order_id?: string;
    order_number?: string;
    tracking_number?: string;
    carrier?: string;
  };
}

/**
 * Handle ShipHero's shipment_update webhook: look up the bridge row,
 * post tracking back to TikTok.
 */
export async function handleShipHeroShipment(
  payload: ShipHeroShipmentPayload
): Promise<{ status: 'ok' | 'skipped'; reason?: string }> {
  const trackingNumber =
    payload.tracking_number || payload.shipment?.tracking_number;
  const carrier = payload.carrier || payload.shipment?.carrier;
  const shipheroOrderId = payload.order_id || payload.shipment?.order_id;
  const shipheroOrderNumber = payload.order_number || payload.shipment?.order_number;

  if (!trackingNumber) {
    return { status: 'skipped', reason: 'no tracking_number in payload' };
  }

  // Look up the bridge row by ShipHero order id OR order number
  let query = supabase
    .from('tiktok_shiphero_orders')
    .select('*')
    .eq('status', 'imported')
    .limit(1);

  if (shipheroOrderId) {
    query = query.eq('shiphero_order_id', shipheroOrderId);
  } else if (shipheroOrderNumber) {
    query = query.eq('shiphero_order_number', shipheroOrderNumber);
  } else {
    return { status: 'skipped', reason: 'no ShipHero order id or number in payload' };
  }

  const { data: row, error } = await query.single();

  if (error || !row) {
    return {
      status: 'skipped',
      reason: `no matching tiktok_shiphero_orders row for ShipHero ${shipheroOrderId || shipheroOrderNumber} (probably not a TikTok order)`,
    };
  }

  console.log(
    `[tiktok-bridge] Shipment received for TikTok order ${row.tiktok_order_id}, tracking=${trackingNumber}, carrier=${carrier}`
  );

  // Mark as shipped first (so retries don't double-post)
  await supabase
    .from('tiktok_shiphero_orders')
    .update({
      carrier: carrier || null,
      tracking_number: trackingNumber,
      shipped_at: new Date().toISOString(),
      status: 'shipped',
    })
    .eq('id', row.id);

  // Post back to TikTok
  try {
    await postTrackingToTikTok(row, trackingNumber, carrier || '');
    await supabase
      .from('tiktok_shiphero_orders')
      .update({
        tracking_posted_at: new Date().toISOString(),
        status: 'tracking_confirmed',
      })
      .eq('id', row.id);
    console.log(`[tiktok-bridge] Tracking posted to TikTok for ${row.tiktok_order_id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tiktok-bridge] TikTok tracking post-back failed for ${row.tiktok_order_id}:`, msg);
    await supabase
      .from('tiktok_shiphero_orders')
      .update({
        status: 'error',
        error_message: `tracking post-back failed: ${msg}`,
        retry_count: (row.retry_count || 0) + 1,
      })
      .eq('id', row.id);
    throw err;
  }

  return { status: 'ok' };
}

async function postTrackingToTikTok(
  row: any,
  trackingNumber: string,
  carrier: string
): Promise<void> {
  const creds = await getTikTokCredentials();

  // Gather all line item ids from the bridge row snapshot
  const skusJson: Array<{ tiktok_line_item_ids?: string[] }> = row.skus || [];
  const lineItemIds = skusJson.flatMap((s) => s.tiktok_line_item_ids || []);

  if (lineItemIds.length === 0) {
    throw new Error('no tiktok_line_item_ids stored on bridge row — cannot declare package');
  }

  // 1. Declare package
  const pkg = await declarePackage(creds, row.tiktok_order_id, lineItemIds);

  // 2. Resolve carrier → TikTok provider id
  const canonical = normalizeCarrier(carrier);
  const providers = await getShippingProviders(creds);
  const providerId = resolveProviderId(canonical, providers);

  if (!providerId) {
    throw new Error(
      `could not resolve TikTok provider id for carrier "${carrier}" (canonical=${canonical})`
    );
  }

  // 3. Ship the package
  await shipPackage(creds, pkg.package_id, trackingNumber, providerId);
}
