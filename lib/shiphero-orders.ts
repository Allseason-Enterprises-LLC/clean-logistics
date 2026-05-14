import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ShipHeroCredentials, ShipHeroOrderCreateResult, ShipHeroTransferOrderInput } from './cin7-transfer-types';

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
 * Create a ShipHero Wholesale Order for FBA transfers.
 * Supports lot-aware FEFO picking from non-pickable locations.
 */
async function createWholesaleOrderViaGraphQL(credentials: ShipHeroCredentials, input: ShipHeroTransferOrderInput) {
  console.log(`[shiphero-orders] Creating WHOLESALE order for FBA transfer: ${input.orderNumber}`);

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

  // Build packing note with lot/expiration info
  const packingNote = input.notes || `FBA Transfer: ${input.orderNumber}`;

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
          order_number: input.orderNumber,
          partner_order_id: input.externalOrderId,
          customer_account_id: '95145',
          fulfillment_status: 'pending',
          shipping_option: 'FREIGHT',
          picking_flow: 'DESKTOP',
          packing_note: packingNote,
          skip_address_validation: true,
          ignore_address_validation_errors: true,
          shipping_address: input.shippingAddress,
          line_items: (input.partnerLineItems || []).map((item, idx) => ({
            sku: item.sku,
            quantity: item.quantity,
            price: '0.00',
            partner_line_item_id: `${input.orderNumber}-line-${idx + 1}`,
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
  const wholesaleId = order.wholesale_order?.id || orderId;

  // Auto-allocate picking with FEFO (First Expired, First Out) from non-pickable locations
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
    shipheroOrderNumber: order.order_number || order.legacy_id || input.orderNumber,
    responsePayload: json,
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
