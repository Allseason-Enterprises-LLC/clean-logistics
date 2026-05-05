/**
 * Amazon SP-API Proxy Client
 * ==========================
 * Every Amazon SP-API call from clean-logistics MUST go through this helper,
 * which forwards to the `amazon-sp-api` Supabase edge function. Direct calls
 * to sellingpartnerapi-*.amazon.com are forbidden by architectural policy.
 *
 * Why: centralized auth, token caching, logging, retry/rate-limit handling.
 *
 * Env vars required (set in Vercel for clean-logistics):
 *   SUPABASE_URL
 *   AMAZON_PROXY_SHARED_SECRET   (must match the edge function's secret)
 *
 * Usage:
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

function resolveEdgeFunctionUrl(): string {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL env var is required for Amazon SP-API proxy calls');
  }
  // Supabase edge function URL: https://<ref>.supabase.co/functions/v1/<fn>
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/amazon-sp-api`;
}

function resolveSharedSecret(): string {
  const secret = process.env.AMAZON_PROXY_SHARED_SECRET;
  if (!secret) {
    throw new Error('AMAZON_PROXY_SHARED_SECRET env var is required for Amazon SP-API proxy calls');
  }
  return secret;
}

/**
 * Call the Amazon SP-API via the Supabase proxy edge function.
 * Throws SpApiError on non-2xx Amazon responses; returns { status, data } on success.
 */
export async function callAmazonSpApi<T = any>(req: SpApiRequest): Promise<SpApiResponse<T>> {
  const url = resolveEdgeFunctionUrl();
  const secret = resolveSharedSecret();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method: req.method,
      path: req.path,
      region: req.region ?? 'na',
      body: req.body,
      query: req.query,
    }),
  });

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new SpApiError(`Proxy returned non-JSON response (HTTP ${response.status})`, response.status);
  }

  if (!response.ok) {
    throw new SpApiError(
      payload?.error || `Proxy error (HTTP ${response.status})`,
      response.status,
      payload?.details ?? payload,
    );
  }

  // payload shape: { status, data }
  const amazonStatus: number = payload.status;
  const amazonData = payload.data;

  if (amazonStatus >= 400) {
    throw new SpApiError(
      `Amazon SP-API error (HTTP ${amazonStatus})`,
      amazonStatus,
      amazonData,
    );
  }

  return { status: amazonStatus, data: amazonData as T };
}
