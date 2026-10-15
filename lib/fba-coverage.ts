/**
 * Transfer-level coverage invariant (2026-10-15, Weston: "the floor should never
 * find a short by counting boxes").
 *
 *   ordered  = units on the CIN7 transfer (bridge row partnerLineItems, summed per SKU)
 *   labelled = units on every ACTIVE fba_shipments row for the transfer — all lots,
 *              all runs, including -S1/-S2 top-ups — read from Amazon's plan items
 *              when available, else from the row's stored label_set.
 *
 * `labelled == ordered` → whole. `<` → short (alert). `>` → OVER (alert louder:
 * a duplicate shipment risk). Pure core + one thin DB reader. The result is
 * written to the bridge row (request_payload.coverage) so the reconciler, the
 * poller's ✅ message and the watchdog all read the same truth.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { extractTransferNumber } from './order-naming';

export interface CoverageInput {
  ordered: Record<string, number>;           // sku -> units on the transfer
  rows: Array<{ sku: string; units: number; lot: string | null; transfer: string }>; // active fba rows
}
export interface Coverage {
  whole: boolean;
  over: boolean;
  bySku: Array<{ sku: string; ordered: number; labelled: number; delta: number }>;
  rows: number;
  checkedAt: string;
}

export function computeCoverage(input: CoverageInput, now = new Date()): Coverage {
  const labelled = new Map<string, number>();
  for (const r of input.rows) labelled.set(r.sku, (labelled.get(r.sku) ?? 0) + (r.units || 0));
  const skus = new Set([...Object.keys(input.ordered), ...labelled.keys()]);
  const bySku = [...skus].sort().map((sku) => {
    const o = input.ordered[sku] ?? 0; const l = labelled.get(sku) ?? 0;
    return { sku, ordered: o, labelled: l, delta: l - o };
  });
  return {
    whole: bySku.every((s) => s.delta === 0),
    over: bySku.some((s) => s.delta > 0),
    bySku,
    rows: input.rows.length,
    checkedAt: now.toISOString(),
  };
}

/** Floor/office-facing summary line(s). HTML-safe (no user text). */
export function describeCoverage(transferNumber: string, c: Coverage): string {
  if (c.whole) return `✅ ${transferNumber}: every unit on the transfer has a label (${c.bySku.map((s) => `${s.sku} ${s.labelled.toLocaleString()}`).join(', ')}).`;
  const parts = c.bySku.filter((s) => s.delta !== 0).map((s) =>
    s.delta < 0
      ? `${s.sku}: labels for ${s.labelled.toLocaleString()} of ${s.ordered.toLocaleString()} units — SHORT ${(-s.delta).toLocaleString()}`
      : `${s.sku}: labels for ${s.labelled.toLocaleString()} units but the transfer is ${s.ordered.toLocaleString()} — OVER by ${s.delta.toLocaleString()} (possible duplicate shipment — do not ship the extra)`
  );
  return `${c.over ? '🛑' : '⚠️'} ${transferNumber} is not whole.\n` + parts.join('\n');
}

/**
 * Read ordered + labelled for a transfer and return the coverage. `unitsForPlan`
 * lets the caller supply Amazon plan units (authoritative); when absent we use
 * the stored label_set.units on the row.
 */
export async function readTransferCoverage(
  db: SupabaseClient,
  cin7TransferNumber: string,
  unitsForPlan?: (planId: string) => Promise<number | null>
): Promise<{ coverage: Coverage; transfer: string } | null> {
  const tr = extractTransferNumber(cin7TransferNumber) || cin7TransferNumber;
  const { data: bridge } = await db
    .from('cin7_transfer_shiphero_orders')
    .select('request_payload')
    .eq('cin7_transfer_number', tr)
    .maybeSingle();
  const lines: Array<{ sku: string; quantity: number }> = bridge?.request_payload?.partnerLineItems ?? [];
  if (!lines.length) return null;
  const ordered: Record<string, number> = {};
  for (const l of lines) ordered[l.sku] = (ordered[l.sku] ?? 0) + Number(l.quantity || 0);

  const { data: rows } = await db
    .from('fba_shipments')
    .select('cin7_transfer_number, cin7_sku, cin7_lot, plan_id, prep_instructions, status')
    .like('cin7_transfer_number', `%${tr}%`)
    .neq('status', 'cancelled');
  const active: CoverageInput['rows'] = [];
  for (const r of rows ?? []) {
    if (extractTransferNumber(r.cin7_transfer_number) !== tr) continue; // %TR-00591% must not match TR-005910
    let units: number | null = null;
    if (unitsForPlan && r.plan_id) units = await unitsForPlan(r.plan_id).catch(() => null);
    if (units == null) units = Number((r.prep_instructions as any)?.label_set?.units ?? 0);
    active.push({ sku: r.cin7_sku, units, lot: r.cin7_lot ?? null, transfer: r.cin7_transfer_number });
  }
  return { coverage: computeCoverage({ ordered, rows: active }), transfer: tr };
}

/** Persist on the bridge row (request_payload.coverage) — repair-in-place, no DDL. */
export async function recordCoverage(db: SupabaseClient, transfer: string, coverage: Coverage): Promise<void> {
  const { data } = await db.from('cin7_transfer_shiphero_orders').select('id, request_payload').eq('cin7_transfer_number', transfer).maybeSingle();
  if (!data) return;
  await db.from('cin7_transfer_shiphero_orders').update({ request_payload: { ...(data.request_payload ?? {}), coverage } }).eq('id', data.id);
}
