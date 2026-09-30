/**
 * FBA status sync — write Amazon's REAL inbound status onto fba_shipments.
 *
 * Why this exists (2026-09-30): fba_shipments.status is a PIPELINE column —
 * it records where OUR process left off (draft → plan_created → labels_ready)
 * and nothing ever writes to it again once the boxes leave. So the watchdog,
 * reading it, flagged five transfers as "plan_created 59h old" while Amazon
 * showed every one of them SHIPPED / IN_TRANSIT. False alarms every tick.
 *
 * Fix = one writer of truth: this module polls Amazon for every non-terminal
 * plan and writes the aggregate into `amazon_status` + `amazon_status_updated_at`
 * (columns that existed but were never written). `status` (CHECK-constrained,
 * pipeline-owned) is NOT touched. The watchdog reads amazon_status first.
 *
 * Aggregation across a plan's shipments (worst-first, so a stuck one shows):
 *   any CANCELLED/VOIDED plan            → VOIDED
 *   all shipments RECEIVING/CLOSED/…     → RECEIVING / CLOSED
 *   any IN_TRANSIT / DELIVERED / CHECKED_IN → IN_TRANSIT (boxes left the building)
 *   otherwise (WORKING / READY_TO_SHIP)  → WORKING (still on our floor)
 *
 * Terminal amazon_status values are skipped on later ticks (no wasted quota):
 * CLOSED, VOIDED, CANCELLED.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const FBA_INBOUND_BASE = '/inbound/fba/2024-03-20';

/** Amazon shipment statuses that mean the boxes have physically left us. */
const LEFT_BUILDING = new Set(['IN_TRANSIT', 'DELIVERED', 'CHECKED_IN']);
/** Amazon shipment statuses that mean Amazon is receiving / done. */
const RECEIVING = new Set(['RECEIVING']);
const CLOSED = new Set(['CLOSED']);
const CANCELLED = new Set(['CANCELLED']);

export const TERMINAL_AMAZON_STATUSES = new Set(['CLOSED', 'VOIDED', 'CANCELLED']);

export type AmazonAggregate = 'WORKING' | 'IN_TRANSIT' | 'RECEIVING' | 'CLOSED' | 'VOIDED' | 'CANCELLED' | 'UNKNOWN';

/** Pure: fold a plan status + its shipment statuses into ONE word for the row. */
export function aggregateAmazonStatus(planStatus: string | null | undefined, shipmentStatuses: string[]): AmazonAggregate {
  const p = String(planStatus || '').toUpperCase();
  if (p === 'VOIDED' || p === 'CANCELLED') return 'VOIDED';
  const s = shipmentStatuses.map((x) => String(x || '').toUpperCase());
  if (s.length === 0) return p ? 'WORKING' : 'UNKNOWN';
  if (s.every((x) => CANCELLED.has(x))) return 'CANCELLED';
  if (s.every((x) => CLOSED.has(x) || CANCELLED.has(x))) return 'CLOSED';
  if (s.every((x) => RECEIVING.has(x) || CLOSED.has(x) || CANCELLED.has(x))) return 'RECEIVING';
  if (s.some((x) => LEFT_BUILDING.has(x) || RECEIVING.has(x) || CLOSED.has(x))) return 'IN_TRANSIT';
  return 'WORKING';
}

export interface SyncDeps {
  supabase: SupabaseClient;
  /** GET an SP-API path; returns parsed JSON or throws. Injected for tests. */
  amazonGet: (path: string) => Promise<any>;
  now?: () => Date;
  /** Max rows per tick (quota guard). */
  limit?: number;
  /** ms pause between Amazon calls. */
  pauseMs?: number;
}

export interface SyncResult {
  scanned: number;
  updated: Array<{ transfer: string; lot: string | null; from: string | null; to: AmazonAggregate }>;
  unchanged: number;
  errors: string[];
}

export async function syncFbaAmazonStatus(deps: SyncDeps): Promise<SyncResult> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const r: SyncResult = { scanned: 0, updated: [], unchanged: 0, errors: [] };
  const pause = deps.pauseMs ?? 600;

  // Candidates: has a plan, pipeline row not cancelled, Amazon not terminal.
  const { data, error } = await deps.supabase
    .from('fba_shipments')
    .select('id, cin7_transfer_number, cin7_lot, plan_id, status, amazon_status')
    .not('plan_id', 'is', null)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(deps.limit ?? 60);
  if (error) throw new Error(`fba_shipments read failed: ${error.message}`);

  const rows = (data || []).filter((row: any) => !TERMINAL_AMAZON_STATUSES.has(String(row.amazon_status || '').toUpperCase()));

  // De-dupe plans: several lot rows can share one plan; poll Amazon once.
  const byPlan = new Map<string, any[]>();
  for (const row of rows) {
    const list = byPlan.get(row.plan_id) || [];
    list.push(row);
    byPlan.set(row.plan_id, list);
  }

  for (const [planId, planRows] of byPlan) {
    r.scanned += planRows.length;
    try {
      const plan = await deps.amazonGet(`${FBA_INBOUND_BASE}/inboundPlans/${planId}`);
      const shipments: any[] = plan?.shipments || [];
      const statuses: string[] = [];
      for (const s of shipments) {
        const d = await deps.amazonGet(`${FBA_INBOUND_BASE}/inboundPlans/${planId}/shipments/${s.shipmentId}`);
        statuses.push(String(d?.status || ''));
        if (pause) await new Promise((res) => setTimeout(res, pause));
      }
      const agg = aggregateAmazonStatus(plan?.status, statuses);
      for (const row of planRows) {
        const prev = row.amazon_status ? String(row.amazon_status).toUpperCase() : null;
        if (prev === agg) { r.unchanged++; continue; }
        const { error: upErr } = await deps.supabase
          .from('fba_shipments')
          .update({ amazon_status: agg, amazon_status_updated_at: now })
          .eq('id', row.id);
        if (upErr) { r.errors.push(`${row.cin7_transfer_number}/${row.cin7_lot}: update failed: ${upErr.message}`); continue; }
        r.updated.push({ transfer: row.cin7_transfer_number, lot: row.cin7_lot ?? null, from: prev, to: agg });
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      // Expired tokens look like empty data elsewhere — here they surface as errors, which is what we want.
      r.errors.push(`plan ${planId} (${planRows.map((x) => x.cin7_transfer_number).join(',')}): ${msg}`);
    }
    if (pause) await new Promise((res) => setTimeout(res, pause));
  }
  return r;
}
