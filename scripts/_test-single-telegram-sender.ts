/**
 * GUARD: exactly ONE place in lib/ + api/ may call api.telegram.org/sendMessage —
 * fba-post-process.sendTelegram (hardcoded FBA chat id, HTML, read-the-body).
 *
 * Why this exists (2026-10-03): four hand-rolled senders read
 * TELEGRAM_FBA_CHAT_ID from env, which is stale on Vercel. Their messages —
 * including the "on hold, @marketing" notices for TR-00484/00508 and every
 * reconciler config-error escalation — returned 200 to nobody. The floor
 * waited 1–2 days. A second sender is how that comes back; this test fails
 * the build if one appears.
 *
 * Run: npx tsx scripts/_test-single-telegram-sender.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const root = path.join(__dirname, '..');
const files = [...walk(path.join(root, 'lib')), ...walk(path.join(root, 'api'))];
const ALLOWED = new Set([path.join(root, 'lib/fba-post-process.ts'), path.join(root, 'lib/telegram-health.ts')]);

// Source minus line and block comments: history may NAME the old pattern; code may not USE it.
const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const senders = files.filter((f) => /api\.telegram\.org\/bot[^\n]*sendMessage|\/sendMessage`/.test(code(f)) && !ALLOWED.has(f));
ok('🔴 no sendMessage call outside fba-post-process (and the health probe)', senders.length === 0, senders.map((s) => path.relative(root, s)).join(', '));

const envReaders = files.filter((f) => /TELEGRAM_FBA_CHAT_ID/.test(code(f)) && !ALLOWED.has(f));
ok('🔴 nobody but resolveFbaChatId reads TELEGRAM_FBA_CHAT_ID', envReaders.length === 0, envReaders.map((s) => path.relative(root, s)).join(', '));

const pp = fs.readFileSync(path.join(root, 'lib/fba-post-process.ts'), 'utf8');
ok('the one sender reads the response body and returns false on !ok', /if \(!resp\.ok\)[\s\S]{0,400}return false/.test(pp));
ok('sendTelegramMarkdown exists for legacy alert text', /export async function sendTelegramMarkdown/.test(pp));

const rec = fs.readFileSync(path.join(root, 'lib/fba-reconciler.ts'), 'utf8');
ok('reconciler alerts delegate to the shared sender', /sendTelegramMarkdown\(message\)/.test(rec));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
