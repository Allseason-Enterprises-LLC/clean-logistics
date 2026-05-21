/**
 * List TikTok warehouses + delivery options registered for Clean Nutra shop.
 */
import { getTikTokCredentials } from '../lib/tiktok-api';
import crypto from 'crypto';

const TIKTOK_BASE = 'https://open-api.tiktokglobalshop.com';

function sign(appSecret: string, path: string, params: Record<string, string>, body?: string): string {
  const sortedParams = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  const stringToSign = `${appSecret}${path}${sortedParams}${body || ''}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(stringToSign).digest('hex');
}

async function call(method: 'GET' | 'POST', path: string, creds: any, query: any = {}, body: any = null): Promise<any> {
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
    body: method === 'POST' ? bodyString : undefined,
  });
  return resp.json();
}

async function main() {
  const creds = await getTikTokCredentials();

  console.log('=== List Warehouses ===');
  const w = await call('GET', '/logistics/202309/warehouses', creds);
  console.log(JSON.stringify(w, null, 2));

  console.log('\n=== Global shipping providers ===');
  const sp = await call('GET', '/logistics/202309/shipping_providers', creds);
  console.log(JSON.stringify(sp, null, 2).slice(0, 2000));

  console.log('\n=== Try get warehouse delivery options ===');
  const dopts = await call('GET', '/logistics/202309/warehouses/delivery_options', creds);
  console.log(JSON.stringify(dopts, null, 2).slice(0, 2000));
}

main().catch(e => { console.error(e); process.exit(1); });
