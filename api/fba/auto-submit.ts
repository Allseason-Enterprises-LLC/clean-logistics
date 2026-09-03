import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { getShipHeroProductData, getShipHeroToken, getLotBreakdown } from '../../lib/shiphero-product-data';
import { allocateFefoByLot, sanitizeLotName, type LotAllocation } from '../../lib/lot-allocation';
import { lookupSkuMapping, createFbaInboundShipment } from '../../lib/fba-orchestrator';
import { postProcessFbaShipment } from '../../lib/fba-post-process';
import { PartneredUnavailableError } from '../../lib/fba-inbound';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

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
 * Send an alert to the FBA Telegram channel. Best-effort: failures are logged but
 * never thrown, so an alert outage doesn't compound a real failure.
 */
async function sendFbaAlert(text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    console.warn('[fba-auto] Telegram env vars not set — skipping alert');
    return;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!resp.ok) {
      console.error('[fba-auto] Telegram alert failed:', resp.status, (await resp.text()).slice(0, 300));
    }
  } catch (err: any) {
    console.error('[fba-auto] Telegram alert threw:', err?.message);
  }
}

/**
 * Cancel an Amazon FBA inbound plan via SP-API. Best-effort: errors logged not thrown
 * because we only call this in cleanup paths where we already have a primary failure.
 */
async function cancelInboundPlan(planId: string): Promise<boolean> {
  try {
    await callAmazonSpApi({
      method: 'PUT',
      path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/cancellation`,
      body: {},
    });
    console.log(`[fba-auto] Cancelled Amazon plan ${planId} (retry cleanup)`);
    return true;
  } catch (err: any) {
    console.warn(`[fba-auto] Failed to cancel Amazon plan ${planId}: ${err?.message}`);
    return false;
  }
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
    const chainDepth = Number(req.body.chain_depth ?? 0);

    if (!cin7_transfer_number || !items?.length) {
      return res.status(400).json({
        error: 'Required: cin7_transfer_number, items (array of {sku, quantity})',
      });
    }

    // ---- Multi-lot timeout guard (added 2026-08-01 after TR-00242/00283) ----
    // Each lot = a full Amazon inbound workflow (plan→pack→place→partnered→labels,
    // ~2-4 min). Running N lots sequentially blows the 300s maxDuration mid-lot,
    // leaving an OFFERED plan + frozen draft row. Instead: once we've completed at
    // least one real lot AND the elapsed time passes the soft deadline, DEFER the
    // remaining lots and self-chain (re-invoke this endpoint with the same payload;
    // the (transfer,sku,lot) dedup index skips finished lots).
    const startedAt = Date.now();
    const SOFT_DEADLINE_MS = Number(process.env.FBA_LOT_SOFT_DEADLINE_MS || 60_000);
    const MAX_CHAIN_DEPTH = 6;
    let lotsProcessedThisRun = 0;
    const deferredLots: Array<{ sku: string; lot: string }> = [];

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
        isKit: productData.isKit,
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

      const casePack = productData.casePack;
      const unitsPerBox = casePack.caseQuantity;

      // 3. LOT SPLIT: one Amazon plan per lot (FEFO, full-case multiples), each
      // carrying that lot's TRUE expiration from ShipHero. Kits and SKUs without
      // lot-tracked stock fall back to a single "lot" using the legacy earliest
      // expiration (unchanged behavior).
      let lotPlan: LotAllocation[];
      if (!productData.isKit) {
        let lots = await getLotBreakdown(shipheroToken, item.sku);
        // Optional explicit lot targeting (added 2026-08-20 for supplemental
        // label runs like TR-00306/TR-00325): when the caller passes
        // items[].lot, allocate ONLY from that lot instead of FEFO across all
        // lots. Prevents dedup-skipped lots from silently shifting units onto
        // lots the warehouse didn't stage.
        if (item.lot) {
          const target = lots.find((l) => l.name === item.lot);
          if (!target) {
            results.push({
              sku: item.sku,
              status: 'failed',
              error: `Explicit lot ${item.lot} not found in ShipHero lot breakdown for ${item.sku} (available: ${lots.map((l) => l.name).join(', ') || 'none'})`,
            });
            continue;
          }
          console.log(`[fba-auto] ${item.sku}: explicit lot override → ${item.lot} (${target.availableQty}u available)`);
          lots = [target];
        }
        if (lots.length) {
          try {
            lotPlan = allocateFefoByLot(lots, item.quantity, unitsPerBox);
          } catch (allocErr: any) {
            results.push({
              sku: item.sku,
              status: 'failed',
              error: `Lot allocation failed: ${allocErr?.message}`,
            });
            continue;
          }
        } else {
          console.log(`[fba-auto] ${item.sku} has no lot-tracked stock — single legacy shipment`);
          lotPlan = [{
            name: productData.lotNumber ?? 'UNKNOWN',
            expiresAt: productData.expirationDate.slice(0, 10),
            qty: item.quantity,
            cases: Math.ceil(item.quantity / unitsPerBox),
          }];
        }
      } else {
        console.log(`[fba-auto] ${item.sku} is a kit — single legacy shipment (earliest component expiry)`);
        lotPlan = [{
          name: productData.lotNumber ?? 'UNKNOWN',
          expiresAt: productData.expirationDate.slice(0, 10),
          qty: item.quantity,
          cases: Math.ceil(item.quantity / unitsPerBox),
        }];
      }

      console.log(
        `[fba-auto] Lot plan for ${item.sku}: ` +
          lotPlan.map((l) => `${l.name}=${l.qty}u/${l.cases}c exp ${l.expiresAt}`).join(', ')
      );

      for (const lot of lotPlan) {
      const totalQty = lot.qty;
      const numBoxes = lot.cases;
      const lotSuffix = sanitizeLotName(lot.name);

      // Timeout guard: if we've already burned past the soft deadline and have
      // completed at least one lot this run, defer the rest to a chained
      // invocation rather than dying mid-Amazon-workflow. (Deferral happens
      // BEFORE the reservation insert, so deferred lots stay unreserved.)
      if (lotsProcessedThisRun > 0 && Date.now() - startedAt > SOFT_DEADLINE_MS) {
        console.log(
          `[fba-auto] Soft deadline (${SOFT_DEADLINE_MS}ms) exceeded — deferring ${item.sku} lot ${lot.name} to chained invocation`
        );
        deferredLots.push({ sku: item.sku, lot: lot.name });
        results.push({ sku: item.sku, lot: lot.name, status: 'deferred', reason: 'soft deadline — will be picked up by self-chained re-invocation' });
        continue;
      }

      // Atomic idempotency reservation (per transfer+sku+lot).
      //
      // Historical race (fixed 2026-07-02): the previous SELECT-then-INSERT
      // guard had Amazon's createInboundPlan sitting inside its window. Two
      // concurrent callers ~7s apart (TR-00203 CN-POW-WMNSCREATIORA-30SV)
      // both passed the SELECT and both created independent Amazon plans.
      //
      // New approach: INSERT a `draft` reservation row BEFORE calling Amazon.
      // A partial unique index (fba_shipments_active_transfer_sku_lot_uniq) on
      // (cin7_transfer_number, cin7_sku, cin7_lot) WHERE status NOT IN
      // ('cancelled','failed','voided') makes this atomic. If a concurrent
      // caller already reserved, Postgres returns 23505 → we skip.
      //
      // Then later, onPlanCreated UPDATEs this reserved row with the real
      // plan_id instead of INSERTing a fresh row.
      let reservationId: string | null = null;
      {
        const { data: reserved, error: reserveErr } = await supabase
          .from('fba_shipments')
          .insert({
            name: `CIN7-${cin7_transfer_number}-${item.sku}-${lotSuffix}`,
            marketplace_id: 'ATVPDKIKX0DER',
            ship_from_warehouse_id: warehouseId,
            status: 'draft',
            cin7_transfer_number,
            cin7_sku: item.sku,
            cin7_lot: lot.name,
            lot_expiration: lot.expiresAt,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (reserveErr) {
          // 23505 = unique_violation → active row already exists for this
          // (transfer, sku, lot). Look it up and report as skipped.
          if ((reserveErr as any).code === '23505') {
            const { data: existing } = await supabase
              .from('fba_shipments')
              .select('id, status, plan_id, amazon_shipment_ids')
              .eq('cin7_transfer_number', cin7_transfer_number)
              .eq('cin7_sku', item.sku)
              .eq('cin7_lot', lot.name)
              .not('status', 'in', '("failed","voided","cancelled")')
              .maybeSingle();
            console.log(
              `[fba-auto] Skipping ${item.sku} lot ${lot.name} — active reservation exists ` +
                `(id=${existing?.id} status=${existing?.status} plan=${existing?.plan_id})`
            );
            results.push({
              sku: item.sku,
              lot: lot.name,
              status: 'skipped',
              reason: `Already processed / in-flight — plan ${existing?.plan_id ?? 'pending'}, ` +
                `${(existing?.amazon_shipment_ids as any[] | null)?.length || 0} shipments. ` +
                `To re-run, mark the existing fba_shipments row status='cancelled' first.`,
              existing_plan_id: existing?.plan_id,
              existing_record_id: existing?.id,
            });
            continue;
          }
          // Non-unique error: log and fall through to processing (better to
          // risk a dup than block forever on a transient DB hiccup).
          console.warn(
            `[fba-auto] Reservation insert failed for ${item.sku} lot ${lot.name}: ${reserveErr.message} ` +
              `(code=${(reserveErr as any).code}) — proceeding without reservation`
          );
        } else {
          reservationId = reserved?.id || null;
          console.log(`[fba-auto] Reserved fba_shipments row ${reservationId} for ${item.sku} lot ${lot.name}`);
        }
      }

      console.log(`[fba-auto] ${totalQty} units ÷ ${unitsPerBox} per case = ${numBoxes} boxes (lot ${lot.name})`);
      lotsProcessedThisRun++; // real Amazon work begins for this lot

      // 4. Submit to Amazon FBA
      console.log(`[fba-auto] Submitting to Amazon: ${skuMapping.amz_sku} x ${totalQty}, ${numBoxes} boxes of ${unitsPerBox} each, exp ${lot.expiresAt} (lot ${lot.name})`);

      // Early-persistence: the reservation row already exists (created above
      // atomically before we called Amazon). Once Amazon returns a plan_id,
      // UPDATE that row with the plan_id + box dims so downstream steps and
      // any concurrent retriers can see the plan is bound to this reservation.
      let earlyRecordId: string | null = reservationId;
      const onPlanCreated = async (planId: string) => {
        if (!reservationId) {
          // Reservation insert failed earlier (non-unique error). Fall back to
          // inserting a fresh row so downstream code still has an id to update.
          try {
            const { data: earlyRec, error: earlyErr } = await supabase
              .from('fba_shipments')
              .insert({
                name: `CIN7-${cin7_transfer_number}-${item.sku}-${lotSuffix}`,
                marketplace_id: 'ATVPDKIKX0DER',
                ship_from_warehouse_id: warehouseId,
                status: 'draft',
                plan_id: planId,
                box_length: casePack.boxLength,
                box_width: casePack.boxWidth,
                box_height: casePack.boxHeight,
                box_weight_lbs: casePack.boxWeightLbs,
                cin7_transfer_number,
                cin7_sku: item.sku,
                cin7_lot: lot.name,
                lot_expiration: lot.expiresAt,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .select('id')
              .single();
            if (earlyErr) {
              console.warn(`[fba-auto] Fallback early insert failed: ${earlyErr.message} (code=${earlyErr.code})`);
            } else {
              earlyRecordId = earlyRec?.id || null;
              console.log(`[fba-auto] Fallback early row written: id=${earlyRecordId} plan=${planId}`);
            }
          } catch (e: any) {
            console.warn(`[fba-auto] onPlanCreated fallback threw: ${e?.message || e}`);
          }
          return;
        }
        // Normal path: bind the plan_id + dims to our reserved row.
        try {
          const { error: updErr } = await supabase
            .from('fba_shipments')
            .update({
              plan_id: planId,
              box_length: casePack.boxLength,
              box_width: casePack.boxWidth,
              box_height: casePack.boxHeight,
              box_weight_lbs: casePack.boxWeightLbs,
              updated_at: new Date().toISOString(),
            })
            .eq('id', reservationId);
          if (updErr) {
            console.warn(`[fba-auto] Bind plan_id to reservation failed: ${updErr.message} (code=${updErr.code})`);
          } else {
            console.log(`[fba-auto] Bound plan ${planId} to reservation ${reservationId}`);
          }
        } catch (e: any) {
          console.warn(`[fba-auto] onPlanCreated update threw: ${e?.message || e}`);
        }
      };

      // Cascading retry on PartneredUnavailableError: Amazon's placement algorithm is
      // stochastic — a fresh roll may offer partnered SPD where the previous didn't.
      // We retry up to 3 times. Each retry:
      //   1. Cancels the failed plan on Amazon (so it doesn't leave ACTIVE junk)
      //   2. Marks the early-persisted fba_shipments row as cancelled
      //   3. Calls createFbaInboundShipment again (which mints a fresh inboundPlan)
      //
      // After 3 attempts, send a Telegram alert with full diagnostics and fail the SKU.
      const MAX_PARTNERED_RETRIES = 3;
      let fbaResult: any = null;
      let partneredAttempts: PartneredUnavailableError[] = [];

      for (let attempt = 1; attempt <= MAX_PARTNERED_RETRIES; attempt++) {
        // Reset early-record state for this attempt. Each retry creates a fresh
        // plan + row — the cancelled reservation from the previous attempt is
        // out of the partial unique index, so onPlanCreated's fallback INSERT
        // will succeed.
        earlyRecordId = null;
        if (attempt > 1) reservationId = null;
        try {
          fbaResult = await createFbaInboundShipment(
            warehouseId,
            [{
              sellerSku: skuMapping.amz_sku,
              quantity: totalQty,
              casePack: unitsPerBox,
              cases: numBoxes,
              expiration: lot.expiresAt,
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
              onPlanCreated,
            }
          );
          break; // success
        } catch (err: any) {
          if (err instanceof PartneredUnavailableError) {
            partneredAttempts.push(err);
            console.warn(
              `[fba-auto] PartneredUnavailable attempt ${attempt}/${MAX_PARTNERED_RETRIES} for ${item.sku} ` +
              `plan=${err.diagnostics.planId}: ${err.message}`
            );
            // Cancel the dud plan on Amazon
            await cancelInboundPlan(err.diagnostics.planId);
            // Mark the early-persisted draft row cancelled
            if (earlyRecordId) {
              try {
                await supabase
                  .from('fba_shipments')
                  .update({
                    status: 'cancelled',
                    error_message: `partnered unavailable (attempt ${attempt}/${MAX_PARTNERED_RETRIES})`,
                    cancelled_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', earlyRecordId);
              } catch (markErr: any) {
                console.warn(`[fba-auto] Failed to mark dud row cancelled: ${markErr?.message}`);
              }
            }
            if (attempt < MAX_PARTNERED_RETRIES) {
              // Brief pause before re-rolling (Amazon's placement service caches briefly)
              await new Promise((r) => setTimeout(r, 30_000));
              continue;
            }
          }
          // Either not partnered-related, or we've exhausted retries — bubble up
          throw err;
        }
      }

      if (!fbaResult) {
        // All retries hit PartneredUnavailableError. Build a structured alert.
        const last = partneredAttempts[partneredAttempts.length - 1];
        const placementSummary = last.diagnostics.placements
          .map(p => `• POID ${p.placementOptionId.slice(0, 12)}…  $${p.fee.toFixed(2)}  ${p.shipments} shipments  partneredCoverage=${(p.partneredCoverage * 100).toFixed(0)}%`)
          .join('\n');
        const alertText =
          `🚨 *FBA Pipeline: Partnered Carrier Unavailable After ${MAX_PARTNERED_RETRIES} Retries*\n` +
          `\n` +
          `*Transfer:* ${cin7_transfer_number}\n` +
          `*SKU:* \`${item.sku}\` (Amazon: \`${skuMapping.amz_sku}\`)\n` +
          `*Lot:* \`${lot.name}\` (exp ${lot.expiresAt})\n` +
          `*Quantity:* ${totalQty} units, ${numBoxes} boxes\n` +
          `*Box:* ${casePack.boxLength}×${casePack.boxWidth}×${casePack.boxHeight} in, ${casePack.boxWeightLbs} lbs\n` +
          `\n` +
          `Across ${partneredAttempts.length} fresh plan rolls, Amazon never offered AMAZON_PARTNERED_CARRIER ` +
          `(UPS Ground SPD) coverage on every shipment of any placement option.\n` +
          `\n` +
          `*Last roll's placements:*\n` +
          placementSummary +
          `\n\n` +
          `*Likely root causes (in order of likelihood):*\n` +
          `1. ASIN-level restock/IPI limit at the destination FCs Amazon picked\n` +
          `2. Per-SKU partnered SPD volume threshold exceeded — try splitting transfer\n` +
          `3. Box dimensions edge case (verify in ShipHero: must be ≥6×4×1 in, ≤25" longest, ≤50 lbs)\n` +
          `\n` +
          `*Next steps:* Cancel CIN7 transfer ${cin7_transfer_number} or split into smaller batches. ` +
          `Check Seller Central Restock Limits for ${skuMapping.amz_sku}.`;
        await sendFbaAlert(alertText);

        results.push({
          sku: item.sku,
          lot: lot.name,
          status: 'failed',
          error: `Partnered unavailable after ${MAX_PARTNERED_RETRIES} retries (alert sent to FBA channel)`,
          partnered_attempts: partneredAttempts.length,
          last_diagnostics: last.diagnostics,
        });
        continue;
      }

      // 5. Post-process: fetch labels, upload to Supabase, attach to ShipHero, Telegram notify
      const shipmentIds = fbaResult.shipmentIds || fbaResult.amazon_shipment_ids || [];
      const confirmationIds = fbaResult.shipmentConfirmationIds || [];
      const planId = fbaResult.planId || fbaResult.plan_id || null;

      // Persist the fba_shipments row with full details (the early write at plan creation
      // captured plan_id + status='in_progress'; now update it with shipment IDs, or
      // insert fresh if the early write failed).
      let fbaRecordId: string | null = earlyRecordId;
      try {
        if (earlyRecordId) {
          // Update the existing in_progress row with final shipment IDs
          const { error: updErr } = await supabase
            .from('fba_shipments')
            .update({
              status: 'plan_created',
              amazon_shipment_ids: confirmationIds.length ? confirmationIds : shipmentIds,
              prep_instructions: fbaResult.prepInstructions || fbaResult.prep_instructions || null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', earlyRecordId);
          if (updErr) console.warn(`[fba-auto] fba_shipments update failed: ${updErr.message}`);
          else console.log(`[fba-auto] fba_shipments updated to plan_created: ${earlyRecordId}`);
        } else {
          // Fallback: early write never ran, insert fresh
          const { data: rec, error: recErr } = await supabase
            .from('fba_shipments')
            .insert({
              name: `CIN7-${cin7_transfer_number}-${item.sku}-${lotSuffix}`,
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
              cin7_lot: lot.name,
              lot_expiration: lot.expiresAt,
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
        }
      } catch (recordErr: any) {
        console.warn(`[fba-auto] fba_shipments persistence threw: ${recordErr?.message || recordErr}`);
      }

      let postProcess: any = null;
      try {
        postProcess = await postProcessFbaShipment({
          cin7TransferNumber: cin7_transfer_number,
          shipheroOrderNumberOverride: `${cin7_transfer_number}-${lotSuffix}`,
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
          expiration: lot.expiresAt,
          lot: lot.name,
        });
        console.log(`[fba-auto] post-process done: ${postProcess.attachmentsCreated} attachments (${postProcess.attachmentsSkipped} skipped as dupes), telegram=${postProcess.telegramSent}, errors=${postProcess.errors.length}`);

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
        expiration: lot.expiresAt,
        lot: lot.name,
        amazon_shipment_ids: shipmentIds,
        shipment_confirmation_ids: confirmationIds,
        labels: postProcess?.labels ?? [],
        total_shipping_cost: postProcess?.totalShippingCost,
        placement_fee: postProcess?.placementFee,
        shiphero_order_id: postProcess?.shipheroOrderId,
        attachments_created: postProcess?.attachmentsCreated ?? 0,
        attachments_skipped: postProcess?.attachmentsSkipped ?? 0,
        telegram_sent: postProcess?.telegramSent ?? false,
        post_process_errors: postProcess?.errors ?? [],
        prep: fbaResult.prepInstructions || fbaResult.prep_instructions,
      });
      } // end lot loop
    }

    // ---- Self-chain deferred lots (multi-lot timeout guard) ----
    // Re-invoke this same endpoint with the ORIGINAL payload. The dedup index
    // skips every lot already reserved/completed, so the chained run converges
    // on the deferred lots with a fresh 300s budget. We only wait ~8s for the
    // request to be delivered (the chained invocation runs independently).
    if (deferredLots.length > 0) {
      if (chainDepth >= MAX_CHAIN_DEPTH) {
        const msg =
          `🚨 *FBA Pipeline: chain depth ${chainDepth} exhausted on ${cin7_transfer_number}* — ` +
          `${deferredLots.length} lot(s) still pending: ` +
          deferredLots.map((d) => `\`${d.sku}/${d.lot}\``).join(', ') +
          `. Re-fire auto-submit manually with the same payload.`;
        console.error(`[fba-auto] ${msg}`);
        await sendFbaAlert(msg);
      } else {
        const selfUrl = process.env.FBA_SELF_URL
          || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
          || 'https://shiphero-shipstation-bridge.vercel.app';
        console.log(
          `[fba-auto] Self-chaining ${deferredLots.length} deferred lot(s) via ${selfUrl} (depth ${chainDepth + 1})`
        );
        try {
          const chainReq = fetch(`${selfUrl}/api/fba/auto-submit`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.CRON_SECRET}`,
            },
            body: JSON.stringify({ cin7_transfer_number, items, chain_depth: chainDepth + 1 }),
          }).then(
            (r) => console.log(`[fba-auto] Chained invocation returned ${r.status}`),
            (e) => console.warn(`[fba-auto] Chained invocation fetch error: ${e?.message}`)
          );
          // Give the request time to be delivered; the chained function keeps
          // running server-side even if this lambda freezes afterwards.
          await Promise.race([chainReq, new Promise((r) => setTimeout(r, 8_000))]);
        } catch (chainErr: any) {
          console.warn(`[fba-auto] Self-chain failed: ${chainErr?.message}`);
          await sendFbaAlert(
            `⚠️ FBA auto-submit self-chain failed on ${cin7_transfer_number} — re-fire the same payload manually to finish ${deferredLots.length} lot(s).`
          );
        }
      }
    }

    res.status(200).json({
      cin7_transfer_number,
      processed: results.length,
      successful: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
      deferred: deferredLots.length,
      chain_depth: chainDepth,
      results,
    });
  } catch (error) {
    console.error('[fba-auto] Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
