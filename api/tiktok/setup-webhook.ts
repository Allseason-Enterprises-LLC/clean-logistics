/**
 * POST /api/tiktok/setup-webhook
 * 
 * Creates a ShipHero webhook that fires on new order creation.
 * This webhook will POST to our /api/tiktok/route-order endpoint
 * so we can automatically route TikTok orders to the correct warehouse.
 * 
 * Should only be called once during initial setup.
 * 
 * Body:
 * { "action": "create" | "list" | "delete", "webhook_id": "..." (for delete) }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const WEBHOOK_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}/api/tiktok/route-order`
  : 'https://shiphero-shipstation-bridge.vercel.app/api/tiktok/route-order';

async function getShipHeroToken(): Promise<string> {
  if (process.env.SHIPHERO_ACCESS_TOKEN) {
    return process.env.SHIPHERO_ACCESS_TOKEN;
  }

  // Must use Clean Nutra account's ShipHero token (not Clear Ship 3PL's).
  // The webhook is registered under Clean Nutra's account so order_create
  // events fire for Clean Nutra shops (TikTok, Shopify, etc.).
  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, api_credentials')
    .eq('provider', 'shiphero');

  if (error) throw new Error(`Failed to query ShipHero warehouses: ${error.message}`);

  const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
  const row =
    (data || []).find((w: any) => w.id === CLEAN_NUTRA_LV_UUID) ||
    (data || []).find((w: any) => {
      const name = (w.name || '').toLowerCase();
      return name.includes('clean nutra') || name.includes('las vegas') || name.includes('lv');
    });

  if (!row) throw new Error('Could not find Clean Nutra ShipHero warehouse row');
  const creds = row.api_credentials as any;
  if (!creds?.accessToken) throw new Error(`No accessToken on warehouses row ${row.id}`);
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth - internal only
  const authHeader = req.headers['authorization'];
  const apiKey = process.env.INTERNAL_API_KEY;
  if (apiKey && authHeader !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, webhook_id } = req.body;

  try {
    if (action === 'list') {
      const data = await gql(`
        query {
          webhooks {
            request_id
            data(first: 50) {
              edges {
                node {
                  id
                  account_id
                  name
                  url
                  source
                  shop_name
                }
              }
            }
          }
        }
      `);
      return res.status(200).json({ webhooks: data.webhooks });
    }

    if (action === 'create') {
      const data = await gql(`
        mutation($data: CreateWebhookInput!) {
          webhook_create(data: $data) {
            request_id
            webhook {
              id
              account_id
              name
              url
              source
            }
          }
        }
      `, {
        data: {
          // "Order Allocated" is ShipHero's canonical event name for when an order
          // is assigned to a warehouse — the perfect trigger for routing because
          // the warehouse_id is populated by then.
          name: 'Order Allocated',
          url: WEBHOOK_URL,
          shop_name: '*',  // All shops - route-order endpoint filters for TikTok
        },
      });

      return res.status(200).json({
        success: true,
        webhook: data.webhook_create.webhook,
        note: 'Webhook "Order Allocated" created. It fires when any new order is allocated to a warehouse. The route-order endpoint filters for TikTok shops only.',
      });
    }

    if (action === 'delete') {
      if (!webhook_id) {
        return res.status(400).json({ error: 'Missing webhook_id' });
      }

      const data = await gql(`
        mutation($data: DeleteWebhookInput!) {
          webhook_delete(data: $data) {
            request_id
          }
        }
      `, {
        data: { id: webhook_id },
      });

      return res.status(200).json({ success: true, deleted: webhook_id });
    }

    return res.status(400).json({ error: 'Invalid action. Use: create, list, delete' });
  } catch (error: any) {
    console.error('Webhook setup error:', error);
    return res.status(500).json({ error: error.message });
  }
}
