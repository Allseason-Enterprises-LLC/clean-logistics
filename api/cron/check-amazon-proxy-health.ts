/**
 * GET /api/cron/check-amazon-proxy-health
 *
 * Probes the Supabase `amazon-sp-api` edge function. When it detects the
 * known regional-loss failure (HTTP 404 from us-east-1), it **automatically
 * redeploys** the function via the Supabase Management API instead of just
 * alerting a human.
 *
 * Failure mode: edge function vanishes from us-east-1 (Vercel's region)
 * periodically. Symptom: HTTP 404 {"code":"NOT_FOUND"}.
 *
 * Self-heal flow:
 *   1. Probe the edge function with a lightweight SP-API call.
 *   2. On 404 NOT_FOUND → call Supabase Management API to redeploy.
 *   3. Re-probe after 10s to confirm recovery.
 *   4. Alert Telegram with outcome (auto-healed vs still down).
 *
 * Requires env vars: SUPABASE_MGMT_TOKEN (Supabase PAT, sbp_...)
 *
 * Schedule: every 5 minutes (vercel.json).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';
import * as fs from 'fs';
import * as path from 'path';

export const config = { maxDuration: 60 };

const SUPABASE_PROJECT_REF = 'gvrwkjmmgohtovtcyjiu';
const FUNCTION_SLUG = 'amazon-sp-api';
// Path to the edge function source (relative to project root on Vercel)
const FUNCTION_SOURCE_PATH = path.join(process.cwd(), 'supabase/functions/amazon-sp-api/index.ts');

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

/**
 * Auto-redeploy the edge function via Supabase Management API.
 * Replicates what `supabase functions deploy --no-verify-jwt` does:
 * POST /v1/projects/{ref}/functions/deploy?slug={slug} with multipart body.
 */
async function redeployEdgeFunction(): Promise<{ success: boolean; error?: string }> {
  const mgmtToken = process.env.SUPABASE_MGMT_TOKEN;
  if (!mgmtToken) {
    return { success: false, error: 'SUPABASE_MGMT_TOKEN env var not set' };
  }

  let sourceCode: string;
  try {
    sourceCode = fs.readFileSync(FUNCTION_SOURCE_PATH, 'utf-8');
  } catch (err: any) {
    return { success: false, error: `Could not read function source: ${err?.message}` };
  }

  // Build multipart form body: Supabase deploy API expects
  // a .eszip bundle or raw TS file uploaded as multipart
  const boundary = `----SupabaseDeployBoundary${Date.now()}`;
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="metadata"`,
    `Content-Type: application/json`,
    ``,
    JSON.stringify({ entrypoint_path: `supabase/functions/${FUNCTION_SLUG}/index.ts`, import_map: false }),
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${FUNCTION_SLUG}/index.ts"`,
    `Content-Type: application/typescript`,
    ``,
    sourceCode,
    `--${boundary}--`,
  ].join('\r\n');

  try {
    const resp = await fetch(
      `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/functions/deploy?slug=${FUNCTION_SLUG}&no-verify-jwt=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mgmtToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { success: false, error: `Deploy API returned HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
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

  // Initial probe
  const probe = await probeEdgeFunction();

  if (probe.healthy) {
    return res.status(200).json({ healthy: true, latency_ms: probe.latency_ms });
  }

  const details = probe.error || '';
  const isRegionalLoss = probe.status === 404 && /not_found/i.test(details);

  console.error('[health] amazon-sp-api probe failed:', probe.error, 'status:', probe.status);

  if (!isRegionalLoss) {
    // Non-404 error (Amazon outage, token expiry, etc.) — alert only, don't redeploy
    await sendTelegramAlert(
      `⚠️ *FBA proxy health check failed*\n\nError: ${probe.error}\nStatus: ${probe.status ?? '?'}`
    );
    return res.status(503).json({ healthy: false, error: probe.error, status: probe.status });
  }

  // Regional loss detected — auto-redeploy
  console.log('[health] Regional loss detected — auto-redeploying edge function...');
  const deploy = await redeployEdgeFunction();

  if (!deploy.success) {
    console.error('[health] Auto-redeploy failed:', deploy.error);
    await sendTelegramAlert(
      `🚨 *FBA pipeline DOWN — edge function unreachable + auto-redeploy failed*\n\n` +
        `Probe error: ${probe.error}\n` +
        `Redeploy error: ${deploy.error}\n\n` +
        `Manual fix: \`SUPABASE_ACCESS_TOKEN=<sbp_…> supabase functions deploy amazon-sp-api --project-ref ${SUPABASE_PROJECT_REF} --no-verify-jwt\``
    );
    return res.status(503).json({ healthy: false, error: probe.error, redeploy: deploy });
  }

  // Wait 10s for propagation, then re-probe
  await new Promise(r => setTimeout(r, 10_000));
  const reProbe = await probeEdgeFunction();

  if (reProbe.healthy) {
    console.log('[health] Auto-redeploy successful — edge function recovered');
    // Silent recovery — no alert needed, don't spam the channel every time this happens
    return res.status(200).json({ healthy: true, auto_redeployed: true, latency_ms: reProbe.latency_ms });
  }

  // Still down after redeploy — escalate
  await sendTelegramAlert(
    `🚨 *FBA pipeline DOWN — auto-redeploy attempted but function still unreachable*\n\n` +
      `The \`amazon-sp-api\` edge function returned 404 after auto-redeploy. ` +
      `Manual investigation required.\n\n` +
      `Error: ${reProbe.error}`
  );
  return res.status(503).json({ healthy: false, auto_redeployed: true, still_down: true, error: reProbe.error });
}
