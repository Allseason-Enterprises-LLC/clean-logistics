/**
 * GET /api/cron/reconcile-fba-handoffs
 *
 * Periodic self-healing for the CIN7 → FBA pipeline. Finds bridges that
 * have a ShipHero order but no Amazon FBA shipment, and re-fires the FBA
 * handoff (throttled to once per hour per bridge, max 3 attempts).
 *
 * Schedule: every 15 min (vercel.json).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { reconcileFbaHandoffs } from '../../lib/fba-reconciler';

// 300s: frozen-draft transport recovery (fba-transport-recovery.ts) polls
// Amazon operations and can take a few minutes when quotes must regenerate.
export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await reconcileFbaHandoffs();
    return res.status(result.errors.length > 0 ? 207 : 200).json(result);
  } catch (err: any) {
    console.error('[reconcile-fba] Fatal:', err);
    return res
      .status(500)
      .json({ error: err?.message || String(err), reFired: 0, errors: [err?.message] });
  }
}
