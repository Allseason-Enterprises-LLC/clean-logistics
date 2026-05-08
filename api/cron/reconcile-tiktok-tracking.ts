/**
 * GET /api/cron/reconcile-tiktok-tracking
 *
 * Self-healing reconciliation cron for the TikTok ↔ ShipHero bridge.
 *
 * We don't trust the ShipHero `shipment_update` webhook alone — it can be
 * dropped by Vercel (cold starts, 5xx on transient errors), rejected by
 * auth middleware, or silently broken by URL drift. This cron is the
 * fallback: every tick, it scans `tiktok_shiphero_orders` rows that are
 * still `status='imported'`, queries ShipHero for tracking, and pushes
 * to TikTok. Idempotent — re-running is always safe.
 *
 * Scheduled every 5 minutes (see vercel.json).
 *
 * Auth: Vercel cron header OR Bearer CRON_SECRET.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { reconcileStuckBridgeRows } from '../../lib/tiktok-bridge';

function authorized(req: VercelRequest): boolean {
  // Vercel cron sends x-vercel-cron=1 on production invocations
  if (req.headers['x-vercel-cron'] === '1' && process.env.VERCEL === '1') {
    return true;
  }
  const auth = req.headers.authorization;
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return auth === `Bearer ${expected}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // GET so Vercel cron works natively. Manual POST also fine.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!authorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Allow ?batchSize=N for manual runs doing backfill. Cap at 100 to
  // stay comfortably under Vercel function timeout (max ~10s per row).
  const requested = Number(req.query.batchSize);
  const batchSize = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), 100)
    : 25;

  try {
    const result = await reconcileStuckBridgeRows(batchSize);
    return res.status(200).json({ success: true, batchSize, ...result });
  } catch (err) {
    console.error('[reconcile-tiktok-tracking] Fatal error:', err);
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
