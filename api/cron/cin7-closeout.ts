/**
 * CIN7 transfer close-out — completes FBA transfers in CIN7 once ShipHero has
 * shipped them, Amazon shows them in transit, and coverage is whole.
 * Schedule 10,30,50 (offset from sync at :00/:20/:40 — same CIN7 key budget).
 * ?only=TR-00699  canary one transfer   ?dry=1  decide but write nothing
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { runCin7Closeout } from '../../lib/cin7-closeout';
import { getShipHeroToken } from '../../lib/shiphero-product-data';
import { sendTelegram } from '../../lib/fba-post-process';

export const config = { maxDuration: 120 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const url = process.env.SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const db = createClient(url, key, { auth: { persistSession: false } });
    const shToken = await getShipHeroToken(url, key, process.env.SHIPHERO_WAREHOUSE_UUID || '22e17170-af72-4bf8-b77c-d73c86b06765');
    const only = typeof req.query.only === 'string' ? req.query.only : undefined;
    const dryRun = req.query.dry === '1';
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await runCin7Closeout(db, shToken, { only, dryRun, limit, notify: sendTelegram });
    return res.status(result.errors.length ? 207 : 200).json({ ok: result.errors.length === 0, dryRun, ...result });
  } catch (e: any) {
    console.error('[cin7-closeout]', e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
}
