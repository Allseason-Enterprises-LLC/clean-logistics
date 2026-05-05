/**
 * POST /api/tiktok/shipment-update
 *
 * Webhook target for ShipHero's "Shipment Update" event on the Clean Nutra account.
 * When an order ships we receive the shipment payload with tracking_number + carrier,
 * look up the bridge row that links it to a TikTok order, and post tracking back
 * to TikTok Shop.
 *
 * Auth: ShipHero webhook signature (if `SHIPHERO_WEBHOOK_SECRET` set), or the
 * webhook URL itself acts as the shared secret (typical pattern).
 *
 * Payload shape (ShipHero, defensive — see lib/tiktok-bridge.ts handleShipHeroShipment):
 *   {
 *     "order_id": "...",        // ShipHero order GraphQL id
 *     "order_number": "...",
 *     "tracking_number": "1Z...",
 *     "carrier": "UPS",
 *     "shipment": { ... }        // sometimes nested
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleShipHeroShipment } from '../../lib/tiktok-bridge';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional: verify webhook secret
  const webhookSecret = process.env.SHIPHERO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const authHeader = req.headers['x-webhook-secret'] || req.headers['authorization'];
    if (authHeader !== webhookSecret && authHeader !== `Bearer ${webhookSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const payload = req.body || {};
    console.log('[shipment-update] Received:', JSON.stringify(payload).slice(0, 500));

    const result = await handleShipHeroShipment(payload);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[shipment-update] Error:', error);
    // Return 500 so ShipHero retries. handleShipHeroShipment already
    // persisted the failure state on the bridge row.
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
