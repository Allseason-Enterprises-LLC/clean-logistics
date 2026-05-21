/**
 * Audit: for each CSV TikTok order ID, look it up in ShipHero by partner_order_id
 * AND by order_number = TT-{id}, to figure out the ACTUAL ShipHero state.
 *
 * Reads:  /tmp/tiktok_orders_csv_state.json
 * Writes: /tmp/shiphero_audit.json
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
  console.log(`Auditing ${allIds.length} CSV orders against ShipHero...`);

  const token = await getToken();

  // Pull ALL ShipHero orders from May 10 onward (TikTok orders + bridge TT- orders both)
  // We need to fetch by date and then map by partner_order_id AND order_number
  const since = '2026-05-10';
  console.log(`Fetching ShipHero orders since ${since}...`);

  const orders: any[] = [];
  let after: string | null = null;
  let page = 0;

  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "${since}") {
          data(first: 100, after: $after) {
            edges { node { id order_number partner_order_id shop_name source fulfillment_status tags
              line_items { edges { node { sku quantity } } }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const j = await gql(token, q, { after });
    if (j.errors) {
      console.error('GraphQL error:', JSON.stringify(j.errors).slice(0, 300));
      throw new Error('Failed');
    }
    const data = j.data?.orders?.data;
    (data?.edges || []).forEach((e: any) => orders.push(e.node));
    page++;
    process.stdout.write(`\r  Page ${page}: ${orders.length} orders fetched...`);
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
  }
  console.log(`\nFetched ${orders.length} ShipHero orders total`);

  // Build lookup maps
  const byPartnerId = new Map<string, any>();
  const byOrderNumber = new Map<string, any>();
  for (const o of orders) {
    if (o.partner_order_id) byPartnerId.set(o.partner_order_id, o);
    if (o.order_number) byOrderNumber.set(o.order_number, o);
  }
  console.log(`  By partner_order_id: ${byPartnerId.size}`);
  console.log(`  By order_number:     ${byOrderNumber.size}`);

  // Bridge table snapshot
  const bridgeMap = new Map<string, any>();
  for (let i = 0; i < allIds.length; i += 500) {
    const slice = allIds.slice(i, i + 500);
    const { data } = await supabase
      .from('tiktok_shiphero_orders')
      .select('tiktok_order_id, status, shiphero_order_id, shiphero_order_number, skus, error_message')
      .in('tiktok_order_id', slice);
    (data || []).forEach((r: any) => bridgeMap.set(r.tiktok_order_id, r));
  }
  console.log(`Bridge rows: ${bridgeMap.size}/${allIds.length}`);

  // Audit each CSV order
  const audit: any[] = [];
  const buckets = {
    in_sh_native: 0,        // partner_order_id match, NOT TT- prefix → ShipHero native integration
    in_sh_via_bridge: 0,    // order_number = TT-{id} → our bridge created it
    in_both: 0,             // somehow both
    not_in_sh: 0,           // not in ShipHero at all
  };

  for (const csv of csvState) {
    const ttId = csv.tiktok_id;
    const ttPrefixed = `TT-${ttId}`;

    const shByPartner = byPartnerId.get(ttId);
    const shByTT = byOrderNumber.get(ttPrefixed);
    const bridge = bridgeMap.get(ttId);

    // Native ShipHero TikTok integration uses order_number = tiktok_id (no TT- prefix)
    const shByOrderNumberRaw = byOrderNumber.get(ttId);

    const row: any = {
      tiktok_id: ttId,
      csv_substatus: csv.substatus,
      csv_has_tracking: !!csv.tracking,
      // ShipHero presence
      sh_native_partner: shByPartner ? { id: shByPartner.id, order_number: shByPartner.order_number, shop_name: shByPartner.shop_name, source: shByPartner.source, status: shByPartner.fulfillment_status } : null,
      sh_tt_prefixed: shByTT ? { id: shByTT.id, order_number: shByTT.order_number, status: shByTT.fulfillment_status, skus: shByTT.line_items?.edges?.map((e: any) => e.node.sku) } : null,
      sh_native_order_number: shByOrderNumberRaw ? { id: shByOrderNumberRaw.id, order_number: shByOrderNumberRaw.order_number, status: shByOrderNumberRaw.fulfillment_status } : null,
      // Bridge state
      bridge_status: bridge?.status || null,
      bridge_error: bridge?.error_message || null,
      bridge_skus: bridge?.skus || null,
    };

    const hasTT = !!shByTT;
    const hasNative = !!shByPartner || !!shByOrderNumberRaw;

    if (hasTT && hasNative) row._bucket = 'in_both';
    else if (hasTT) row._bucket = 'in_sh_via_bridge';
    else if (hasNative) row._bucket = 'in_sh_native';
    else row._bucket = 'not_in_sh';

    buckets[row._bucket as keyof typeof buckets]++;
    audit.push(row);
  }

  fs.writeFileSync('/tmp/shiphero_audit.json', JSON.stringify({ buckets, audit }, null, 2));

  console.log('\n========== AUDIT SUMMARY ==========');
  console.log(`Total CSV orders:           ${csvState.length}`);
  console.log(`In SH via bridge (TT-...):  ${buckets.in_sh_via_bridge}`);
  console.log(`In SH native (no TT-):      ${buckets.in_sh_native}`);
  console.log(`In SH BOTH (weird):         ${buckets.in_both}`);
  console.log(`NOT IN SHIPHERO AT ALL:     ${buckets.not_in_sh}`);
  console.log(`\nFull audit: /tmp/shiphero_audit.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
