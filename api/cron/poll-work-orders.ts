/**
 * GET /api/cron/poll-work-orders
 *
 * Release half of the kit / multi-pack work-order gate. Checks every bridge
 * row parked behind a ShipHero work order; on COMPLETED it releases the row
 * so the reconciler (every 15 min) fires the FBA shipment through the existing
 * duplicate gates. Nudges the warehouse at 24 h and 48 h+ (with the bulk-stock
 * reading). Never fires a shipment itself; never completes a WO itself.
 *
 * Schedule: every 30 min (vercel.json). Returns a balanced ledger.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { pollWorkOrders } from '../../lib/work-order-poller';
import { sendTelegram } from '../../lib/fba-post-process';
import { resolveShipHeroLasVegasWarehouse } from '../../lib/cin7-transfer-sync';

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

    // Same token source as sync-cin7 (the warehouses row), so a refresh by the
    // daily refresh-shiphero-token cron is picked up here too.
    const wh = await resolveShipHeroLasVegasWarehouse(supabase, process.env.SHIPHERO_WAREHOUSE_ID);
    const shipheroToken: string | undefined = wh?.credentials?.accessToken;
    if (!shipheroToken) throw new Error('no ShipHero access token on the LV warehouse row');

    const result = await pollWorkOrders({ supabase, shipheroToken, sendTelegram });
    const balanced =
      result.scanned ===
      result.released.length + result.failed.length + result.nudged.length +
      result.escalated.length + result.waiting.length + result.errors.length;
    return res.status(result.errors.length > 0 ? 207 : 200).json({ ...result, balanced });
  } catch (err: any) {
    console.error('[poll-work-orders] Fatal:', err);
    return res.status(500).json({ error: err?.message || String(err), scanned: 0 });
  }
}
