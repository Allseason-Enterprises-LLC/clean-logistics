/**
 * push_clearship_tracking_to_tiktok.ts
 *
 * For the 236 "fulfilled" ClearShip orders that have real USPS tracking in ShipHero,
 * push tracking back to TikTok using the shipping_info/update bypass endpoint
 * (works on partner-warehouse / held orders, which is what ClearShip-routed orders are).
 *
 * Reads /tmp/fulfilled_tracking.json (output of check_fulfilled_tracking.ts)
 * Writes results to /tmp/tiktok_push_results.json
 *
 * Usage:
 *   npx tsx scripts/push_clearship_tracking_to_tiktok.ts [--dry-run] [--limit=N]
 */
import { getTikTokCredentials, updateShippingInfo, getShippingProviders } from '../lib/tiktok-api';
import { normalizeCarrier, resolveProviderIdWithFallback } from '../lib/tiktok-carriers';
import * as fs from 'fs';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  return arg ? parseInt(arg.split('=')[1]) : Infinity;
})();

async function main() {
  const raw = JSON.parse(fs.readFileSync('/tmp/fulfilled_tracking.json', 'utf8'));
  const allOrders: any[] = raw.with_tracking;

  // Pick best label per order (newest valid one)
  const orders = allOrders.slice(0, LIMIT).map((o: any) => {
    // Prefer a 'valid' status label; otherwise newest
    const valid = o.labels.find((l: any) => !l.status || l.status === 'valid');
    const chosen = valid || o.labels[0];
    return {
      order_number: o.order_number,
      tracking_number: chosen.tracking_number,
      carrier: chosen.carrier || chosen.shipping_name || 'usps_modern',
    };
  });

  console.log(`\n🚚 Pushing tracking for ${orders.length} fulfilled ClearShip orders to TikTok`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const creds = await getTikTokCredentials();

  // Get TikTok providers once (or use fallback map if scope missing)
  let providers: Array<{ id: string; name: string }> = [];
  try {
    providers = await getShippingProviders(creds);
    console.log(`Loaded ${providers.length} TikTok shipping providers`);
  } catch (err) {
    console.warn(`getShippingProviders failed (${(err as Error).message}); using fallback map`);
  }

  // All these are usps_modern → USPS — resolve once
  const usCarrier = normalizeCarrier('usps_modern');
  const uspsProviderId = resolveProviderIdWithFallback(usCarrier, providers);
  if (!uspsProviderId) {
    console.error('Cannot resolve USPS provider id — check tiktok-carriers.ts');
    process.exit(1);
  }
  console.log(`USPS provider id: ${uspsProviderId}\n`);

  const results: any[] = [];
  let pushed = 0;
  let refused = 0;
  let errored = 0;

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    // Strip TT- prefix to get raw TikTok order id
    const tiktokId = o.order_number.replace(/^TT-/, '');
    process.stdout.write(`\r  [${i+1}/${orders.length}] pushed=${pushed} refused=${refused} errors=${errored}   `);

    if (DRY_RUN) {
      results.push({ ...o, tiktok_id: tiktokId, status: 'dry-run' });
      continue;
    }

    try {
      await updateShippingInfo(creds, tiktokId, o.tracking_number, uspsProviderId);
      pushed++;
      results.push({ ...o, tiktok_id: tiktokId, status: 'ok' });
      await new Promise(r => setTimeout(r, 150));  // mild rate limit
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      const codeMatch = msg.match(/code=(\d+)/);
      const code = codeMatch ? Number(codeMatch[1]) : null;

      // 21008026 = package already exists / declared, treat as "already pushed"
      // 21001001 = invalid params (typically: order already IN_TRANSIT)
      if (code === 21008026 || code === 21001001) {
        refused++;
        results.push({ ...o, tiktok_id: tiktokId, status: 'already_pushed', code, message: msg });
      } else {
        errored++;
        results.push({ ...o, tiktok_id: tiktokId, status: 'error', code, message: msg });
        process.stdout.write(`\n  ✗ ${o.order_number}: ${msg}\n`);
      }
    }
  }

  console.log(`\n\n=== RESULTS ===`);
  console.log(`Tracking pushed successfully: ${pushed}`);
  console.log(`Already pushed (refused):     ${refused}`);
  console.log(`Errors:                       ${errored}`);

  fs.writeFileSync('/tmp/tiktok_push_results.json', JSON.stringify(results, null, 2));
  console.log(`\nFull results: /tmp/tiktok_push_results.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
