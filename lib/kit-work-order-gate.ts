/**
 * Kit / multi-pack WORK-ORDER GATE for FBA-bound transfers.
 *
 * Sits between "ShipHero order created" and "FBA handoff fired" in
 * lib/cin7-transfer-sync.ts. For a transfer whose lines need kitting it:
 *   1. creates ONE ShipHero work order (type CUSTOM — see shiphero-work-orders.ts
 *      for why not ASSEMBLY) with the build spec,
 *   2. parks the bridge row: status stays 'synced' (the status column has a
 *      CHECK constraint; new values are rejected) and
 *      request_payload.work_order = { ...state } is written,
 *   3. tells the caller NOT to queue the FBA handoff.
 *
 * Release happens elsewhere: api/cron/poll-work-orders flips
 * work_order.status to COMPLETED when ShipHero says so, and the reconciler —
 * which skips rows with an unfinished work_order — then fires the shipment
 * through every existing duplicate gate. One fire path, no new one.
 *
 * No schema change. State lives in the same jsonb column the reconciler
 * already reads partnerLineItems from. Verified live 2026-09-26: PostgREST
 * writes/filters request_payload->work_order fine; a new status value is 400.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isKitTransfer, type KitTransferVerdict } from './kit-detection';
import { createAssemblyWorkOrder } from './shiphero-work-orders';

/** ShipHero GRAPH id for Clean Nutra LV (Warehouse:135872) — the UUID in
 *  SHIPHERO_WAREHOUSE_ID is OUR id and work_order_create rejects it. */
export const SHIPHERO_LV_WAREHOUSE_GRAPH_ID = 'V2FyZWhvdXNlOjEzNTg3Mg==';
export const SHIPHERO_CUSTOMER_ACCOUNT_ID = '95145';

/** The per-row state object stored at request_payload.work_order. */
export interface WorkOrderState {
  type: 'CUSTOM';
  /** ShipHero legacy_id(s) as strings; work_order(id:Int) wants Number(). */
  ids: string[];
  status: string;               // mirrors ShipHero WorkOrderStatus, or 'CANCELED'
  created_at: string;
  completed_at?: string | null;
  /** last nudge/escalation post to Telegram, for once-a-day pacing */
  last_nudge_at?: string | null;
  kit_sku: string;
  kit_qty: number;
  pack_count?: number | null;
  amazon_msku?: string | null;
  /** which rule gated it — for the ledger / debugging */
  reason: string;
}

export interface GateResult {
  gated: boolean;
  verdict: KitTransferVerdict;
  workOrder?: WorkOrderState;
}

export interface GateDeps {
  supabase: SupabaseClient;
  shipheroToken: string;
  /** cin7 sku -> amazon msku (sku_master). Injected so tests are offline. */
  resolveAmazonSku: (cin7Sku: string) => Promise<string | null>;
  createWorkOrder?: typeof createAssemblyWorkOrder;
  now?: () => Date;
}

export function buildWorkOrderText(args: {
  transferNumber: string; kitSku: string; qty: number; packCount?: number | null; amazonMsku?: string | null;
}) {
  const pack = args.packCount ? `${args.packCount}-pack` : 'multi-pack';
  return {
    name: `${args.transferNumber} · build ${args.qty} × ${args.kitSku} (${pack}) for Amazon FBA`,
    instructions:
      `CIN7 ${args.transferNumber} → Amazon FBA${args.amazonMsku ? ` (MSKU ${args.amazonMsku})` : ''}.\n` +
      `Build ${args.qty} × ${args.kitSku} (${pack}). Put the finished packs in a NON-pickable bulk bin.\n` +
      `Do NOT ship anything from this work order. When it is marked COMPLETED the FBA labels ` +
      `are generated automatically (usually within 15 min) and posted to the FBA Shipments channel.`,
  };
}

/**
 * Evaluate + apply the gate for one just-synced FBA transfer.
 * Returns { gated:false } for non-kits (caller proceeds exactly as before).
 * Throws only if WO creation itself fails — the caller records that on the row
 * so the transfer is visible, not silently un-gated.
 */
export async function applyKitWorkOrderGate(
  deps: GateDeps,
  transfer: {
    id: string;
    transferNumber: string;
    destinationName?: string | null;
    lines: Array<{ sku: string; quantity: number }>;
  }
): Promise<GateResult> {
  // Resolve Amazon MSKUs (suffix normally lives there). A failed lookup is
  // treated as "no MSKU" — the CIN7 sku alone can still gate.
  const enriched = await Promise.all(
    transfer.lines.map(async (l) => {
      let amazonSku: string | null = null;
      try { amazonSku = await deps.resolveAmazonSku(l.sku); }
      catch (e: any) { console.warn(`[kit-gate] ${transfer.transferNumber}: msku lookup failed for ${l.sku}: ${e?.message || e}`); }
      return { sku: l.sku, quantity: l.quantity, amazonSku };
    })
  );

  const verdict = isKitTransfer(enriched);
  if (!verdict.isKit) return { gated: false, verdict };

  // Weston: one WO per transfer order (one TO per SKU in practice). If a
  // transfer somehow carries several kit lines, we still create ONE WO per
  // kit line so each has a clean COMPLETED signal — and store all ids.
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const today = nowIso.slice(0, 10) + 'T00:00:00';
  const create = deps.createWorkOrder ?? createAssemblyWorkOrder;
  const ids: string[] = [];
  let first: { sku: string; qty: number; pack?: number | null; msku?: string | null; reason: string } | null = null;

  for (const line of enriched.filter((l) => verdict.kitSkus.includes(l.sku))) {
    const r = verdict.reasons[line.sku];
    const text = buildWorkOrderText({
      transferNumber: transfer.transferNumber, kitSku: line.sku, qty: line.quantity,
      packCount: r?.packCount ?? null, amazonMsku: line.amazonSku,
    });
    const wo = await create(deps.shipheroToken, {
      warehouseId: SHIPHERO_LV_WAREHOUSE_GRAPH_ID,
      customerAccountId: SHIPHERO_CUSTOMER_ACCOUNT_ID,
      sku: line.sku, quantity: line.quantity, packCount: r?.packCount ?? null,
      name: text.name, instructions: text.instructions,
      requestedDate: today, priority: 'HIGH',
    });
    ids.push(String(wo.legacyId));
    if (!first) first = { sku: line.sku, qty: line.quantity, pack: r?.packCount ?? null, msku: line.amazonSku, reason: `${r?.via}:${r?.reason}` };
  }

  const state: WorkOrderState = {
    type: 'CUSTOM', ids, status: 'IN_PROGRESS', created_at: nowIso, completed_at: null, last_nudge_at: null,
    kit_sku: first!.sku, kit_qty: first!.qty, pack_count: first!.pack ?? null, amazon_msku: first!.msku ?? null, reason: first!.reason,
  };

  await parkRow(deps.supabase, transfer.id, transfer.destinationName || '', state);
  return { gated: true, verdict, workOrder: state };
}

/** Merge work_order into request_payload without clobbering partnerLineItems etc. */
export async function parkRow(
  supabase: SupabaseClient, cin7TransferId: string, cin7Destination: string, state: WorkOrderState
): Promise<void> {
  const { data: row, error: readErr } = await supabase
    .from('cin7_transfer_shiphero_orders')
    .select('id, request_payload')
    .eq('cin7_transfer_id', cin7TransferId)
    .eq('cin7_destination', cin7Destination)
    .maybeSingle();
  if (readErr) throw new Error(`kit-gate: read bridge row failed: ${readErr.message}`);
  if (!row) throw new Error(`kit-gate: no bridge row for ${cin7TransferId} / ${cin7Destination}`);

  const merged = { ...(row.request_payload || {}), work_order: state };
  const { error } = await supabase
    .from('cin7_transfer_shiphero_orders')
    .update({
      request_payload: merged,
      last_fba_handoff_status: 'awaiting_work_order',
      last_fba_handoff_detail:
        `${state.created_at.slice(0, 16)}: kit gate — work order ${state.ids.join(',')} (${state.kit_qty} × ${state.kit_sku}) must be COMPLETED before the FBA shipment fires`,
    })
    .eq('id', row.id);
  if (error) throw new Error(`kit-gate: park failed: ${error.message}`);
}

/** Read helper shared by the reconciler + poller. */
export function readWorkOrderState(requestPayload: any): WorkOrderState | null {
  const wo = requestPayload?.work_order;
  return wo && Array.isArray(wo.ids) ? (wo as WorkOrderState) : null;
}

/** True when the row must NOT fire yet. COMPLETED (or no WO at all) → false. */
export function isBlockedByWorkOrder(requestPayload: any): boolean {
  const wo = readWorkOrderState(requestPayload);
  return !!wo && wo.status !== 'COMPLETED';
}
