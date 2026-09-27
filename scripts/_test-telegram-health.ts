/**
 * Telegram health check: never throws, never leaks the token, names the bot and the failure.
 * Run: npx tsx scripts/_test-telegram-health.ts
 */
import { checkTelegramHealth } from '../lib/telegram-health';
let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const fake = (map: Record<string, any>) => (async (url: string) => ({ json: async () => { for (const k in map) if (url.includes(k)) return map[k]; return { ok: false, description: 'Not Found' }; } })) as any;

async function main() {
  const env = process.env;
  env.TELEGRAM_BOT_TOKEN = '8350576274:AAGzSECRETSECRET'; env.TELEGRAM_FBA_CHAT_ID = '-5244576221\n';
  let h = await checkTelegramHealth(fake({ getMe: { ok: false, description: 'Not Found' } }));
  ok('dead token -> ok:false, names the bot id, says token is dead', !h.ok && h.bot_id_prefix === '8350576274' && /dead|revoked/.test(h.problem || ''));
  ok('never leaks the token secret', !JSON.stringify(h).includes('SECRETSECRET'));
  ok('stale env chat id is REPLACED by the fixed group id', h.chat_id === '-1003528234475');

  h = await checkTelegramHealth(fake({ getMe: { ok: true, result: { username: 'freightaiagentbm_bot' } }, getChat: { ok: false, description: 'Bad Request: chat not found' } }));
  ok('good token, stale chat -> ok:false, names bot + chat', !h.ok && h.bot_username === 'freightaiagentbm_bot' && /chat not found/.test(h.problem || '') && /stale|not in that chat/.test(h.problem || ''));

  h = await checkTelegramHealth(fake({ getMe: { ok: true, result: { username: 'freightaiagentbm_bot' } }, getChat: { ok: true, result: { title: 'Clean Nutra FBA Shipments 🚚' } } }));
  ok('good token + live chat -> ok:true with chat title', h.ok && h.chat_title === 'Clean Nutra FBA Shipments 🚚' && h.problem === null);

  delete env.TELEGRAM_BOT_TOKEN;
  h = await checkTelegramHealth(fake({}));
  ok('missing token -> ok:false, no network call needed', !h.ok && /missing/.test(h.problem || '') && h.token_set === false);
  ok('missing chat env is NOT a failure any more (fixed default)', h.chat_id === '-1003528234475');

  env.TELEGRAM_BOT_TOKEN = 'x:y';
  h = await checkTelegramHealth((async () => { throw new Error('ECONNRESET'); }) as any);
  ok('network error -> ok:false, never throws', !h.ok && /ECONNRESET/.test(h.problem || ''));

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
