/**
 * Work-order poller — the RELEASE half of the kit gate.
 *
 * Every tick: for each bridge row parked behind a work order, ask ShipHero
 * for the WO status and act:
 *   COMPLETED           → flip request_payload.work_order.status; the reconciler
 *                         fires the shipment on its next tick through every
 *                         existing duplicate gate. We never fire from here.
 *   CANCELED / CLOSED   → mark failed + Telegram alert (needs a human)
 *   open, >= 48 h        → NUDGE with the bulk-stock reading. NOT auto-complete:
 *                         ShipHero refuses work_order_complete for a WO that has
 *                         not been worked on the floor ("Invalid status
 *                         transition", verified 2026-09-26) — and that is the
 *                         right guard; we only tell them whether the kits are
 *                         on the shelf. Once a day.
 *   open, >= 24 h        → gentle reminder, once a day
 *   open, < 24 h         → wait
 *
 * Pure decision logic lives in decideWorkOrder() (tested offline). This file
 * is the I/O shell. Returns a balanced ledger like the reconciler:
 *   scanned == released + failed + nudged + escalated + waiting + errors
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getWorkOrder, getNonPickableBulkUnits, decideWorkOrder } from './shiphero-work-orders';
import { readWorkOrderState, type WorkOrderState } from './kit-work-order-gate';

export interface PollResult {
  scanned: number;
  released: string[];
  failed: string[];
  nudged: string[];
  escalated: string[];
  waiting: Array<{ transfer: string; status: string; ageHours: number }>;
  errors: string[];
}

export interface PollerDeps {
  supabase: SupabaseClient;
  shipheroToken: string;
  sendTelegram: (html: string) => Promise<boolean>;
  getWorkOrder?: typeof getWorkOrder;
  getBulk?: typeof getNonPickableBulkUnits;
  /**
   * Preflight the released transfer BEFORE promising labels. Returns the
   * blockers (empty = clear). When something blocks, the gate itself has
   * already created the WO / posted the marketing notice; the poller then
   * says the TRUE thing instead of "labels within ~15 minutes".
   * 2026-10-03: TR-00508/00509/00510/00516/00484/00489 all got the ✅ promise
   * and then nothing, for 1–2 days. Optional for tests; omit = legacy message.
   */
  preflight?: (row: { id: string; cin7_transfer_number: string; request_payload: any }) => Promise<{ gated: boolean; hold: 'floor' | 'marketing' | null; blockers: Array<{ code: string; summary: string }>; workOrderIds?: string[] } | null>;
  now?: () => Date;
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function pollWorkOrders(deps: PollerDeps): Promise<PollResult> {
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const getWO = deps.getWorkOrder ?? getWorkOrder;
  const getBulk = deps.getBulk ?? getNonPickableBulkUnits;
  const r: PollResult = { scanned: 0, released: [], failed: [], nudged: [], escalated: [], waiting: [], errors: [] };

  // Parked rows = synced + a work_order object that is not COMPLETED.
  const { data, error } = await deps.supabase
    .from('cin7_transfer_shiphero_orders')
    .select('id, cin7_transfer_number, request_payload')
    .eq('status', 'synced')
    .not('request_payload->work_order', 'is', null)
    .limit(100);
  if (error) throw new Error(`poller: bridge query failed: ${error.message}`);

  const rows = (data || []).filter((row: any) => {
    const wo = readWorkOrderState(row.request_payload);
    return wo && wo.status !== 'COMPLETED';
  });
  r.scanned = rows.length;

  for (const row of rows as any[]) {
    const tr: string = row.cin7_transfer_number;
    const wo = readWorkOrderState(row.request_payload) as WorkOrderState;
    try {
      // Live status from ShipHero (all ids must be COMPLETED to release).
      const live = await Promise.all(wo.ids.map((id) => getWO(deps.shipheroToken, Number(id))));
      const statuses = live.map((l) => l.status);
      // Representative status = the LEAST finished WO. A row releases only when
      // EVERY id is COMPLETED; any CANCELED/CLOSED fails it; otherwise report the
      // first non-complete one. (Bug caught by _test-work-order-poller: picking
      // statuses[0] released a row whose first WO was done and second wasn't.)
      const liveStatus = statuses.every((s) => s === 'COMPLETED') ? 'COMPLETED'
        : statuses.find((s) => s === 'CANCELED' || s === 'CLOSED')
          ?? statuses.find((s) => s !== 'COMPLETED')
          ?? statuses[0];

      const ageHours = (now.getTime() - new Date(wo.created_at).getTime()) / 36e5;

      // No reminders (Weston 2026-09-28): the creation notice is the only floor
      // message for an open WO, so no stock read is needed here any more.
      const d = decideWorkOrder({ status: liveStatus, ageHours, kitQty: wo.kit_qty });
      const patch = (next: Partial<WorkOrderState>, handoff?: { status: string; detail: string }) =>
        deps.supabase.from('cin7_transfer_shiphero_orders')
          .update({
            request_payload: { ...row.request_payload, work_order: { ...wo, ...next, status: next.status ?? liveStatus } },
            ...(handoff ? { last_fba_handoff_status: handoff.status, last_fba_handoff_detail: handoff.detail.slice(0, 500) } : {}),
          })
          .eq('id', row.id);

      const spec = `${wo.kit_qty} × ${esc(wo.kit_sku)}${wo.pack_count ? ` (${wo.pack_count}-pack)` : ''}`;
      const woIds = wo.ids.join(', ');
      // Lead every floor message with the ORDER number they search for
      // (AMZ_<SKU>_<NNNNN>), TR in brackets for traceability.
      const label = wo.order_number ? `${esc(wo.order_number)} (${esc(tr)})` : esc(tr);

      switch (d.action) {
        case 'release': {
          await patch({ status: 'COMPLETED', completed_at: live[0]?.completedAt ?? nowIso },
            { status: 'pending', detail: `${nowIso.slice(0, 16)}: work order ${woIds} COMPLETED — released to the reconciler for FBA handoff` });

          // Say the TRUE thing. Preflight first; promise labels only when clear.
          let pf: Awaited<ReturnType<NonNullable<PollerDeps['preflight']>>> = null;
          if (deps.preflight) {
            try {
              pf = await deps.preflight({ id: row.id, cin7_transfer_number: tr, request_payload: { ...row.request_payload, work_order: { ...wo, status: 'COMPLETED' } } });
            } catch (e: any) {
              console.warn(`[poller] preflight threw for ${tr} (not promising labels): ${e?.message || e}`);
              pf = { gated: true, hold: 'floor', blockers: [{ code: 'PREFLIGHT_ERROR', summary: 'the pre-shipment check could not run' }] };
            }
          }
          if (!pf || !pf.gated) {
            await deps.sendTelegram(`✅ <b>${label}</b>: work order ${woIds} is complete (${spec}). FBA labels will post here automatically within ~15 minutes.`);
          } else if (pf.hold === 'marketing') {
            // The gate already posted the ⏸ notice tagging marketing with the steps.
            await deps.sendTelegram(`✅ <b>${label}</b>: work order ${woIds} is complete (${spec}). ⏸ The FBA shipment is <b>on hold for an Amazon listing fix</b> (${esc(pf.blockers.map((b) => b.summary).join('; '))}) — see the notice above. <b>Warehouse: no action.</b> Labels post automatically once the listing is ready.`);
          } else {
            // Floor blocker — the gate already created the follow-up WO and posted its 🔧 notice.
            const next = pf.workOrderIds?.length ? ` A new work order <code>${esc(pf.workOrderIds.join(', '))}</code> has the steps.` : '';
            await deps.sendTelegram(`✅ <b>${label}</b>: work order ${woIds} is complete (${spec}). ⚠️ One more thing is needed before the FBA shipment can be created: ${esc(pf.blockers.map((b) => b.summary).join('; '))}.${next} Labels post automatically once that is marked Complete.`);
          }
          r.released.push(tr); break;
        }
        case 'failed': {
          await patch({ status: d.status },
            { status: 'work_order_failed', detail: `${nowIso.slice(0, 16)}: work order ${woIds} is ${d.status} in ShipHero — FBA shipment NOT created; needs a human` });
          await deps.sendTelegram(`⚠️ <b>${label}</b>: work order ${woIds} was <b>${d.status}</b> in ShipHero, so the FBA shipment was <b>not</b> created (${spec}). Someone needs to decide whether to rebuild it.`);
          r.failed.push(tr); break;
        }
        case 'escalate': {
          const short = wo.kit_qty - d.bulk;
          const msg = d.bulk >= wo.kit_qty
            ? `🔔 <b>${label}</b>: work order ${woIds} has been open ${Math.floor(d.ageHours)} h and all <b>${wo.kit_qty}</b> packs are already in bulk — it just needs to be marked <b>Complete</b> in ShipHero. The FBA labels generate the moment that happens.`
            : `🚨 <b>${label}</b>: work order ${woIds} has been open ${Math.floor(d.ageHours)} h. Bulk shows <b>${d.bulk} of ${wo.kit_qty}</b> packs (${short} short). Please build/move the rest into a non-pickable bin and mark it <b>Complete</b> — the FBA shipment is waiting on this.`;
          await patch({ status: liveStatus, last_nudge_at: nowIso });
          await deps.sendTelegram(msg);
          r.escalated.push(tr); break;
        }
        case 'nudge': {
          await patch({ status: liveStatus, last_nudge_at: nowIso });
          await deps.sendTelegram(`⏳ <b>${label}</b>: reminder — work order ${woIds} (${spec}) is due today. Mark it <b>Complete</b> in ShipHero when the packs are built and the FBA labels will generate automatically.`);
          r.nudged.push(tr); break;
        }
        case 'auto_complete': {
          // Reachable from decideWorkOrder but intentionally NOT executed: ShipHero
          // refuses API completion of an unworked WO. Treat as an escalate-with-good-news.
          await patch({ status: liveStatus, last_nudge_at: nowIso });
          await deps.sendTelegram(`🔔 <b>${label}</b>: work order ${woIds} has been open 48 h+ and all <b>${wo.kit_qty}</b> packs are in bulk — please mark it <b>Complete</b> in ShipHero so the FBA labels can generate.`);
          r.escalated.push(tr); break;
        }
        default: {
          if (liveStatus !== wo.status) await patch({ status: liveStatus });
          r.waiting.push({ transfer: tr, status: liveStatus, ageHours: Math.round(ageHours * 10) / 10 });
        }
      }
    } catch (e: any) {
      r.errors.push(`${tr}: ${e?.message || e}`);
    }
  }
  return r;
}
