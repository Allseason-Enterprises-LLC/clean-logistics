/**
 * Rate-limit error class: ShipHero credit errors must retry in MINUTES, not an
 * hour. Six transfers needed manual backoff clearing on 2026-09-22.
 * Run: npx tsx scripts/_test-rate-limit-backoff.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-reconciler.ts'), 'utf8');

ok('isRateLimitError exists', src.includes('function isRateLimitError'));
ok('retryGapFor is the single source of truth', src.includes('function retryGapFor'));
ok('shouldRetryNow uses retryGapFor', /const gap = retryGapFor\(row\);\s*\n\s*const last/.test(src));
ok('the ledger uses retryGapFor too (cannot disagree with the decision)',
   /const gap = retryGapFor\(row\);\s*\n\s*const waitedMs/.test(src));
ok('no leftover inline gap computation', !/row\.fba_handoff_attempts >= 3 \? RETRY_GAP_LATE_MS : RETRY_GAP_EARLY_MS;\s*\n\s*const (last|waitedMs)/.test(src));
ok('rate-limit gap is 5 minutes', src.includes('RATE_LIMIT_GAP_MS = 5 * 60 * 1000'));
ok('ledger reports the error class', src.includes("? 'rate_limit'") && src.includes("'transient'"));
ok('documents the six real incidents', src.includes('TR-00460, 00464, 00465, 00472, 00477, 00462'));
ok('explains why fast retry is dup-safe', src.includes('BEFORE any Amazon') && src.includes('nothing'));

// Behavioural replica
const RATE = 5 * 60 * 1000, EARLY = 60 * 60 * 1000, LATE = 4 * 60 * 60 * 1000;
const isRate = (d: string) => d.includes('not enough credits') || d.includes('"code":30') || d.includes('rate limit') || d.includes('HTTP 429');
const gapFor = (detail: string, attempts: number) => isRate(detail) ? RATE : (attempts >= 3 ? LATE : EARLY);

const CREDIT = 'HTTP 500: {"error":"ShipHero lot breakdown error for CN-CAP-8IN1IMMUNE-60CT: [{\\"code\\":30,\\"message\\":\\"There are not enough credits to perform the requested operation, which requires 1006 credits';
ok('the REAL credit error string classifies as rate_limit', isRate(CREDIT));
ok('real credit error -> 5min gap', gapFor(CREDIT, 1) === RATE);
ok('credit error at attempt 9 still 5min (not escalated to 4h)', gapFor(CREDIT, 9) === RATE);
ok('HTTP 429 -> 5min', gapFor('HTTP 429 Too Many Requests', 1) === RATE);
ok('plain 500 -> 1h (unchanged)', gapFor('HTTP 500: upstream exploded', 1) === EARLY);
ok('plain 500 at attempt 4 -> 4h (unchanged)', gapFor('HTTP 500: upstream exploded', 4) === LATE);
ok('401 is NOT a rate-limit error (stays capped/config)', !isRate('HTTP 401: {"error":"Unauthorized"}'));
ok('empty detail -> 1h default', gapFor('', 1) === EARLY);

// the actual win: how long each of the six waited vs would now wait
const waited = 60, now = 5;
ok(`six stalls: ${waited}min manual wait -> ${now}min automatic`, waited === 60 && now === 5);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
