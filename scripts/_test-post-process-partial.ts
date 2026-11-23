/**
 * Post-process must never call a transfer "ready" while label files are missing,
 * and must stop cleanly before the 300s function kill instead of dying mid-loop.
 *
 * TR-00889 (2026-11-20): 5 Amazon shipments / 667 boxes, 3 files attached, row
 * left `plan_created`, no alert. TR-00726/728 (2026-11-04): rows went
 * `labels_ready` with files missing — status was written because post-process
 * RETURNED, not because the labels were complete.
 *
 * Run: npx tsx scripts/_test-post-process-partial.ts
 */
import { runShipmentsWithDeadline, isTransientLabelError, decideLabelOutcome } from '../lib/fba-post-process';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };
const IDS = ['sh1', 'sh2', 'sh3', 'sh4', 'sh5'];

async function main() {
  // ── runShipmentsWithDeadline ────────────────────────────────────────────
  {
    const done: string[] = [];
    const r = await runShipmentsWithDeadline(IDS, async (id) => { done.push(id); }, { deadlineMs: 10_000_000, now: () => 0, retryDelayMs: 0 });
    ok('all 5 processed when time allows', done.length === 5 && r.deferred.length === 0 && r.failed.length === 0);
  }
  {
    // clock: each shipment "takes" 60s; deadline at 200s with 45s reserve → stop before #4
    let t = 0; const done: string[] = [];
    const r = await runShipmentsWithDeadline(IDS, async (id) => { done.push(id); t += 60_000; }, { deadlineMs: 200_000, now: () => t, reserveMs: 45_000, retryDelayMs: 0 });
    ok('🔴 deadline: stops BEFORE the kill (3 done, 2 deferred)', done.length === 3 && JSON.stringify(r.deferred) === JSON.stringify(['sh4', 'sh5']), `done=${done} deferred=${r.deferred}`);
  }
  {
    // transient error once → retried → succeeds
    const calls: Record<string, number> = {};
    const r = await runShipmentsWithDeadline(IDS, async (id) => {
      calls[id] = (calls[id] || 0) + 1;
      if (id === 'sh4' && calls[id] === 1) throw new Error('ShipHero query error: [{"code":30,"message":"not enough credits"}]');
    }, { deadlineMs: 1e12, now: () => 0, retryDelayMs: 0 });
    ok('transient code:30 on sh4 → retried once and succeeded', calls.sh4 === 2 && r.failed.length === 0);
  }
  {
    // permanent error → not retried, recorded
    const calls: Record<string, number> = {};
    const r = await runShipmentsWithDeadline(IDS, async (id) => {
      calls[id] = (calls[id] || 0) + 1;
      if (id === 'sh2') throw new Error('fetchLabelPdf: FBA1 expected ~208 pages but PDF has 2');
    }, { deadlineMs: 1e12, now: () => 0, retryDelayMs: 0 });
    ok('permanent error → no retry, recorded as failed, loop continues', calls.sh2 === 1 && r.failed.length === 1 && r.failed[0].id === 'sh2' && calls.sh5 === 1);
  }
  ok('isTransient: code:30 / 429 / 503 / abort', ['"code":30', 'HTTP 429', 'status 503', 'The operation was aborted', 'fetch failed', 'ETIMEDOUT'].every((m) => isTransientLabelError(new Error(m))));
  ok('isTransient: page-count abort is NOT transient', !isTransientLabelError(new Error('fetchLabelPdf: expected ~8 pages but PDF has 2. Aborting')));

  // ── decideLabelOutcome ─────────────────────────────────────────────────
  {
    const d = decideLabelOutcome({ complete: true }, { alreadyNotified: false });
    ok('complete → labels_ready + floor post', d.status === 'labels_ready' && d.postFloor === true);
  }
  {
    const d = decideLabelOutcome({ complete: true }, { alreadyNotified: true });
    ok('complete but every file was already attached → labels_ready, NO second floor post', d.status === 'labels_ready' && d.postFloor === false);
  }
  {
    const d = decideLabelOutcome({ complete: false, diff: { missingAttachment: ['FBA19Y0GZ79Q', 'FBA19Y0GWL9S'] } as any }, { alreadyNotified: false });
    ok('🔴 partial → stays plan_created, NO floor post, missing listed', d.status === 'plan_created' && d.postFloor === false && d.missing.length === 2);
  }
  {
    const d = decideLabelOutcome({ complete: undefined, error: 'code:30' }, { alreadyNotified: false });
    ok('unknown (check could not run) → plan_created, no post (sweep re-checks)', d.status === 'plan_created' && d.postFloor === false && d.unknown === true);
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
