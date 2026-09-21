import { supabase } from './supabase';
import { extractTransferNumber } from './order-naming';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

async function getShipHeroToken(): Promise<string> {
  const { data, error } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', process.env.SHIPHERO_WAREHOUSE_ID!)
    .eq('provider', 'shiphero')
    .single();

  if (error) throw new Error(`Failed to get ShipHero token: ${error.message}`);
  const creds = data?.api_credentials as any;
  if (!creds?.accessToken) throw new Error('No ShipHero access token in api_credentials');
  return creds.accessToken;
}

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

export interface WholesaleOrderInput {
  orderNumber: string;
  items: Array<{
    sku: string;
    quantity: number;
    productName?: string;
    price?: string;
  }>;
  packingNote?: string;
  shippingAddress: {
    firstName: string;
    lastName: string;
    company?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
    phone?: string;
  };
  customerAccountId?: string;
  warehouseId?: string;
}

export interface WholesaleOrderResult {
  orderId: string;
  orderNumber: string;
  wholesaleOrderId: string;
}

/**
 * Create a ShipHero Wholesale Order for FBA transfers.
 * Wholesale orders support lot-aware FEFO picking from non-pickable locations.
 */
export async function createWholesaleOrder(input: WholesaleOrderInput): Promise<WholesaleOrderResult> {
  const mutation = `
    mutation wholesale_order_create($data: CreateWholesaleOrderInput!) {
      wholesale_order_create(data: $data) {
        request_id
        complexity
        order {
          id
          order_number
          wholesale_order {
            id
          }
        }
      }
    }
  `;

  const lineItems = input.items.map((item, idx) => ({
    sku: item.sku,
    partner_line_item_id: `${input.orderNumber}-${item.sku}-${idx}`,
    quantity: item.quantity,
    price: item.price || '0.00',
    product_name: item.productName || item.sku,
    warehouse_id: input.warehouseId || 'V2FyZWhvdXNlOjEzNTg3Mg==',
  }));

  const data = await gql(mutation, {
    data: {
      order_number: input.orderNumber,
      partner_order_id: input.orderNumber,
      customer_account_id: input.customerAccountId || '95145', // Clean Nutra
      fulfillment_status: 'pending',
      shipping_option: 'FREIGHT',
      fulfillment_flow: 'WHOLESALE_PICKING',
      picking_flow: 'DESKTOP',
      packing_note: input.packingNote || '',
      shipping_address: {
        first_name: input.shippingAddress.firstName,
        last_name: input.shippingAddress.lastName,
        company: input.shippingAddress.company || 'Amazon FBA',
        address1: input.shippingAddress.address1,
        address2: input.shippingAddress.address2 || '',
        city: input.shippingAddress.city,
        state: input.shippingAddress.state,
        zip: input.shippingAddress.zip,
        country: input.shippingAddress.country || 'US',
        phone: input.shippingAddress.phone || '',
      },
      line_items: lineItems,
      skip_address_validation: true,
      ignore_address_validation_errors: true,
    },
  });

  const order = data.wholesale_order_create.order;
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    wholesaleOrderId: order.wholesale_order?.id || order.id,
  };
}

/**
 * Auto-allocate picking for a wholesale order using FEFO (First Expired, First Out).
 * Pulls from non-pickable locations where FBA stock lives.
 */
export async function autoAllocateWholesaleOrder(orderId: string): Promise<any> {
  const mutation = `
    mutation wholesale_order_auto_allocate_for_picking($data: WholesaleOrderAutoAllocateInput!) {
      wholesale_order_auto_allocate_for_picking(data: $data) {
        request_id
        complexity
      }
    }
  `;

  return gql(mutation, {
    data: {
      order_id: orderId,
      sort_lots: 'EXPIRATION_FEFO',
      location_type: 'NON_PICKABLE',
    },
  });
}

/**
 * Set wholesale order as ready to pick.
 */
export async function setReadyToPick(orderId: string): Promise<any> {
  const mutation = `
    mutation wholesale_set_as_ready_to_pick($data: WholesaleOrderSetReadyToPickInput!) {
      wholesale_set_as_ready_to_pick(data: $data) {
        request_id
        complexity
      }
    }
  `;

  return gql(mutation, {
    data: {
      order_id: orderId,
    },
  });
}

/**
 * Get expiration lot info for a SKU.
 */
export async function getExpirationLots(sku: string): Promise<Array<{ name: string; expiresAt: string; isActive: boolean }>> {
  const data = await gql(`
    query {
      expiration_lots(sku: "${sku}") {
        data(first: 20) {
          edges {
            node {
              name
              expires_at
              is_active
            }
          }
        }
      }
    }
  `);

  return data.expiration_lots.data.edges.map((e: any) => ({
    name: e.node.name,
    expiresAt: e.node.expires_at,
    isActive: e.node.is_active,
  }));
}

/**
 * Add an attachment to an order.
 * Uses ShipHero GraphQL mutation order_add_attachment.
 */
export async function addOrderAttachment(
  orderId: string, 
  url: string, 
  description: string
): Promise<void> {
  const mutation = `
    mutation order_add_attachment($data: OrderAddAttachmentInput!) {
      order_add_attachment(data: $data) {
        request_id
        complexity
        attachment {
          id
          url
          description
        }
      }
    }
  `;

  const data = await gql(mutation, {
    data: {
      order_id: orderId,
      url: url,
      description: description,
    },
  });

  console.log('[shiphero-wholesale] order_add_attachment result:', JSON.stringify(data));
}

/**
 * Update the packing note on an order.
 * Uses ShipHero GraphQL mutation order_update.
 */
export async function updateOrderPackingNote(
  orderId: string, 
  note: string
): Promise<void> {
  const mutation = `
    mutation order_update($data: OrderUpdateMutationInput!) {
      order_update(data: $data) {
        request_id
        complexity
        order {
          id
          order_number
          packing_note
        }
      }
    }
  `;

  const data = await gql(mutation, {
    data: {
      order_id: orderId,
      packing_note: note,
    },
  });

  console.log('[shiphero-wholesale] order_update (packing_note) result:', JSON.stringify(data));
}

/**
 * Find a ShipHero order by CIN7 task ID (partner_order_id) or by matching SKU in recent orders.
 * The CIN7→ShipHero bridge auto-creates orders with pattern CIN7-TR-XXXXX.
 */
export async function findOrderByPartnerIdOrRecent(
  cin7TaskId: string,
  sku: string
): Promise<{ orderId: string; orderNumber: string; wholesaleOrderId: string } | null> {
  // Try finding by partner_order_id first
  try {
    const data = await gql(`
      query {
        orders(partner_order_id: "${cin7TaskId}") {
          data(first: 1) {
            edges {
              node {
                id
                order_number
                fulfillment_status
              }
            }
          }
        }
      }
    `);
    const edges = data?.orders?.data?.edges;
    if (edges && edges.length > 0) {
      const order = edges[0].node;
      return {
        orderId: order.id,
        orderNumber: order.order_number,
        wholesaleOrderId: order.id,
      };
    }
  } catch (err) {
    console.warn('[shiphero] partner_order_id lookup failed:', err);
  }

  // Fallback: search recent orders matching the SKU
  try {
    const data = await gql(`
      query {
        orders(sku: "${sku}") {
          data(first: 5) {
            edges {
              node {
                id
                order_number
                fulfillment_status
                created_at
              }
            }
          }
        }
      }
    `);
    const edges = data?.orders?.data?.edges;
    if (edges && edges.length > 0) {
      // Match the embedded TR-XXXXX token rather than a `CIN7-TR` prefix —
      // order numbers are now descriptive (AMZ_<SKU>_TR-00477). (2026-09-21)
      const cin7Order = edges.find((e: any) =>
        extractTransferNumber(e.node.order_number) &&
        e.node.fulfillment_status === 'pending'
      );
      if (cin7Order) {
        return {
          orderId: cin7Order.node.id,
          orderNumber: cin7Order.node.order_number,
          wholesaleOrderId: cin7Order.node.id,
        };
      }
    }
  } catch (err) {
    console.warn('[shiphero] SKU-based lookup failed:', err);
  }

  return null;
}
