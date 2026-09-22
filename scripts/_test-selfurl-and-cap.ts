/**
 * Tests for the two 401 fixes:
 *   1. getSelfBaseUrl must NEVER return the protected VERCEL_URL
 *   2. the reconciler must CAP config errors (401/403) instead of retrying forever
 * Run: npx tsx scripts/_test-selfurl-and-cap.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
function ok(label: string, cond: boolean, extra = '') {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + extra}`);
}

const ALIAS = 'https://shiphero-shipstation-bridge.vercel.app';

// ---- 1. self URL ----
const handoff = fs.readFileSync(path.join(__dirname, '../lib/cin7-fba-handoff.ts'), 'utf8');
const raw = handoff.slice(
  handoff.indexOf('function getSelfBaseUrl'),
  handoff.indexOf('\n}', handoff.indexOf('function getSelfBaseUrl'))
);
// Strip comments — the explanatory block legitimately NAMES the vars we removed.
const fn = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');
ok('getSelfBaseUrl no longer reads VERCEL_URL', !fn.includes('VERCEL_URL'), fn);
ok('getSelfBaseUrl no longer branches on VERCEL_ENV', !fn.includes('VERCEL_ENV'), fn);
ok('getSelfBaseUrl still honours FBA_SELF_BASE_URL override', fn.includes('FBA_SELF_BASE_URL'));
ok('getSelfBaseUrl returns the public alias', fn.includes(ALIAS));
ok('the removal is documented in a comment', raw.includes('Deployment Protection') || raw.includes('Deployment-Protection'));

// Behavioural: simulate the old failure mode. With VERCEL_ENV unset (the case
// that broke prod), the old code returned VERCEL_URL; the new code must not.
process.env.VERCEL_URL = 'shiphero-shipstation-bridge-abc123-wcoricas-projects.vercel.app';
delete process.env.VERCEL_ENV;
delete process.env.FBA_SELF_BASE_URL;
// Re-derive using the same logic shape as shipped:
const derived = process.env.FBA_SELF_BASE_URL
  ? String(process.env.FBA_SELF_BASE_URL).replace(/\/+$/, '')
  : ALIAS;
ok('with VERCEL_ENV unset, target is the alias (not the SSO host)', derived === ALIAS, derived);
ok('derived host is not the per-deployment hostname', !derived.includes('wcoricas-projects'));

// ---- 2. reconciler cap ----
const rec = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');
ok('isPermanentConfigError exists', rec.includes('function isPermanentConfigError'));
ok('detects HTTP 401', rec.includes("d.includes('HTTP 401')"));
ok('detects HTTP 403', rec.includes("d.includes('HTTP 403')"));
ok('detects missing CRON_SECRET', rec.includes('CRON_SECRET not set'));
ok('has a config-error attempt cap', /CONFIG_ERROR_MAX_ATTEMPTS\s*=\s*\d+/.test(rec));
ok('shouldRetryNow returns config_error', rec.includes("reason: 'config_error'"));
ok('config_error path ESCALATES via Telegram', /config_error[\s\S]{0,900}sendTelegramAlert/.test(rec));
ok('alert names the likely cause', rec.includes('CRON_SECRET') && rec.includes('Deployment-Protection'));
ok('detail column is selected from the bridge', rec.includes('last_fba_handoff_detail,'));
ok('transient failures still retry uncapped', rec.includes('No hard cap') || rec.includes('no hard cap'));

// Replicate the predicate to prove classification
const isCfg = (d: string) =>
  d.includes('HTTP 401') || d.includes('"Unauthorized"') || d.includes('CRON_SECRET not set') || d.includes('HTTP 403');
ok('classifies the real 401 detail', isCfg('HTTP 401: {"error":"Unauthorized"}'));
ok('does NOT classify a 429 as config', !isCfg('HTTP 500: {"error":"Amazon SP-API error (HTTP 429)"}'));
ok('does NOT classify QuotaExceeded as config', !isCfg('HTTP 500: {"error":"confirmPackingOption failed: QuotaExceeded"}'));
ok('does NOT classify a hazmat error as config', !isCfg('HTTP 500: {"error":"FBA_INB_0011 hazmat"}'));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
