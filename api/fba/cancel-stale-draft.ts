import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';
import { supabase } from '../../lib/supabase';

export const config = { maxDuration: 60 };

/**
 * Safely cancel a stuck FBA draft row AND void the associated Amazon inbound plan.
 * POST /api/fba/cancel-stale-draft
 * Body: { "cin7_transfer_number": "CIN7-TR-00124", "cin7_sku"?: "..." }
 *
 * Behavior:
 *   - For each matching fba_shipments row (status NOT IN cancelled/failed/voided):
 *     - If no amazon_shipment_ids: void the Amazon plan (if plan_id set) then PATCH row to cancelled.
 *     - If amazon_shipment_ids has entries: refuse — post-labels-ready plans must be voided manually
 *       in Seller Central (see references/2026-07-02-fba-duplicate-plan-race.md).
 */

function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

interface CancelledResult {
  row_id: string;
  plan_id: string | null;
  amazon_op_id?: string | null;
  amazon_cancel_error?: string;
  db_patch_error?: string;
}

interface RefusedResult {
  row_id: string;
  plan_id: string | null;
  reason: 'has_shipments';
  amazon_shipment_ids: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  const cin7_transfer_number = req.body?.cin7_transfer_number as string | undefined;
  const cin7_sku = req.body?.cin7_sku as string | undefined;

  if (!cin7_transfer_number) {
    return res.status(400).json({ error: 'Missing cin7_transfer_number' });
  }

  try {
    let query = supabase
      .from('fba_shipments')
      .select('id, plan_id, amazon_shipment_ids, status, cin7_transfer_number, cin7_sku')
      .eq('cin7_transfer_number', cin7_transfer_number)
      .not('status', 'in', '(cancelled,failed,voided)');

    if (cin7_sku) query = query.eq('cin7_sku', cin7_sku);

    const { data: rows, error: qErr } = await query;
    if (qErr) {
      return res.status(500).json({ error: 'Query failed', details: qErr.message });
    }

    const cancelled: CancelledResult[] = [];
    const refused: RefusedResult[] = [];

    for (const row of rows ?? []) {
      const shipmentIds: string[] = Array.isArray(row.amazon_shipment_ids) ? row.amazon_shipment_ids : [];
      if (shipmentIds.length > 0) {
        refused.push({
          row_id: row.id,
          plan_id: row.plan_id ?? null,
          reason: 'has_shipments',
          amazon_shipment_ids: shipmentIds,
        });
        continue;
      }

      const result: CancelledResult = { row_id: row.id, plan_id: row.plan_id ?? null };

      // Try to void the Amazon plan first (if we have one)
      if (row.plan_id) {
        try {
          const response = await callAmazonSpApi<any>({
            method: 'PUT',
            path: `/inbound/fba/2024-03-20/inboundPlans/${row.plan_id}/cancellation`,
            body: {},
          });
          const opId =
            response?.data?.operationId ??
            response?.data?.operation_id ??
            null;
          result.amazon_op_id = opId;
        } catch (err: any) {
          result.amazon_cancel_error = err?.message ?? String(err);
          console.warn(`[cancel-stale-draft] Amazon cancel failed for plan ${row.plan_id}: ${result.amazon_cancel_error}`);
        }
      }

      // Always attempt the DB PATCH so we don't leave the row in a state that lets
      // auto-submit retry against a stale plan_id.
      const { error: patchErr } = await supabase
        .from('fba_shipments')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          error_message: 'cancelled via cancel-stale-draft',
        })
        .eq('id', row.id);

      if (patchErr) {
        result.db_patch_error = patchErr.message;
        console.error(`[cancel-stale-draft] DB patch failed for row ${row.id}: ${patchErr.message}`);
      }

      cancelled.push(result);
    }

    return res.json({
      cin7_transfer_number,
      processed: (rows ?? []).length,
      cancelled,
      refused,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: err?.message ?? 'Unknown error',
      details: err?.details ?? err?.response?.data,
    });
  }
}
