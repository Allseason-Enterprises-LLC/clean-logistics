/**
 * POST /api/tiktok/sync-orders
 *
 * Pulls recent AWAITING_SHIPMENT orders from TikTok Shop, filters by Clean Nutra
 * SKU allowlist, and creates matching orders in the Clean Nutra ShipHero account.
 *
 * Invoked by:
 *   - Vercel cron (every 5 minutes) — unauthenticated, Vercel signs with
 *     `x-vercel-signature`, but for simplicity we also accept the INTERNAL_API_KEY
 *     header for manual runs.
 *   - Manual curl: `curl -X POST -H "x-api-key: $INTERNAL_API_KEY" .../api/tiktok/sync-orders`
 *
 * Query params:
 *   - lookback  (optional, default 15)  — minutes of history to scan
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { syncTikTokOrders } from '../../lib/tiktok-bridge';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron calls arrive as GET with a user-agent of "vercel-cron/1.0" and
  // include the `x-vercel-cron` header. For manual calls require INTERNAL_API_KEY.
  const isVercelCron = !!req.headers['x-vercel-cron'] || req.headers['user-agent']?.includes('vercel-cron');
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  const expectedKey = process.env.INTERNAL_API_KEY;

  if (!isVercelCron) {
    if (!expectedKey) {
      return res.status(500).json({ error: 'INTERNAL_API_KEY not configured' });
    }
    if (apiKey !== expectedKey && apiKey !== `Bearer ${expectedKey}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const lookbackRaw = req.query.lookback || req.body?.lookback;
  const lookback = lookbackRaw ? parseInt(String(lookbackRaw), 10) : 15;

  try {
    const result = await syncTikTokOrders(lookback);
    return res.status(200).json({
      success: true,
      lookback_minutes: lookback,
      ...result,
    });
  } catch (error) {
    console.error('[sync-orders] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
