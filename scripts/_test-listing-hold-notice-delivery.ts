/**
 * A listing-hold notice that FAILED to deliver must be retried — not silenced
 * forever by the hold it created.
 *
 * 2026-10-16, Weston on TR-00543 (OsteoZen 120ct Bag, NO_AMAZON_MAPPING, held
 * since 2026-10-08): "If there's a listing problem your automation should be
 * flagging this in the FBA Shipments channel for marketing to fix. I don't see
 * this one but I see others."
 *
 * Mechanism: applyPreflightGate de-dupes the marketing notice on
 * `existingHold.codes === current codes`. But parkMarketingHold writes the hold
 * whether or not sendTelegram delivered. One failed send (false or throw) →
 * hold persisted → every later tick sees "same hold" → notice NEVER sent.
 * A permanent, invisible silence — the exact failure the gate was built to stop.
 *
 * Fix: the hold records `notified` (delivery result). Dedupe only when the hold
 * is the same AND `notified !== false`. Legacy holds (no field) are treated as
 * delivered so the fix does not re-ping holds the channel already saw.
 *
 * Run: npx tsx scripts/_test-listing-hold-notice-delivery.ts
 */
import { applyPreflightGate } from '../lib/fba-preflight-gate';
import type { PreflightFacts } from '../lib/fba-preflight';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

function fakeSupabase(initialPayload: any = {}) {
  const row: any = { id: 'row-1', request_payload: { partnerLineItems: [{ sku: 'CN-CAP-BONEHEALTH-120BG', quantity: 1920 }], ...initialPayload } };
  const sb: any = { from: () => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
    update: (u: any) => ({ eq: async () => { Object.assign(row, { request_payload: u.request_payload ?? row.request_payload }); return { error: null }; } }),
  }) };
  return { sb, row };
}
// TR-00543 shape: ShipHero data complete, no Amazon MSKU → marketing-only hold.
const facts: PreflightFacts = {
  cin7Sku: 'CN-CAP-BONEHEALTH-120BG', quantity: 1920,
  casePack: { caseQuantity: 48, boxLength: 16, boxWidth: 12, boxHeight: 10, boxWeightLbs: 20 }, productNote: 'ok',
  lotNumber: '2607075A', expirationDate: '2028-07-31', amazonMsku: null, inboundReady: null as any, labelOwnerConstraint: 'NONE_ONLY',
};
const transfer = { id: 'cin7-543', transferNumber: 'TR-00543', destinationName: 'Amazon FBA', lines: [{ sku: facts.cin7Sku, quantity: 1920 }], shipheroOrderNumber: 'AMZ_BONEHEALTH_00543-2607075A' };
const run = (sb: any, send: (h: string) => Promise<boolean>, row: any) =>
  applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => facts, sendTelegram: send },
    { ...transfer, existingHold: row.request_payload.preflight_hold ?? null });

async function main() {
  // 1. 🔴 the TR-00543 failure: first send fails, later ticks must RETRY
  {
    const { sb, row } = fakeSupabase(); const posts: string[] = [];
    let deliver = false;
    const send = async (h: string) => { posts.push(h); return deliver; };
    const a = await run(sb, send, row);
    ok('tick 1: hold=marketing, notice attempted', a.hold === 'marketing' && posts.length === 1);
    ok('tick 1: hold persisted with notified=false (delivery failed)', row.request_payload.preflight_hold?.notified === false);
    deliver = true;
    const b = await run(sb, send, row);
    ok('🔴 tick 2: same hold but undelivered → notice RETRIED', posts.length === 2 && b.marketingNotified === true);
    ok('tick 2: hold now notified=true', row.request_payload.preflight_hold?.notified === true);
    await run(sb, send, row);
    ok('🔴 tick 3: delivered hold → NO further notice (still once)', posts.length === 2);
  }
  // 2. a THROWING sender counts as not delivered
  {
    const { sb, row } = fakeSupabase(); let calls = 0;
    await run(sb, async () => { calls++; throw new Error('tg down'); }, row);
    ok('throwing sender → hold persisted with notified=false (not silently "sent")', row.request_payload.preflight_hold?.notified === false && calls === 1);
    await run(sb, async () => { calls++; return true; }, row);
    ok('next tick retries after a throw and records notified=true', calls === 2 && row.request_payload.preflight_hold?.notified === true);
  }
  // 3. happy path unchanged: delivered once, never again
  {
    const { sb, row } = fakeSupabase(); const posts: string[] = [];
    const send = async (h: string) => { posts.push(h); return true; };
    await run(sb, send, row); await run(sb, send, row); await run(sb, send, row);
    ok('delivered first time → exactly ONE notice across 3 ticks', posts.length === 1);
  }
  // 4. 🔴 legacy holds (no `notified` field) must NOT be re-pinged after deploy
  {
    const { sb, row } = fakeSupabase({ preflight_hold: { since: '2026-10-08T16:20:13.424Z', codes: ['NO_AMAZON_MAPPING'], summary: 'No Amazon MSKU mapped for CN-CAP-BONEHEALTH-120BG' } });
    const posts: string[] = [];
    await run(sb, async (h) => { posts.push(h); return true; }, row);
    ok('🔴 legacy hold without notified field → no re-ping on deploy', posts.length === 0);
    ok('legacy hold keeps its original `since`', row.request_payload.preflight_hold?.since === '2026-10-08T16:20:13.424Z');
  }
  // 5. codes change → a NEW notice even if the old one was delivered
  {
    const { sb, row } = fakeSupabase({ preflight_hold: { since: '2026-10-08T00:00:00Z', codes: ['LISTING_NOT_INBOUND_READY'], summary: 'x', notified: true } });
    const posts: string[] = [];
    await run(sb, async (h) => { posts.push(h); return true; }, row);
    ok('different blocker codes → new notice', posts.length === 1);
  }
  // 6. no sender wired → do not claim delivery
  {
    const { sb, row } = fakeSupabase();
    await applyPreflightGate({ supabase: sb, shipheroToken: 't', gatherFacts: async () => facts }, { ...transfer, existingHold: null });
    ok('no sendTelegram dep → notified=false recorded (retried once a sender exists)', row.request_payload.preflight_hold?.notified === false);
  }
  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
