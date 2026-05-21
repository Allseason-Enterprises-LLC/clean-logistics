/**
 * One-shot script: push tracking to TikTok for orders that are already shipped
 * in ShipHero but whose tracking never reached TikTok.
 *
 * These orders already have packages declared on TikTok's side (the native
 * integration declared them). So we skip declarePackage and instead:
 *   1. Fetch existing package_id from TikTok getOrderDetail
 *   2. Call shipPackage with the tracking number from ShipHero
 *
 * Run:
 *   set -a && source .env.prod.local && set +a
 *   npx tsx scripts/push_tracking_from_csv.ts
 */

import * as fs from 'fs';
import { supabase } from '../lib/supabase';
import { getTikTokCredentials, getOrderDetail, shipPackage, getShippingProviders } from '../lib/tiktok-api';
import { normalizeCarrier, resolveProviderIdWithFallback } from '../lib/tiktok-carriers';

const TRACKING_MAP_PATH = '/tmp/shiphero_tracking_map.json';
const RESULTS_PATH = '/tmp/push_tracking_results.json';
const TIKTOK_BATCH_SIZE = 50;
const SLEEP_MS = 800;
const SLEEP_BETWEEN_BATCHES_MS = 1500;

interface TrackingEntry {
  tracking: string;
  carrier: string;
  sh_order_number: string;
}

interface ResultRow {
  tiktok_order_id: string;
  outcome: 'pushed' | 'skipped_already_done' | 'skipped_tiktok_refused' | 'skipped_no_package' | 'skipped_no_bridge_row' | 'error';
  tracking?: string;
  error?: string;
  ts: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const trackingMap: Record<string, TrackingEntry> = JSON.parse(
    fs.readFileSync(TRACKING_MAP_PATH, 'utf-8')
  );
  const orderIds = Object.keys(trackingMap);
  console.log(`[push-tracking] Loaded ${orderIds.length} orders from tracking map`);

  // Load prior results to resume safely
  let results: ResultRow[] = [];
  if (fs.existsSync(RESULTS_PATH)) {
    results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    console.log(`[push-tracking] Resuming — ${results.length} prior results loaded`);
  }
  const alreadyDone = new Set(
    results
      .filter(r => r.outcome === 'pushed' || r.outcome === 'skipped_already_done')
      .map(r => r.tiktok_order_id)
  );

  const toProcess = orderIds.filter(id => !alreadyDone.has(id));
  console.log(`[push-tracking] Need to process: ${toProcess.length} (skipping ${alreadyDone.size} already done)`);
  if (toProcess.length === 0) { console.log('[push-tracking] Nothing to do.'); return; }

  const creds = await getTikTokCredentials();

  // Pre-fetch shipping providers once
  let providers: Array<{ id: string; name: string }> = [];
  try {
    providers = await getShippingProviders(creds);
    console.log(`[push-tracking] Loaded ${providers.length} shipping providers`);
  } catch (err) {
    console.warn(`[push-tracking] getShippingProviders failed; using fallback carrier map`);
  }

  // Fetch bridge rows for all orders
  const { data: bridgeRows, error: bridgeError } = await supabase
    .from('tiktok_shiphero_orders')
    .select('id, tiktok_order_id, status, tracking_number')
    .in('tiktok_order_id', toProcess);
  if (bridgeError) throw new Error(`Supabase fetch failed: ${bridgeError.message}`);
  const bridgeByOrderId = new Map((bridgeRows || []).map((r: any) => [r.tiktok_order_id, r]));

  let pushed = 0, skippedAlready = 0, skippedRefused = 0, skippedNoPackage = 0, skippedNoRow = 0, errors = 0;

  // Process in batches to fetch TikTok order details efficiently
  for (let i = 0; i < toProcess.length; i += TIKTOK_BATCH_SIZE) {
    const chunk = toProcess.slice(i, i + TIKTOK_BATCH_SIZE);
    const batchNum = Math.floor(i / TIKTOK_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toProcess.length / TIKTOK_BATCH_SIZE);
    console.log(`\n[push-tracking] === Batch ${batchNum}/${totalBatches} (${chunk.length} orders) ===`);

    // Fetch order details from TikTok to get existing package_ids
    let details: any[] = [];
    try {
      details = await getOrderDetail(creds, chunk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[push-tracking] getOrderDetail failed for batch: ${msg}`);
      for (const id of chunk) {
        results.push({ tiktok_order_id: id, outcome: 'error', error: `getOrderDetail failed: ${msg}`, ts: new Date().toISOString() });
        errors++;
      }
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      await sleep(SLEEP_BETWEEN_BATCHES_MS);
      continue;
    }

    const detailById = new Map(details.map((d: any) => [d.id || d.order_id, d]));

    for (const tiktokOrderId of chunk) {
      const entry = trackingMap[tiktokOrderId];
      const bridgeRow = bridgeByOrderId.get(tiktokOrderId);
      const detail = detailById.get(tiktokOrderId);

      if (!bridgeRow) {
        console.warn(`[push-tracking] No bridge row for ${tiktokOrderId}`);
        results.push({ tiktok_order_id: tiktokOrderId, outcome: 'skipped_no_bridge_row', ts: new Date().toISOString() });
        skippedNoRow++;
        fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
        continue;
      }

      if (bridgeRow.status === 'tracking_confirmed') {
        console.log(`[push-tracking] ${tiktokOrderId} already tracking_confirmed`);
        results.push({ tiktok_order_id: tiktokOrderId, outcome: 'skipped_already_done', ts: new Date().toISOString() });
        skippedAlready++;
        fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
        continue;
      }

      if (!detail) {
        console.warn(`[push-tracking] No TikTok detail for ${tiktokOrderId}`);
        results.push({ tiktok_order_id: tiktokOrderId, outcome: 'error', error: 'no detail from TikTok', ts: new Date().toISOString() });
        errors++;
        fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
        continue;
      }

      // Get existing package_id(s) from TikTok order detail
      const packages: any[] = detail.packages || [];
      if (packages.length === 0) {
        console.warn(`[push-tracking] No packages on TikTok order ${tiktokOrderId} — skipping`);
        results.push({ tiktok_order_id: tiktokOrderId, outcome: 'skipped_no_package', ts: new Date().toISOString() });
        skippedNoPackage++;
        fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
        continue;
      }

      // Use the first package (single-package shipments)
      const packageId = packages[0].id;
      const canonical = normalizeCarrier(entry.carrier);
      const providerId = resolveProviderIdWithFallback(canonical, providers);

      if (!providerId) {
        const msg = `Cannot resolve TikTok provider for carrier "${entry.carrier}"`;
        console.error(`[push-tracking] ${tiktokOrderId}: ${msg}`);
        results.push({ tiktok_order_id: tiktokOrderId, outcome: 'error', error: msg, ts: new Date().toISOString() });
        errors++;
        fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
        continue;
      }

      console.log(`[push-tracking] Shipping package ${packageId} for ${tiktokOrderId}: ${entry.tracking}`);

      try {
        // Mark shipped in bridge first
        await supabase.from('tiktok_shiphero_orders').update({
          carrier: entry.carrier,
          tracking_number: entry.tracking,
          shipped_at: new Date().toISOString(),
          status: 'shipped',
        }).eq('id', bridgeRow.id);

        // Call shipPackage with existing package_id (skip declarePackage)
        await shipPackage(creds, packageId, entry.tracking, providerId);

        // Mark confirmed
        await supabase.from('tiktok_shiphero_orders').update({
          tracking_posted_at: new Date().toISOString(),
          status: 'tracking_confirmed',
        }).eq('id', bridgeRow.id);

        console.log(`[push-tracking] ✓ ${tiktokOrderId}`);
        results.push({ tiktok_order_id: tiktokOrderId, outcome: 'pushed', tracking: entry.tracking, ts: new Date().toISOString() });
        pushed++;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[push-tracking] ✗ ${tiktokOrderId}: ${msg.slice(0, 120)}`);
        await supabase.from('tiktok_shiphero_orders').update({
          status: 'error',
          error_message: `push_tracking_from_csv: ${msg.slice(0, 200)}`,
        }).eq('id', bridgeRow.id);
        results.push({ tiktok_order_id: tiktokOrderId, outcome: 'error', error: msg.slice(0, 150), ts: new Date().toISOString() });
        errors++;
      }

      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      await sleep(SLEEP_MS);
    }

    console.log(`[push-tracking] Progress: pushed=${pushed} skippedRefused=${skippedRefused} skippedNoPackage=${skippedNoPackage} errors=${errors}`);
    await sleep(SLEEP_BETWEEN_BATCHES_MS);
  }

  console.log('\n[push-tracking] DONE');
  console.log(`  Pushed to TikTok:        ${pushed}`);
  console.log(`  Already confirmed:       ${skippedAlready}`);
  console.log(`  No package on TikTok:    ${skippedNoPackage}`);
  console.log(`  No bridge row:           ${skippedNoRow}`);
  console.log(`  Errors:                  ${errors}`);
  console.log(`  Results: ${RESULTS_PATH}`);
}

main().catch(e => {
  console.error('[push-tracking] Fatal:', e);
  process.exit(1);
});
