/**
 * TikTok Shop API client for clean-logistics.
 *
 * Scoped to what the TikTok↔ShipHero bridge needs:
 *   - Search for AWAITING_SHIPMENT orders (poll)
 *   - Get order details with line items + shipping address
 *   - POST package + tracking back to TikTok once shipped
 *
 * Auth:
 *   - HMAC-SHA256 signature on every request
 *     (pattern: {app_secret}{path}{sorted_params}{body}{app_secret})
 *   - x-tts-access-token header carries the access token
 *   - Tokens are stored in Supabase `platform_credentials` (shared with BrandMind)
 *     and auto-refreshed when expiry is within 5 minutes
 */

import crypto from 'crypto';
import { supabase } from './supabase';

const TIKTOK_BASE = 'https://open-api.tiktokglobalshop.com';

export interface TikTokCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  shopCipher: string;
  shopId: string;
}

interface TikTokRefreshResponse {
  code: number;
  message: string;
  data?: {
    access_token: string;
    refresh_token: string;
    access_token_expire_in: number;
    refresh_token_expire_in: number;
  };
}

/**
 * Fetch TikTok creds from Supabase `platform_credentials` table,
 * refreshing the access token if it's expired or close to expiry.
 *
 * Mirrors the pattern from brandmind/apps/api/lib/tiktok-token-manager.ts.
 * We re-implement here so clean-logistics stays independently deployable.
 */
export async function getTikTokCredentials(): Promise<TikTokCredentials> {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  const shopCipher = process.env.TIKTOK_SHOP_CIPHER;
  const shopId = process.env.TIKTOK_SHOP_ID;

  if (!appKey || !appSecret) {
    throw new Error('TIKTOK_APP_KEY and TIKTOK_APP_SECRET must be set');
  }
  if (!shopCipher && !shopId) {
    throw new Error('Either TIKTOK_SHOP_CIPHER or TIKTOK_SHOP_ID must be set');
  }

  // Try DB first (shared credential store with BrandMind)
  const { data: creds, error } = await supabase
    .from('platform_credentials')
    .select('*')
    .eq('platform', 'tiktok')
    .single();

  let accessToken: string;

  if (error || !creds) {
    // Fall back to env var if DB is empty
    accessToken = process.env.TIKTOK_ACCESS_TOKEN || '';
    if (!accessToken) {
      throw new Error(
        'No TikTok creds in platform_credentials table and no TIKTOK_ACCESS_TOKEN env fallback'
      );
    }
    console.log('[tiktok-api] Using access token from env (DB empty)');
  } else {
    const expiresAt = creds.expires_at ? new Date(creds.expires_at) : null;
    const soon = new Date(Date.now() + 5 * 60 * 1000);

    if (!expiresAt || expiresAt < soon) {
      console.log('[tiktok-api] Token expired or expiring, refreshing...');
      accessToken = await refreshAccessToken(appKey, appSecret, creds.refresh_token);
    } else {
      accessToken = creds.access_token;
    }
  }

  return {
    appKey,
    appSecret,
    accessToken,
    shopCipher: shopCipher || '',
    shopId: shopId || '',
  };
}

async function refreshAccessToken(
  appKey: string,
  appSecret: string,
  refreshToken: string
): Promise<string> {
  const url = new URL('https://auth.tiktok-shops.com/api/v2/token/refresh');
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('app_secret', appSecret);
  url.searchParams.set('refresh_token', refreshToken);
  url.searchParams.set('grant_type', 'refresh_token');

  const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  const json = (await resp.json()) as TikTokRefreshResponse;

  if (json.code !== 0 || !json.data) {
    throw new Error(`TikTok token refresh failed: ${json.code} - ${json.message}`);
  }

  const { access_token, refresh_token, access_token_expire_in } = json.data;
  const expiresAt = new Date(Date.now() + access_token_expire_in * 1000);

  await supabase
    .from('platform_credentials')
    .upsert(
      {
        platform: 'tiktok',
        access_token,
        refresh_token,
        expires_at: expiresAt.toISOString(),
        metadata: { last_refreshed: new Date().toISOString(), app_key: appKey },
      },
      { onConflict: 'platform' }
    );

  console.log(`[tiktok-api] Token refreshed, expires ${expiresAt.toISOString()}`);
  return access_token;
}

/**
 * Generate HMAC-SHA256 signature for TikTok Shop API.
 * Format: {app_secret}{path}{sorted_params}{body}{app_secret}
 */
function sign(
  appSecret: string,
  path: string,
  params: Record<string, string>,
  body?: string
): string {
  const sortedParams = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  const stringToSign = `${appSecret}${path}${sortedParams}${body || ''}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(stringToSign).digest('hex');
}

/**
 * Low-level TikTok Shop API call with HMAC signing.
 */
async function tiktokCall<T = any>(
  method: 'GET' | 'POST',
  path: string,
  creds: TikTokCredentials,
  opts: {
    query?: Record<string, string>;
    body?: any;
  } = {}
): Promise<T> {
  const params: Record<string, string> = {
    app_key: creds.appKey,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    ...(opts.query || {}),
  };
  if (creds.shopCipher) params.shop_cipher = creds.shopCipher;
  else if (creds.shopId) params.shop_id = creds.shopId;

  const bodyString = opts.body ? JSON.stringify(opts.body) : '';
  params.sign = sign(creds.appSecret, path, params, bodyString);

  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const resp = await fetch(`${TIKTOK_BASE}${path}?${queryString}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tts-access-token': creds.accessToken,
    },
    body: method === 'POST' ? bodyString : undefined,
  });

  const json: any = await resp.json();
  if (json.code !== 0) {
    throw new Error(
      `TikTok API ${method} ${path} failed: code=${json.code} message=${json.message} request_id=${json.request_id}`
    );
  }
  return json.data as T;
}

// ============================================================================
// Order search (polling)
// ============================================================================

export interface TikTokOrderSummary {
  id: string;
  order_status?: string;
  status?: string;
  create_time: number;
  update_time: number;
  line_items?: Array<{ sku_id?: string; seller_sku?: string; sku_name?: string; id?: string }>;
  payment?: any;
  recipient_address?: any;
}

/**
 * Search for TikTok orders updated within a time window.
 * We filter by `update_time_ge` so recent status transitions (e.g. payment → awaiting_shipment)
 * get pulled even if the order was created days ago.
 *
 * Returns a flat list across pagination (capped to avoid runaway loops).
 */
export async function searchOrders(
  creds: TikTokCredentials,
  opts: {
    updateTimeGe: number; // unix seconds
    updateTimeLt?: number;
    orderStatus?: string; // e.g. 'AWAITING_SHIPMENT'
    maxPages?: number;
  }
): Promise<TikTokOrderSummary[]> {
  const { updateTimeGe, updateTimeLt, orderStatus, maxPages = 10 } = opts;
  const orders: TikTokOrderSummary[] = [];

  let pageToken: string | undefined;
  let page = 0;

  while (page < maxPages) {
    page++;
    const query: Record<string, string> = { page_size: '50' };
    if (pageToken) query.page_token = pageToken;

    const body: any = { update_time_ge: updateTimeGe };
    if (updateTimeLt) body.update_time_lt = updateTimeLt;
    if (orderStatus) body.order_status = orderStatus;

    const data = await tiktokCall<any>('POST', '/order/202309/orders/search', creds, {
      query,
      body,
    });

    const batch: TikTokOrderSummary[] = data?.orders || [];
    orders.push(...batch);

    pageToken = data?.next_page_token;
    if (!pageToken || batch.length === 0) break;

    // gentle rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  return orders;
}

/**
 * Fetch full order details (address, line items with quantity, pricing).
 * TikTok's /order/search payload is truncated — this gives the full picture.
 */
export async function getOrderDetail(
  creds: TikTokCredentials,
  orderIds: string[]
): Promise<any[]> {
  if (orderIds.length === 0) return [];
  // TikTok supports up to 50 ids per call on the detail endpoint
  const data = await tiktokCall<any>('GET', '/order/202309/orders', creds, {
    query: { ids: orderIds.join(',') },
  });
  return data?.orders || [];
}

// ============================================================================
// Tracking post-back (ShipHero → TikTok after ship)
// ============================================================================

/**
 * Declare a package on a TikTok order (required before tracking).
 * Call once per physical package. For a single-package shipment,
 * pass all order_line_item_ids.
 */
export async function declarePackage(
  creds: TikTokCredentials,
  orderId: string,
  orderLineItemIds: string[]
): Promise<{ package_id: string }> {
  const data = await tiktokCall<any>(
    'POST',
    `/fulfillment/202309/packages`,
    creds,
    {
      body: {
        order_id: orderId,
        order_line_item_ids: orderLineItemIds,
      },
    }
  );
  return { package_id: data?.package_id };
}

/**
 * Push tracking info to TikTok.
 * TikTok strictly validates the `shipping_provider_id` against its allowed list,
 * but a free-form carrier + tracking_number is accepted via the /ship endpoint
 * with `self_shipment` field.
 */
export async function shipPackage(
  creds: TikTokCredentials,
  packageId: string,
  trackingNumber: string,
  tiktokCarrierId: string
): Promise<void> {
  await tiktokCall<any>(
    'POST',
    `/fulfillment/202309/packages/${packageId}/ship`,
    creds,
    {
      body: {
        self_shipment: {
          tracking_number: trackingNumber,
          shipping_provider_id: tiktokCarrierId,
        },
      },
    }
  );
}

/**
 * Fetch TikTok's current list of shipping providers for this shop.
 * Each has an `id` we must use in ship() calls — the string names change.
 * Cache this on first call; providers rarely change.
 */
let _providerCache: Array<{ id: string; name: string }> | null = null;

export async function getShippingProviders(
  creds: TikTokCredentials
): Promise<Array<{ id: string; name: string }>> {
  if (_providerCache) return _providerCache;
  const data = await tiktokCall<any>(
    'GET',
    '/logistics/202309/shipping_providers',
    creds,
    {}
  );
  const result = (data?.shipping_providers || []).map((p: any) => ({
    id: p.id,
    name: p.name,
  })) as Array<{ id: string; name: string }>;
  _providerCache = result;
  return result;
}
