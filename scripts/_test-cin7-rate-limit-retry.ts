/**
 * CIN7 429 hardening (2026-10-19, Cortex brief, Weston-approved).
 * The CIN7 key is account-wide (60 calls/60s) and shared with
 * checkoutchamp-cin7-sync, brandmind-api, shiphero-shipstation-bridge and
 * V100-1 scripts; bursts recur. executeCIN7Request now waits Retry-After and
 * retries up to 2x on a rate limit. Everything else is unchanged.
 * Mocked fetch + injected sleep — no network, no waiting.
 * Run: npx tsx scripts/_test-cin7-rate-limit-retry.ts
 */
process.env.CIN7_ACCOUNT_ID ||= 'acct-test';
process.env.CIN7_API_KEY ||= 'key-test';

import * as fs from 'fs';
import * as path from 'path';
import {
  executeCIN7Request,
  fetchCIN7TransferDetail,
  parseCin7RetryAfterSeconds,
  isCin7RateLimitBody,
  isCin7RateLimitError,
  newCin7Meter,
  __setCin7SleepForTests,
  __resetCin7DetailPathCache,
  CIN7_RATE_LIMIT_MAX_RETRIES,
} from '../lib/cin7-transfer-sync';
import { readLiveCin7Status } from '../lib/fba-reconciler';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const LIMIT_TEXT = 'You have reached 60 calls per 60 seconds API limit.';
type R = { status: number; body: string; headers?: Record<string, string> };
let script: R[] = [];
let seen: string[] = [];
const sleeps: number[] = [];
globalThis.fetch = (async (input: any) => {
  seen.push(new URL(String(input)).pathname.replace('/ExternalApi/v2', ''));
  const r = script.shift() ?? { status: 500, body: 'script exhausted' };
  return new Response(r.body, { status: r.status, headers: r.headers });
}) as any;
__setCin7SleepForTests(async (ms) => { sleeps.push(ms); });
const reset = (s: R[]) => { script = s; seen = []; sleeps.length = 0; };
const r429 = (ra = '60 Seconds'): R => ({ status: 429, body: LIMIT_TEXT, headers: { 'Retry-After': ra } });
const r200 = (o: any = { Status: 'IN TRANSIT' }): R => ({ status: 200, body: JSON.stringify(o) });
const capture = async (fn: () => Promise<any>) => { try { return { v: await fn(), e: null as any }; } catch (e) { return { v: null, e }; } };

async function main() {
  // --- Retry-After parsing ---
  ok('Retry-After "60 Seconds" -> 60', parseCin7RetryAfterSeconds('60 Seconds') === 60);
  ok('Retry-After "30" -> 30', parseCin7RetryAfterSeconds('30') === 30);
  ok('Retry-After missing -> 60 default', parseCin7RetryAfterSeconds(null) === 60);
  ok('Retry-After garbage -> 60 default', parseCin7RetryAfterSeconds('soon') === 60);
  ok('Retry-After "0" -> 60 default (never a zero-wait hammer)', parseCin7RetryAfterSeconds('0') === 60);
  ok('Retry-After "120 Seconds" -> capped at 65', parseCin7RetryAfterSeconds('120 Seconds') === 65);
  ok('max retries is 2', CIN7_RATE_LIMIT_MAX_RETRIES === 2);

  // (a) 429 then 200 -> succeeds, 2 calls, waited per Retry-After
  reset([r429('60 Seconds'), r200({ Status: 'AUTHORISED' })]);
  let m = newCin7Meter();
  let res = await capture(() => executeCIN7Request<any>('/stockTransfer', { TaskID: 't' }, { meter: m }));
  ok('(a) 429 then 200 -> succeeds', !res.e && res.v?.Status === 'AUTHORISED', String(res.e));
  ok('(a) exactly 2 calls', seen.length === 2, String(seen.length));
  ok('(a) waited 60s per Retry-After', sleeps.length === 1 && sleeps[0] === 60_000, JSON.stringify(sleeps));
  ok('(a) per-run meter: 2 calls, 1 rate-limited, 60s waited', m.calls === 2 && m.rateLimited === 1 && m.waitedMs === 60_000, JSON.stringify(m));

  reset([r429('30'), r200()]);
  await capture(() => executeCIN7Request<any>('/x'));
  ok('(a2) honours a shorter Retry-After (30s)', sleeps[0] === 30_000, JSON.stringify(sleeps));

  // (b) 429 x3 -> throws after 3 calls
  reset([r429(), r429(), r429(), r200()]);
  m = newCin7Meter();
  res = await capture(() => executeCIN7Request<any>('/stockTransferList', {}, { meter: m }));
  ok('(b) 429x3 -> throws', !!res.e);
  ok('(b) after exactly 3 calls (1 + 2 retries)', seen.length === 3, String(seen.length));
  ok('(b) waited twice', sleeps.length === 2, JSON.stringify(sleeps));
  ok('(b) error is a typed rate-limit error', isCin7RateLimitError(res.e) && res.e.attempts === 3 && res.e.deferred === false);
  ok('(b) message keeps the "CIN7 transfer API error: 429" shape', /CIN7 transfer API error: 429/.test(res.e?.message || ''), res.e?.message);

  // (c) rate-limit text in a 200 -> treated as 429
  reset([{ status: 200, body: LIMIT_TEXT }, r200({ Status: 'PICKING' })]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer'));
  ok('(c) 200 + limit text -> retried, then succeeds', !res.e && res.v?.Status === 'PICKING', String(res.e));
  ok('(c) 2 calls, waited 60s default (no Retry-After header)', seen.length === 2 && sleeps[0] === 60_000, JSON.stringify({ n: seen.length, sleeps }));
  reset([{ status: 200, body: JSON.stringify({ Exception: LIMIT_TEXT }) }, r200()]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer'));
  ok('(c2) 200 + JSON error envelope {Exception: limit text} -> treated as 429', !res.e && seen.length === 2);
  reset([{ status: 200, body: JSON.stringify([{ ErrorCode: 429, Exception: LIMIT_TEXT }]) }, r200()]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer'));
  ok('(c3) 200 + array error envelope -> treated as 429', !res.e && seen.length === 2);
  reset([{ status: 200, body: LIMIT_TEXT }, { status: 200, body: LIMIT_TEXT }, { status: 200, body: LIMIT_TEXT }]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer'));
  ok('(c4) limit-text 200 x3 -> throws after 3 calls (not parsed as JSON)', isCin7RateLimitError(res.e) && seen.length === 3);
  const realTransfer = { TaskID: 't', Status: 'AUTHORISED', Note: 'customer said: 60 calls per 60 seconds API limit lol', Lines: [] };
  ok('(c5) a REAL transfer whose Note contains the phrase is NOT a rate limit', !isCin7RateLimitBody(JSON.stringify(realTransfer)));
  reset([r200(realTransfer)]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer'));
  ok('(c5) ...and is returned on the first call', !res.e && seen.length === 1 && res.v?.Note === realTransfer.Note);

  // (d) 403 -> no retry (and 401/5xx unchanged)
  for (const status of [403, 401, 500, 503, 404]) {
    reset([{ status, body: 'nope' }, r200()]);
    res = await capture(() => executeCIN7Request<any>('/stockTransfer'));
    ok(`(d) ${status} -> throws immediately, 1 call, no wait`, !!res.e && seen.length === 1 && sleeps.length === 0 && !isCin7RateLimitError(res.e), `${seen.length} calls`);
    ok(`(d) ${status} error message unchanged`, res.e?.message === `CIN7 transfer API error: ${status} - nope`, res.e?.message);
  }

  // Deadline: a wait that cannot fit is not taken; stop cleanly
  reset([r429('60 Seconds'), r200()]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer', {}, { deadline: Date.now() + 30_000 }));
  ok('deadline: 60s wait that would overrun -> throws at once, 1 call, no sleep', isCin7RateLimitError(res.e) && res.e.deferred && seen.length === 1 && sleeps.length === 0);
  ok('deadline: message says deferred to next tick', /deferred to next tick/.test(res.e?.message || ''), res.e?.message);
  reset([r429('60 Seconds'), r200()]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer', {}, { deadline: Date.now() + 120_000 }));
  ok('deadline: a wait that fits is taken', !res.e && seen.length === 2 && sleeps.length === 1);
  reset([r429(), r200()]);
  res = await capture(() => executeCIN7Request<any>('/stockTransfer', {}, { maxRetries: 0 }));
  ok('maxRetries 0 -> no wait, throws after 1 call', isCin7RateLimitError(res.e) && seen.length === 1 && sleeps.length === 0);

  // --- detail path: remember the working casing; a 429 never walks the casings ---
  __resetCin7DetailPathCache();
  reset([{ status: 404, body: 'nf' }, r200({ Status: 'A' }), r200({ Status: 'B' })]);
  await fetchCIN7TransferDetail('t1');
  ok('detail cold: first casing 404, second answers (2 calls)', seen.join(',') === '/stockTransfer,/StockTransfer', seen.join(','));
  seen = [];
  const d2 = await fetchCIN7TransferDetail('t2');
  ok('detail warm: remembered casing used first -> 1 call', seen.join(',') === '/StockTransfer' && d2.Status === 'B', seen.join(','));
  reset([{ status: 404, body: 'nf' }, r200({ Status: 'C' })]);
  await fetchCIN7TransferDetail('t3');
  ok('detail: if the remembered casing stops working, falls back to the others', seen.join(',') === '/StockTransfer,/stockTransfer', seen.join(','));
  __resetCin7DetailPathCache();
  reset([r429(), r429(), r429(), r200(), r200(), r200()]);
  res = await capture(() => fetchCIN7TransferDetail('t4'));
  ok('detail: rate limit is NOT retried across casings (3 calls on one path, then throws)',
     isCin7RateLimitError(res.e) && seen.length === 3 && new Set(seen).size === 1, seen.join(','));

  // --- reconciler status read: never waits on a 429 (fail CLOSED unchanged) ---
  reset([r429(), r200({ Status: 'IN TRANSIT' })]);
  const st = await readLiveCin7Status({ cin7_transfer_id: 'tid' });
  ok('reconciler: 429 -> null (fail CLOSED), 1 call, no 60s wait', st === null && seen.length === 1 && sleeps.length === 0, `${st} ${seen.length} ${sleeps}`);

  // --- source guards ---
  const sync = fs.readFileSync(path.join(__dirname, '../lib/cin7-transfer-sync.ts'), 'utf8');
  const types = fs.readFileSync(path.join(__dirname, '../lib/cin7-transfer-types.ts'), 'utf8');
  const cron = fs.readFileSync(path.join(__dirname, '../api/cron/sync-cin7-las-vegas-transfers.ts'), 'utf8');
  ok('sync passes its per-run options to the list fetch', /status: options\.status,\n\s*\}, cin7\);/.test(sync));
  ok('sync passes its per-run options to the detail fetch', sync.includes('fetchCIN7TransferDetail(transfer.id, cin7)'));
  ok('run result carries cin7_calls (both return paths)', (sync.match(/\.\.\.cin7Stats\(\)/g) || []).length === 2);
  ok('result type declares cin7_calls', types.includes('cin7_calls: number;'));
  ok('cron logs cin7_calls', cron.includes('cin7_calls: result.cin7_calls'));
  ok('after a rate limit the run stops calling CIN7 (no half-built state)', sync.includes('not attempted — CIN7 rate limit earlier in this run'));
  ok('handoff drain cannot START past the run cutoff', sync.includes('Date.now() - startedAt > RUN_HANDOFF_CUTOFF_MS'));
  ok('CIN7 phase budget + handoff cutoff fit inside maxDuration 300', /CIN7_PHASE_BUDGET_MS = 170_000/.test(sync) && /RUN_HANDOFF_CUTOFF_MS = 255_000/.test(sync));

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
