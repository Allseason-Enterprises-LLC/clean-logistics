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

  // 2) Resolve internal shipment IDs from Amazon (we may not have stored them)
  const shipmentsRes = await callAmazonSpApi<any>({
    method: 'GET',
    path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments`,
  });
  const shipments = shipmentsRes.data?.shipments || [];
  if (shipments.length === 0) {
    return res.status(500).json({ error: `Amazon returned 0 shipments for plan ${planId}` });
  }
  const internalShipmentIds: string[] = shipments
    .map((s: any) => s.shipmentId)
    .filter(Boolean);
  const shipmentConfirmationIds: string[] = shipments
    .map((s: any) => s.shipmentConfirmationId)
    .filter(Boolean);

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

  // Derive units / cases / unitsPerBox from product data + Amazon items
  const unitsPerBox = productData?.casePack?.caseQuantity || 0;
  // Total units across all shipments (sum of items quantities from the first shipment listing)
  let totalUnits = 0;
  for (const s of shipments) {
    for (const it of s.items || []) {
      totalUnits += it.quantity || 0;
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
