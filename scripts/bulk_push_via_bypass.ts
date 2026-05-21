/**
 * Push tracking back to TikTok for all shipped orders in the CSV using
 * /fulfillment/202309/orders/{id}/shipping_info/update bypass.
 *
 * Reads:  /tmp/csv_v2_orders.json  (full CSV state)
 * Writes: /tmp/bulk_push_results.json
 */
import * as fs from 'fs';
import { supabase } from '../lib/supabase';
import { getTikTokCredentials, getOrderDetail, shipPackage } from '../lib/tiktok-api';
import { normalizeCarrier, resolveProviderIdWithFallback } from '../lib/tiktok-carriers';
import crypto from 'crypto';

const TIKTOK_BASE = 'https://open-api.tiktokglobalshop.com';
const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

function sign(appSecret: string, path: string, params: Record<string, string>, body?: string): string {
  const sortedParams = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  return crypto.createHmac('sha256', appSecret).update(`${appSecret}${path}${sortedParams}${body || ''}${appSecret}`).digest('hex');
}

async function updateShippingInfo(creds: any, orderId: string, trackingNumber: string, providerId: string): Promise<void> {
  const path = `/fulfillment/202309/orders/${orderId}/shipping_info/update`;
  const params: Record<string, string> = {
    app_key: creds.appKey,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    shop_cipher: creds.shopCipher,
  };
  const body = { tracking_number: trackingNumber, shipping_provider_id: providerId };
  const bodyString = JSON.stringify(body);
  params.sign = sign(creds.appSecret, path, params, bodyString);
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`).join('&');
  const resp = await fetch(`${TIKTOK_BASE}${path}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': creds.accessToken },
    body: bodyString,
  });
  const j: any = await resp.json();
  if (j.code !== 0) {
    throw new Error(`code=${j.code} message=${j.message}`);
  }
}

async function getShipheroToken(): Promise<string> {
  const { data } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID).eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function shGql(token: string, q: string, vars: any = {}): Promise<any> {
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
  // Step 1: Load CSV state + audit
  const csvOrders = JSON.parse(fs.readFileSync('/tmp/csv_v2_orders.json', 'utf8'));
  const audit = JSON.parse(fs.readFileSync('/tmp/fast_audit.json', 'utf8'));
  const auditByTid = new Map(audit.map((a: any) => [a.tiktok_id, a]));

  // Pick orders that have ANY ShipHero presence (TT or native or both)
  const candidates = csvOrders.filter((o: any) => {
    const a: any = auditByTid.get(o.tiktok_id);
    return a && (a.sh_native.length > 0 || a.sh_tt_bridge.length > 0);
  });
  console.log(`Candidates with ShipHero presence: ${candidates.length}/${csvOrders.length}`);

  // Step 2: Fetch TikTok state for ALL candidates in batches of 50
  const creds = await getTikTokCredentials();
  const ttDetails = new Map<string, any>();
  console.log(`Fetching TikTok details for ${candidates.length} orders...`);
  const ids = candidates.map((c: any) => c.tiktok_id);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const details = await getOrderDetail(creds, chunk);
      for (const d of details) ttDetails.set(d.id, d);
    } catch (e: any) {
      console.error(`Batch ${i} failed: ${e.message.slice(0, 200)}`);
    }
    process.stdout.write(`\r  ${Math.min(i + 50, ids.length)}/${ids.length} fetched...`);
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`\nFetched ${ttDetails.size} TikTok details`);

  // Step 3: Find which need tracking pushed
  //   Need push = TikTok shows AWAITING_SHIPMENT (no tracking yet) AND we have it shipped in ShipHero
  const needPush: any[] = [];
  let ttAlreadyHasTracking = 0;
  let ttCancelled = 0;
  let ttDelivered = 0;
  let ttOther = 0;

  for (const c of candidates) {
    const d = ttDetails.get(c.tiktok_id);
    if (!d) continue;
    const li = d.line_items?.[0];
    const status = li?.display_status || d.order_status;

    if (status === 'IN_TRANSIT' || status === 'DELIVERED' || status === 'AWAITING_COLLECTION') {
      ttAlreadyHasTracking++;
      continue;
    }
    if (status === 'CANCELLED') {
      ttCancelled++;
      continue;
    }
    if (status === 'AWAITING_SHIPMENT') {
      needPush.push({ ...c, tt_detail: d });
      continue;
    }
    ttOther++;
  }

  console.log(`\nTikTok states:`);
  console.log(`  Already has tracking (IN_TRANSIT/DELIVERED/COLLECTION): ${ttAlreadyHasTracking}`);
  console.log(`  Cancelled:                                              ${ttCancelled}`);
  console.log(`  Other:                                                  ${ttOther}`);
  console.log(`  AWAITING_SHIPMENT (need check):                         ${needPush.length}`);

  // Step 4: For each need-push order, query ShipHero for tracking
  const shToken = await getShipheroToken();
  const haveTracking: any[] = [];
  const noShTracking: any[] = [];

  console.log(`\nQuerying ShipHero for tracking on ${needPush.length} orders...`);
  for (let i = 0; i < needPush.length; i++) {
    const o = needPush[i];
    const a: any = auditByTid.get(o.tiktok_id);
    // Try both TT and native ShipHero IDs
    const shIds = [...(a.sh_tt_bridge.map((x: any) => x.id)), ...(a.sh_native.map((x: any) => x.id))];

    let found = null;
    for (const shId of shIds) {
      const q = `query($id: String!) { order(id: $id) { data { shipments { shipping_labels { tracking_number carrier shipping_name status } } } } }`;
      const j = await shGql(shToken, q, { id: shId });
      const labels = j.data?.order?.data?.shipments?.flatMap((s: any) => s.shipping_labels || []) || [];
      const label = labels.find((l: any) => l.tracking_number);
      if (label) {
        found = { tracking: label.tracking_number, carrier: label.carrier || 'usps_modern', sh_order_id: shId };
        break;
      }
    }

    if (found) {
      haveTracking.push({ ...o, ...found });
    } else {
      noShTracking.push(o);
    }
    if ((i + 1) % 20 === 0) {
      process.stdout.write(`\r  ${i + 1}/${needPush.length}  have_tracking=${haveTracking.length}  no_track=${noShTracking.length}  `);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log('');
  console.log(`Have ShipHero tracking: ${haveTracking.length}`);
  console.log(`No ShipHero tracking yet (warehouse hasn't shipped): ${noShTracking.length}`);

  if (haveTracking.length === 0) {
    console.log('Nothing to push.');
    return;
  }

  // Step 5: Push tracking via bypass endpoint
  console.log(`\nPushing tracking for ${haveTracking.length} orders via shipping_info/update bypass...`);
  const results: any[] = [];
  let pushed = 0, failed = 0;

  for (const o of haveTracking) {
    const canonical = normalizeCarrier(o.carrier);
    const providerId = resolveProviderIdWithFallback(canonical, []);
    if (!providerId) {
      results.push({ tiktok_id: o.tiktok_id, outcome: 'no_provider', carrier: o.carrier });
      failed++;
      continue;
    }
    try {
      await updateShippingInfo(creds, o.tiktok_id, o.tracking, providerId);
      results.push({ tiktok_id: o.tiktok_id, outcome: 'pushed', tracking: o.tracking });
      pushed++;
      // Update bridge if present
      await supabase.from('tiktok_shiphero_orders')
        .update({
          tracking_number: o.tracking,
          carrier: o.carrier,
          tracking_posted_at: new Date().toISOString(),
          status: 'tracking_confirmed',
        })
        .eq('tiktok_order_id', o.tiktok_id);
      process.stdout.write(`\r  Pushed ${pushed}/${haveTracking.length}, failed ${failed}   `);
    } catch (e: any) {
      const msg = e.message.slice(0, 200);
      results.push({ tiktok_id: o.tiktok_id, outcome: 'error', error: msg });
      failed++;
      process.stdout.write(`\n  ✗ ${o.tiktok_id}: ${msg}\n`);
    }
    await new Promise(r => setTimeout(r, 250));
    fs.writeFileSync('/tmp/bulk_push_results.json', JSON.stringify(results, null, 2));
  }
  console.log('');

  console.log('\n=========== SUMMARY ===========');
  console.log(`Candidates:                 ${candidates.length}`);
  console.log(`TikTok already had tracking: ${ttAlreadyHasTracking}`);
  console.log(`TikTok cancelled:            ${ttCancelled}`);
  console.log(`Awaiting ShipHero ship:      ${noShTracking.length}`);
  console.log(`Pushed:                      ${pushed}`);
  console.log(`Failed:                      ${failed}`);
  console.log(`Results: /tmp/bulk_push_results.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
