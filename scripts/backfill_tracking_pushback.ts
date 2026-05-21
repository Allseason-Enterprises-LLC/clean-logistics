/**
 * One-shot backfill: push tracking from ShipHero back to TikTok for all
 * bridge rows that are still `status='imported'` (i.e. shipped in ShipHero
 * but tracking never got posted to TikTok).
 *
 * Uses reconcileStuckBridgeRows() — the same function the 5-min cron uses —
 * but drives it in a tight loop until no `imported` rows remain (or all
 * remaining have no tracking yet).
 *
 * Safe to re-run: already-shipped rows are skipped, errors are recorded.
 *
 * Run:
 *   set -a && source .env.prod.local && set +a
 *   npx tsx scripts/backfill_tracking_pushback.ts
 */

import { reconcileStuckBridgeRows } from '../lib/tiktok-bridge';
import { supabase } from '../lib/supabase';

const BATCH_SIZE = 50; // rows per reconcile call
const SLEEP_BETWEEN_BATCHES_MS = 1000;
const MAX_EMPTY_BATCHES = 3; // stop after N consecutive batches with nothing new to push

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getImportedCount(): Promise<number> {
  const { count } = await supabase
    .from('tiktok_shiphero_orders')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'imported');
  return count ?? 0;
}

async function main() {
  console.log('[tracking-backfill] Starting tracking pushback...');

  const initialCount = await getImportedCount();
  console.log(`[tracking-backfill] ${initialCount} rows currently at status=imported`);

  let totalPushed = 0;
  let totalSkippedNoTracking = 0;
  let totalSkippedRefused = 0;
  let totalErrors = 0;
  let emptyBatches = 0;
  let batchNum = 0;
  const startTs = Date.now();

  while (true) {
    batchNum++;
    console.log(`\n[tracking-backfill] === Batch ${batchNum} ===`);

    const result = await reconcileStuckBridgeRows(BATCH_SIZE);

    totalPushed += result.pushed;
    totalSkippedNoTracking += result.skipped_no_tracking;
    totalSkippedRefused += result.skipped_tiktok_refused;
    totalErrors += result.errors.length;

    const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);
    console.log(
      `[tracking-backfill] Batch result: pushed=${result.pushed} no_tracking=${result.skipped_no_tracking} refused=${result.skipped_tiktok_refused} errors=${result.errors.length} | cumulative: pushed=${totalPushed} elapsed=${elapsed}s`
    );

    if (result.errors.length > 0) {
      for (const e of result.errors) {
        console.error(`  ERROR ${e.tiktokOrderId}: ${e.message}`);
      }
    }

    // If nothing was pushed AND nothing had tracking yet, increment empty counter
    if (result.pushed === 0 && result.skipped_no_tracking === result.scanned) {
      emptyBatches++;
      console.log(`[tracking-backfill] All ${result.scanned} rows have no tracking yet (${emptyBatches}/${MAX_EMPTY_BATCHES} empty batches)`);
      if (emptyBatches >= MAX_EMPTY_BATCHES) {
        console.log('[tracking-backfill] No more tracking available — remaining orders not yet shipped. Stopping.');
        break;
      }
    } else {
      emptyBatches = 0;
    }

    // If scanned < batch size, we've exhausted the queue
    if (result.scanned < BATCH_SIZE) {
      console.log('[tracking-backfill] Scanned fewer than batch size — queue exhausted.');
      break;
    }

    await sleep(SLEEP_BETWEEN_BATCHES_MS);
  }

  const remaining = await getImportedCount();
  const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);

  console.log('\n[tracking-backfill] DONE');
  console.log(`  Tracking pushed to TikTok: ${totalPushed}`);
  console.log(`  Skipped (not shipped yet): ${totalSkippedNoTracking}`);
  console.log(`  Skipped (TikTok refused):  ${totalSkippedRefused}`);
  console.log(`  Errors:                    ${totalErrors}`);
  console.log(`  Remaining imported rows:   ${remaining}`);
  console.log(`  Elapsed: ${elapsed}s`);
}

main().catch((e) => {
  console.error('[tracking-backfill] Fatal error:', e);
  process.exit(1);
});
