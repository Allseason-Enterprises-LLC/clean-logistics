/**
 * GET /api/cron/check-amazon-proxy-health
 *
 * Probes the Supabase `amazon-sp-api` edge function and alerts Telegram
 * if it is unreachable.
 *
 * NOTE: Auto-redeploy is intentionally NOT done here. Vercel's serverless
 * environment does not ship the raw TS source files, so `supabase functions
 * deploy` cannot read them. Auto-redeploy runs as a Hermes cron on the local
 * machine where the source is present (job: "amazon-sp-api health check + auto-redeploy").
 *
 * Schedule: every 5 minutes (vercel.json).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 60 };

const SUPABASE_PROJECT_REF = 'gvrwkjmmgohtovtcyjiu';

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID?.trim();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    });
  } catch (err: any) {
    console.warn('[health] Telegram alert failed:', err?.message || err);
  }
}

async function probeEdgeFunction(): Promise<{ healthy: boolean; latency_ms: number; error?: string; status?: number }> {
  const startedAt = Date.now();
  try {
    const r = await callAmazonSpApi<any>({
      method: 'GET',
      path: '/inbound/fba/2024-03-20/inboundPlans',
      query: { pageSize: 1 },
    });
    return { healthy: r.status === 200, latency_ms: Date.now() - startedAt };
  } catch (err: any) {
    return {
      healthy: false,
      latency_ms: Date.now() - startedAt,
      error: err?.message || String(err),
      status: err?.status,
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const probe = await probeEdgeFunction();

  if (probe.healthy) {
    return res.status(200).json({ healthy: true, latency_ms: probe.latency_ms });
  }

  console.error('[health] amazon-sp-api probe failed:', probe.error, 'status:', probe.status);

  // HTTP 404 = regional propagation loss — Hermes cron handles the redeploy
  const isRegionalLoss = probe.status === 404;
  const label = isRegionalLoss
    ? '🚨 *FBA pipeline DOWN — edge function unreachable (auto-redeploy triggered on server)*'
    : '⚠️ *FBA proxy health check failed*';

  await sendTelegramAlert(
    `${label}\n\nProject: \`${SUPABASE_PROJECT_REF}\`\nError: ${probe.error}\nStatus: ${probe.status ?? '?'}`
  );

  return res.status(503).json({ healthy: false, error: probe.error, status: probe.status });
}
