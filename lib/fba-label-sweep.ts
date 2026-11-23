/**
 * Label sweep — finish label sets that post-process left incomplete.
 *
 * Why (2026-11-23): TR-00694/729/731/889 sat `plan_created` for days with
 * every Amazon shipment created but label PDFs missing from the ShipHero order.
 * Recovery (`/api/fba/relabel`) worked every time but only ran when a human
 * asked. This runs it from the 15-min reconciler, bounded and once-loud.
 *
 * Safety:
 *   - read-only on Amazon (relabel GETs labels; attach skips files already on
 *     the order) → no duplicate-shipment risk
 *   - only `plan_created` rows with shipment ids, idle ≥ 20 min, attempts < 3
 *   - writes only status / labels_url / prep_instructions.label_check — never
 *     request_payload, never labels_ready rows, never plans
 *   - UNKNOWN completeness → no write, no post
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { decideLabelOutcome, sendTelegram, resolveLotChildOrder } from './fba-post-process';
import {
  checkLabelCompleteness, liveAmazonShipments, shipheroOrderAttachments, storedPdfPages, labelStoragePrefix,
  type CompletenessResult,
} from './fba-label-completeness';

export const SWEEP_MIN_IDLE_MS = 20 * 60_000;
export const SWEEP_MAX_ATTEMPTS = 3;

export interface SweepRow {
  id: string;
  cin7_transfer_number: string;
  cin7_lot: string | null;
  plan_id: string | null;
  status: string;
  amazon_shipment_ids: string[] | null;
  updated_at: string;
  prep_instructions: any;
}

export interface SweepDeps {
  now?: () => number;
  maxPerTick?: number;
  loadCandidates: () => Promise<SweepRow[]>;
  /** Live ShipHero order for the row's transfer. null = none found. */
  resolveOrder: (row: SweepRow) => Promise<{ orderId: string; cancelled: boolean } | null>;
  check: (row: SweepRow, orderId: string) => Promise<CompletenessResult>;
  /** POST /api/fba/relabel {plan_id} equivalent. Throws on failure. */
  relabel: (planId: string) => Promise<void>;
  update: (id: string, patch: Record<string, any>) => Promise<void>;
  alert: (html: string) => Promise<boolean>;
}

export interface SweepResult {
  checked: number;
  alreadyComplete: string[];
  recovered: string[];
  stillMissing: string[];
  escalated: string[];
  unknown: string[];
  skipped: Array<{ transfer: string; reason: string }>;
  errors: string[];
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function eligible(r: SweepRow, now: number): string | null {
  if (r.status !== 'plan_created') return 'status';
  if (!r.plan_id || !(r.amazon_shipment_ids ?? []).length) return 'no_shipments';
  if (now - Date.parse(r.updated_at) < SWEEP_MIN_IDLE_MS) return 'in_flight';
  if (Number(r.prep_instructions?.label_check?.attempts ?? 0) >= SWEEP_MAX_ATTEMPTS) return 'escalated_already';
  return null;
}

function labelCheckPatch(row: SweepRow, check: Record<string, any>) {
  const prep = row.prep_instructions && typeof row.prep_instructions === 'object' ? row.prep_instructions : {};
  return { prep_instructions: { ...prep, label_check: { ...(prep.label_check ?? {}), ...check } } };
}

export async function sweepIncompleteLabels(deps: SweepDeps): Promise<SweepResult> {
  const now = (deps.now ?? Date.now)();
  const max = deps.maxPerTick ?? 3;
  const out: SweepResult = { checked: 0, alreadyComplete: [], recovered: [], stillMissing: [], escalated: [], unknown: [], skipped: [], errors: [] };

  const rows = (await deps.loadCandidates()).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  for (const row of rows) {
    const tr = row.cin7_transfer_number;
    const why = eligible(row, now);
    if (why) { if (why === 'escalated_already') out.skipped.push({ transfer: tr, reason: why }); continue; }
    if (out.checked >= max) break;
    out.checked++;

    const order = await deps.resolveOrder(row).catch(() => null);
    if (!order || order.cancelled) { out.skipped.push({ transfer: tr, reason: order ? 'order_cancelled' : 'no_order' }); continue; }

    const first = await deps.check(row, order.orderId).catch((e) => ({ complete: undefined, error: String(e?.message || e) }) as CompletenessResult);
    if (first.complete === undefined) { out.unknown.push(tr); continue; }
    if (first.complete === true) {
      await deps.update(row.id, { status: 'labels_ready', updated_at: new Date(now).toISOString(), ...labelCheckPatch(row, { checked_at: new Date(now).toISOString(), complete: true, source: 'sweep' }) });
      out.alreadyComplete.push(tr);
      continue;
    }

    // Verified gap → one relabel, then re-verify.
    let relabelErr: string | null = null;
    try { await deps.relabel(row.plan_id!); }
    catch (e: any) { relabelErr = String(e?.message || e).slice(0, 200); out.errors.push(`${tr}: relabel ${relabelErr}`); }

    const second = relabelErr ? first : await deps.check(row, order.orderId).catch((e) => ({ complete: undefined, error: String(e?.message || e) }) as CompletenessResult);
    if (second.complete === true) {
      await deps.update(row.id, { status: 'labels_ready', updated_at: new Date(now).toISOString(), ...labelCheckPatch(row, { checked_at: new Date(now).toISOString(), complete: true, source: 'sweep-relabel' }) });
      out.recovered.push(tr);
      continue;
    }
    if (second.complete === undefined) { out.unknown.push(tr); continue; }

    const missing = decideLabelOutcome(second, { alreadyNotified: true }).missing;
    const attempts = Number(row.prep_instructions?.label_check?.attempts ?? 0) + 1;
    await deps.update(row.id, labelCheckPatch(row, { checked_at: new Date(now).toISOString(), complete: false, missing, attempts, last_error: relabelErr, source: 'sweep' }));
    out.stillMissing.push(tr);

    if (attempts >= SWEEP_MAX_ATTEMPTS) {
      out.escalated.push(tr);
      const short = tr.replace(/^CIN7-/, '');
      await deps.alert(
        `🔴 <b>${esc(short)}</b>${row.cin7_lot ? ` (lot ${esc(row.cin7_lot)})` : ''}: Amazon has the shipments, but label file(s) are still not on the ShipHero order after ${attempts} automatic recovery attempts: ${missing.map((m) => `<code>${esc(m)}</code>`).join(', ') || '(unknown)'}.` +
          ` Nothing new was sent to Amazon. <b>Warehouse: do not start this transfer.</b> Office: this needs a look (plan <code>${esc(row.plan_id)}</code>).`,
      ).catch(() => false);
    }
  }
  return out;
}

/** Merge a label_check into prep_instructions (used by auto-submit on partial). */
export async function recordLabelCheck(
  db: SupabaseClient, rowId: string,
  check: { complete: boolean | undefined; missing: string[]; deferred: string[]; source: string },
): Promise<void> {
  const { data } = await db.from('fba_shipments').select('prep_instructions').eq('id', rowId).maybeSingle();
  const prep = (data as any)?.prep_instructions && typeof (data as any).prep_instructions === 'object' ? (data as any).prep_instructions : {};
  await db.from('fba_shipments').update({
    prep_instructions: { ...prep, label_check: { ...(prep.label_check ?? {}), checked_at: new Date().toISOString(), complete: check.complete ?? null, missing: check.missing, deferred: check.deferred, source: check.source } },
    updated_at: new Date().toISOString(),
  }).eq('id', rowId);
}

// ── Production wiring ────────────────────────────────────────────────────────

export function productionSweepDeps(db: SupabaseClient, shipheroToken: string, opts: { baseUrl: string; cronSecret: string }): SweepDeps {
  const sbUrl = process.env.SUPABASE_URL!; const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return {
    loadCandidates: async () => {
      const { data, error } = await db.from('fba_shipments')
        .select('id, cin7_transfer_number, cin7_lot, plan_id, status, amazon_shipment_ids, updated_at, prep_instructions')
        .eq('status', 'plan_created').not('plan_id', 'is', null)
        .lt('updated_at', new Date(Date.now() - SWEEP_MIN_IDLE_MS).toISOString())
        .order('updated_at', { ascending: true }).limit(25);
      if (error) throw new Error(`label sweep query: ${error.message}`);
      return (data ?? []) as SweepRow[];
    },
    resolveOrder: async (row) => {
      // SAME resolution post-process attaches with — lot child first (legacy
      // lot-split transfers, e.g. TR-00532 lot 2609102A lives on its own
      // child order), then the bridge's single order. Checking the wrong
      // order reports a false gap → needless relabel + false alert.
      const tr = row.cin7_transfer_number.replace(/^CIN7-/, '').replace(/-S\d+$/, '');
      let id: string | null = null;
      if (row.cin7_lot) id = (await resolveLotChildOrder(tr, row.cin7_lot, db).catch(() => null))?.orderId ?? null;
      if (!id) {
        const { data } = await db.from('cin7_transfer_shiphero_orders').select('shiphero_order_id').eq('cin7_transfer_number', tr).not('shiphero_order_id', 'is', null).maybeSingle();
        id = (data as any)?.shiphero_order_id ?? null;
      }
      if (!id) return null;
      const r = await fetch('https://public-api.shiphero.com/graphql', { method: 'POST', headers: { Authorization: `Bearer ${shipheroToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `{ order(id: "${id}") { data { fulfillment_status } } }` }) });
      const j: any = await r.json().catch(() => null);
      const st = j?.data?.order?.data?.fulfillment_status; if (!st) return null;
      return { orderId: id, cancelled: /cancel/i.test(String(st)) };
    },
    check: (row, orderId) => checkLabelCompleteness(row.plan_id!, orderId, {
      amazonShipments: liveAmazonShipments,
      orderAttachments: (id) => shipheroOrderAttachments(shipheroToken, id),
      pdfPages: (fbaId) => storedPdfPages(sbUrl, sbKey, labelStoragePrefix(row.cin7_transfer_number, row.cin7_lot), fbaId),
    }),
    relabel: async (planId) => {
      const r = await fetch(`${opts.baseUrl}/api/fba/relabel`, { method: 'POST', headers: { Authorization: `Bearer ${opts.cronSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: planId }), signal: AbortSignal.timeout(280_000) });
      if (r.status >= 500) throw new Error(`relabel HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    },
    update: async (id, patch) => { const { error } = await db.from('fba_shipments').update(patch).eq('id', id); if (error) throw new Error(error.message); },
    alert: (html) => sendTelegram(html),
  };
}
