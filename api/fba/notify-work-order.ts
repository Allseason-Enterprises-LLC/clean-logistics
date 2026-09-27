/**
 * POST /api/fba/notify-work-order  { cin7_transfer_number }   (CRON_SECRET)
 *
 * (Re)posts the "work order created" notice for a parked kit transfer, using
 * the exact same builder + sendTelegram the gate uses at sync time. Exists so a
 * notice lost to a delivery fault (2026-09-27, TR-00484) can be sent without
 * touching the row or the work order. Idempotent: posting twice just posts twice.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { readWorkOrderState, buildWorkOrderCreatedNotice } from '../../lib/kit-work-order-gate';
import { sendTelegram } from '../../lib/fba-post-process';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const tr = String((req.body?.cin7_transfer_number ?? req.query.tr) || '').trim();
  if (!/^TR-\d+$/.test(tr)) return res.status(400).json({ error: 'cin7_transfer_number like TR-00484 required' });

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: row, error } = await supabase
    .from('cin7_transfer_shiphero_orders')
    .select('cin7_transfer_number, request_payload')
    .eq('cin7_transfer_number', tr)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: `${tr}: no bridge row` });
  const wo = readWorkOrderState(row.request_payload);
  if (!wo) return res.status(409).json({ error: `${tr}: not a kit-gated transfer (no work_order on row)` });

  const sent = await sendTelegram(buildWorkOrderCreatedNotice(wo, tr));
  return res.status(sent ? 200 : 502).json({ transfer: tr, work_order_ids: wo.ids, status: wo.status, sent });
}
