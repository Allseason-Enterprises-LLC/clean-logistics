/**
 * TR-00502 regression (2026-09-30): the label notification must post ONCE
 * per set of labels. A re-run (transport-recovery → relabel) over labels that
 * were already attached and announced must attach nothing and say nothing.
 * Run: npx tsx scripts/_test-notify-once.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { shouldSkipTelegramAsAlreadyNotified } from '../lib/fba-post-process';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const L = (n: number) => new Array(n).fill({});

// ---------- decision (pure) ----------
ok('🔴 TR-00502 shape: 5 labels, 0 created, 5 skipped -> SKIP the post', shouldSkipTelegramAsAlreadyNotified({ labels: L(5), attachmentsCreated: 0, attachmentsSkipped: 5 }));
ok('first run: 5 labels, 5 created -> POST', !shouldSkipTelegramAsAlreadyNotified({ labels: L(5), attachmentsCreated: 5, attachmentsSkipped: 0 }));
ok('partial: 5 labels, 2 created, 3 skipped -> POST (new labels exist, floor must see them)', !shouldSkipTelegramAsAlreadyNotified({ labels: L(5), attachmentsCreated: 2, attachmentsSkipped: 3 }));
ok('even ONE new label -> POST', !shouldSkipTelegramAsAlreadyNotified({ labels: L(5), attachmentsCreated: 1, attachmentsSkipped: 4 }));
ok('🔴 fail OPEN: nothing attached at all (0/0, e.g. order not found) -> still POST', !shouldSkipTelegramAsAlreadyNotified({ labels: L(5), attachmentsCreated: 0, attachmentsSkipped: 0 }));
ok('fail OPEN: some labels unaccounted (0 created, 3 skipped of 5) -> POST', !shouldSkipTelegramAsAlreadyNotified({ labels: L(5), attachmentsCreated: 0, attachmentsSkipped: 3 }));
ok('no labels generated -> POST (that message carries the error state)', !shouldSkipTelegramAsAlreadyNotified({ labels: [], attachmentsCreated: 0, attachmentsSkipped: 0 }));
ok('single-destination plan re-run: 1 label, 0 created, 1 skipped -> SKIP', shouldSkipTelegramAsAlreadyNotified({ labels: L(1), attachmentsCreated: 0, attachmentsSkipped: 1 }));

// ---------- wiring in postProcessFbaShipment ----------
const src = fs.readFileSync(path.join(__dirname, '../lib/fba-post-process.ts'), 'utf8');
const fnStart = src.indexOf('export async function postProcessFbaShipment');
const body = src.slice(fnStart, src.indexOf('\n}\n', fnStart));
const attachLoop = body.indexOf('result.attachmentsSkipped++');
const decision = body.indexOf('shouldSkipTelegramAsAlreadyNotified(result)');
const send = body.indexOf('sendTelegram(tg)');
ok('decision is made AFTER the attach loop has counted created/skipped', attachLoop > 0 && decision > attachLoop);
ok('decision guards the ONLY sendTelegram call in post-process', decision < send && (body.match(/sendTelegram\(/g) || []).length === 1);
ok('skip sets telegramSkippedAlreadyNotified=true on the result', /telegramSkippedAlreadyNotified = true/.test(body));
ok('skip is logged with the count (observable in Vercel logs)', /already attached — floor already notified, skipping Telegram/.test(body));
ok('result shape initialises the flag false', /telegramSkippedAlreadyNotified: false/.test(src));
ok('relabel endpoint surfaces the flag', /telegramSkippedAlreadyNotified: result\.telegramSkippedAlreadyNotified/.test(fs.readFileSync(path.join(__dirname, '../api/fba/relabel.ts'), 'utf8')));
ok('transport-recovery trail records the skip', /skipped:already-notified/.test(fs.readFileSync(path.join(__dirname, '../lib/fba-transport-recovery.ts'), 'utf8')));
ok('cites the TR-00502 incident', /TR-00502/.test(src));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
