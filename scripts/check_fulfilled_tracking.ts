/**
 * check_fulfilled_tracking.ts
 *
 * For the 236 ClearShip orders marked "fulfilled" in ShipHero, pull the actual
 * shipment / tracking number / carrier so we know if there's data to push
 * back to TikTok before we wipe their status.
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}
let _tok: string | null = null;
async function tok() { return (_tok ??= await getToken()); }

async function shGql(query: string): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok()}` },
      body: JSON.stringify({ query }),
    });
    const json: any = await resp.json();
    if (json.errors?.find((e: any) => e.code === 30)) {
      const wait = (parseInt(json.errors[0]?.time_remaining) || 15) + 2;
      process.stdout.write(`\r  ⏳ rate-limited ${wait}s   `);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
}

async function main() {
  const audit = JSON.parse(fs.readFileSync('/tmp/clearship_audit.json', 'utf8'));
  const fulfilled = audit.in_shiphero_orders.filter((o: any) => o.status === 'fulfilled');
  console.log(`\nChecking ${fulfilled.length} "fulfilled" ClearShip orders for tracking...\n`);

  const withTracking: any[] = [];
  const noTracking: any[] = [];

  for (let i = 0; i < fulfilled.length; i++) {
    const o = fulfilled[i];
    process.stdout.write(`\r  [${i+1}/${fulfilled.length}] with_tracking=${withTracking.length} no_tracking=${noTracking.length}   `);

    const q = `{ orders(order_number: "${o.order_number}") { data(first:1) { edges { node {
      id order_number fulfillment_status
      shipments {
        id created_date delivered
        shipping_labels {
          tracking_number
          carrier
          shipping_name
          shipping_method
          status
          source
          created_date
        }
      }
    } } } } }`;
    try {
      const d = await shGql(q);
      const node = d?.orders?.data?.edges?.[0]?.node;
      const shipments = node?.shipments || [];
      const labels: any[] = [];
      for (const s of shipments) {
        for (const lbl of (s.shipping_labels || [])) {
          if (lbl.tracking_number) labels.push({ ...lbl, shipment_id: s.id, shipment_created: s.created_date });
        }
      }
      if (labels.length > 0) {
        withTracking.push({ order_number: o.order_number, labels });
      } else {
        noTracking.push({ order_number: o.order_number, shipments_count: shipments.length });
      }
    } catch (e) {
      console.error(`\n  ✗ ${o.order_number}: ${e}`);
    }
  }

  console.log(`\n\n=== RESULTS ===`);
  console.log(`Fulfilled WITH tracking:    ${withTracking.length}`);
  console.log(`Fulfilled WITHOUT tracking: ${noTracking.length}\n`);

  if (withTracking.length > 0) {
    console.log('=== Orders with REAL tracking (need to push to TikTok) ===');
    // Group by carrier
    const byCarrier: Record<string, number> = {};
    for (const o of withTracking) {
      for (const lbl of o.labels) {
        byCarrier[lbl.carrier || '(unknown)'] = (byCarrier[lbl.carrier || '(unknown)'] || 0) + 1;
      }
    }
    console.log('By carrier:');
    for (const [c, n] of Object.entries(byCarrier)) console.log(`  ${c}: ${n}`);

    // Sample
    console.log('\nSample (first 10):');
    for (const o of withTracking.slice(0, 10)) {
      for (const lbl of o.labels) {
        console.log(`  ${o.order_number} → ${lbl.tracking_number} (${lbl.carrier}, ${lbl.shipping_method}, source: ${lbl.source})`);
      }
    }
  }

  fs.writeFileSync('/tmp/fulfilled_tracking.json', JSON.stringify({ with_tracking: withTracking, no_tracking: noTracking }, null, 2));
  console.log(`\nSaved full data to /tmp/fulfilled_tracking.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
