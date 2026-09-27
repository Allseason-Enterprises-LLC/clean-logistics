/**
 * The FBA group id is a fixed fact. A stale env var must NEVER win.
 * Run: npx tsx scripts/_test-fba-chat-id.ts
 */
import { resolveFbaChatId, FBA_TELEGRAM_CHAT_ID } from '../lib/fba-post-process';
let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

ok('default is the live supergroup', FBA_TELEGRAM_CHAT_ID === '-1003528234475');
ok('🔴 the stale pre-supergroup id that broke 00484 is IGNORED', resolveFbaChatId('-5244576221') === '-1003528234475');
ok('stale id with the trailing newline (the real prod value) is IGNORED', resolveFbaChatId('-5244576221\n') === '-1003528234475');
ok('unset env -> default', resolveFbaChatId(undefined) === '-1003528234475' && resolveFbaChatId('') === '-1003528234475');
ok('same id in env -> default (no warning path)', resolveFbaChatId('-1003528234475') === '-1003528234475');
ok('a DIFFERENT real supergroup id IS honoured as a deliberate override', resolveFbaChatId('-1009999999999') === '-1009999999999');
ok('garbage is ignored', resolveFbaChatId('abc') === '-1003528234475' && resolveFbaChatId('-100') === '-1003528234475');
ok('a user id / plain number is ignored (never DM a person by accident)', resolveFbaChatId('855387948') === '-1003528234475');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
