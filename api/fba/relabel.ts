/**
 * POST /api/fba/relabel
 *
 * Re-fetches FBA labels for an existing fba_shipments row using the corrected
 * post-process logic (real box IDs from listShipmentBoxes, not guessed). Re-uploads
 * label PDFs to Supabase Storage, re-attaches them to the ShipHero order, and
 * re-sends the Telegram summary.
 *
 * Use this to fix shipments that were processed BEFORE the box-ID fix landed
 * (2026-05-22 incident: TR-00079..00084 produced PDFs with only 1 box label each).
 *
 * Body: { cin7_transfer_number: "CIN7-TR-00079" }
 *   or: { plan_id: "wf..." }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';
import { lookupSkuMapping } from '../../lib/fba-orchestrator';
import { getShipHeroProductData, getShipHeroToken } from '../../lib/shiphero-product-data';
import { postProcessFbaShipment } from '../../lib/fba-post-process';

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { cin7_transfer_number, plan_id } = req.body || {};
  if (!cin7_transfer_number && !plan_id) {
    return res
      .status(400)
      .json({ error: 'Provide cin7_transfer_number or plan_id' });
  }

  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const warehouseId =
    process.env.SHIPHERO_WAREHOUSE_ID || '22e17170-af72-4bf8-b77c-d73c86b06765';
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  // 1) Load the existing fba_shipments row
  let row: any;
  if (plan_id) {
    const { data, error } = await supabase
      .from('fba_shipments')
      .select('*')
      .eq('plan_id', plan_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return res.status(404).json({ error: `No fba_shipments row for plan_id=${plan_id}` });
    }
    row = data;
  } else {
    const { data, error } = await supabase
      .from('fba_shipments')
      .select('*')
      .eq('cin7_transfer_number', cin7_transfer_number)
      .not('status', 'in', '("failed","voided","cancelled")')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return res
        .status(404)
        .json({ error: `No active fba_shipments row for ${cin7_transfer_number}` });
    }
    row = data;
  }

  const planId = row.plan_id;
  if (!planId) {
    return res.status(400).json({ error: 'fba_shipments row has no plan_id — cannot relabel' });
  }

  // 2) Resolve internal shipment IDs via placementOptions (the /shipments listing
  //    endpoint returns 403 with our current LWA scope — confirmed 2026-05-22).
  //    The ACCEPTED placement option carries the same shipmentIds[] we got at
  //    confirmPlacementOption time during auto-submit.
  const placementRes = await callAmazonSpApi<any>({
    method: 'GET',
    path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/placementOptions`,
  });
  const placementOptions = placementRes.data?.placementOptions ?? [];
  const accepted = placementOptions.find((p: any) => p.status === 'ACCEPTED');
  if (!accepted) {
    return res.status(500).json({
      error: `No ACCEPTED placement option found for plan ${planId}`,
      placementOptionCount: placementOptions.length,
      statuses: placementOptions.map((p: any) => p.status),
    });
  }
  const internalShipmentIds: string[] = accepted.shipmentIds ?? [];
  if (internalShipmentIds.length === 0) {
    return res.status(500).json({
      error: `ACCEPTED placement option has no shipmentIds for plan ${planId}`,
    });
  }
  // shipmentConfirmationIds are not on placementOptions — postProcessFbaShipment
  // will fetch them per-shipment via getShipmentDetails (it reads
  // d.shipmentConfirmationId from /shipments/{internalId}).
  const shipmentConfirmationIds: string[] = [];

  // Persist the recovered internal IDs so future relabel calls (or other tools)
  // don't need to call placementOptions again. Best-effort — failure is non-fatal.
  try {
    await supabase
      .from('fba_shipments')
      .update({ amazon_internal_shipment_ids: internalShipmentIds })
      .eq('id', row.id);
  } catch (persistErr: any) {
    console.warn(`[relabel] Could not persist internal IDs: ${persistErr?.message}`);
  }

  // 3) Resolve product metadata for the Telegram message (best-effort)
  const cin7Sku = row.cin7_sku;
  const skuMapping = await lookupSkuMapping(cin7Sku).catch(() => null);
  const shipheroToken = await getShipHeroToken(
    supabaseUrl,
    supabaseKey,
    warehouseId,
  ).catch(() => null);
  const productData = shipheroToken
    ? await getShipHeroProductData(shipheroToken, cin7Sku).catch(() => null)
    : null;

  // Derive units / cases / unitsPerBox.
  // Prefer the placement option's items aggregate when available; fall back to
  // per-shipment GETs to sum items (rarely needed).
  const unitsPerBox = productData?.casePack?.caseQuantity || 0;
  let totalUnits = 0;
  // Aggregate from placement-option items if present (newer Amazon responses
  // include items here). Otherwise we'll fetch per-shipment below.
  for (const sid of (accepted.shipmentIds as string[]) || []) {
    void sid; // placeholder to keep lint happy; real summing happens next
  }
  // Fetch each shipment's items to sum quantities. Items are NOT on the
  // /shipments/{id} response — they live on /shipments/{id}/items. Calling
  // /shipments/{id} alone returns destination + tracking but no items, which
  // is why earlier relabel runs sent "Units: 0" Telegram messages.
  for (const internalId of internalShipmentIds) {
    try {
      const sres = await callAmazonSpApi<any>({
        method: 'GET',
        path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments/${internalId}/items`,
      });
      for (const it of (sres.data?.items as any[]) || []) {
        totalUnits += it.quantity || 0;
      }
    } catch (e: any) {
      console.warn(`[relabel] Could not fetch shipment ${internalId} items for totals: ${e?.message}`);
    }
  }
  const cases = unitsPerBox > 0 ? Math.ceil(totalUnits / unitsPerBox) : 0;

  // 4) Re-run post-process
  try {
    const result = await postProcessFbaShipment({
      cin7TransferNumber: row.cin7_transfer_number || cin7_transfer_number,
      fbaResult: {
        planId,
        shipmentIds: internalShipmentIds,
        shipmentConfirmationIds,
      },
      product: {
        cin7Sku,
        amazonSku: skuMapping?.amz_sku || '',
        productName: skuMapping?.product_name,
        fnsku: skuMapping?.amz_fnsku || undefined,
        asin: skuMapping?.amz_asin || undefined,
      },
      quantity: {
        totalUnits,
        boxes: cases,
        unitsPerBox,
      },
      box: {
        length: Number(row.box_length) || 0,
        width: Number(row.box_width) || 0,
        height: Number(row.box_height) || 0,
        weightLbs: Number(row.box_weight_lbs) || 0,
      },
      expiration: productData?.expirationDate || undefined,
      lot: productData?.lotNumber || undefined,
    });

    return res.status(result.errors.length > 0 ? 207 : 200).json({
      ok: true,
      cin7_transfer_number: row.cin7_transfer_number,
      plan_id: planId,
      labels: result.labels.map((l) => ({
        fbaId: l.fbaId,
        boxes: l.boxes,
        destination: l.destination,
        supabaseUrl: l.supabaseUrl,
      })),
      attachmentsCreated: result.attachmentsCreated,
      telegramSent: result.telegramSent,
      errors: result.errors,
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err?.message || String(err), stack: err?.stack?.slice(0, 1000) });
  }
}
