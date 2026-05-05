// supabase/functions/amazon-sp-api/index.ts
//
// Amazon SP-API Proxy Edge Function
// ================================
// A single gateway for all Amazon Selling Partner API calls from Clean Nutra apps.
// Consolidates auth, token refresh, retries, and logging in one place so no
// application code ever talks to sellingpartnerapi-*.amazon.com directly.
//
// Request body:
//   {
//     "method": "GET" | "POST" | "PUT" | "DELETE",
//     "path": "/inbound/fba/2024-03-20/inboundPlans",   // no host, starts with /
//     "region": "na" | "eu" | "fe"                      // default: na
//     "body": { ... }                                   // optional request body
//     "query": { key: value, ... }                      // optional query params
//   }
//
// Response:
//   200: { status, data }                               // proxied Amazon response
//   4xx/5xx: { error, details? }
//
// Secrets (set in Supabase dashboard or via `supabase secrets set`):
//   AMAZON_LWA_CLIENT_ID
//   AMAZON_LWA_CLIENT_SECRET
//   AMAZON_SP_REFRESH_TOKEN
//   AMAZON_PROXY_SHARED_SECRET    (callers must send this in Authorization header)

// @ts-ignore - Deno URL import resolved at runtime in Supabase Edge Runtime
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Deno global shim for TS compile
declare const Deno: { env: { get(name: string): string | undefined } };

const SP_API_ENDPOINTS: Record<string, string> = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};

const LWA_TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';

// Cache access token across warm invocations (~55 min expiry; tokens last 60 min)
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

interface ProxyRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  region?: 'na' | 'eu' | 'fe';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Optional: if the caller has a specific token (rare — e.g. LWA-scoped), skip refresh */
  overrideAccessToken?: string;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'content-type': 'application/json' },
  });
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 5 * 60 * 1000) {
    return cachedToken.accessToken;
  }

  const clientId = Deno.env.get('IM_AMAZON_CLIENT_ID') || Deno.env.get('AMAZON_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('IM_AMAZON_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET');
  const refreshToken = Deno.env.get('IM_AMAZON_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Amazon LWA credentials in edge function secrets (IM_AMAZON_CLIENT_ID / IM_AMAZON_CLIENT_SECRET / IM_AMAZON_REFRESH_TOKEN — or AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_SP_REFRESH_TOKEN as fallback)');
  }

  console.log('[amazon-sp-api] Refreshing LWA access token...');
  const tokenRes = await fetch(LWA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    throw new Error(`LWA token refresh failed: ${tokenRes.status} - ${errorText}`);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token as string;
  const expiresIn = (tokenData.expires_in as number) ?? 3600;
  cachedToken = {
    accessToken,
    expiresAt: now + expiresIn * 1000,
  };
  console.log(`[amazon-sp-api] Got new LWA token, expires in ${expiresIn}s`);
  return accessToken;
}

function buildUrl(baseUrl: string, path: string, query?: ProxyRequest['query']): string {
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

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  // Shared-secret auth between caller (clean-logistics / brandmind) and this proxy.
  // Optional: if AMAZON_PROXY_SHARED_SECRET is not set, we fall back to relying on
  // Supabase's function invocation auth (apikey or JWT). For now the edge function
  // is deployed with verify_jwt=false so anyone with the URL can call it — add the
  // shared secret env var to lock that down.
  const sharedSecret = Deno.env.get('AMAZON_PROXY_SHARED_SECRET');
  if (sharedSecret) {
    const authHeader = req.headers.get('authorization') || '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '');
    if (bearer !== sharedSecret) {
      return json(401, { error: 'Unauthorized' });
    }
  } else {
    console.warn('[amazon-sp-api] WARNING: AMAZON_PROXY_SHARED_SECRET not set — endpoint is publicly callable. Set this secret to enable shared-secret auth.');
  }

  let payload: ProxyRequest;
  try {
    payload = (await req.json()) as ProxyRequest;
  } catch (_e) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { method = 'GET', path, region = 'na', body, query, overrideAccessToken } = payload;
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    return json(400, { error: 'path is required and must start with /' });
  }

  const baseUrl = SP_API_ENDPOINTS[region];
  if (!baseUrl) {
    return json(400, { error: `Unknown region: ${region}. Expected na|eu|fe` });
  }

  let accessToken: string;
  try {
    accessToken = overrideAccessToken || (await getAccessToken());
  } catch (err: any) {
    console.error('[amazon-sp-api] Auth failed:', err?.message || err);
    return json(500, { error: 'Amazon auth failed', details: err?.message || String(err) });
  }

  const url = buildUrl(baseUrl, path, query);
  console.log(`[amazon-sp-api] ${method} ${url}`);

  const amazonHeaders: Record<string, string> = {
    'x-amz-access-token': accessToken,
    'Accept': 'application/json',
  };
  // Only send Content-Type on methods with a body payload (some Amazon endpoints reject it on bodyless POSTs)
  const hasBody = body !== undefined && body !== null && method !== 'GET' && method !== 'DELETE';
  if (hasBody || (method !== 'GET' && method !== 'DELETE')) {
    amazonHeaders['Content-Type'] = 'application/json';
  }

  let amzRes: Response;
  try {
    amzRes = await fetch(url, {
      method,
      headers: amazonHeaders,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    console.error('[amazon-sp-api] Network error:', err?.message || err);
    return json(502, { error: 'Upstream network error', details: err?.message || String(err) });
  }

  const respText = await amzRes.text();
  let respData: unknown;
  try {
    respData = respText ? JSON.parse(respText) : null;
  } catch {
    respData = respText;
  }

  if (!amzRes.ok) {
    console.warn(`[amazon-sp-api] Amazon returned ${amzRes.status}:`, typeof respData === 'string' ? respData.slice(0, 500) : JSON.stringify(respData).slice(0, 500));
  }

  return json(amzRes.status, { status: amzRes.status, data: respData });
});
