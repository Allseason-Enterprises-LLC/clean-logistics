/**
 * GET /api/cron/check-amazon-proxy-health
 *
 * Probes the Supabase `amazon-sp-api` edge function via the production proxy
 * client. Catches the known failure mode where the function vanishes from the
 * us-east-1 edge region (where Vercel functions run) while remaining healthy
 * from other regions.
 *
 * Symptom of the failure: HTTP 404 with body
 *   {"code":"NOT_FOUND","message":"Requested function was not found"}
 * and response headers `sb-error-code: NOT_FOUND` + `x-sb-edge-region: us-east-1`.
 *
 * On failure: posts a Telegram alert with the redeploy command.
 *
 * Schedule: every 5 minutes (vercel.json).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 30 };

const REDEPLOY_HINT =
  "cd /home/wcorica/clean-logistics && SUPABASE_ACCESS_TOKEN=<sbp_…> npx supabase functions deploy amazon-sp-api --project-ref gvrwkjmmgohtovtcyjiu --no-verify-jwt";

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[health] TELEGRAM creds missing — skipping alert');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    if (!res.ok) {
      console.warn('[health] Telegram alert HTTP', res.status, await res.text().catch(() => ''));
    }
  } catch (err: any) {
    console.warn('[health] Telegram alert failed:', err?.message || err);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();

  try {
    const r = await callAmazonSpApi<any>({
      method: 'GET',
      path: '/inbound/fba/2024-03-20/inboundPlans',
      query: { pageSize: 1 },
    });
    if (r.status === 200) {
      return res.status(200).json({
        healthy: true,
        latency_ms: Date.now() - startedAt,
        plans_visible: r.data?.inboundPlans?.length ?? 0,
      });
    }
    throw new Error(`Unexpected status ${r.status}`);
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    const status = err?.status;
    const details =
      err?.details && typeof err.details === 'object'
        ? JSON.stringify(err.details).slice(0, 300)
        : String(err?.details || '').slice(0, 300);

    console.error('[health] amazon-sp-api probe failed:', errMsg, details);

    // Only alert on the specific signature of regional propagation loss —
    // HTTP 404 from the Supabase gateway. Other errors (Amazon-side outage,
    // token expiry, etc.) shouldn't fire the redeploy alert.
    const isRegionalLoss =
      status === 404 && /not_found/i.test(details + ' ' + errMsg);

    if (isRegionalLoss) {
      await sendTelegramAlert(
        `🚨 *FBA pipeline DOWN — Supabase edge function unreachable*\n\n` +
          `The \`amazon-sp-api\` proxy returned 404 from Vercel. This is the regional propagation loss issue ` +
          `(function vanished from us-east-1 edge).\n\n` +
          `*Redeploy:* \`${REDEPLOY_HINT}\`\n\n` +
          `Error: ${errMsg}\nDetails: ${details}`
      );
    } else {
      await sendTelegramAlert(
        `⚠️ *FBA proxy health check failed*\n\n` +
          `Error: ${errMsg}\nStatus: ${status ?? '?'}\nDetails: ${details}`
      );
    }

    return res.status(503).json({
      healthy: false,
      error: errMsg,
      status,
      details,
      latency_ms: Date.now() - startedAt,
    });
  }
}
