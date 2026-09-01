/**
 * FBA Transport Recovery
 *
 * Self-healing for the "crashed after confirmPlacementOption, before
 * confirmTransportationOptions" failure mode (TR-00370, 2026-08-31).
 *
 * When an auto-submit run dies mid-workflow, the frozen draft row may point at
 * an Amazon plan that is ACTIVE with an ACCEPTED placement and real shipments —
 * but transportation was never confirmed, so v0 getLabels 400s with
 * "Carrier estimate is not yet confirmed". This state is recoverable IN PLACE:
 * no new plan, no duplicate shipments, no dedup-slot risk. We simply finish the
 * remaining workflow steps against the EXISTING plan:
 *
 *   1. Verify plan ACTIVE + placement ACCEPTED (else not our case → caller
 *      falls back to needs_review).
 *   2. Resolve internal shipment ids + FBA confirmation ids.
 *   3. Probe v0 getLabels:
 *        200 → transport already confirmed; run died even later. Skip to bind.
 *        400 "Carrier estimate…" → complete transport confirmation:
 *          - list transportationOptions per shipment
 *          - regenerate if any shipment lost its partnered option (quotes expire)
 *          - pick cheapest AMAZON_PARTNERED_CARRIER per shipment
 *          - confirm delivery windows where preconditioned
 *          - confirmTransportationOptions
 *   4. Bind ids to the fba_shipments row (status='plan_created').
 *   5. Fire /api/fba/relabel to upload PDFs + attach to ShipHero + Telegram,
 *      then mark labels_ready.
 *
 * SAFETY: this module NEVER calls createInboundPlan, never cancels anything,
 * and never frees the (transfer,sku,lot) dedup slot. Every Amazon call is
 * either a read or an idempotent confirmation on the already-existing plan.
 */
import { SupabaseClient } from '@supabase/supabase-js';
import { callAmazonSpApi } from './amazon-sp-api-client';

const FBA_INBOUND_BASE = '/inbound/fba/2024-03-20';
const LTL_MODES = new Set([
  'FREIGHT_LTL',
  'FREIGHT_FTL_PALLET',
  'FREIGHT_FTL_NONPALLET',
  'PARTIAL_TRUCK_LOAD',
  'FULL_TRUCK_LOAD',
]);

export interface RecoveryOutcome {
  recovered: boolean;
  /** Human-readable trail for logs / Telegram */
  detail: string;
  /** FBA confirmation ids bound to the row (when recovered) */
  fbaIds?: string[];
}

interface FrozenRow {
  id: string;
  plan_id: string | null;
  cin7_transfer_number: string | null;
  cin7_sku: string | null;
  cin7_lot: string | null;
}

function extractErr(e: unknown): string {
  const any = e as any;
  return any?.message || String(e);
}

async function pollOperation(operationId: string, maxWaitMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await callAmazonSpApi<any>({
      method: 'GET',
      path: `${FBA_INBOUND_BASE}/operations/${operationId}`,
    });
    const status = res.data?.operationStatus;
    if (status === 'SUCCESS') return;
    if (status === 'FAILED') {
      throw new Error(
        `operation ${operationId} FAILED: ${JSON.stringify(res.data?.operationProblems ?? []).slice(0, 400)}`
      );
    }
  }
  throw new Error(`operation ${operationId} timed out after ${maxWaitMs}ms`);
}

async function listTransportOptions(planId: string, shipmentId: string): Promise<any[]> {
  let all: any[] = [];
  let nextToken: string | undefined;
  do {
    const query: Record<string, string> = { shipmentId, pageSize: '20' };
    if (nextToken) query.paginationToken = nextToken;
    const r = await callAmazonSpApi<any>({
      method: 'GET',
      path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/transportationOptions`,
      query,
    });
    all = all.concat(r.data?.transportationOptions ?? []);
    nextToken = r.data?.pagination?.nextToken;
  } while (nextToken);
  return all.filter((o: any) => !LTL_MODES.has(o.shippingMode));
}

/** Probe v0 getLabels; returns 'ok' | 'unconfirmed_transport' | 'other_error' */
async function probeLabels(fbaId: string): Promise<'ok' | 'unconfirmed_transport' | 'other_error'> {
  try {
    await callAmazonSpApi<any>({
      method: 'GET',
      path: `/fba/inbound/v0/shipments/${fbaId}/labels`,
      query: { PageType: 'PackageLabel_Thermal', LabelType: 'BARCODE_2D' },
    });
    return 'ok';
  } catch (e) {
    // SpApiError.message is the generic "Amazon SP-API error (HTTP 400)" —
    // the real reason ("Carrier estimate is not yet confirmed...") is in
    // .details. Check both.
    const any = e as any;
    const haystack = `${any?.message ?? ''} ${JSON.stringify(any?.details ?? '')}`;
    if (/carrier estimate is not yet confirmed/i.test(haystack)) return 'unconfirmed_transport';
    return 'other_error';
  }
}

/**
 * Attempt in-place recovery of a frozen draft whose plan may be stuck at the
 * unconfirmed-transportation step. Returns recovered=false (with detail) for
 * every state that is NOT provably this failure mode — the caller then falls
 * back to the safe needs_review path.
 */
export async function attemptTransportRecovery(
  db: SupabaseClient,
  row: FrozenRow
): Promise<RecoveryOutcome> {
  const trail: string[] = [];
  const planId = row.plan_id;
  if (!planId) return { recovered: false, detail: 'no plan_id on row' };

  // 1) Plan must be ACTIVE
  let plan: any;
  try {
    const r = await callAmazonSpApi<any>({
      method: 'GET',
      path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}`,
    });
    plan = r.data;
  } catch (e) {
    return { recovered: false, detail: `plan fetch failed: ${extractErr(e)}` };
  }
  if (plan?.status !== 'ACTIVE') {
    return { recovered: false, detail: `plan status=${plan?.status ?? 'unknown'} (not ACTIVE)` };
  }
  trail.push('plan ACTIVE');

  // 2) Placement must be ACCEPTED with shipmentIds
  let accepted: any;
  try {
    const r = await callAmazonSpApi<any>({
      method: 'GET',
      path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/placementOptions`,
    });
    accepted = (r.data?.placementOptions ?? []).find((p: any) => p.status === 'ACCEPTED');
  } catch (e) {
    return { recovered: false, detail: `placementOptions fetch failed: ${extractErr(e)}` };
  }
  const shipmentIds: string[] = accepted?.shipmentIds ?? [];
  if (!accepted || shipmentIds.length === 0) {
    return { recovered: false, detail: 'no ACCEPTED placement with shipmentIds' };
  }
  trail.push(`placement ACCEPTED (${shipmentIds.length} shipments)`);

  // 3) Resolve FBA confirmation ids per internal shipment
  const confIds: string[] = [];
  for (const sid of shipmentIds) {
    try {
      const r = await callAmazonSpApi<any>({
        method: 'GET',
        path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/shipments/${sid}`,
      });
      const conf = r.data?.shipmentConfirmationId;
      if (conf) confIds.push(conf);
    } catch (e) {
      return { recovered: false, detail: `shipment ${sid} fetch failed: ${extractErr(e)}` };
    }
  }
  if (confIds.length !== shipmentIds.length) {
    return {
      recovered: false,
      detail: `only ${confIds.length}/${shipmentIds.length} shipments have confirmation ids`,
    };
  }
  trail.push(`FBA ids: ${confIds.join(',')}`);

  // 4) Probe labels — decides whether transport confirmation is the blocker
  const probe = await probeLabels(confIds[0]);
  if (probe === 'other_error') {
    return { recovered: false, detail: `labels probe failed for a non-transport reason — ${trail.join('; ')}` };
  }

  if (probe === 'unconfirmed_transport') {
    trail.push('labels blocked on unconfirmed carrier estimate — completing transport confirmation');

    // 4a) List current options; quotes may have expired for some shipments
    const optsByShipment = new Map<string, any[]>();
    let anyMissingPartnered = false;
    for (const sid of shipmentIds) {
      const opts = await listTransportOptions(planId, sid);
      optsByShipment.set(sid, opts);
      if (!opts.some((o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER')) {
        anyMissingPartnered = true;
      }
    }

    // 4b) Regenerate if needed. readyToShipWindow MUST be full ISO timestamps —
    //     date-only values 400 with a misleading "pallet and freight info" error.
    if (anyMissingPartnered) {
      trail.push('partnered quote expired on ≥1 shipment — regenerating options');
      const contactInformation = {
        name: process.env.SHIP_FROM_NAME || 'Clean Nutra',
        phoneNumber: process.env.SHIP_FROM_PHONE || '7027108850',
        email: process.env.SHIP_FROM_EMAIL || 'shipping@cleannutra.com',
      };
      const start = new Date(Date.now() + 24 * 3600e3);
      const end = new Date(Date.now() + 8 * 24 * 3600e3);
      const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const gen = await callAmazonSpApi<any>({
        method: 'POST',
        path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/transportationOptions`,
        body: {
          placementOptionId: accepted.placementOptionId,
          shipmentTransportationConfigurations: shipmentIds.map((sid) => ({
            shipmentId: sid,
            contactInformation,
            readyToShipWindow: { start: iso(start), end: iso(end) },
          })),
        },
      });
      if (gen.data?.operationId) await pollOperation(gen.data.operationId);
      for (const sid of shipmentIds) {
        optsByShipment.set(sid, await listTransportOptions(planId, sid));
      }
    }

    // 4c) Pick cheapest partnered per shipment
    const selections: Array<{ shipmentId: string; transportationOptionId: string }> = [];
    const needDeliveryWindow: string[] = [];
    for (const sid of shipmentIds) {
      const partnered = (optsByShipment.get(sid) ?? []).filter(
        (o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER'
      );
      if (partnered.length === 0) {
        return { recovered: false, detail: `no partnered option for ${sid} even after regeneration — ${trail.join('; ')}` };
      }
      partnered.sort(
        (a: any, b: any) =>
          (typeof a.quote?.cost?.amount === 'number' ? a.quote.cost.amount : Infinity) -
          (typeof b.quote?.cost?.amount === 'number' ? b.quote.cost.amount : Infinity)
      );
      const pick = partnered[0];
      selections.push({ shipmentId: sid, transportationOptionId: pick.transportationOptionId });
      if ((pick.preconditions ?? []).includes('CONFIRMED_DELIVERY_WINDOW')) {
        needDeliveryWindow.push(sid);
      }
    }

    // 4d) Delivery windows where required
    for (const sid of needDeliveryWindow) {
      const gen = await callAmazonSpApi<any>({
        method: 'POST',
        path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/shipments/${sid}/deliveryWindowOptions`,
        body: {},
      });
      if (gen.data?.operationId) await pollOperation(gen.data.operationId);
      let windows: any[] = [];
      for (let attempt = 0; attempt < 4 && windows.length === 0; attempt++) {
        const r = await callAmazonSpApi<any>({
          method: 'GET',
          path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/shipments/${sid}/deliveryWindowOptions`,
        });
        windows = r.data?.deliveryWindowOptions ?? [];
        if (windows.length === 0) await new Promise((r2) => setTimeout(r2, 5000 * (attempt + 1)));
      }
      if (windows.length === 0) {
        return { recovered: false, detail: `no delivery windows for ${sid} — ${trail.join('; ')}` };
      }
      const conf = await callAmazonSpApi<any>({
        method: 'POST',
        path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/shipments/${sid}/deliveryWindowOptions/${windows[0].deliveryWindowOptionId}/confirmation`,
        body: {},
      });
      if (conf.data?.operationId) await pollOperation(conf.data.operationId);
    }

    // 4e) Confirm transportation
    const conf = await callAmazonSpApi<any>({
      method: 'POST',
      path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}/transportationOptions/confirmation`,
      body: { transportationSelections: selections },
    });
    if (conf.data?.operationId) await pollOperation(conf.data.operationId);
    trail.push('transportation confirmed');

    // 4f) Verify labels are now printable
    await new Promise((r) => setTimeout(r, 5000));
    const verify = await probeLabels(confIds[0]);
    if (verify !== 'ok') {
      return { recovered: false, detail: `labels still not printable after confirm (${verify}) — ${trail.join('; ')}` };
    }
    trail.push('labels verified printable');
  } else {
    trail.push('labels already printable (run died after transport confirm)');
  }

  // 5) Bind ids so the dedup slot is defended and downstream tools see reality
  const { error: bindErr } = await db
    .from('fba_shipments')
    .update({
      status: 'plan_created',
      amazon_shipment_ids: confIds,
      amazon_internal_shipment_ids: shipmentIds,
      error_message: `auto-recovered by transport-recovery: ${trail.join('; ')}`,
      error_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (bindErr) {
    return { recovered: false, detail: `id bind failed: ${bindErr.message} — ${trail.join('; ')}` };
  }

  // 6) Relabel: uploads PDFs to Storage, attaches to ShipHero, sends the
  //    Telegram post. Self-HTTP like cin7-fba-handoff (relabel needs its own
  //    300s budget — cannot run inline in the reconciler's window).
  try {
    // Always use the canonical production URL. VERCEL_URL points at the
    // deployment-specific *.vercel.app host, which is behind Vercel deployment
    // protection → self-calls 401 (seen on TR-00368 recovery, 2026-08-31).
    const base = 'https://shiphero-shipstation-bridge.vercel.app';
    const res = await fetch(`${base}/api/fba/relabel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_id: planId }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body?.ok && (body.errors ?? []).length === 0) {
      const lotSeg = row.cin7_lot ? `/${String(row.cin7_lot).replace(/[^A-Za-z0-9_-]/g, '')}` : '';
      const bareTr = (row.cin7_transfer_number ?? '').replace(/^CIN7-/, '');
      await db
        .from('fba_shipments')
        .update({
          status: 'labels_ready',
          labels_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/shipment-labels/${bareTr}${lotSeg}/`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      trail.push(`relabel ok (${(body.labels ?? []).length} PDFs, telegram=${body.telegramSent})`);
    } else {
      trail.push(
        `relabel incomplete (HTTP ${res.status}, errors=${JSON.stringify(body?.errors ?? []).slice(0, 200)}) — ids are bound; run relabel manually`
      );
    }
  } catch (e) {
    trail.push(`relabel call failed: ${extractErr(e)} — ids are bound; run relabel manually`);
  }

  return { recovered: true, detail: trail.join('; '), fbaIds: confIds };
}
