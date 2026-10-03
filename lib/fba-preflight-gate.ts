/**
 * PREFLIGHT GATE — turns fba-preflight blockers into actions, reusing the kit
 * gate's park/notice/release machinery so there is ONE way a transfer waits.
 *
 *   floor blockers     → ONE ShipHero CUSTOM work order ("DATA FIX …") with the
 *                        checklist; row parks with request_payload.work_order
 *                        exactly like a kit WO; poll-work-orders releases on
 *                        COMPLETED and the reconciler RE-RUNS preflight before
 *                        firing (so a ticked-but-unfixed WO re-parks, not fails).
 *   marketing blockers → NO work order. One channel notice tagging marketing
 *                        (@primeaiagentbm_bot) with the Seller Central steps; row
 *                        parks with request_payload.preflight_hold and clears on
 *                        its own when the next preflight passes.
 *
 * Fail-closed on ShipHero data (the shipment literally cannot be built),
 * fail-OPEN on the Amazon readiness probe (unknown ≠ not ready).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { runPreflight, buildPreflightWorkOrderText, preflightReason, type PreflightFacts, type PreflightResult, type Blocker } from './fba-preflight';
import { parkRow, SHIPHERO_LV_WAREHOUSE_GRAPH_ID, SHIPHERO_CUSTOMER_ACCOUNT_ID, type WorkOrderState } from './kit-work-order-gate';
import { createCustomWorkOrder } from './shiphero-work-orders';

export const MARKETING_HANDLE = '@primeaiagentbm_bot';

export interface PreflightGateDeps {
  supabase: SupabaseClient;
  shipheroToken: string;
  /** Gather the facts for one line. Injected: tests are offline. */
  gatherFacts: (sku: string, quantity: number) => Promise<PreflightFacts>;
  createWorkOrder?: typeof createCustomWorkOrder;
  sendTelegram?: (html: string) => Promise<boolean>;
  now?: () => Date;
}

export interface PreflightGateResult {
  gated: boolean;
  result: PreflightResult;
  workOrder?: WorkOrderState;
  marketingNotified?: boolean;
  /** 'floor' | 'marketing' | null — which hold the row is under. */
  hold: 'floor' | 'marketing' | null;
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function applyPreflightGate(
  deps: PreflightGateDeps,
  transfer: {
    id: string;
    transferNumber: string;
    destinationName?: string | null;
    lines: Array<{ sku: string; quantity: number }>;
    shipheroOrderNumber?: string | null;
    /** request_payload.preflight_hold already on the row, if any (dedupes the notice). */
    existingHold?: MarketingHold | null;
    /** request_payload.work_order already on the row, if any (dedupes the WO). */
    existingWorkOrder?: WorkOrderState | null;
  }
): Promise<PreflightGateResult> {
  // One preflight per line; a transfer is one SKU in practice but stay honest.
  const results: Array<{ sku: string; quantity: number; r: PreflightResult }> = [];
  for (const l of transfer.lines) {
    const facts = await deps.gatherFacts(l.sku, l.quantity);
    results.push({ sku: l.sku, quantity: l.quantity, r: runPreflight(facts) });
  }
  const blockers: Blocker[] = results.flatMap((x) => x.r.blockers);
  const merged: PreflightResult = {
    ok: blockers.length === 0,
    blockers,
    floor: blockers.filter((b) => b.owner === 'floor'),
    marketing: blockers.filter((b) => b.owner === 'marketing'),
  };
  if (merged.ok) return { gated: false, result: merged, hold: null };

  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const primary = results.find((x) => !x.r.ok) ?? results[0];

  // ONE notice per hold. The reconciler re-runs preflight every tick; if the
  // row already carries a preflight_hold with the SAME codes, the floor and
  // marketing have already been told — refresh the hold silently.
  // (2026-10-03: TR-00484/00489 each got the ⏸ notice twice in 15 minutes.)
  const existingHold: MarketingHold | undefined = transfer.existingHold ?? undefined;
  const sameHold = !!existingHold && JSON.stringify([...existingHold.codes].sort()) === JSON.stringify(merged.marketing.map((b) => b.code).sort());

  // ── Marketing first: if the listing is the problem, a floor WO for data
  //    entry is still useful, but the FNSKU stage must wait. Post the notice
  //    (once); the floor WO (if any) is created below.
  let marketingNotified = false;
  if (merged.marketing.length > 0 && deps.sendTelegram && !sameHold) {
    try {
      marketingNotified = await deps.sendTelegram(buildMarketingHoldNotice({
        transferNumber: transfer.transferNumber, orderNumber: transfer.shipheroOrderNumber ?? null,
        sku: primary.sku, quantity: primary.quantity, blockers: merged.marketing,
      }));
    } catch (e: any) {
      console.warn(`[preflight-gate] ${transfer.transferNumber}: marketing notice failed (non-fatal): ${e?.message || e}`);
    }
  }

  // ── Floor: ONE custom WO with every floor blocker's checklist. If the row
  //    already carries an open preflight WO for the SAME reason, don't create
  //    another (the poller re-runs preflight at release; same blockers → same WO).
  let state: WorkOrderState | undefined;
  const reasonNow = preflightReason(merged);
  const openSame = transfer.existingWorkOrder && transfer.existingWorkOrder.status !== 'COMPLETED' && transfer.existingWorkOrder.reason === reasonNow ? transfer.existingWorkOrder : null;
  if (merged.floor.length > 0 && openSame) {
    return { gated: true, result: merged, workOrder: openSame, marketingNotified, hold: 'floor' };
  }
  if (merged.floor.length > 0) {
    const text = buildPreflightWorkOrderText({
      transferNumber: transfer.transferNumber, orderNumber: transfer.shipheroOrderNumber,
      sku: primary.sku, quantity: primary.quantity, blockers: merged.floor,
    });
    const create = deps.createWorkOrder ?? createCustomWorkOrder;
    const wo = await create(deps.shipheroToken, {
      warehouseId: SHIPHERO_LV_WAREHOUSE_GRAPH_ID,
      customerAccountId: SHIPHERO_CUSTOMER_ACCOUNT_ID,
      sku: primary.sku, quantity: primary.quantity,
      name: text.name, instructions: text.instructions,
      requestedDate: nowIso.slice(0, 10) + 'T00:00:00', priority: 'HIGH',
    });
    state = {
      type: 'CUSTOM', ids: [String(wo.legacyId)], status: 'IN_PROGRESS', created_at: nowIso, completed_at: null, last_nudge_at: null,
      kit_sku: primary.sku, kit_qty: primary.quantity, order_number: transfer.shipheroOrderNumber ?? null,
      pack_count: null, amazon_msku: null, reason: preflightReason(merged),
    };
    await parkRow(deps.supabase, transfer.id, transfer.destinationName || '', state);
    if (deps.sendTelegram) {
      try {
        const ok = await deps.sendTelegram(buildPreflightWorkOrderNotice({
          state, transferNumber: transfer.transferNumber, blockers: merged.floor,
        }));
        if (!ok) console.warn(`[preflight-gate] ${transfer.transferNumber}: WO notice not delivered`);
      } catch (e: any) {
        console.warn(`[preflight-gate] ${transfer.transferNumber}: WO notice failed (non-fatal): ${e?.message || e}`);
      }
    }
    return { gated: true, result: merged, workOrder: state, marketingNotified, hold: 'floor' };
  }

  // ── Marketing-only hold: no WO. Park with a hold marker the reconciler
  //    honours; it clears itself when preflight passes on a later tick.
  await parkMarketingHold(deps.supabase, transfer.id, transfer.destinationName || '', {
    since: existingHold?.since ?? nowIso, codes: merged.marketing.map((b) => b.code), summary: merged.marketing.map((b) => b.summary).join('; '),
  });
  return { gated: true, result: merged, marketingNotified, hold: 'marketing' };
}

/** Floor notice — same shape/voice as the kit WO notice, data-fix flavour. */
export function buildPreflightWorkOrderNotice(args: { state: WorkOrderState; transferNumber: string; blockers: Blocker[] }): string {
  const { state, transferNumber, blockers } = args;
  const order = state.order_number ? esc(state.order_number) : esc(transferNumber);
  const L: string[] = [];
  L.push(`🔧 <b>Work Order — Product Data Needed Before FBA Shipment</b>`);
  L.push('');
  L.push(`<b>Order:</b> ${order} (${esc(transferNumber)})`);
  L.push(`<b>Product:</b> <code>${esc(state.kit_sku)}</code> · ${state.kit_qty.toLocaleString()} units`);
  L.push(`<b>Work Order:</b> <code>${esc(state.ids.join(', '))}</code> (Custom) · HIGH`);
  L.push('');
  L.push('<b>The FBA shipment cannot be created yet. ShipHero is missing:</b>');
  blockers.forEach((b, i) => L.push(`${i + 1}. ${esc(b.summary.replace(/^ShipHero (has|lot)/, (m) => m))}`));
  L.push('');
  L.push('The work order lists the exact steps and the exact lines to enter in ShipHero. When it is marked <b>Complete</b>, the system re-checks and creates the shipment; box labels post here automatically. If anything is still missing, a new work order will say what.');
  return L.join('\n');
}

/** Marketing notice — tags Prime; floor is told to hold, not to act. */
export function buildMarketingHoldNotice(args: { transferNumber: string; orderNumber: string | null; sku: string; quantity: number; blockers: Blocker[] }): string {
  const order = args.orderNumber ? esc(args.orderNumber) : esc(args.transferNumber);
  const L: string[] = [];
  L.push(`⏸ <b>On Hold — Amazon Listing Needs Attention</b> ${MARKETING_HANDLE}`);
  L.push('');
  L.push(`<b>Order:</b> ${order} (${esc(args.transferNumber)})`);
  L.push(`<b>Product:</b> <code>${esc(args.sku)}</code> · ${args.quantity.toLocaleString()} units`);
  L.push('');
  L.push('<b>This must be fixed on our side before the shipment can be created:</b>');
  for (const b of args.blockers) {
    L.push(`• ${esc(b.summary)}`);
    b.checklist.forEach((s, i) => L.push(`   ${i + 1}. ${esc(s)}`));
  }
  L.push('');
  L.push('<b>Warehouse:</b> no action — keep the product in its current location. The shipment fires automatically once Amazon accepts the listing; if FNSKU labels are then required, a work order will follow with the label count.');
  return L.join('\n');
}

export interface MarketingHold { since: string; codes: string[]; summary: string }

export async function parkMarketingHold(supabase: SupabaseClient, cin7TransferId: string, cin7Destination: string, hold: MarketingHold): Promise<void> {
  const { data: row, error: readErr } = await supabase
    .from('cin7_transfer_shiphero_orders').select('id, request_payload')
    .eq('cin7_transfer_id', cin7TransferId).eq('cin7_destination', cin7Destination).maybeSingle();
  if (readErr) throw new Error(`preflight-gate: read bridge row failed: ${readErr.message}`);
  if (!row) throw new Error(`preflight-gate: no bridge row for ${cin7TransferId} / ${cin7Destination}`);
  const merged = { ...(row.request_payload || {}), preflight_hold: hold };
  const { error } = await supabase.from('cin7_transfer_shiphero_orders').update({
    request_payload: merged,
    last_fba_handoff_status: 'awaiting_listing',
    last_fba_handoff_detail: `${hold.since.slice(0, 16)}: preflight — ${hold.summary}`,
  }).eq('id', row.id);
  if (error) throw new Error(`preflight-gate: hold failed: ${error.message}`);
}

/** Remove the marketing hold (preflight passed). Leaves work_order alone. */
export async function clearMarketingHold(supabase: SupabaseClient, rowId: string, requestPayload: any): Promise<void> {
  if (!requestPayload?.preflight_hold) return;
  const { preflight_hold: _drop, ...rest } = requestPayload;
  const { error } = await supabase.from('cin7_transfer_shiphero_orders').update({ request_payload: rest }).eq('id', rowId);
  if (error) throw new Error(`preflight-gate: clear hold failed: ${error.message}`);
}

export function isOnMarketingHold(requestPayload: any): boolean {
  return !!requestPayload?.preflight_hold;
}
