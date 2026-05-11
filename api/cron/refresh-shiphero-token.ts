/**
 * GET /api/cron/refresh-shiphero-token
 *
 * Daily cron that proactively refreshes the Clean Nutra ShipHero access
 * token before it expires (28-day window). Strategy:
 *   1. If current token is valid for >7 days, do nothing.
 *   2. Otherwise, try refresh_token grant.
 *   3. If that fails, fall back to username+password grant.
 *   4. Persist new tokens to Supabase warehouses row.
 *   5. On failure, send a loud Telegram alert to the FBA group so we have
 *      time to intervene before the bridge breaks.
 *
 * Scheduled daily (see vercel.json).
 *
 * Auth: Vercel cron header OR Bearer CRON_SECRET.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { refreshShipHeroTokenIfNeeded } from '../../lib/shiphero-auth';

function authorized(req: VercelRequest): boolean {
  if (req.headers['x-vercel-cron'] === '1' && process.env.VERCEL === '1') {
    return true;
  }
  const auth = req.headers.authorization;
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return auth === `Bearer ${expected}`;
}

async function alertTelegram(message: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID;
  if (!botToken || !chatId) {
    console.warn(
      '[refresh-shiphero-token] No Telegram creds — skipping alert'
    );
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[refresh-shiphero-token] Telegram alert failed:', err);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Allow ?withinDays=N for manual override on retries; default 7
  const requestedDays = Number(req.query.withinDays);
  const withinDays = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 30)
    : 7;

  try {
    const outcome = await refreshShipHeroTokenIfNeeded(withinDays);

    if (!outcome.success) {
      // Loud alert: we couldn't refresh, the bridge will break soon
      await alertTelegram(
        `🚨 *ShipHero token refresh FAILED*\n\n` +
          `Both refresh_token and password grants failed.\n` +
          `Error: \`${outcome.error || 'unknown'}\`\n\n` +
          `Action needed: re-mint the token manually via ShipHero dashboard ` +
          `and update Supabase warehouses row \`22e17170-af72-4bf8-b77c-d73c86b06765\`.`
      );
      return res.status(500).json({ ...outcome, success: false });
    }

    if (outcome.wroteToSupabase) {
      console.log(
        `[refresh-shiphero-token] Token refreshed via ${outcome.method} grant`
      );
    }

    // Strip tokens from response so logs don't leak them
    const { newTokens: _hidden, ...safe } = outcome;
    return res.status(200).json({ ...safe, success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[refresh-shiphero-token] Fatal error:', msg);
    await alertTelegram(
      `🚨 *ShipHero token refresh CRASHED*\n\n` +
        `Error: \`${msg}\`\n\n` +
        `Manual intervention may be needed.`
    );
    return res.status(500).json({ success: false, error: msg });
  }
}
