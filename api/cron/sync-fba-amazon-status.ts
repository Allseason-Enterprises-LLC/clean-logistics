/**
 * GET /api/cron/sync-fba-amazon-status
 *
 * Writes Amazon's real inbound status onto fba_shipments.amazon_status so the
 * watchdog (and humans) stop reading a pipeline column frozen at
 * `plan_created` and calling shipped-and-in-transit freight "stuck".
 * See lib/fba-status-sync.ts for the why and the aggregation rules.
 *
 * Never touches `status`; never creates or cancels anything on Amazon.
 * Schedule: every 30 min (vercel.json). Returns a balanced ledger.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { callAmazonSpApi, SpApiError } from '../../lib/amazon-sp-api-client';
import { syncFbaAmazonStatus } from '../../lib/fba-status-sync';

export const config = { maxDuration: 120 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    const supabase = createClient(url, key, { auth: { persistSession: false } });

    const amazonGet = async (path: string) => {
      const r = await callAmazonSpApi({ method: 'GET', path });
      if (r.status >= 400) throw new SpApiError(`GET ${path} -> ${r.status}`, r.status, r.data);
      return r.data;
    };

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await syncFbaAmazonStatus({ supabase, amazonGet, limit });
    const ok = result.errors.length === 0;
    return res.status(ok ? 200 : 207).json({ ok, ...result });
  } catch (e: any) {
    console.error('[sync-fba-amazon-status]', e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
