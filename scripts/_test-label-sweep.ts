/**
 * Label sweep — the self-repair that finishes what post-process could not.
 *
 * TR-00694/729/731/889 sat `plan_created` with shipments on Amazon and label
 * files missing from the ShipHero order, for days, until a human ran relabel.
 * The sweep runs inside the 15-min reconciler and does that itself.
 *
 * Contract:
 *   - selects plan_created rows WITH shipment ids, older than 20 min, attempts < 3
 *   - complete already → labels_ready, NO relabel, NO post
 *   - gap → relabel ONCE (read-only on Amazon: GET labels; attach skips existing)
 *       → re-check → complete → labels_ready (+ the single floor ready post comes
 *         from relabel's post-process, never a second one)
 *       → still gap → attempts++; at 3 → ONE 🔴 alert, never again
 *   - unknown (check can't read) → nothing written, nothing posted
 *   - cancelled ShipHero order / voided plan → skipped
 *   - ≤ maxPerTick rows per tick
 *   - never touches labels_ready rows, never creates/cancels Amazon plans
 *   - request_payload never written (prep_instructions.label_check only)
 *
 * Run: npx tsx scripts/_test-label-sweep.ts
 */
import { sweepIncompleteLabels, type SweepRow, type SweepDeps } from '../lib/fba-label-sweep';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const NOW = Date.parse('2026-11-23T22:00:00Z');
const row = (over: Partial<SweepRow> = {}): SweepRow => ({
  id: 'r889', cin7_transfer_number: 'CIN7-TR-00889', cin7_lot: '2610078A', plan_id: 'wf6fa9de4d',
  status: 'plan_created', amazon_shipment_ids: ['FBA19Y0BF2KZ', 'FBA19Y0CP84L', 'FBA19Y09L19T', 'FBA19Y0GZ79Q', 'FBA19Y0GWL9S'],
  updated_at: '2026-11-23T21:00:00Z', prep_instructions: { label_set: { lot: '2610078A' } }, ...over,
});

function harness(rows: SweepRow[], checks: Array<{ complete: boolean | undefined; missing?: string[] }>, opts: { orderCancelled?: boolean; relabelThrows?: boolean } = {}) {
  const writes: Array<{ id: string; patch: any }> = [];
  const relabels: string[] = [];
  const alerts: string[] = [];
  let ci = 0;
  const deps: SweepDeps = {
    now: () => NOW,
    loadCandidates: async () => rows,
    resolveOrder: async () => (opts.orderCancelled ? { orderId: 'o1', cancelled: true } : { orderId: 'o1', cancelled: false }),
    check: async () => { const c = checks[Math.min(ci++, checks.length - 1)]; return { complete: c.complete, diff: c.complete === false ? { missingAttachment: c.missing ?? ['FBA19Y0GZ79Q'], pageMismatch: [] } as any : undefined }; },
    relabel: async (planId) => { relabels.push(planId); if (opts.relabelThrows) throw new Error('relabel 500'); },
    update: async (id, patch) => { writes.push({ id, patch }); },
    alert: async (html) => { alerts.push(html); return true; },
  };
  return { deps, writes, relabels, alerts };
}

async function main() {
  // 1. 🔴 TR-00889 shape: gap → relabel once → complete → labels_ready
  {
    const h = harness([row()], [{ complete: false, missing: ['FBA19Y0GZ79Q', 'FBA19Y0GWL9S'] }, { complete: true }]);
    const r = await sweepIncompleteLabels(h.deps);
    ok('🔴 gap → relabel called exactly once for the plan', h.relabels.length === 1 && h.relabels[0] === 'wf6fa9de4d', JSON.stringify(h.relabels));
    const w = h.writes.find((x) => x.patch.status === 'labels_ready');
    ok('🔴 …re-check complete → status labels_ready', !!w, JSON.stringify(h.writes));
    ok('…no ops alert on a successful recovery', h.alerts.length === 0);
    ok('…result lists it as recovered', r.recovered.includes('CIN7-TR-00889'));
  }
  // 2. already complete (e.g. TR-00889 today) → labels_ready, no relabel, no post
  {
    const h = harness([row()], [{ complete: true }]);
    await sweepIncompleteLabels(h.deps);
    ok('already complete → labels_ready without relabel', h.relabels.length === 0 && h.writes.some((x) => x.patch.status === 'labels_ready'));
    ok('…no alert', h.alerts.length === 0);
  }
  // 3. relabel didn't fix it → attempts++ , no alert yet
  {
    const h = harness([row()], [{ complete: false }, { complete: false }]);
    await sweepIncompleteLabels(h.deps);
    const w = h.writes.find((x) => x.patch.prep_instructions?.label_check);
    ok('still incomplete → label_check.attempts = 1', w?.patch.prep_instructions.label_check.attempts === 1, JSON.stringify(h.writes));
    ok('…status NOT flipped', !h.writes.some((x) => x.patch.status));
    ok('…no alert before the 3rd attempt', h.alerts.length === 0);
    ok('…existing prep_instructions keys preserved (label_set)', w?.patch.prep_instructions.label_set?.lot === '2610078A');
  }
  // 4. 3rd failed attempt → ONE alert, attempts=3
  {
    const h = harness([row({ prep_instructions: { label_set: {}, label_check: { attempts: 2 } } })], [{ complete: false }, { complete: false }]);
    await sweepIncompleteLabels(h.deps);
    ok('🔴 3rd failure → exactly one alert', h.alerts.length === 1, String(h.alerts.length));
    ok('…alert names the transfer and the missing shipment', /TR-00889/.test(h.alerts[0] || '') && /FBA19Y0GZ79Q/.test(h.alerts[0] || ''));
    ok('…attempts recorded = 3 (row then leaves the sweep)', h.writes.some((x) => x.patch.prep_instructions?.label_check?.attempts === 3));
  }
  // 5. attempts already 3 → skipped entirely
  {
    const h = harness([row({ prep_instructions: { label_check: { attempts: 3 } } })], [{ complete: false }]);
    const r = await sweepIncompleteLabels(h.deps);
    ok('attempts ≥ 3 → skipped (no check, no relabel, no alert)', h.relabels.length === 0 && h.alerts.length === 0 && h.writes.length === 0 && r.skipped.length === 1);
  }
  // 6. unknown → nothing written, nothing posted
  {
    const h = harness([row()], [{ complete: undefined }]);
    await sweepIncompleteLabels(h.deps);
    ok('unknown → no relabel, no write, no alert', h.relabels.length === 0 && h.writes.length === 0 && h.alerts.length === 0);
  }
  // 7. cancelled ShipHero order → skipped
  {
    const h = harness([row()], [{ complete: false }], { orderCancelled: true });
    await sweepIncompleteLabels(h.deps);
    ok('cancelled ShipHero order → skipped, no relabel', h.relabels.length === 0 && h.writes.length === 0);
  }
  // 8. too young (< 20 min) → skipped (auto-submit may still be running)
  {
    const h = harness([row({ updated_at: '2026-11-23T21:50:00Z' })], [{ complete: false }]);
    await sweepIncompleteLabels(h.deps);
    ok('row updated 10 min ago → not touched (in-flight run)', h.relabels.length === 0 && h.writes.length === 0);
  }
  // 9. no shipment ids / not plan_created → not touched
  {
    const h = harness([row({ amazon_shipment_ids: [] }), row({ id: 'x', status: 'labels_ready' })], [{ complete: false }]);
    await sweepIncompleteLabels(h.deps);
    ok('no shipments / labels_ready rows → never touched', h.relabels.length === 0 && h.writes.length === 0);
  }
  // 10. maxPerTick
  {
    const rows = Array.from({ length: 6 }, (_, i) => row({ id: `r${i}`, plan_id: `wf${i}`, cin7_transfer_number: `CIN7-TR-0090${i}` }));
    const h = harness(rows, [{ complete: true }]);
    const r = await sweepIncompleteLabels({ ...h.deps, maxPerTick: 3 });
    ok('≤ 3 rows checked per tick', r.checked === 3, String(r.checked));
  }
  // 11. relabel throws → counts as a failed attempt, no crash
  {
    const h = harness([row()], [{ complete: false }, { complete: false }], { relabelThrows: true });
    const r = await sweepIncompleteLabels(h.deps);
    ok('relabel throwing → attempt recorded, sweep continues', h.writes.some((x) => x.patch.prep_instructions?.label_check?.attempts === 1) && r.errors.length === 1);
  }
  // 12. request_payload is never part of any write
  {
    const h = harness([row()], [{ complete: false }, { complete: true }]);
    await sweepIncompleteLabels(h.deps);
    ok('no write ever touches request_payload', h.writes.every((w) => !('request_payload' in w.patch)));
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
