/**
 * POST /api/fba/notify-work-order  { cin7_transfer_number, enrich?: true }   (CRON_SECRET)
 *
 * (Re)posts the "New Work Order Needed" notice for a parked kit transfer using
 * the exact builder + sendTelegram the gate uses. With `enrich: true` it first
 * resolves the product identity from Amazon (name / ASIN / FNSKU / UPC), renders
 * + attaches the kitting barcode to the ShipHero order, and persists all of it
 * on the row — for rows parked before identity resolution existed (TR-00484).
 * Never touches the work order itself. Idempotent apart from the Telegram post.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { readWorkOrderState, buildWorkOrderCreatedNotice, type WorkOrderState } from '../../lib/kit-work-order-gate';
import { sendTelegram } from '../../lib/fba-post-process';
import { resolveKitProductIdentity, extractAsin } from '../../lib/kit-product-identity';
import { attachKitBarcode } from '../../lib/kit-barcode-attach';
import { resolveShipHeroLasVegasWarehouse } from '../../lib/cin7-transfer-sync';

export const config = { maxDuration: 120 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const tr = String((req.body?.cin7_transfer_number ?? req.query.tr) || '').trim();
  const enrich = req.body?.enrich === true || req.query.enrich === '1';
  if (!/^TR-\d+$/.test(tr)) return res.status(400).json({ error: 'cin7_transfer_number like TR-00484 required' });

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: row, error } = await supabase
    .from('cin7_transfer_shiphero_orders')
    .select('id, cin7_transfer_number, shiphero_order_id, shiphero_order_number, request_payload')
    .eq('cin7_transfer_number', tr)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: `${tr}: no bridge row` });
  let wo = readWorkOrderState(row.request_payload);
  if (!wo) return res.status(409).json({ error: `${tr}: not a kit-gated transfer (no work_order on row)` });

  const enriched: string[] = [];
  if (enrich) {
    try {
      const identity = await resolveKitProductIdentity({
        cin7Sku: wo.kit_sku, amazonMsku: wo.amazon_msku ?? null,
        asin: wo.asin ?? extractAsin(row.request_payload?.rawTransfer?.Reference),
      });
      const next: WorkOrderState = { ...wo, asin: identity.asin, product_name: identity.productName, fnsku: identity.fnsku,
        upc: identity.upc, barcode_kind: identity.barcode?.kind ?? null, amazon_msku: wo.amazon_msku ?? identity.amazonMsku ?? null };
      enriched.push(...identity.notes);
      if (identity.barcode) {
        try {
          const wh = await resolveShipHeroLasVegasWarehouse(supabase, process.env.SHIPHERO_WAREHOUSE_ID);
          const token: string | undefined = wh?.credentials?.accessToken;
          if (token) {
            next.barcode_url = await attachKitBarcode(token, { identity, orderNumber: row.shiphero_order_number || tr, transferNumber: tr, shipheroOrderId: row.shiphero_order_id });
            enriched.push(`barcode ${identity.barcode.kind} ${identity.barcode.value} attached`);
          }
        } catch (e: any) { enriched.push(`barcode attach failed: ${e?.message || e}`); }
      }
      const { error: upErr } = await supabase.from('cin7_transfer_shiphero_orders')
        .update({ request_payload: { ...row.request_payload, work_order: next } }).eq('id', row.id);
      if (upErr) enriched.push(`persist failed: ${upErr.message}`); else wo = next;
    } catch (e: any) { enriched.push(`identity failed: ${e?.message || e}`); }
  }

  const sent = await sendTelegram(buildWorkOrderCreatedNotice(wo, tr));
  return res.status(sent ? 200 : 502).json({
    transfer: tr, work_order_ids: wo.ids, status: wo.status, sent,
    identity: { asin: wo.asin ?? null, fnsku: wo.fnsku ?? null, upc: wo.upc ?? null, barcode_kind: wo.barcode_kind ?? null, barcode_url: wo.barcode_url ?? null, product_name: wo.product_name ?? null },
    enriched,
  });
}
