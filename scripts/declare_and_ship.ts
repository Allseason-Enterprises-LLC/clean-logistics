/**
 * Attempt: declare a package + ship for orders TikTok hasn't declared yet.
 * Targets the "skipped_no_package" outcomes from push_tracking_from_csv.ts.
 */
import * as fs from 'fs';
import { getTikTokCredentials, getOrderDetail, declarePackage, shipPackage, getShippingProviders } from '../lib/tiktok-api';
import { normalizeCarrier, resolveProviderIdWithFallback } from '../lib/tiktok-carriers';
import { supabase } from '../lib/supabase';

async function main() {
  const targetIds = process.argv.slice(2);
  if (targetIds.length === 0) {
    // Default: load from push_tracking_results.json (skipped_no_package outcomes)
    const results = JSON.parse(fs.readFileSync('/tmp/push_tracking_results.json', 'utf8'));
    const ids = results.filter((r: any) => r.outcome === 'skipped_no_package').map((r: any) => r.tiktok_order_id);
    targetIds.push(...ids);
  }
  console.log(`Targets (${targetIds.length}):`, targetIds);

  const trackingMap = JSON.parse(fs.readFileSync('/tmp/shiphero_tracking_map.json', 'utf8'));
  const creds = await getTikTokCredentials();

  let providers: Array<{ id: string; name: string }> = [];
  try {
    providers = await getShippingProviders(creds);
    console.log(`Loaded ${providers.length} live providers`);
  } catch (e) {
    console.warn('getShippingProviders failed, using fallback map');
  }

  for (const tid of targetIds) {
    console.log(`\n=== ${tid} ===`);
    const entry = trackingMap[tid];
    if (!entry) {
      console.log('  No tracking entry. Skip.');
      continue;
    }

    // Get current line items
    const details = await getOrderDetail(creds, [tid]);
    const detail = details[0];
    if (!detail) {
      console.log('  No TikTok detail.');
      continue;
    }
    console.log(`  is_on_hold: ${detail.is_on_hold_order}  warehouse_id: ${detail.warehouse_id}  packages: ${detail.packages?.length || 0}`);
    if (detail.packages?.length > 0) {
      console.log('  Already has package — re-running shipPackage');
      const packageId = detail.packages[0].id;
      const canonical = normalizeCarrier(entry.carrier);
      const providerId = resolveProviderIdWithFallback(canonical, providers);
      try {
        await shipPackage(creds, packageId, entry.tracking, providerId!);
        console.log(`  ✓ Pushed tracking ${entry.tracking}`);
      } catch (e: any) {
        console.log(`  ✗ ${e.message.slice(0, 200)}`);
      }
      continue;
    }

    // Try declarePackage
    const lineItemIds = (detail.line_items || []).map((li: any) => li.id);
    console.log(`  Calling declarePackage with ${lineItemIds.length} line items: ${lineItemIds.join(',')}`);

    let packageId: string | undefined;
    try {
      const r = await declarePackage(creds, tid, lineItemIds);
      packageId = r.package_id;
      console.log(`  ✓ declarePackage → package_id=${packageId}`);
    } catch (e: any) {
      console.log(`  ✗ declarePackage failed: ${e.message.slice(0, 300)}`);
      continue;
    }

    if (!packageId) continue;

    // Resolve provider
    const canonical = normalizeCarrier(entry.carrier);
    const providerId = resolveProviderIdWithFallback(canonical, providers);
    if (!providerId) {
      console.log(`  ✗ Cannot resolve provider for "${entry.carrier}"`);
      continue;
    }
    console.log(`  Provider: ${providerId}`);

    try {
      await shipPackage(creds, packageId, entry.tracking, providerId);
      console.log(`  ✓ shipPackage success — tracking ${entry.tracking} pushed`);

      // Update bridge
      await supabase
        .from('tiktok_shiphero_orders')
        .update({
          carrier: entry.carrier,
          tracking_number: entry.tracking,
          shipped_at: new Date().toISOString(),
          tracking_posted_at: new Date().toISOString(),
          status: 'tracking_confirmed',
        })
        .eq('tiktok_order_id', tid);
    } catch (e: any) {
      console.log(`  ✗ shipPackage failed: ${e.message.slice(0, 300)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
