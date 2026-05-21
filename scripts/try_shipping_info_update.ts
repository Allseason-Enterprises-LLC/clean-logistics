/**
 * Try TikTok's /fulfillment/202309/orders/{order_id}/shipping_info/update endpoint
 * to push tracking directly without going through declarePackage.
 */
import crypto from 'crypto';
import { getTikTokCredentials, getOrderDetail } from '../lib/tiktok-api';
import * as fs from 'fs';

const TIKTOK_BASE = 'https://open-api.tiktokglobalshop.com';

function sign(appSecret: string, path: string, params: Record<string, string>, body?: string): string {
  const sortedParams = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  return crypto.createHmac('sha256', appSecret).update(`${appSecret}${path}${sortedParams}${body || ''}${appSecret}`).digest('hex');
}

async function rawCall(method: string, path: string, creds: any, query: any = {}, body: any = null): Promise<any> {
  const params: Record<string, string> = {
    app_key: creds.appKey,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    ...query,
  };
  if (creds.shopCipher) params.shop_cipher = creds.shopCipher;
  const bodyString = body ? JSON.stringify(body) : '';
  params.sign = sign(creds.appSecret, path, params, bodyString);
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`).join('&');
  const resp = await fetch(`${TIKTOK_BASE}${path}?${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': creds.accessToken },
    body: body ? bodyString : undefined,
  });
  const text = await resp.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: resp.status, json };
}

async function main() {
  const tid = process.argv[2];
  if (!tid) { console.error('Usage: try_shipping_info_update.ts <order_id>'); process.exit(1); }

  const tmap = JSON.parse(fs.readFileSync('/tmp/shiphero_tracking_map.json', 'utf8'));
  const entry = tmap[tid];
  if (!entry) { console.error(`No tracking for ${tid}`); process.exit(1); }

  console.log(`Tracking: ${entry.tracking}, carrier: ${entry.carrier}`);

  const creds = await getTikTokCredentials();
  const details = await getOrderDetail(creds, [tid]);
  const detail = details[0];
  console.log(`Warehouse: ${detail.warehouse_id}, packages: ${detail.packages?.length}, is_on_hold: ${detail.is_on_hold_order}`);

  // Variations to try
  const path = `/fulfillment/202309/orders/${tid}/shipping_info/update`;

  // Variation A: just tracking_number
  let r = await rawCall('POST', path, creds, {}, { tracking_number: entry.tracking });
  console.log(`\nA. body={tracking_number}: status=${r.status} code=${r.json.code} message=${r.json.message}`);

  // Variation B: tracking_number + shipping_provider_id (USPS from CLEAN_NUTRA_PROVIDER_IDS)
  r = await rawCall('POST', path, creds, {}, { tracking_number: entry.tracking, shipping_provider_id: '7117858858072016686' });
  console.log(`B. body={tracking_number, shipping_provider_id}: status=${r.status} code=${r.json.code} message=${r.json.message}`);

  // Variation C: nested under self_shipment
  r = await rawCall('POST', path, creds, {}, { self_shipment: { tracking_number: entry.tracking, shipping_provider_id: '7117858858072016686' } });
  console.log(`C. body={self_shipment: {...}}: status=${r.status} code=${r.json.code} message=${r.json.message}`);

  // Variation D: TikTok docs format with order_line_item_ids
  const lineItemIds = (detail.line_items || []).map((li: any) => li.id);
  r = await rawCall('POST', path, creds, {}, {
    tracking_number: entry.tracking,
    shipping_provider_id: '7117858858072016686',
    order_line_item_ids: lineItemIds,
  });
  console.log(`D. body=+line_items: status=${r.status} code=${r.json.code} message=${r.json.message}`);

  // Variation E: 'shipping_provider' as name string (not id)
  r = await rawCall('POST', path, creds, {}, {
    tracking_number: entry.tracking,
    shipping_provider: 'USPS',
  });
  console.log(`E. body={tracking_number, shipping_provider:'USPS'}: status=${r.status} code=${r.json.code} message=${r.json.message}`);
}

main().catch(e => { console.error(e); process.exit(1); });
