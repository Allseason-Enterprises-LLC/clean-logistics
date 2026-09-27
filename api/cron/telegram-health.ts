/**
 * GET /api/cron/telegram-health   (CRON_SECRET)
 * Reports whether PROD's Telegram credentials can reach the FBA channel.
 * Read-only. Add ?send=1 to also post a one-line test message.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkTelegramHealth } from '../../lib/telegram-health';
import { sendTelegram } from '../../lib/fba-post-process';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const health = await checkTelegramHealth();
  let test_sent: boolean | null = null;
  if (req.query.send === '1' && health.ok) {
    test_sent = await sendTelegram(`🩺 Telegram health check from the FBA pipeline — delivery is working (bot @${health.bot_username}).`);
  }
  return res.status(health.ok ? 200 : 503).json({ ...health, test_sent });
}
