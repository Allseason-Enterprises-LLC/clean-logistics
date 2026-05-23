/**
 * Amazon SP-API Client (Direct)
 * ==============================
 *
 * **Drop-in replacement** for the previous Supabase edge-function proxy version.
 * Same exports, same signatures — but now calls Amazon SP-API directly from
 * Node.js inside the Vercel function. NO Supabase edge function hop.
 *
 * History / Why this exists:
 *   The original implementation forwarded every call through a Supabase edge
 *   function (`amazon-sp-api`) running on Deno Deploy. The edge function got
 *   evicted from `us-east-1` (Vercel's region) on an irregular cadence — once
 *   every ~2-4 days — while continuing to show as ACTIVE in the dashboard and
 *   working from other regions. Vercel → us-east-1 → 404 NOT_FOUND. Every
 *   incident wedged the entire FBA pipeline until a human ran
 *   `supabase functions deploy amazon-sp-api` to re-propagate the function.
 *
 *   Six confirmed incidents between May 6 and May 22 2026. The "value" the
 *   edge function added — token refresh, caching, logging — is all trivially
 *   doable in Node, AND Vercel functions warm-cache module state between
 *   invocations the same way Deno does, so we keep the LWA token cache.
 *
 * Auth: LWA refresh token grant via api.amazon.com/auth/o2/token.
 *   Cached in module scope (~55 min TTL, tokens last 60 min).
 *
 * Env vars required (set on Vercel):
 *   AMAZON_CLIENT_ID         (LWA application client id)
 *   AMAZON_CLIENT_SECRET     (LWA application client secret)
 *   AMAZON_REFRESH_TOKEN     (long-lived refresh token for the seller account)
 *
 * Legacy fallbacks (kept for backward compat with older env layouts):
 *   IM_AMAZON_CLIENT_ID / IM_AMAZON_CLIENT_SECRET / IM_AMAZON_REFRESH_TOKEN
 *   AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_SP_REFRESH_TOKEN
 *
 * Usage (unchanged from the proxy version):
 *   const { data } = await callAmazonSpApi({
 *     method: 'POST',
 *     path: '/inbound/fba/2024-03-20/inboundPlans',
 *     body: { ... },
 *   });
 */

export type Region = 'na' | 'eu' | 'fe';

export interface SpApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;                             // e.g. '/inbound/fba/2024-03-20/inboundPlans'
  region?: Region;                          // default 'na'
  body?: unknown;                           // JSON body
  query?: Record<string, string | number | boolean | undefined>;
}

export interface SpApiResponse<T = any> {
  status: number;                           // HTTP status from Amazon
  data: T;                                  // parsed response body (or raw text)
}

export class SpApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'SpApiError';
  }
}

const SP_API_ENDPOINTS: Record<Region, string> = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};

const LWA_TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';

// Module-scoped LWA token cache. Vercel warm starts reuse this; cold starts
// just refresh once and proceed (adds ~150ms — same cost the edge function had).
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

// Coalesce concurrent refresh attempts so 5 parallel calls during a cold start
// don't all hit the LWA endpoint.
let refreshInFlight: Promise<string> | null = null;

function readLwaCreds(): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId =
    process.env.AMAZON_CLIENT_ID ||
    process.env.IM_AMAZON_CLIENT_ID ||
    process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret =
    process.env.AMAZON_CLIENT_SECRET ||
    process.env.IM_AMAZON_CLIENT_SECRET ||
    process.env.AMAZON_LWA_CLIENT_SECRET;
  const refreshToken =
    process.env.AMAZON_REFRESH_TOKEN ||
    process.env.IM_AMAZON_REFRESH_TOKEN ||
    process.env.AMAZON_SP_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new SpApiError(
      'Missing Amazon LWA credentials in env (need AMAZON_CLIENT_ID / AMAZON_CLIENT_SECRET / AMAZON_REFRESH_TOKEN)',
      500,
    );
  }
  return { clientId, clientSecret, refreshToken };
}

async function refreshAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = readLwaCreds();

  console.log('[amazon-sp-api] Refreshing LWA access token...');
  const startedAt = Date.now();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(LWA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SpApiError(
      `LWA token refresh failed: HTTP ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }

  const tokenData = (await res.json()) as { access_token: string; expires_in?: number };
  const accessToken: string = tokenData.access_token;
  const expiresIn: number = tokenData.expires_in ?? 3600;
  cachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  console.log(
    `[amazon-sp-api] Got new LWA token (expires in ${expiresIn}s, refresh took ${Date.now() - startedAt}ms)`,
  );
  return accessToken;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // Reuse cache if at least 5 minutes of life left
  if (cachedToken && cachedToken.expiresAt > now + 5 * 60 * 1000) {
    return cachedToken.accessToken;
  }
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = refreshAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function buildUrl(baseUrl: string, path: string, query?: SpApiRequest['query']): string {
  const url = new URL(path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.append(k, String(v));
      }
    }
  }
  return url.toString();
}

/**
 * Call the Amazon SP-API directly. Returns { status, data } on 2xx, throws
 * SpApiError on auth failures / non-2xx Amazon responses / network errors.
 */
export async function callAmazonSpApi<T = any>(req: SpApiRequest): Promise<SpApiResponse<T>> {
  const region: Region = req.region ?? 'na';
  const baseUrl = SP_API_ENDPOINTS[region];
  if (!baseUrl) {
    throw new SpApiError(`Unknown region: ${region}. Expected na|eu|fe`, 400);
  }
  if (!req.path || typeof req.path !== 'string' || !req.path.startsWith('/')) {
    throw new SpApiError('path is required and must start with /', 400);
  }

  // Acquire / refresh LWA token
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err: any) {
    if (err instanceof SpApiError) throw err;
    throw new SpApiError(`Amazon LWA auth failed: ${err?.message || err}`, 500);
  }

  const url = buildUrl(baseUrl, req.path, req.query);
  const hasBody =
    req.body !== undefined && req.body !== null && req.method !== 'GET' && req.method !== 'DELETE';

  const headers: Record<string, string> = {
    'x-amz-access-token': accessToken,
    Accept: 'application/json',
  };
  if (hasBody || (req.method !== 'GET' && req.method !== 'DELETE')) {
    headers['Content-Type'] = 'application/json';
  }

  console.log(`[amazon-sp-api] ${req.method} ${url}`);

  let amzRes: Response;
  try {
    amzRes = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
  } catch (err: any) {
    throw new SpApiError(`Upstream network error: ${err?.message || err}`, 502);
  }

  const respText = await amzRes.text();
  let respData: unknown;
  try {
    respData = respText ? JSON.parse(respText) : null;
  } catch {
    respData = respText;
  }

  // 401 from Amazon almost always means the cached token went stale (clock skew,
  // refresh-token rotation, etc). Drop the cache so the next caller refreshes.
  if (amzRes.status === 401) {
    console.warn('[amazon-sp-api] Amazon returned 401 — clearing LWA token cache');
    cachedToken = null;
  }

  if (!amzRes.ok) {
    const preview =
      typeof respData === 'string'
        ? respData.slice(0, 500)
        : JSON.stringify(respData).slice(0, 500);
    console.warn(`[amazon-sp-api] Amazon returned ${amzRes.status}: ${preview}`);
    throw new SpApiError(
      `Amazon SP-API error (HTTP ${amzRes.status})`,
      amzRes.status,
      respData,
    );
  }

  return { status: amzRes.status, data: respData as T };
}

/**
 * Test hook: clear the cached LWA token. Production code should not need to
 * call this, but the health-check cron uses it to force a fresh refresh.
 */
export function _clearTokenCacheForTests(): void {
  cachedToken = null;
  refreshInFlight = null;
}
