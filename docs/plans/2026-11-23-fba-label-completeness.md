# FBA Label Completeness — Implementation Plan

> **For Hermes:** implement task-by-task, TDD. Commit as `Freight <freight@cleannutra.com>`. No schema changes.

**Goal:** a transfer is never reported "ready" or left silent while Amazon has shipments whose label PDFs are not on the ShipHero order. Missing files are recovered automatically; the floor is told once, only when every box has a label.

**Incidents:** TR-00694, 726, 728, 729, 731, 889. Each time Amazon had every shipment, but 1+ label PDFs never reached the order, and no alert fired. TR-00889: 3 of 5 files attached, Henderson NV + Las Vegas NV missing; `relabel` recovered them in 40 s on 2026-11-23.

---

## Root cause (code as of origin/main 25a483d)

1. **No completeness check.** `postProcessFbaShipment` (`lib/fba-post-process.ts` ~L848) loops shipments: fetch PDF → upload → attach. A failure on one shipment is caught and pushed to `errors[]`. Then the loop moves on.
2. **Status is written regardless of errors.** `api/fba/auto-submit.ts` ~L636 sets `labels_ready` whenever post-process *returns*, even with `errors.length > 0`. The floor's "✅ Ready for warehouse processing" message is sent the same way, listing only the files that worked.
3. **Killed mid-loop = silent.** Post-process runs inline after the Amazon workflow (2–4 min) inside a 300 s function. Large plans (TR-00889: 667 boxes, 208–292-page PDFs) can hit `maxDuration` mid-loop. Vercel kills the function, the row stays `plan_created`, and nothing alerts. 4 of the 6 incident rows are still `plan_created`: TR-00694, TR-00729 (1 of 4 plans), TR-00731, TR-00889.
4. **Nothing sweeps.** No cron re-checks `plan_created` rows. `relabel` recovers correctly (it skips files already attached), but only when a human calls it. `relabel` also never writes `labels_ready` / `labels_url`.

**Unconfirmed:** for TR-00889 specifically, whether it was (2) a swallowed per-shipment error or (3) a timeout kill. Task 0 checks the Vercel logs. The plan fixes both.

---

## Design

- **One truth function:** `checkLabelCompleteness(planId, orderId)` compares Amazon (shipments + box count per shipment) against the ShipHero order (`FBA*` attachments) and the stored PDFs (page objects == boxes × 2, counted with `/Type\s*/Page[^s]`). Read-only.
- **Status follows truth:** `labels_ready` only when complete. Otherwise the row stays `plan_created`, with `prep_instructions.label_check = {checked_at, missing:[fbaId], attempts}` (jsonb, no DDL). `request_payload` is untouched.
- **Floor hears once, when true:** the ready message goes only when complete. A partial run sends one ops alert to the planning chat, nothing to the floor.
- **Self-repair:** the reconciler cron (every 15 min) finds `plan_created` rows older than 20 min that have shipments. It runs the check; if files are missing, it calls the existing `relabel` path (read-only on Amazon: GET labels, no plan or shipment created, **no duplicate risk**). Max 3 attempts per row, then one loud alert.
- **Stop before the kill:** post-process gets a deadline. Under 45 s left, it stops cleanly, records what's missing, and leaves the rest to the sweep.

---

## Tasks

### Task 0: Confirm the TR-00889 failure mode (read-only)
- Pull Vercel logs for `/api/fba/auto-submit` around 2026-11-20 17:45 UTC (`[fba-post-process] Failed processing` vs the function timing out).
- Record which in the test-file header. No code change.

### Task 1: `checkLabelCompleteness` (pure core + thin I/O)
**Files:** create `lib/fba-label-completeness.ts`; test in `scripts/_test-label-completeness.ts`.
- `export function diffLabels(expected: {fbaId, boxes}[], attached: string[], pdfPages: Record<fbaId, number>)` → `{complete, missingAttachment[], pageMismatch[{fbaId, boxes, pages}]}`
- `export async function checkLabelCompleteness(planId, orderId, deps)`: Amazon shipments + paginated box counts; ShipHero attachments; storage PDF page counts. Retries `code:30` with back-off. Any read failure gives `complete: undefined`, never `true` or `false`.
- **Tests (red first):**
  - TR-00889 shape: 5 shipments, 3 attached → `complete:false`, missing = Henderson + Las Vegas.
  - All attached, pages = boxes×2 → `true`.
  - Attached but PDF pages < boxes×2 → `false` (pageMismatch).
  - Duplicate attachment filenames don't count twice.
  - ShipHero read throws → `undefined`.

### Task 2: Post-process — deadline + per-shipment retry + result flag
**Files:** `lib/fba-post-process.ts` (~L848 loop, `PostProcessInput`, `PostProcessResult`); test `scripts/_test-post-process-partial.ts`.
- `input.deadlineMs?`: before each shipment, if `Date.now() > deadline - 45_000`, stop and push `deferred: fbaId`.
- Per shipment: on a transient error (`code:30`, 429, 5xx, fetch abort), retry once after back-off. A permanent error goes to `errors[]` as now.
- After the loop: `result.complete = checkLabelCompleteness(...)`, using the Task 1 core.
- **Floor message:** only when `complete === true`. Otherwise no floor post, and `result.partial = {missing, deferred, errors}`.
- **Tests:** shipment 4 of 5 throws → no floor post, `complete:false`, missing names it. Deadline hit after 3 → 2 deferred, no post. All good → one post (existing behaviour).

### Task 3: Status follows truth (auto-submit + relabel)
**Files:** `api/fba/auto-submit.ts` ~L636; `api/fba/relabel.ts` ~L168–220; test `scripts/_test-labels-ready-gate.ts`.
- auto-submit: pass `deadlineMs = start + 300_000`. Write `labels_ready` + `labels_url` **only if** `postProcess.complete === true`. Else keep `plan_created` and merge `prep_instructions.label_check`. Send one ops alert (planning chat, guarded sender) naming the transfer and its missing destinations.
- relabel: same rule. When complete, write `labels_ready` + `labels_url` and clear `label_check`. This closes the "relabel never updates status" gap (TR-00564/554, TR-00889).
- **Tests:** partial → status stays `plan_created`; complete → `labels_ready`; `request_payload.work_order` / `alerted_at` byte-identical before and after.

### Task 4: Reconciler sweep — self-repair
**Files:** `lib/fba-label-sweep.ts` (new), wired into `api/cron/reconcile-fba-handoffs.ts`; test `scripts/_test-label-sweep.ts`.
- **Select:** `fba_shipments` where `status = 'plan_created'`, `amazon_shipment_ids` non-empty, `updated_at < now - 20 min`, `label_check.attempts < 3`, and the ShipHero order is not cancelled. Limit 3 per tick, oldest first. This bounds ShipHero credit use.
- **Per row:**
  1. Run the check. If complete, set `labels_ready` (no relabel, no post).
  2. If not complete, call relabel for that `plan_id`, then re-check.
  3. Complete → `labels_ready` + **one** floor ready message (the transfer's first).
  4. Still missing → `attempts++`. At 3 → one 🔴 planning-chat alert, then stop.
- **Never:** create or cancel Amazon plans, touch `labels_ready` rows, or call auto-submit.
- **Tests:**
  - Partial row → relabel called once → `labels_ready`.
  - 3 failures → exactly one alert, then skipped.
  - A complete row is not relabelled.
  - A row whose ShipHero order is cancelled is skipped.
  - Each tick processes ≤ 3 rows.

### Task 5: Backfill report (read-only), then recovery one at a time
- Run `checkLabelCompleteness` over every non-cancelled `fba_shipments` row since 2026-10-01 with shipments, `labels_ready` included. Output a table: TR, plan, expected files, attached, missing, page mismatches.
- Recover each incomplete one by relabel, **one at a time**, verifying each before the next (needs go-ahead).

### Task 6: Verify on prod
- `tsc --noEmit`; every new test plus the existing post-process, relabel, reconciler and preflight suites, run individually with `timeout`.
- Push → confirm the deploy by behaviour: run the sweep endpoint in dry-run against TR-00889 (expect complete → would set `labels_ready`). The next real transfer must reach `labels_ready` with files == shipments.

---

## Not in scope
- Moving post-process into its own invocation. The deadline + sweep covers it with less change; revisit if Task 0 shows timeouts are routine.
- Any schema / status-constraint change.
