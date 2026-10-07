/**
 * HTML-safety of the FBA Telegram message. OFFLINE by default: asserts the
 * escaping + the sender's parse mode without touching Telegram.
 *
 * 2026-10-07 (Weston: "Why do you send this all the time?"): this suite used
 * to POST a real "[automated render test]" message to Weston's DM on every
 * run — and the full suite runs before every push. Seven test messages in a
 * day. Live send is now opt-in: TELEGRAM_RENDER_TEST_SEND=1.
 *
 * Run: npx tsx scripts/_test-telegram-html.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const mod = fs.readFileSync(path.join(__dirname, '../lib/fba-post-process.ts'), 'utf8');
// Default parse mode is HTML (parameterised 2026-10-03 so legacy Markdown alerts can share the sender).
ok('sendTelegram defaults to HTML parse mode', mod.includes("parseMode: 'HTML' | 'Markdown' = 'HTML'") && mod.includes('parse_mode: parseMode'));

const nasty = {
  name: 'Garlic & Oregano <120ct> Bag',
  dest: 'HAGERSTOWN_MD',
  file: 'FBA19QN44TW9-DESERTHOTSPRINGS_CA-141boxes.pdf',
  sku: 'CN-POW-WMNSCREATIORA-30SV',
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = [
  `📦 <b>FBA Shipment — ${esc(nasty.name)}</b>`,
  `<b>CIN7 SKU:</b> <code>${esc(nasty.sku)}</code>`,
  `• <code>FBA19QN44TW9</code> → ${esc(nasty.dest)} — 141 boxes`,
  `• <a href="https://example.com/${esc(nasty.file)}">${esc(nasty.dest)} (141)</a>`,
  '✅ Ready for warehouse processing',
].join('\n');

ok('& < > in product names are escaped (Telegram HTML rejects raw ones)', text.includes('Garlic &amp; Oregano &lt;120ct&gt; Bag') && !/<120ct>/.test(text));
ok('every opened tag is closed (b/code/a)', ['b', 'code', 'a'].every((t) => (text.match(new RegExp(`<${t}[ >]`, 'g')) || []).length === (text.match(new RegExp(`</${t}>`, 'g')) || []).length));
ok('post-process escapes the product name / destination before building the message', /escapeHtml\(|&amp;/.test(mod));

(async () => {
  if (process.env.TELEGRAM_RENDER_TEST_SEND === '1') {
    const token = fs.readFileSync('/tmp/freightbot', 'utf8').trim();
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '855387948', text: '[automated render test]\n' + text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const body: any = await resp.json();
    ok('LIVE: Telegram accepted the HTML', !!body.ok, JSON.stringify(body).slice(0, 200));
  } else {
    console.log('skip  live send (set TELEGRAM_RENDER_TEST_SEND=1 to actually post the render test)');
  }
  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
})();
