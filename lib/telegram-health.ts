/**
 * Telegram delivery self-check — proves whether the PROD credentials can post
 * to the FBA channel, using Telegram's own API (getMe + getChat).
 *
 * Why: sendTelegram() fails "loudly" into console.error — which on Vercel is a
 * log nobody reads. On 2026-09-27 the kit gate's 🔧 notice for TR-00484 never
 * arrived and nobody could tell whether the env was wrong or the code was.
 * A dead notification channel must be visible in a cron's JSON, not a log.
 *
 * Never throws. Never logs the token. Returns a small verdict object.
 */
import { resolveFbaChatId } from './fba-post-process';

export interface TelegramHealth {
  ok: boolean;
  token_set: boolean;
  /** first 10 chars of the token (the bot id) — enough to identify WHICH bot */
  bot_id_prefix: string | null;
  bot_username: string | null;
  chat_id: string | null;
  chat_title: string | null;
  problem: string | null;
}

export async function checkTelegramHealth(fetchImpl: typeof fetch = fetch): Promise<TelegramHealth> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  // Same resolution sendTelegram uses, so the health check reports the id that
  // will actually be posted to — not whatever a stale env var says.
  const chatId = resolveFbaChatId();
  const out: TelegramHealth = {
    ok: false, token_set: !!token, bot_id_prefix: token ? token.split(':')[0] : null,
    bot_username: null, chat_id: chatId || null, chat_title: null, problem: null,
  };
  if (!token) { out.problem = 'TELEGRAM_BOT_TOKEN missing'; return out; }
  try {
    const me: any = await (await fetchImpl(`https://api.telegram.org/bot${token}/getMe`)).json();
    if (!me?.ok) { out.problem = `getMe failed: ${me?.description || 'unknown'} — token is dead/revoked (bot ${out.bot_id_prefix})`; return out; }
    out.bot_username = me.result?.username || null;
    const chat: any = await (await fetchImpl(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`)).json();
    if (!chat?.ok) { out.problem = `getChat(${chatId}) failed: ${chat?.description || 'unknown'} — bot @${out.bot_username} is not in that chat, or the id is stale`; return out; }
    out.chat_title = chat.result?.title || null;
    out.ok = true;
  } catch (e: any) {
    out.problem = `network: ${e?.message || e}`;
  }
  return out;
}
