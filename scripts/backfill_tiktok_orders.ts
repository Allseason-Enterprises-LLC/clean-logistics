/**
 * One-shot backfill: import missing TikTok orders into ShipHero.
 *
 * Reads order IDs from /tmp/missing_orders.json, fetches full detail from
 * TikTok in batches of 50, then runs each through importOrder() — the same
 * function the cron uses. So all the address parsing (district_info, full_name
 * fallback, etc.), FBT skip logic, SKU matching, and ShipHero order_create
 * happens identically to the live path.
 *
 * Logs each result to /tmp/backfill_results.json for audit. Resumable: if you
 * Ctrl-C and re-run, already-imported orders are skipped via the existing
 * idempotency check in the bridge.
 *
 * Run:
 *   set -a && source .env.prod.local && set +a
 *   npx tsx scripts/backfill_tiktok_orders.ts
 */

import * as fs from 'fs';
import { importOrder } from '../lib/tiktok-bridge';
import { getTikTokCredentials, getOrderDetail } from '../lib/tiktok-api';
import { getLasVegasSkuPatterns } from '../lib/tiktok-routing';
import { supabase } from '../lib/supabase';

interface ResultRow {
  tiktok_order_id: string;
  outcome: 'imported' | 'skipped_no_match' | 'skipped_already_present' | 'error';
  error?: string;
  ts: string;
}

const RESULTS_PATH = '/tmp/backfill_results.json';
const MISSING_PATH = '/tmp/missing_orders.json';
const TIKTOK_BATCH_SIZE = 50; // /order/202309/orders/detail accepts up to 50 ids
const SLEEP_BETWEEN_IMPORTS_MS = 800; // be gentle on ShipHero
const SLEEP_BETWEEN_BATCHES_MS = 1500;

async function main() {
  const allMissing: string[] = JSON.parse(fs.readFileSync(MISSING_PATH, 'utf-8'));

  // Sort oldest-first by treating the numeric ID as a proxy for time
  // (TikTok IDs are time-ordered). Smaller ID = older order.
  allMissing.sort();

  console.log(`[backfill] Loaded ${allMissing.length} missing TikTok order IDs`);
  console.log(`[backfill] Sorted oldest-first (smallest ID first)`);

  // Load existing results to resume safely
  let results: ResultRow[] = [];
  if (fs.existsSync(RESULTS_PATH)) {
    results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    console.log(`[backfill] Resuming — ${results.length} prior results loaded`);
  }
  const alreadyProcessed = new Set(
    results.filter((r) => r.outcome === 'imported' || r.outcome === 'skipped_already_present')
      .map((r) => r.tiktok_order_id)
  );

  // Also pre-skip anything Supabase already shows as imported (extra safety)
  const { data: existingRows } = await supabase
    .from('tiktok_shiphero_orders')
    .select('tiktok_order_id, status')
    .in('tiktok_order_id', allMissing);
  for (const row of existingRows || []) {
    if (row.status === 'imported') alreadyProcessed.add(row.tiktok_order_id);
  }

  const toProcess = allMissing.filter((id) => !alreadyProcessed.has(id));
  console.log(`[backfill] Need to process: ${toProcess.length}  (skipping ${alreadyProcessed.size} already done)`);

  if (toProcess.length === 0) {
    console.log('[backfill] Nothing to do.');
    return;
  }

  const creds = await getTikTokCredentials();
  const patterns = await getLasVegasSkuPatterns();
  console.log(`[backfill] Loaded ${patterns.length} Las Vegas SKU patterns`);

  let imported = 0;
  let skippedNoMatch = 0;
  let errors = 0;
  const startTs = Date.now();

  for (let i = 0; i < toProcess.length; i += TIKTOK_BATCH_SIZE) {
    const chunk = toProcess.slice(i, i + TIKTOK_BATCH_SIZE);
    const batchNum = Math.floor(i / TIKTOK_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toProcess.length / TIKTOK_BATCH_SIZE);

    console.log(`\n[backfill] === Batch ${batchNum}/${totalBatches} (${chunk.length} orders) ===`);

    let details: any[];
    try {
      details = await getOrderDetail(creds, chunk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] Batch fetch failed: ${msg}`);
      // Mark every order in this chunk as errored, then continue
      for (const id of chunk) {
        results.push({
          tiktok_order_id: id,
          outcome: 'error',
          error: `getOrderDetail failed: ${msg}`,
          ts: new Date().toISOString(),
        });
        errors++;
      }
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      await sleep(SLEEP_BETWEEN_BATCHES_MS);
      continue;
    }

    const detailById = new Map(details.map((d: any) => [d.id || d.order_id, d]));

    for (const tikTokId of chunk) {
      const detail = detailById.get(tikTokId);
      if (!detail) {
        console.warn(`[backfill] No detail returned for ${tikTokId} — recording error`);
        results.push({
          tiktok_order_id: tikTokId,
          outcome: 'error',
          error: 'TikTok did not return detail (order may be cancelled / outside scope)',
          ts: new Date().toISOString(),
        });
        errors++;
        continue;
      }

      try {
        const outcome = await importOrder(creds, detail, patterns, { skipSkuAllowlist: true });
        results.push({
          tiktok_order_id: tikTokId,
          outcome,
          ts: new Date().toISOString(),
        });
        if (outcome === 'imported') imported++;
        else skippedNoMatch++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // ShipHero rejects duplicate order_number with code 6 / "already exists".
        // Treat as success — the order is in ShipHero (from a prior run, the
        // live cron, or the native integration), so no action needed.
        if (msg.includes('already exists') || msg.includes('"code":6')) {
          console.log(`[backfill] ${tikTokId} already in ShipHero — counting as imported`);
          results.push({
            tiktok_order_id: tikTokId,
            outcome: 'skipped_already_present',
            ts: new Date().toISOString(),
          });
          // Make sure the bridge row reflects reality
          await supabase
            .from('tiktok_shiphero_orders')
            .upsert(
              { tiktok_order_id: tikTokId, status: 'imported', error_message: null },
              { onConflict: 'tiktok_order_id' }
            );
        } else {
          console.error(`[backfill] importOrder(${tikTokId}) failed: ${msg}`);
          results.push({
            tiktok_order_id: tikTokId,
            outcome: 'error',
            error: msg,
            ts: new Date().toISOString(),
          });
          errors++;

          await supabase
            .from('tiktok_shiphero_orders')
            .upsert(
              { tiktok_order_id: tikTokId, status: 'error', error_message: msg },
              { onConflict: 'tiktok_order_id' }
            );
        }
      }

      // Persist progress after every order so a crash never loses state
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      await sleep(SLEEP_BETWEEN_IMPORTS_MS);
    }

    const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);
    const remaining = toProcess.length - (i + chunk.length);
    const ratePerSec = (i + chunk.length) / Math.max(parseFloat(elapsed), 1);
    const etaSec = remaining / Math.max(ratePerSec, 0.1);
    console.log(
      `[backfill] Progress: imported=${imported} skipped=${skippedNoMatch} errors=${errors}  ` +
        `elapsed=${elapsed}s  ETA=${(etaSec / 60).toFixed(1)}m`
    );

    await sleep(SLEEP_BETWEEN_BATCHES_MS);
  }

  console.log(`\n[backfill] DONE`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (no SKU match / FBT): ${skippedNoMatch}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Results saved to: ${RESULTS_PATH}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('[backfill] Fatal error:', e);
  process.exit(1);
});
