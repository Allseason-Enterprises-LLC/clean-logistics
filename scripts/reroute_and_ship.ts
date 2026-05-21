/**
 * Attempt to re-route a TikTok order to a different warehouse, then declare + ship.
 *
 * Usage:  npx tsx scripts/reroute_and_ship.ts <tiktok_order_id> <target_warehouse_id>
 *
 * Default target: Clean Nutra Las Vegas Warehouse (7632882156952700685)
 */
import * as fs from 'fs';
import crypto from 'crypto';
import { getTikTokCredentials, getOrderDetail, declarePackage, shipPackage } from '../lib/tiktok-api';
import { normalizeCarrier, resolveProviderIdWithFallback } from '../lib/tiktok-carriers';

const TIKTOK_BASE = 'https://open-api.tiktokglobalshop.com';
const CLEAN_NUTRA_LV_WAREHOUSE = '7632882156952700685';

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
  const warehouseId = process.argv[3] || CLEAN_NUTRA_LV_WAREHOUSE;
  if (!tid) { console.error('Usage: reroute_and_ship.ts <order_id> [warehouse_id]'); process.exit(1); }

  const creds = await getTikTokCredentials();
  console.log(`\n=== Order ${tid} → target warehouse ${warehouseId} ===`);

  // Current state
  let details = await getOrderDetail(creds, [tid]);
  let detail = details[0];
  console.log(`Current warehouse_id: ${detail.warehouse_id}`);
  console.log(`is_on_hold: ${detail.is_on_hold_order}, packages: ${detail.packages?.length || 0}`);

  // Attempt 1: update warehouse via /fulfillment/202309/orders/<id>/warehouses
  console.log(`\nAttempt 1: POST /fulfillment/202309/orders/${tid}/warehouses`);
  let r = await rawCall('POST', `/fulfillment/202309/orders/${tid}/warehouses`, creds, {}, { warehouse_id: warehouseId });
  console.log(`  status=${r.status} code=${r.json.code} message=${r.json.message}`);

  // Attempt 2: PUT
  console.log(`\nAttempt 2: PUT /fulfillment/202309/orders/${tid}/warehouses`);
  r = await rawCall('PUT', `/fulfillment/202309/orders/${tid}/warehouses`, creds, {}, { warehouse_id: warehouseId });
  console.log(`  status=${r.status} code=${r.json.code} message=${r.json.message}`);

  // Attempt 3: shipment route - /fulfillment/202309/orders/{order_id}/shipping_info/update
  console.log(`\nAttempt 3: POST /fulfillment/202309/orders/${tid}/shipping_info/update (warehouse_id)`);
  r = await rawCall('POST', `/fulfillment/202309/orders/${tid}/shipping_info/update`, creds, {}, { warehouse_id: warehouseId });
  console.log(`  status=${r.status} code=${r.json.code} message=${r.json.message}`);

  // Re-fetch
  details = await getOrderDetail(creds, [tid]);
  detail = details[0];
  console.log(`\nAfter reroute attempts — warehouse_id: ${detail.warehouse_id}`);
}

main().catch(e => { console.error(e); process.exit(1); });
