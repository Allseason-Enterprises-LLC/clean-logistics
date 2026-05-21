/**
 * Diagnose: for a list of TikTok order IDs from a CSV, report bridge state +
 * ShipHero fulfillment status.
 *
 * Usage:
 *   set -a && source .env.prod.local && set +a
 *   npx tsx scripts/diagnose_csv_orders.ts
 *
 * Reads:  /tmp/tiktok_orders_csv_state.json  (full CSV state — produced by parse step)
 * Writes: /tmp/diagnosis_results.json
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken(): Promise<string> {
  const { data } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID).eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function gql(token: string, q: string, vars: any = {}): Promise<any> {
  while (true) {
    const r = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: vars }),
    });
    const json = await r.json();
    if (json.errors?.[0]?.code === 30) {
      const wait = parseInt((json.errors[0].time_remaining || '2').toString().replace(/\D/g, '') || '2');
      await new Promise(res => setTimeout(res, (wait + 1) * 1000));
      continue;
    }
    return json;
  }
}

async function main() {
  const csvState = JSON.parse(fs.readFileSync('/tmp/tiktok_orders_csv_state.json', 'utf8'));
  const allIds: string[] = csvState.map((o: any) => o.tiktok_id);
  console.log(`Loaded ${allIds.length} order IDs from CSV state file`);

  // 1) Query Supabase bridge in batches of 500
  console.log('\n[1/2] Querying Supabase bridge table...');
  const bridgeMap = new Map<string, any>();
  for (let i = 0; i < allIds.length; i += 500) {
    const slice = allIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from('tiktok_shiphero_orders')
      .select('tiktok_order_id, status, shiphero_order_id, shiphero_order_number, tracking_number, tracking_posted_at, error_message, shipped_at')
      .in('tiktok_order_id', slice);
    if (error) throw error;
    (data || []).forEach((r: any) => bridgeMap.set(r.tiktok_order_id, r));
    process.stdout.write(`\r  ${Math.min(i + 500, allIds.length)}/${allIds.length} queried...`);
  }
  console.log(`\n  Found ${bridgeMap.size}/${allIds.length} in bridge table`);

  // 2) For all bridge rows with shiphero_order_id, get current ShipHero state
  const shipheroIds = Array.from(bridgeMap.values())
    .filter(r => r.shiphero_order_id)
    .map(r => r.shiphero_order_id);

  console.log(`\n[2/2] Querying ShipHero for ${shipheroIds.length} orders...`);

  const token = await getToken();
  const shipheroMap = new Map<string, any>();

  let done = 0;
  for (const id of shipheroIds) {
    const q = `query($id: String!) {
      order(id: $id) {
        data { id order_number fulfillment_status
          shipments { id completed
            shipping_labels { tracking_number carrier shipping_name status }
          }
        }
      }
    }`;
    try {
      const j = await gql(token, q, { id });
      const data = j.data?.order?.data;
      if (data) shipheroMap.set(id, data);
    } catch (e: any) {
      console.error(`\n  ERROR fetching ${id}: ${e.message}`);
    }
    done++;
    if (done % 25 === 0) process.stdout.write(`\r  ${done}/${shipheroIds.length} fetched...`);
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`\n  Fetched ${shipheroMap.size}/${shipheroIds.length}`);

  // Build diagnosis report
  const report: any = {
    total_csv: csvState.length,
    in_bridge: bridgeMap.size,
    not_in_bridge: 0,
    by_bridge_status: {} as Record<string, number>,
    shipped_in_shiphero_no_tracking_to_tiktok: [] as any[],
    fulfilled_in_shiphero: 0,
    not_fulfilled_in_shiphero: 0,
    detail_rows: [] as any[],
  };

  for (const o of csvState) {
    const bridge = bridgeMap.get(o.tiktok_id);
    if (!bridge) {
      report.not_in_bridge++;
      report.detail_rows.push({
        tiktok_id: o.tiktok_id,
        csv_substatus: o.substatus,
        csv_tracking: o.tracking,
        bridge_status: 'NOT_IN_BRIDGE',
      });
      continue;
    }

    report.by_bridge_status[bridge.status] = (report.by_bridge_status[bridge.status] || 0) + 1;

    const sh = bridge.shiphero_order_id ? shipheroMap.get(bridge.shiphero_order_id) : null;
    const labels = sh?.shipments?.flatMap((s: any) => s.shipping_labels || []) || [];
    const trackingNumber = labels.find((l: any) => l.tracking_number)?.tracking_number;
    const carrier = labels.find((l: any) => l.carrier)?.carrier;
    const isFulfilledShipHero = !!trackingNumber;

    if (isFulfilledShipHero) report.fulfilled_in_shiphero++;
    else report.not_fulfilled_in_shiphero++;

    // The interesting bucket: shipped in ShipHero, but TikTok doesn't have tracking (CSV has empty Tracking ID)
    if (isFulfilledShipHero && !o.tracking) {
      report.shipped_in_shiphero_no_tracking_to_tiktok.push({
        tiktok_id: o.tiktok_id,
        shiphero_order_id: bridge.shiphero_order_id,
        shiphero_order_number: bridge.shiphero_order_number || sh?.order_number,
        bridge_status: bridge.status,
        bridge_tracking_number: bridge.tracking_number,
        bridge_tracking_posted_at: bridge.tracking_posted_at,
        bridge_error: bridge.error_message,
        shiphero_tracking: trackingNumber,
        shiphero_carrier: carrier,
        csv_substatus: o.substatus,
      });
    }

    report.detail_rows.push({
      tiktok_id: o.tiktok_id,
      csv_substatus: o.substatus,
      csv_tracking: o.tracking,
      bridge_status: bridge.status,
      bridge_tracking: bridge.tracking_number,
      bridge_error: bridge.error_message,
      shiphero_order_number: bridge.shiphero_order_number || sh?.order_number,
      shiphero_tracking: trackingNumber,
      shiphero_carrier: carrier,
      shiphero_fulfilled: isFulfilledShipHero,
    });
  }

  fs.writeFileSync('/tmp/diagnosis_results.json', JSON.stringify(report, null, 2));

  console.log('\n=========== DIAGNOSIS SUMMARY ===========');
  console.log(`Total CSV orders:                            ${report.total_csv}`);
  console.log(`In bridge table:                             ${report.in_bridge}`);
  console.log(`NOT in bridge table:                         ${report.not_in_bridge}`);
  console.log(`\nBy bridge status:`);
  for (const [s, n] of Object.entries(report.by_bridge_status)) {
    console.log(`  ${s.padEnd(25)} ${n}`);
  }
  console.log(`\nFulfilled (has tracking) in ShipHero:        ${report.fulfilled_in_shiphero}`);
  console.log(`Not yet fulfilled in ShipHero:               ${report.not_fulfilled_in_shiphero}`);
  console.log(`\n🎯 SHIPPED IN SHIPHERO + TIKTOK HAS NO TRACKING: ${report.shipped_in_shiphero_no_tracking_to_tiktok.length}`);
  console.log(`\nFull report saved to /tmp/diagnosis_results.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
