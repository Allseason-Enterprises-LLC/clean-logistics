import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

export const config = { maxDuration: 60 };

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

async function getShipHeroToken(): Promise<string> {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765')
    .eq('provider', 'shiphero')
    .single();
  if (error || !data) throw new Error('Failed to get ShipHero token');
  return (data.api_credentials as any).accessToken;
}

async function shGql(token: string, query: string, variables?: any): Promise<any> {
  const res = await axios.post(SHIPHERO_API, { query, variables }, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

/**
 * POST /api/fba/attach-labels
 * 
 * Finds the ShipHero order for a CIN7 transfer and attaches FBA labels.
 * Called automatically after FBA shipment creation, or manually.
 * 
 * Body: {
 *   cin7TransferPrefix: "CIN7-TR-",  // Will search CIN7-TR-00040, 00041, etc.
 *   sku: "CN-CAP-METHYLATEDB-60BG",  // To match the right order
 *   labelsUrl: "https://...",
 *   shipmentId: "FBA19CCRZYML",
 *   productName: "Methylated B Complex",
 *   cases: 20,
 *   units: 2000,
 *   expiration: "2028-04-30",
 *   lot: "0426084"
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { sku, labelsUrl, shipmentId, productName, cases, units, expiration, lot } = req.body || {};

  if (!labelsUrl || !shipmentId) {
    return res.status(400).json({ error: 'Missing labelsUrl or shipmentId' });
  }

  try {
    const token = await getShipHeroToken();

    // Search for the most recent pending order with this SKU that has CIN7-TR pattern
    const data = await shGql(token, `
      query { 
        orders(sku: "${sku}", fulfillment_status: "pending") { 
          data(first: 10) { 
            edges { node { id order_number fulfillment_status created_at } } 
          } 
        } 
      }
    `);

    const edges = data?.orders?.data?.edges || [];
    const cin7Order = edges.find((e: any) =>
      e.node.order_number?.startsWith('CIN7-TR') && e.node.fulfillment_status === 'pending'
    );

    if (!cin7Order) {
      return res.json({ success: false, error: 'No CIN7-TR order found yet', searched: edges.length });
    }

    const orderId = cin7Order.node.id;
    const orderNumber = cin7Order.node.order_number;

    // Attach labels
    await shGql(token, `
      mutation order_add_attachment($data: OrderAddAttachmentInput!) { 
        order_add_attachment(data: $data) { request_id } 
      }
    `, {
      data: {
        order_id: orderId,
        url: labelsUrl,
        description: `FBA Shipping Labels - ${cases} boxes (4x6 thermal) - ${shipmentId}`,
      },
    });

    // Update packing note
    const note = [
      `FBA Shipment ${shipmentId} - ${productName}`,
      `${cases} cases (${units} units) - Exp: ${expiration} (Lot ${lot}) FEFO`,
      '',
      `Labels (4x6 thermal, ${cases} boxes):`,
      labelsUrl,
      '',
      'Apply one unique label per box. FNSKU labeling: SELLER.',
    ].join('\n');

    await shGql(token, `
      mutation order_update($data: UpdateOrderInput!) { 
        order_update(data: $data) { request_id } 
      }
    `, { data: { order_id: orderId, packing_note: note } });

    return res.json({ 
      success: true, 
      orderNumber, 
      orderId,
      labelsAttached: true, 
      packingNoteUpdated: true,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
