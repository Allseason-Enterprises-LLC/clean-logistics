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
import { resolveKitProductIdentity, renderBarcodePng, extractAsin, type KitProductIdentity } from './kit-product-identity';

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
  /** The ShipHero order number the WO is named after (what the floor searches). */
  order_number?: string | null;
  pack_count?: number | null;
  amazon_msku?: string | null;
  /** Product identity for the kitting instructions (resolved from Amazon at gate time). */
  asin?: string | null;
  product_name?: string | null;
  fnsku?: string | null;
  upc?: string | null;
  barcode_kind?: 'FNSKU' | 'UPC' | null;
  /** public URL of the rendered barcode PNG, when we could generate one */
  barcode_url?: string | null;
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
  /** Posts the "work order created" notice to the FBA channel. Optional; a
   *  failure here never blocks the gate (fail OPEN on notifications). */
  sendTelegram?: (html: string) => Promise<boolean>;
  /** Amazon identity (FNSKU/UPC/name). Optional + fail-open: a lookup failure
   *  produces the "download from Seller Central" instruction, never a stall. */
  resolveIdentity?: typeof resolveKitProductIdentity;
  /** Render + upload + attach the barcode to the ShipHero order. Fail-open. */
  attachBarcode?: (args: { identity: KitProductIdentity; orderNumber: string; transferNumber: string; shipheroOrderId?: string | null }) => Promise<string | null>;
  now?: () => Date;
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The floor's FIRST message about a kit transfer — posted the moment the row
 * parks. Weston 2026-09-27: formal, "similar to the FBA shipment labels
 * notification but shorter and sweeter": header, product block, work-order
 * block, what-to-do, and the kitting/prep instructions — including WHICH
 * barcode goes on the finished pack (FNSKU if Amazon assigned one, else UPC;
 * if neither is known, download it from Seller Central) and Transparency
 * stickers. Same HTML conventions as buildTelegramMessage in fba-post-process.
 */
export function buildWorkOrderCreatedNotice(state: WorkOrderState, transferNumber: string): string {
  const order = state.order_number ? esc(state.order_number) : esc(transferNumber);
  const pack = state.pack_count ? `${state.pack_count}-Pack` : 'Multi-Pack';
  const name = state.product_name ? esc(state.product_name) : `${esc(state.kit_sku)}`;
  const woIds = esc(state.ids.join(', '));
  const L: string[] = [];

  L.push(`🔧 <b>New Work Order Needed — ${pack} for Amazon FBA</b>`);
  L.push('');
  L.push(`<b>Product:</b> ${name}`);
  L.push(`<b>CIN7 SKU:</b> <code>${esc(state.kit_sku)}</code>`);
  if (state.amazon_msku) L.push(`<b>Amazon MSKU:</b> <code>${esc(state.amazon_msku)}</code>`);
  const ids: string[] = [];
  if (state.asin) ids.push(`<b>ASIN:</b> <code>${esc(state.asin)}</code>`);
  if (state.fnsku) ids.push(`<b>FNSKU:</b> <code>${esc(state.fnsku)}</code>`);
  if (!state.fnsku && state.upc) ids.push(`<b>UPC:</b> <code>${esc(state.upc)}</code>`);
  if (ids.length) L.push(ids.join(' · '));
  L.push('');
  L.push(`<b>Work Order:</b> <code>${woIds}</code> — <b>${order}</b> (${esc(transferNumber)})`);
  L.push(`• Build: <b>${state.kit_qty.toLocaleString()} × ${pack}</b>${state.pack_count ? ` (${(state.kit_qty * state.pack_count).toLocaleString()} units total)` : ''}`);
  L.push(`• Priority: <b>HIGH</b> — requested today, needed within 1 business day`);
  L.push('');
  L.push('<b>What to do:</b>');
  L.push(`1. Kit the ${pack.toLowerCase()}s as specified in the work order`);
  if (state.barcode_kind && (state.fnsku || state.upc)) {
    const code = state.fnsku || state.upc;
    L.push(`2. Label each finished pack with the <b>${esc(state.barcode_kind)}</b> barcode <code>${esc(code!)}</code>${state.barcode_url ? ` — <a href="${state.barcode_url}">barcode PNG</a> (also attached to the ShipHero order)` : ''}`);
  } else {
    L.push(`2. Label each finished pack with the Amazon barcode for this ASIN — <b>download it from Seller Central</b> (Manage Inventory → Print item labels)`);
  }
  L.push(`3. Apply the <b>Amazon Transparency</b> sticker to each pack (codes come from the Transparency program)`);
  L.push(`4. Put finished packs in a <b>non-pickable bulk bin</b>`);
  L.push(`5. Mark work order <code>${woIds}</code> <b>Complete</b> in ShipHero`);
  L.push('');
  L.push(`⚠️ The FBA shipment and shipping labels are <b>not</b> created until the work order is marked Complete. Once it is, labels post here automatically within ~15 min.`);
  return L.join('\n');
}

/**
 * WO name = the ShipHero ORDER number the floor already sees
 * (`AMZ_<SKU>_<NNNNN>`, or the CIN7 Reference override — see order-naming.ts),
 * so the work order and the order line up on the same screen. Weston
 * 2026-09-27: "remember we started renaming transfer orders a different way".
 * Falls back to the TR number only if no order number is available.
 */
export function buildWorkOrderText(args: {
  transferNumber: string; orderNumber?: string | null; kitSku: string; qty: number;
  packCount?: number | null; amazonMsku?: string | null;
}) {
  const pack = args.packCount ? `${args.packCount}-pack` : 'multi-pack';
  const label = (args.orderNumber || '').trim() || args.transferNumber;
  return {
    name: `${label} · build ${args.qty} × ${pack}`,
    instructions:
      `Order ${label} (CIN7 ${args.transferNumber}) → Amazon FBA${args.amazonMsku ? ` (MSKU ${args.amazonMsku})` : ''}.\n` +
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
    /** The ShipHero order number just created for this transfer (AMZ_<SKU>_<NNNNN>). */
    shipheroOrderNumber?: string | null;
    shipheroOrderId?: string | null;
    /** CIN7 Reference free text — may carry the ASIN ("FBA B0HJN6KKVK - …"). */
    reference?: string | null;
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
      transferNumber: transfer.transferNumber, orderNumber: transfer.shipheroOrderNumber, kitSku: line.sku, qty: line.quantity,
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
    kit_sku: first!.sku, kit_qty: first!.qty, order_number: transfer.shipheroOrderNumber ?? null,
    pack_count: first!.pack ?? null, amazon_msku: first!.msku ?? null, reason: first!.reason,
  };

  // Product identity + barcode for the kitting instructions. FAIL-OPEN: any
  // failure here degrades to "download the barcode from Seller Central" in
  // the notice — it must never block the work order or the row parking.
  if (deps.resolveIdentity) {
    try {
      const identity = await deps.resolveIdentity({
        cin7Sku: first!.sku, amazonMsku: first!.msku ?? null, asin: extractAsin(transfer.reference),
      });
      state.asin = identity.asin; state.product_name = identity.productName;
      state.fnsku = identity.fnsku; state.upc = identity.upc; state.barcode_kind = identity.barcode?.kind ?? null;
      if (identity.barcode && deps.attachBarcode) {
        try {
          state.barcode_url = await deps.attachBarcode({
            identity, orderNumber: transfer.shipheroOrderNumber || transfer.transferNumber,
            transferNumber: transfer.transferNumber, shipheroOrderId: transfer.shipheroOrderId ?? null,
          });
        } catch (e: any) { console.warn(`[kit-gate] ${transfer.transferNumber}: barcode attach failed (non-fatal): ${e?.message || e}`); }
      }
      for (const n of identity.notes) console.log(`[kit-gate] ${transfer.transferNumber}: ${n}`);
    } catch (e: any) { console.warn(`[kit-gate] ${transfer.transferNumber}: identity lookup failed (non-fatal): ${e?.message || e}`); }
  }

  await parkRow(deps.supabase, transfer.id, transfer.destinationName || '', state);

  // Tell the floor NOW — not 24 h later. Notification failure is logged, never thrown:
  // the row is already parked and the WO already exists; the gate must not un-gate.
  if (deps.sendTelegram) {
    try {
      const ok = await deps.sendTelegram(buildWorkOrderCreatedNotice(state, transfer.transferNumber));
      if (!ok) console.warn(`[kit-gate] ${transfer.transferNumber}: 'work order created' notice was not delivered`);
    } catch (e: any) {
      console.warn(`[kit-gate] ${transfer.transferNumber}: 'work order created' notice failed: ${e?.message || e}`);
    }
  }
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
