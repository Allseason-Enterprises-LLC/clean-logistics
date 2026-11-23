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
import { createClient } from '@supabase/supabase-js';
import { reconcileFbaHandoffs } from '../../lib/fba-reconciler';
import { sweepIncompleteLabels, productionSweepDeps } from '../../lib/fba-label-sweep';
import { getShipHeroToken } from '../../lib/shiphero-product-data';

// 300s: frozen-draft transport recovery (fba-transport-recovery.ts) polls
// Amazon operations and can take a few minutes when quotes must regenerate.
export const config = { maxDuration: 300 };

/**
 * Label sweep (2026-11-23): finish label sets post-process left incomplete
 * (TR-00694/729/731/889). Runs AFTER reconcile, in its own try — a sweep
 * failure never fails the reconcile tick. Read-only on Amazon; ≤3 rows/tick.
 * `?label_sweep=0` disables it for a tick; `?label_sweep_dry=1` reports only.
 */
async function runLabelSweep(req: VercelRequest) {
  if (String(req.query?.label_sweep ?? '1') === '0') return { disabled: true };
  const sbUrl = process.env.SUPABASE_URL!; const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const db = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
  const token = await getShipHeroToken(sbUrl, sbKey, process.env.SHIPHERO_WAREHOUSE_ID || '22e17170-af72-4bf8-b77c-d73c86b06765');
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://shiphero-shipstation-bridge.vercel.app';
  const deps = productionSweepDeps(db, token, { baseUrl, cronSecret: process.env.CRON_SECRET! });
  if (String(req.query?.label_sweep_dry ?? '0') === '1') {
    const noWrite = async () => {};
    return sweepIncompleteLabels({ ...deps, relabel: async () => { throw new Error('dry-run: relabel skipped'); }, update: noWrite, alert: async () => false });
  }
  return sweepIncompleteLabels(deps);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await reconcileFbaHandoffs();
    let labelSweep: any = null;
    try { labelSweep = await runLabelSweep(req); }
    catch (e: any) { labelSweep = { error: e?.message || String(e) }; console.error('[reconcile-fba] label sweep failed (non-fatal):', e); }
    return res.status(result.errors.length > 0 ? 207 : 200).json({ ...result, labelSweep });
  } catch (err: any) {
    console.error('[reconcile-fba] Fatal:', err);
    return res
      .status(500)
      .json({ error: err?.message || String(err), reFired: 0, errors: [err?.message] });
  }
}
