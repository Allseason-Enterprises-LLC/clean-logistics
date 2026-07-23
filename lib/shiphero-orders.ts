import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ShipHeroCredentials, ShipHeroOrderCreateResult, ShipHeroTransferOrderInput } from './cin7-transfer-types';
import { getShipHeroProductData, getLotBreakdown } from './shiphero-product-data';
import { allocateFefoByLot, sanitizeLotName, type LotAllocation } from './lot-allocation';

const SHIPHERO_GRAPHQL_ENDPOINT = 'https://public-api.shiphero.com/graphql';

interface CreateShipHeroOrderParams {
  credentials: ShipHeroCredentials;
  warehouseName: string;
  input: ShipHeroTransferOrderInput;
  supabase?: SupabaseClient;
  /**
   * The CIN7 destination location name (e.g. "Amazon FBA Warehouse",
   * "Clean Nutra ASE Warehouse - Vegas"). This is the actual CIN7 ToLocation
   * value, NOT the ShipHero shipping address company.
   *
   * Required for accurate routing reports and historical lookups. When omitted,
   * the bridge row will fall back to the ShipHero shipping company name for
   * backwards compatibility (legacy behavior — emits a console warning).
   */
  cin7DestinationName?: string;
}

function getSupabaseClient(explicit?: SupabaseClient): SupabaseClient {
  if (explicit) return explicit;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to persist CIN7→ShipHero bridge records');
  }

  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function findExistingBridgeRecord(supabase: SupabaseClient, externalOrderId: string) {
  const cin7TransferId = externalOrderId.replace(/^cin7-transfer:/, '');

  const { data, error } = await supabase
    .from('cin7_transfer_shiphero_orders')
    .select('id, cin7_transfer_id, cin7_transfer_number, shiphero_order_id, shiphero_order_number, status, cin7_destination')
    .eq('cin7_transfer_id', cin7TransferId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to query cin7_transfer_shiphero_orders: ${error.message}`);
  }

  return data;
}

async function upsertBridgeRecord(
  supabase: SupabaseClient,
  payload: {
    cin7TransferId: string;
    cin7TransferNumber: string;
    cin7Destination: string;
    cin7Source?: string | null;
    warehouseId?: string | null;
    warehouseExternalId?: string | null;
    status: string;
    requestPayload: any;
    responsePayload?: any;
    shipheroOrderId?: string | null;
    shipheroOrderNumber?: string | null;
    errorMessage?: string | null;
  }
) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('cin7_transfer_shiphero_orders').upsert(
    {
      cin7_transfer_id: payload.cin7TransferId,
      cin7_transfer_number: payload.cin7TransferNumber,
      cin7_destination: payload.cin7Destination,
      cin7_source: payload.cin7Source || null,
      warehouse_id: payload.warehouseId || null,
      warehouse_provider: 'shiphero',
      warehouse_external_id: payload.warehouseExternalId || null,
      shiphero_order_id: payload.shipheroOrderId || null,
      shiphero_order_number: payload.shipheroOrderNumber || null,
      status: payload.status,
      sync_attempts: 1,
      last_attempt_at: now,
      synced_at: payload.status === 'synced' ? now : null,
      request_payload: payload.requestPayload || {},
      response_payload: payload.responsePayload || {},
      payload_snapshot: payload.requestPayload?.rawTransfer || payload.requestPayload || {},
      error_message: payload.errorMessage || null,
      last_error_at: payload.errorMessage ? now : null,
    },
    { onConflict: 'cin7_transfer_id,cin7_destination', ignoreDuplicates: false }
  );

  if (error) {
    throw new Error(`Failed to upsert cin7_transfer_shiphero_orders: ${error.message}`);
  }
}

async function createOrderViaGraphQL(credentials: ShipHeroCredentials, input: ShipHeroTransferOrderInput) {
  // Determine if this is an FBA transfer (use wholesale order) or regular transfer
  const isFbaTransfer = input.tags?.includes('FBA') ||
    input.shippingAddress?.company?.toLowerCase().includes('amazon') ||
    input.shippingAddress?.company?.toLowerCase().includes('fba') ||
    input.orderNumber?.toLowerCase().includes('fba');

  if (isFbaTransfer) {
    return createWholesaleOrderViaGraphQL(credentials, input);
  }

  const mutation = `
    mutation CreateOrder($data: CreateOrderInput!) {
      order_create(data: $data) {
        request_id
        order {
          id
          order_number
          legacy_id
        }
      }
    }
  `;

  const response = await fetch(SHIPHERO_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.accessToken}`,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        data: {
          order_number: input.orderNumber,
          partner_order_id: input.externalOrderId,
          shop_name: 'Clean Nutra',
          profile: 'default',
          fulfillment_status: 'pending',
          customer_account_id: '95145',
          line_items: (input.partnerLineItems || []).map((item, idx) => ({
            sku: item.sku,
            quantity: item.quantity,
            price: '0.00',
            partner_line_item_id: `${input.orderNumber}-line-${idx + 1}`,
          })),
          shipping_address: input.shippingAddress,
          shipping_lines: {
            title: 'Internal Transfer',
            carrier: 'Internal',
            method: 'Warehouse Transfer',
            price: '0.00',
          },
          tags: input.tags || [],

        },
      },
    }),
  });

  const json: any = await response.json().catch(() => null);

  if (!response.ok) {
    const details = json ? JSON.stringify(json) : await response.text().catch(() => '');
    throw new Error(`ShipHero order_create failed: ${response.status} - ${details}`);
  }

  if (json?.errors?.length) {
    throw new Error(`ShipHero GraphQL errors: ${json.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ')}`);
  }

  const order = json?.data?.order_create?.order;
  if (!order?.id) {
    throw new Error(`ShipHero order_create returned no order id: ${JSON.stringify(json)}`);
  }

  return {
    shipheroOrderId: String(order.id),
    shipheroOrderNumber: order.order_number || order.legacy_id || input.orderNumber,
    responsePayload: json,
  };
}

/**
 * Create ONE ShipHero wholesale order (create + FEFO auto-allocate).
 * Extracted so the lot-split fan-out can create N of these per transfer.
 */
async function createOneWholesaleOrder(
  credentials: ShipHeroCredentials,
  input: ShipHeroTransferOrderInput,
  overrides?: {
    orderNumber?: string;
    partnerOrderId?: string;
    packingNote?: string;
    lineItems?: Array<{ sku: string; quantity: number }>;
  }
) {
  const orderNumber = overrides?.orderNumber || input.orderNumber;
  const partnerOrderId = overrides?.partnerOrderId || input.externalOrderId;
  const packingNote = overrides?.packingNote || input.notes || `FBA Transfer: ${input.orderNumber}`;
  const lineItems = overrides?.lineItems || (input.partnerLineItems || []);

  const createMutation = `
    mutation WholesaleOrderCreate($data: CreateWholesaleOrderInput!) {
      wholesale_order_create(data: $data) {
        request_id
        order {
          id
          order_number
          legacy_id
          wholesale_order {
            id
          }
        }
      }
    }
  `;

  const response = await fetch(SHIPHERO_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.accessToken}`,
    },
    body: JSON.stringify({
      query: createMutation,
      variables: {
        data: {
          order_number: orderNumber,
          partner_order_id: partnerOrderId,
          customer_account_id: '95145',
          fulfillment_status: 'pending',
          shipping_option: 'FREIGHT',
          picking_flow: 'DESKTOP',
          packing_note: packingNote,
          skip_address_validation: true,
          ignore_address_validation_errors: true,
          shipping_address: input.shippingAddress,
          line_items: lineItems.map((item, idx) => ({
            sku: item.sku,
            quantity: item.quantity,
            price: '0.00',
            partner_line_item_id: `${orderNumber}-line-${idx + 1}`,
            warehouse_id: 'V2FyZWhvdXNlOjEzNTg3Mg==',
          })),
          tags: [...(input.tags || []), 'FBA', 'Wholesale'],
        },
      },
    }),
  });

  const json: any = await response.json().catch(() => null);

  if (!response.ok) {
    const details = json ? JSON.stringify(json) : await response.text().catch(() => '');
    throw new Error(`ShipHero wholesale_order_create failed: ${response.status} - ${details}`);
  }

  if (json?.errors?.length) {
    throw new Error(`ShipHero GraphQL errors: ${json.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ')}`);
  }

  const order = json?.data?.wholesale_order_create?.order;
  if (!order?.id) {
    throw new Error(`ShipHero wholesale_order_create returned no order id: ${JSON.stringify(json)}`);
  }

  const orderId = String(order.id);

  // Auto-allocate picking with FEFO (First Expired, First Out) from non-pickable locations.
  // Done immediately after create — for lot-split children this sequential
  // create→allocate ordering is what steers each child order onto its intended
  // lot (ShipHero's FEFO allocator consumes the earliest lot first).
  console.log(`[shiphero-orders] Auto-allocating wholesale order ${orderId} with FEFO...`);
  try {
    const allocateMutation = `
      mutation WholesaleAutoAllocate($data: WholesaleOrderAutoAllocateInput!) {
        wholesale_order_auto_allocate_for_picking(data: $data) {
          request_id
          complexity
        }
      }
    `;

    const allocateResponse = await fetch(SHIPHERO_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.accessToken}`,
      },
      body: JSON.stringify({
        query: allocateMutation,
        variables: {
          data: {
            order_id: orderId,
            sort_lots: 'EXPIRATION_FEFO',
            location_type: 'NON_PICKABLE',
          },
        },
      }),
    });

    const allocateJson: any = await allocateResponse.json().catch(() => null);
    if (allocateJson?.errors?.length) {
      console.warn(`[shiphero-orders] FEFO auto-allocate warning (non-fatal): ${JSON.stringify(allocateJson.errors)}`);
    } else {
      console.log(`[shiphero-orders] FEFO auto-allocate successful for ${orderId}`);
    }
  } catch (allocateErr) {
    console.warn(`[shiphero-orders] FEFO auto-allocate failed (non-fatal):`, allocateErr);
  }

  return {
    shipheroOrderId: orderId,
    shipheroOrderNumber: order.order_number || order.legacy_id || orderNumber,
    responsePayload: json,
  };
}

/**
 * Compute the per-lot allocation plan for a transfer's line items.
 * Returns null when the transfer should use the LEGACY single-order path:
 * kits, missing case pack, no lot-tracked stock, or insufficient lot capacity.
 */
async function computeLotSplitPlan(
  accessToken: string,
  input: ShipHeroTransferOrderInput,
): Promise<Array<{ sku: string; lot: LotAllocation }> | null> {
  const plan: Array<{ sku: string; lot: LotAllocation }> = [];

  for (const item of input.partnerLineItems || []) {
    let productData;
    try {
      productData = await getShipHeroProductData(accessToken, item.sku);
    } catch (err: any) {
      console.warn(`[lot-split] product data fetch failed for ${item.sku} — legacy path: ${err?.message}`);
      return null;
    }

    if (productData.isKit) {
      console.log(`[lot-split] ${item.sku} is a kit — using legacy single-shipment path`);
      return null;
    }
    if (!productData.casePack?.caseQuantity) {
      console.log(`[lot-split] ${item.sku} has no case pack data — using legacy single-shipment path`);
      return null;
    }

    let lots;
    try {
      lots = await getLotBreakdown(accessToken, item.sku);
    } catch (err: any) {
      console.warn(`[lot-split] lot breakdown failed for ${item.sku} — legacy path: ${err?.message}`);
      return null;
    }
    if (!lots.length) {
      console.log(`[lot-split] ${item.sku} has no lot-tracked stock — using legacy single-shipment path`);
      return null;
    }

    let allocations: LotAllocation[];
    try {
      allocations = allocateFefoByLot(lots, item.quantity, productData.casePack.caseQuantity);
    } catch (err: any) {
      // Stock math shouldn't block the bridge — auto-submit does its own gate.
      console.warn(`[lot-split] allocation failed for ${item.sku} — legacy path: ${err?.message}`);
      return null;
    }

    for (const lot of allocations) {
      plan.push({ sku: item.sku, lot });
    }
  }

  return plan.length ? plan : null;
}

/**
 * Create ShipHero Wholesale Order(s) for FBA transfers.
 * Supports lot-aware FEFO picking from non-pickable locations.
 *
 * LOT SPLIT (2026-07-22): non-kit SKUs with lot-tracked stock fan out into
 * ONE wholesale order PER LOT (FEFO order, full-case multiples) so each
 * physical shipment contains a single lot. Kits / missing case pack /
 * insufficient lot data fall back to the legacy single-order behavior.
 */
async function createWholesaleOrderViaGraphQL(credentials: ShipHeroCredentials, input: ShipHeroTransferOrderInput) {
  console.log(`[shiphero-orders] Creating WHOLESALE order(s) for FBA transfer: ${input.orderNumber}`);

  const lotPlan = await computeLotSplitPlan(credentials.accessToken, input);

  if (!lotPlan) {
    // Legacy: one order for the whole transfer.
    return createOneWholesaleOrder(credentials, input);
  }

  console.log(
    `[lot-split] ${input.orderNumber}: splitting into ${lotPlan.length} order(s): ` +
      lotPlan.map((p) => `${p.sku}@${p.lot.name}=${p.lot.qty}`).join(', ')
  );

  // Create child orders SEQUENTIALLY in plan order (FEFO within each SKU) so
  // ShipHero's allocator consumes lot N before child N+1 allocates.
  const childOrders: Array<{
    orderId: string;
    orderNumber: string;
    sku: string;
    lot: string;
    expiresAt: string;
    qty: number;
    cases: number;
  }> = [];
  let firstResponsePayload: any = null;

  for (const { sku, lot } of lotPlan) {
    const lotSuffix = sanitizeLotName(lot.name);
    const childNumber = `${input.orderNumber}-${lotSuffix}`;
    const childPartnerId = `${input.externalOrderId}:${lotSuffix}`;
    const packingNote =
      `Lot ${lot.name} · Exp ${lot.expiresAt} · ${lot.qty} units (${lot.cases} cases) · SINGLE LOT — DO NOT MIX\n` +
      (input.notes || '');

    const result = await createOneWholesaleOrder(credentials, input, {
      orderNumber: childNumber,
      partnerOrderId: childPartnerId,
      packingNote,
      lineItems: [{ sku, quantity: lot.qty }],
    });

    if (!firstResponsePayload) firstResponsePayload = result.responsePayload;
    childOrders.push({
      orderId: result.shipheroOrderId,
      orderNumber: result.shipheroOrderNumber,
      sku,
      lot: lot.name,
      expiresAt: lot.expiresAt,
      qty: lot.qty,
      cases: lot.cases,
    });
    console.log(`[lot-split] Created child order ${result.shipheroOrderNumber} (${result.shipheroOrderId}) for lot ${lot.name}`);
  }

  // Return shape: first child (earliest lot) as the primary order, full list in payload.
  return {
    shipheroOrderId: childOrders[0].orderId,
    shipheroOrderNumber: childOrders[0].orderNumber,
    responsePayload: {
      lot_split: true,
      child_orders: childOrders,
      first_order_response: firstResponsePayload,
    },
  };
}

export async function createShipHeroOrderFromCIN7Transfer({
  credentials,
  warehouseName,
  input,
  supabase,
  cin7DestinationName,
}: CreateShipHeroOrderParams): Promise<ShipHeroOrderCreateResult & { status?: string; requestPayload?: any; responsePayload?: any; shipheroOrderId?: string | null; shipheroOrderNumber?: string | null; }> {
  if (!credentials?.accessToken) {
    throw new Error(`ShipHero access token missing for warehouse ${warehouseName}`);
  }

  const db = getSupabaseClient(supabase);
  const existing = await findExistingBridgeRecord(db, input.externalOrderId);
  if (existing?.shiphero_order_id) {
    return {
      created: false,
      existingOrderId: existing.shiphero_order_id,
      orderId: existing.shiphero_order_id,
      orderNumber: existing.shiphero_order_number || input.orderNumber,
      shipheroOrderId: existing.shiphero_order_id,
      shipheroOrderNumber: existing.shiphero_order_number,
      status: existing.status,
      requestPayload: input,
      responsePayload: existing,
    };
  }

  const cin7TransferId = input.externalOrderId.replace(/^cin7-transfer:/, '');
  const cin7TransferNumber = input.reference || input.orderNumber;
  // Prefer the real CIN7 ToLocation (e.g. "Amazon FBA Warehouse"). Fall back to
  // the ShipHero shipping company / warehouse name only when the caller didn't
  // pass one — older callers relied on that legacy behavior, but it produces
  // misleading reports because every ASE-origin transfer ends up labeled
  // "Allseason Enterprises LLC" regardless of where it actually went.
  const cin7Destination =
    cin7DestinationName || input.shippingAddress.company || warehouseName;
  if (!cin7DestinationName) {
    console.warn(
      `[shiphero-orders] createShipHeroOrderFromCIN7Transfer called without cin7DestinationName for transfer ${cin7TransferNumber}; ` +
        `falling back to "${cin7Destination}". Update the caller to pass transfer.destinationName for accurate routing labels.`
    );
  }
  const cin7Source = input.notes?.match(/Source: (.+)/)?.[1] || null;

  try {
    const created = await createOrderViaGraphQL(credentials, input);

    await upsertBridgeRecord(db, {
      cin7TransferId,
      cin7TransferNumber,
      cin7Destination,
      cin7Source,
      status: 'synced',
      requestPayload: input,
      responsePayload: created.responsePayload,
      shipheroOrderId: created.shipheroOrderId,
      shipheroOrderNumber: created.shipheroOrderNumber,
    });

    return {
      created: true,
      existingOrderId: null,
      orderId: created.shipheroOrderId,
      orderNumber: created.shipheroOrderNumber,
      shipheroOrderId: created.shipheroOrderId,
      shipheroOrderNumber: created.shipheroOrderNumber,
      status: 'synced',
      requestPayload: input,
      responsePayload: created.responsePayload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    await upsertBridgeRecord(db, {
      cin7TransferId,
      cin7TransferNumber,
      cin7Destination,
      cin7Source,
      status: 'failed',
      requestPayload: input,
      errorMessage: message,
      responsePayload: { error: message },
    });

    throw error;
  }
}
