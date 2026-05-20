import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getShipHeroProductData, getShipHeroToken } from '../../lib/shiphero-product-data';
import { lookupSkuMapping, createFbaInboundShipment } from '../../lib/fba-orchestrator';
import { postProcessFbaShipment } from '../../lib/fba-post-process';

export const config = { maxDuration: 300 };

function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Fully automated FBA submission.
 * 
 * Takes a CIN7 transfer with SKU + quantity, auto-pulls everything from ShipHero:
 * - Case pack quantity + box dimensions (from product_note)
 * - Expiration date (from expiration_lots)
 * - Amazon MSKU mapping (from sku_master + amazon_products)
 * 
 * Then submits to Amazon FBA and returns labels.
 *
 * POST /api/fba/auto-submit
 * {
 *   cin7_transfer_number: "TR-00029",
 *   items: [{ sku: "CN-DRP-BLOODSUGAR-2OZ", quantity: 90 }]
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const { cin7_transfer_number, items } = req.body;

    if (!cin7_transfer_number || !items?.length) {
      return res.status(400).json({
        error: 'Required: cin7_transfer_number, items (array of {sku, quantity})',
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const warehouseId = process.env.SHIPHERO_WAREHOUSE_ID || '22e17170-af72-4bf8-b77c-d73c86b06765';

    // Get ShipHero token
    const shipheroToken = await getShipHeroToken(supabaseUrl, supabaseKey, warehouseId);

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    const results: any[] = [];

    for (const item of items) {
      console.log(`[fba-auto] Processing ${item.sku} x ${item.quantity}...`);

      // Idempotency check: skip if an active fba_shipments row already exists
      // for this transfer+SKU. Prevents duplicate Amazon plans when the caller
      // retries (Vercel timeout, reconciler re-fire, manual re-run).
      try {
        const { data: existing, error: lookupErr } = await supabase
          .from('fba_shipments')
          .select('id, status, plan_id, amazon_shipment_ids')
          .eq('cin7_transfer_number', cin7_transfer_number)
          .eq('cin7_sku', item.sku)
          .not('status', 'in', '("failed","voided","cancelled")')
          .maybeSingle();

        if (lookupErr) {
          console.warn(`[fba-auto] Idempotency lookup failed for ${item.sku}: ${lookupErr.message}`);
          // Fall through and process anyway — better to risk a dup than block forever
        } else if (existing) {
          console.log(
            `[fba-auto] Skipping ${item.sku} — active fba_shipments record exists ` +
              `(id=${existing.id} status=${existing.status} plan=${existing.plan_id})`
          );
          results.push({
            sku: item.sku,
            status: 'skipped',
            reason: `Already processed — plan ${existing.plan_id}, ` +
              `${(existing.amazon_shipment_ids as any[] | null)?.length || 0} shipments. ` +
              `If you need to re-run, mark the existing fba_shipments row status='cancelled' first.`,
            existing_plan_id: existing.plan_id,
            existing_record_id: existing.id,
          });
          continue;
        }
      } catch (idemErr: any) {
        console.warn(`[fba-auto] Idempotency check threw: ${idemErr?.message || idemErr}`);
      }

      // 1. Resolve CIN7 SKU → Amazon MSKU
      const skuMapping = await lookupSkuMapping(item.sku);
      if (!skuMapping?.amz_sku) {
        results.push({
          sku: item.sku,
          status: 'failed',
          error: `No Amazon SKU mapping found for ${item.sku}`,
        });
        continue;
      }

      // 2. Pull product data from ShipHero (case dims, expiration)
      const productData = await getShipHeroProductData(shipheroToken, item.sku);
      console.log(`[fba-auto] ShipHero data:`, JSON.stringify({
        casePack: productData.casePack,
        expiration: productData.expirationDate,
        lot: productData.lotNumber,
      }));

      if (!productData.casePack) {
        results.push({
          sku: item.sku,
          status: 'failed',
          error: `No case pack data in ShipHero product_note for ${item.sku}. Add "Box Weight: X Lbs, Box Size: LxWxH inches, Quantity per Case: N" to ShipHero product notes.`,
        });
        continue;
      }

      if (!productData.expirationDate) {
        results.push({
          sku: item.sku,
          status: 'failed',
          error: `No expiration date found in ShipHero for ${item.sku}`,
        });
        continue;
      }

      // 3. Calculate box count
      const casePack = productData.casePack;
      const totalQty = item.quantity;
      const numBoxes = Math.ceil(totalQty / casePack.caseQuantity);
      const unitsPerBox = casePack.caseQuantity;

      console.log(`[fba-auto] ${totalQty} units ÷ ${unitsPerBox} per case = ${numBoxes} boxes`);

      // 4. Submit to Amazon FBA
      console.log(`[fba-auto] Submitting to Amazon: ${skuMapping.amz_sku} x ${totalQty}, ${numBoxes} boxes of ${unitsPerBox} each, exp ${productData.expirationDate}`);

      const fbaResult = await createFbaInboundShipment(
        warehouseId,
        [{
          sellerSku: skuMapping.amz_sku,
          quantity: totalQty,
          casePack: unitsPerBox,
          cases: numBoxes,
          expiration: productData.expirationDate,
        }],
        {
          length: casePack.boxLength,
          width: casePack.boxWidth,
          height: casePack.boxHeight,
        },
        casePack.boxWeightLbs,
        {
          boxQuantity: numBoxes,
          casePack: unitsPerBox,
        }
      );

      // 5. Post-process: fetch labels, upload to Supabase, attach to ShipHero, Telegram notify
      const shipmentIds = fbaResult.shipmentIds || fbaResult.amazon_shipment_ids || [];
      const confirmationIds = fbaResult.shipmentConfirmationIds || [];
      const planId = fbaResult.planId || fbaResult.plan_id || null;

      // Persist the fba_shipments row BEFORE post-process so idempotency
      // works even if post-process (labels/Telegram) fails. The row captures
      // the cin7 transfer + sku linkage so re-runs are blocked.
      let fbaRecordId: string | null = null;
      try {
        const { data: rec, error: recErr } = await supabase
          .from('fba_shipments')
          .insert({
            name: `CIN7-${cin7_transfer_number}-${item.sku}`,
            marketplace_id: 'ATVPDKIKX0DER',
            ship_from_warehouse_id: warehouseId,
            status: 'plan_created',
            plan_id: planId,
            amazon_shipment_ids: confirmationIds.length ? confirmationIds : shipmentIds,
            box_length: casePack.boxLength,
            box_width: casePack.boxWidth,
            box_height: casePack.boxHeight,
            box_weight_lbs: casePack.boxWeightLbs,
            cin7_transfer_number,
            cin7_sku: item.sku,
            prep_instructions: fbaResult.prepInstructions || fbaResult.prep_instructions || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        if (recErr) {
          console.warn(`[fba-auto] fba_shipments insert failed: ${recErr.message}`);
        } else {
          fbaRecordId = rec?.id || null;
          console.log(`[fba-auto] fba_shipments row created: ${fbaRecordId}`);
        }
      } catch (recordErr: any) {
        console.warn(`[fba-auto] fba_shipments persistence threw: ${recordErr?.message || recordErr}`);
      }

      let postProcess: any = null;
      try {
        postProcess = await postProcessFbaShipment({
          cin7TransferNumber: cin7_transfer_number,
          fbaResult: {
            planId: fbaResult.planId || fbaResult.plan_id,
            shipmentIds,
            shipmentConfirmationIds: confirmationIds,
          },
          product: {
            cin7Sku: item.sku,
            amazonSku: skuMapping.amz_sku,
            productName: productData.name,
            fnsku: skuMapping.amz_fnsku ?? undefined,
            asin: skuMapping.amz_asin ?? undefined,
          },
          quantity: {
            totalUnits: totalQty,
            boxes: numBoxes,
            unitsPerBox,
          },
          box: {
            length: casePack.boxLength,
            width: casePack.boxWidth,
            height: casePack.boxHeight,
            weightLbs: casePack.boxWeightLbs,
          },
          expiration: productData.expirationDate ?? undefined,
          lot: productData.lotNumber ?? undefined,
        });
        console.log(`[fba-auto] post-process done: ${postProcess.attachmentsCreated} attachments, telegram=${postProcess.telegramSent}, errors=${postProcess.errors.length}`);

        // Update fba_shipments status now that labels are attached and Telegram fired
        if (fbaRecordId) {
          try {
            await supabase
              .from('fba_shipments')
              .update({
                status: 'labels_ready',
                labels_url: postProcess.labels?.[0]?.supabaseUrl ?? null,
                updated_at: new Date().toISOString(),
              })
              .eq('id', fbaRecordId);
          } catch (updErr: any) {
            console.warn(`[fba-auto] fba_shipments status update failed: ${updErr?.message}`);
          }
        }
      } catch (postErr: any) {
        console.error('[fba-auto] post-process failed (non-fatal):', postErr?.message);
      }

      results.push({
        sku: item.sku,
        amazon_sku: skuMapping.amz_sku,
        status: 'success',
        quantity: totalQty,
        boxes: numBoxes,
        units_per_box: unitsPerBox,
        box_dims: `${casePack.boxLength}x${casePack.boxWidth}x${casePack.boxHeight} in`,
        box_weight: `${casePack.boxWeightLbs} lbs`,
        expiration: productData.expirationDate,
        lot: productData.lotNumber,
        amazon_shipment_ids: shipmentIds,
        shipment_confirmation_ids: confirmationIds,
        labels: postProcess?.labels ?? [],
        total_shipping_cost: postProcess?.totalShippingCost,
        placement_fee: postProcess?.placementFee,
        shiphero_order_id: postProcess?.shipheroOrderId,
        attachments_created: postProcess?.attachmentsCreated ?? 0,
        telegram_sent: postProcess?.telegramSent ?? false,
        post_process_errors: postProcess?.errors ?? [],
        prep: fbaResult.prepInstructions || fbaResult.prep_instructions,
      });
    }

    res.status(200).json({
      cin7_transfer_number,
      processed: results.length,
      successful: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (error) {
    console.error('[fba-auto] Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
