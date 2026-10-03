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
import { checkTelegramHealth } from '../../lib/telegram-health';
import { livePreflight } from '../../lib/fba-reconciler';

export const config = { maxDuration: 300 }; // preflight at release adds ShipHero + Amazon reads per released row

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

    // Every tick: can we actually reach the floor? A dead channel means every
    // nudge/release message below is silently lost — say so in the JSON.
    const telegram = await checkTelegramHealth();
    if (!telegram.ok) console.error(`[poll-work-orders] ⚠️ TELEGRAM DEAD: ${telegram.problem}`);

    const result = await pollWorkOrders({
      supabase, shipheroToken, sendTelegram,
      // Preflight at release so the ✅ message tells the truth (2026-10-03).
      // livePreflight needs the bridge row's identity + lines; fetch the full
      // row by id — the poller only selected id/transfer/request_payload.
      preflight: async (r) => {
        const { data: full } = await supabase
          .from('cin7_transfer_shiphero_orders')
          .select('id, cin7_transfer_id, cin7_transfer_number, cin7_destination, shiphero_order_number, request_payload')
          .eq('id', r.id).maybeSingle();
        if (!full) return null;
        const pf = await livePreflight(supabase, { ...full, request_payload: r.request_payload });
        if (!pf) return null;
        return { gated: pf.gated, hold: pf.hold, blockers: pf.result.blockers.map((b) => ({ code: b.code, summary: b.summary })), workOrderIds: pf.workOrder?.ids };
      },
    });
    const balanced =
      result.scanned ===
      result.released.length + result.failed.length + result.nudged.length +
      result.escalated.length + result.waiting.length + result.errors.length;
    return res.status(result.errors.length > 0 || !telegram.ok ? 207 : 200).json({ ...result, balanced, telegram });
  } catch (err: any) {
    console.error('[poll-work-orders] Fatal:', err);
    return res.status(500).json({ error: err?.message || String(err), scanned: 0 });
  }
}
