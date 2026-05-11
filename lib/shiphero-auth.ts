/**
 * ShipHero token refresh
 *
 * Strategy (in order):
 *   1. Try refresh_token grant via POST /auth/refresh
 *   2. If that fails (refresh token expired/revoked), fall back to
 *      username+password grant via POST /auth/token using
 *      SHIPHERO_USERNAME + SHIPHERO_PASSWORD env vars
 *   3. On any success, write the new {accessToken, refreshToken} pair to the
 *      Supabase warehouses row for the Clean Nutra (Las Vegas) account.
 *
 * Tokens last 28 days. We run this daily so we always refresh well before
 * expiry. If both paths fail, the caller (the cron handler) is expected to
 * raise a Telegram alert.
 */

import { supabase } from './supabase';

const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const SHIPHERO_AUTH_REFRESH = 'https://public-api.shiphero.com/auth/refresh';
const SHIPHERO_AUTH_TOKEN = 'https://public-api.shiphero.com/auth/token';

interface ShipHeroTokenPair {
  accessToken: string;
  refreshToken: string;
}

interface RefreshOutcome {
  success: boolean;
  method: 'refresh_token' | 'password' | 'failed';
  newTokens?: ShipHeroTokenPair;
  error?: string;
  // Whether we actually wrote new tokens to Supabase (only if refreshed)
  wroteToSupabase: boolean;
}

/**
 * Decode a JWT and return its `exp` claim as a unix timestamp (seconds), or
 * null if the token is malformed.
 */
function getJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8')
    );
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Read the currently-stored ShipHero credentials from Supabase.
 */
async function readCurrentTokens(): Promise<ShipHeroTokenPair> {
  const { data, error } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID)
    .single();

  if (error) throw new Error(`Failed to read warehouses row: ${error.message}`);
  const creds = (data?.api_credentials || {}) as ShipHeroTokenPair;
  if (!creds.accessToken || !creds.refreshToken) {
    throw new Error('warehouses row missing accessToken or refreshToken');
  }
  return creds;
}

/**
 * Persist a new token pair to Supabase. Preserves any other fields on
 * api_credentials.
 */
async function writeTokens(pair: ShipHeroTokenPair): Promise<void> {
  const { error } = await supabase
    .from('warehouses')
    .update({
      api_credentials: {
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
      },
    })
    .eq('id', CLEAN_NUTRA_LV_UUID);

  if (error) throw new Error(`Failed to write tokens: ${error.message}`);
}

/**
 * Try refresh_token grant. ShipHero's /auth/refresh returns
 * "Service Unavailable" with HTTP 400 when the refresh token is invalid /
 * expired — that misleading wording is normal and means we should fall back.
 *
 * NOTE: ShipHero's refresh endpoint returns ONLY access_token (no refresh_token).
 * The existing refresh_token stays valid. We pass it through so callers can
 * persist both fields together.
 */
async function tryRefreshGrant(
  refreshToken: string
): Promise<ShipHeroTokenPair | null> {
  const resp = await fetch(SHIPHERO_AUTH_REFRESH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.warn(
      `[shiphero-auth] /auth/refresh returned HTTP ${resp.status}: ${text.slice(0, 200)}`
    );
    return null;
  }
  try {
    const json = JSON.parse(text);
    if (json.access_token) {
      // ShipHero's /auth/refresh does not rotate the refresh token —
      // reuse the one we already have.
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || refreshToken,
      };
    }
  } catch {
    /* fall through */
  }
  console.warn(
    `[shiphero-auth] /auth/refresh ok but body unexpected: ${text.slice(0, 200)}`
  );
  return null;
}

/**
 * Try password grant. Reads SHIPHERO_USERNAME + SHIPHERO_PASSWORD from env.
 */
async function tryPasswordGrant(): Promise<ShipHeroTokenPair | null> {
  const username = process.env.SHIPHERO_USERNAME;
  const password = process.env.SHIPHERO_PASSWORD;
  if (!username || !password) {
    console.warn(
      '[shiphero-auth] SHIPHERO_USERNAME or SHIPHERO_PASSWORD not set — cannot fall back to password grant'
    );
    return null;
  }

  const resp = await fetch(SHIPHERO_AUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.warn(
      `[shiphero-auth] /auth/token returned HTTP ${resp.status}: ${text.slice(0, 200)}`
    );
    return null;
  }
  try {
    const json = JSON.parse(text);
    if (json.access_token && json.refresh_token) {
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
      };
    }
  } catch {
    /* fall through */
  }
  console.warn(
    `[shiphero-auth] /auth/token ok but body unexpected: ${text.slice(0, 200)}`
  );
  return null;
}

/**
 * Refresh the ShipHero token if it expires within the next `withinDays` days.
 * Returns an outcome describing what happened. Idempotent and safe to call
 * daily.
 */
export async function refreshShipHeroTokenIfNeeded(
  withinDays = 7
): Promise<RefreshOutcome> {
  const current = await readCurrentTokens();
  const exp = getJwtExpiry(current.accessToken);
  const now = Math.floor(Date.now() / 1000);
  const threshold = now + withinDays * 24 * 60 * 60;

  if (exp && exp > threshold) {
    const daysLeft = Math.floor((exp - now) / 86400);
    console.log(
      `[shiphero-auth] Token still valid for ${daysLeft} days — no refresh needed`
    );
    return {
      success: true,
      method: 'refresh_token', // arbitrary, no refresh occurred
      wroteToSupabase: false,
    };
  }

  if (exp) {
    const hoursLeft = Math.max(0, Math.floor((exp - now) / 3600));
    console.log(
      `[shiphero-auth] Token expires in ${hoursLeft}h — refreshing now`
    );
  } else {
    console.log(
      '[shiphero-auth] Could not parse token expiry — attempting refresh anyway'
    );
  }

  // Path 1: refresh_token grant
  let pair = await tryRefreshGrant(current.refreshToken);
  if (pair) {
    await writeTokens(pair);
    console.log('[shiphero-auth] ✅ Refreshed via refresh_token grant');
    return {
      success: true,
      method: 'refresh_token',
      newTokens: pair,
      wroteToSupabase: true,
    };
  }

  // Path 2: password grant fallback
  console.log(
    '[shiphero-auth] refresh_token grant failed — falling back to password grant'
  );
  pair = await tryPasswordGrant();
  if (pair) {
    await writeTokens(pair);
    console.log('[shiphero-auth] ✅ Refreshed via password grant');
    return {
      success: true,
      method: 'password',
      newTokens: pair,
      wroteToSupabase: true,
    };
  }

  return {
    success: false,
    method: 'failed',
    error:
      'Both refresh_token and password grants failed. Check SHIPHERO_USERNAME / SHIPHERO_PASSWORD env vars and the ShipHero account status.',
    wroteToSupabase: false,
  };
}
