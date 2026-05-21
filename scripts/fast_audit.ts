/**
 * Fast audit: for each CSV TikTok order ID, query ShipHero individually using
 * partner_order_id filter (cheap, no big pagination).
 *
 * Reads:  /tmp/tiktok_orders_csv_state.json
 * Writes: /tmp/fast_audit.json
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

  // Bridge map
  const bridgeMap = new Map<string, any>();
  for (let i = 0; i < allIds.length; i += 500) {
    const slice = allIds.slice(i, i + 500);
    const { data } = await supabase
      .from('tiktok_shiphero_orders')
      .select('tiktok_order_id, status, shiphero_order_id, shiphero_order_number')
      .in('tiktok_order_id', slice);
    (data || []).forEach((r: any) => bridgeMap.set(r.tiktok_order_id, r));
  }
  console.log(`Bridge rows: ${bridgeMap.size}/${allIds.length}`);

  const token = await getToken();

  // For each CSV order, do ONE ShipHero query with partner_id filter
  // ShipHero's orders query supports partner_order_id filter
  const q = `
    query($pid: String!) {
      orders(partner_order_id: $pid) {
        data(first: 5) {
          edges { node { id order_number partner_order_id shop_name source fulfillment_status } }
        }
      }
    }`;

  const audit: any[] = [];
  let done = 0;
  const startTime = Date.now();

  console.log(`Querying ShipHero for ${allIds.length} orders by partner_order_id...`);

  for (const csv of csvState) {
    const ttId = csv.tiktok_id;
    let shResults: any[] = [];
    try {
      const j = await gql(token, q, { pid: ttId });
      shResults = (j.data?.orders?.data?.edges || []).map((e: any) => e.node);
    } catch (e: any) {
      console.error(`Error for ${ttId}: ${e.message}`);
    }

    const bridge = bridgeMap.get(ttId);

    // Classify
    const ttPrefixedMatches = shResults.filter((r: any) => r.order_number?.startsWith('TT-'));
    const nativeMatches = shResults.filter((r: any) => !r.order_number?.startsWith('TT-'));

    audit.push({
      tiktok_id: ttId,
      csv_substatus: csv.substatus,
      csv_has_tracking: !!csv.tracking,
      sh_results: shResults,
      sh_native: nativeMatches,
      sh_tt_bridge: ttPrefixedMatches,
      sh_count: shResults.length,
      bridge_status: bridge?.status || null,
    });

    done++;
    if (done % 25 === 0) {
      const rate = done / ((Date.now() - startTime) / 1000);
      const remaining = (allIds.length - done) / rate;
      process.stdout.write(`\r  ${done}/${allIds.length}  (${rate.toFixed(1)}/s, ETA ${remaining.toFixed(0)}s)   `);
      // Save partial progress
      fs.writeFileSync('/tmp/fast_audit.json', JSON.stringify(audit, null, 2));
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log('');

  fs.writeFileSync('/tmp/fast_audit.json', JSON.stringify(audit, null, 2));

  // Summary
  const buckets = {
    in_sh_native_only: 0,
    in_sh_bridge_only: 0,
    in_sh_both: 0,
    not_in_sh: 0,
  };
  for (const row of audit) {
    const hasNative = row.sh_native.length > 0;
    const hasTT = row.sh_tt_bridge.length > 0;
    if (hasNative && hasTT) buckets.in_sh_both++;
    else if (hasNative) buckets.in_sh_native_only++;
    else if (hasTT) buckets.in_sh_bridge_only++;
    else buckets.not_in_sh++;
  }

  console.log('\n========== FAST AUDIT SUMMARY ==========');
  console.log(`Total CSV orders:           ${csvState.length}`);
  console.log(`In SH as NATIVE only:       ${buckets.in_sh_native_only}`);
  console.log(`In SH as TT-bridge only:    ${buckets.in_sh_bridge_only}`);
  console.log(`In SH as BOTH:              ${buckets.in_sh_both}`);
  console.log(`NOT IN SHIPHERO AT ALL:     ${buckets.not_in_sh}  ← these need to be imported`);
  console.log(`\nDetail: /tmp/fast_audit.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
