/**
 * Regression: TikTok access_token_expire_in is an ABSOLUTE unix ts (~7d out).
 * Old code added it to now → expires_at ≈ 2082 → never refreshed → order
 * bridge dead from 2026-05/06 until 2026-11-18.
 * Run: npx tsx scripts/_test-tiktok-token-expiry.ts
 */
import { tiktokExpiryToDate } from '../lib/tiktok-api';

let fails = 0;
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${detail}`}`);
}

const now = Date.UTC(2026, 10, 18, 18, 58, 0); // 2026-11-18 18:58 UTC
const realTs = Math.floor(Date.UTC(2026, 10, 25, 18, 58, 0) / 1000); // value TikTok returned

const d = tiktokExpiryToDate(realTs, now);
ok('absolute 7-day ts -> 2026-11-25', d.toISOString() === '2026-11-25T18:58:00.000Z', d.toISOString());
ok('never lands decades out (the 2082 bug)', d.getTime() - now < 30 * 86400_000, d.toISOString());

const old = (v: number) => {
  const nowSec = Math.floor(now / 1000);
  return v > nowSec + 365 * 86400 ? new Date(v * 1000) : new Date(now + v * 1000);
};
ok('old logic reproduces the bug (sanity)', old(realTs).getUTCFullYear() > 2080, old(realTs).toISOString());

const dur = tiktokExpiryToDate(604800, now);
ok('small value treated as duration', dur.toISOString() === '2026-11-25T18:58:00.000Z', dur.toISOString());

let threw = false;
try { tiktokExpiryToDate(0, now); } catch { threw = true; }
ok('0 throws instead of storing a bogus expiry', threw);
threw = false;
try { tiktokExpiryToDate(NaN, now); } catch { threw = true; }
ok('NaN throws', threw);

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
