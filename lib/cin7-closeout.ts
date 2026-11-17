/**
 * CIN7 transfer close-out (2026-11-07, Weston: "we need the transfer bridge to
 * close open transfers — TR-00699 is completed but still open so the ShipHero
 * bridge keeps flagging it").
 *
 * Until now this bridge was READ-ONLY toward CIN7. Every FBA transfer it ever
 * shipped stayed ORDERED / IN TRANSIT in CIN7 (58 of the last 60 dispatched).
 *
 * Rule (Weston, 2026-11-07): ShipHero fulfilled + Amazon shipped + coverage
 * whole  ⇒  CIN7 transfer COMPLETED, completion date = ShipHero ship date,
 * one line per lot with the lot's BatchSN + ExpiryDate (CIN7 refuses to
 * complete without them). A SHORT transfer (coverage not whole) is never
 * auto-completed — a human decides partial vs top-up.
 *
 * Mechanics learned from the live probe on TR-00699:
 *   - no `/complete` endpoint; completion is PUT /stockTransfer/order (lines
 *     with lots) then PUT /stockTransfer (header, Status=COMPLETED,
 *     CompletionDate, Lines echoed).
 *   - the BrandMind Integration key (CIN7_API_KEY) has write scope — chosen
 *     over a second app (Weston, "A"). Shares the 60/min budget with sync, so
 *     this runs on :10/:30/:50, capped per tick, and defers on 429.
 *
 * Idempotent: a transfer already COMPLETED in CIN7 is recorded and skipped.
 * State lives in request_payload.cin7_closeout on the bridge row (no DDL).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { executeCIN7Request, newCin7Meter, Cin7RateLimitError, type Cin7CallMeter } from './cin7-transfer-sync';
import { extractTransferNumber } from './order-naming';

export const CLOSEOUT_PER_TICK = 5;
export const WAIT_RECHECK_MS = 6 * 3600 * 1000;
/** Amazon statuses that mean the freight has left the dock. */
export const AMAZON_SHIPPED_STATUSES = new Set(['SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED']);
const CIN7_OPEN_STATUSES = new Set(['ORDERED', 'IN TRANSIT', 'AUTHORISED', 'AUTHORIZED']);

export interface CloseoutLot { sku: string; lot: string; expiry: string | null; units: number; amazonStatus: string | null }
export interface CloseoutFacts {
  transfer: string;
  cin7Status: string | null;            // live header status
  cin7CompletionDate: string | null;    // live
  cin7Lines: Array<{ sku: string; qty: number; productId?: string; comments?: string | null }>;
  shipheroFulfilled: boolean;
  shipheroShippedBySku: Record<string, number>;
  shipheroShipDate: string | null;      // ISO
  coverageWhole: boolean | null;        // request_payload.coverage.whole, null if never computed
  lots: CloseoutLot[];                  // active fba_shipments rows
}
export type CloseoutDecision =
  | { action: 'complete'; completionDate: string; lines: Array<{ sku: string; qty: number; lot: string; expiry: string; productId?: string }> }
  | { action: 'already_complete' }
  | { action: 'wait'; reason: string }
  | { action: 'hold'; reason: string };   // needs a human; recorded once, never retried automatically

/** Pure. */
export function decideCloseout(f: CloseoutFacts): CloseoutDecision {
  if (f.cin7Status && !CIN7_OPEN_STATUSES.has(f.cin7Status.toUpperCase())) {
    return f.cin7Status.toUpperCase() === 'COMPLETED' ? { action: 'already_complete' } : { action: 'hold', reason: `CIN7 status ${f.cin7Status} — nothing to close` };
  }
  if (!f.shipheroFulfilled) return { action: 'wait', reason: 'ShipHero order not fulfilled' };
  if (!f.lots.length) return { action: 'wait', reason: 'no active FBA shipment rows' };
  // Rows from before lot/status tracking (null lot, null amazon_status, no label_set) can never
  // satisfy CIN7's per-line BatchSN requirement from our records → HOLD once (human closes in
  // CIN7 by hand or leaves it), not WAIT forever (which would re-read CIN7 every tick).
  const legacy = f.lots.filter((l) => !l.lot || l.units === 0);
  if (legacy.length === f.lots.length) return { action: 'hold', reason: 'pre-lot-tracking shipment: no lot/units on record — close in CIN7 by hand if desired' };
  // Amazon status: WORKING/READY_TO_SHIP = freight still on our dock → wait. A row with NO recorded
  // status (pre-status-sync, ~80 of them) is not "not shipped": ShipHero fulfilled + ship date older
  // than 7 days is the physical fact. Only a KNOWN pre-ship status blocks.
  const PRE_SHIP = new Set(['WORKING', 'READY_TO_SHIP', 'CANCELLED', 'VOIDED', 'DELETED', 'ERROR']);
  const stillHere = f.lots.filter((l) => l.amazonStatus && PRE_SHIP.has(l.amazonStatus.toUpperCase()));
  if (stillHere.length) return { action: 'wait', reason: `Amazon not shipped for lot(s) ${stillHere.map((l) => `${l.lot}=${l.amazonStatus}`).join(', ')}` };
  const unknown = f.lots.filter((l) => !l.amazonStatus);
  if (unknown.length && f.shipheroShipDate && Date.now() - Date.parse(f.shipheroShipDate) < 7 * 86400000) {
    return { action: 'wait', reason: `Amazon status not yet recorded for lot(s) ${unknown.map((l) => l.lot).join(', ')} (shipped < 7d ago)` };
  }
  // Coverage: the stored verdict exists only for transfers fired after 2026-10-15. Before that,
  // compute it here from the same facts (Σ lot units vs CIN7 ordered). Never hold on a missing record.
  if (f.coverageWhole === false) return { action: 'hold', reason: 'coverage not whole (short/over transfer) — complete partial or top up, by hand' };

  // Per-SKU: CIN7 ordered == ShipHero shipped == sum of lot units.
  const orderedBySku = new Map<string, number>();
  for (const l of f.cin7Lines) orderedBySku.set(l.sku, (orderedBySku.get(l.sku) ?? 0) + l.qty);
  const lotUnitsBySku = new Map<string, number>();
  for (const l of f.lots) lotUnitsBySku.set(l.sku, (lotUnitsBySku.get(l.sku) ?? 0) + l.units);
  for (const [sku, ordered] of orderedBySku) {
    const shipped = f.shipheroShippedBySku[sku] ?? 0;
    const lotted = lotUnitsBySku.get(sku) ?? 0;
    if (shipped !== ordered) return { action: 'hold', reason: `${sku}: CIN7 ordered ${ordered}, ShipHero shipped ${shipped}` };
    if (lotted !== ordered) return { action: 'hold', reason: `${sku}: CIN7 ordered ${ordered}, FBA lot rows total ${lotted}` };
  }
  const missingExpiry = f.lots.filter((l) => !l.expiry);
  if (missingExpiry.length) return { action: 'hold', reason: `no expiry recorded for lot(s) ${missingExpiry.map((l) => l.lot).join(', ')} — CIN7 requires it` };
  // Lot sanity: CIN7 line comments often name the lot ("lot 0426355"). If a lot is named and does
  // NOT match any shipped lot for that SKU, hold — TR-00699 (0426355 vs 0426354) is exactly this.
  for (const line of f.cin7Lines) {
    const named = [...String(line.comments ?? '').matchAll(/\blot\s*#?\s*([A-Za-z0-9]{5,})/gi)].map((m) => m[1].toUpperCase());
    if (!named.length) continue;
    const shippedLots = f.lots.filter((l) => l.sku === line.sku).map((l) => l.lot.toUpperCase());
    if (!named.some((n) => shippedLots.includes(n))) {
      return { action: 'hold', reason: `${line.sku}: CIN7 line names lot ${named.join('/')} but shipped lot(s) ${shippedLots.join('/')} — confirm which is right before completing` };
    }
  }
  if (!f.shipheroShipDate) return { action: 'hold', reason: 'ShipHero ship date unknown' };
  const productId = (sku: string) => f.cin7Lines.find((l) => l.sku === sku)?.productId;
  return {
    action: 'complete',
    completionDate: f.shipheroShipDate.slice(0, 10) + 'T00:00:00',
    lines: f.lots.map((l) => ({ sku: l.sku, qty: l.units, lot: l.lot, expiry: l.expiry!, productId: productId(l.sku) })),
  };
}

// ───────────────────────── I/O ─────────────────────────

async function cin7Write(method: 'PUT' | 'POST', path: string, body: unknown, meter: Cin7CallMeter): Promise<any> {
  // executeCIN7Request is GET-only; mirror its auth + 429 handling for writes.
  // CIN7 Core: header is PUT /stockTransfer; sub-documents (/order) are POST (405 on PUT — TR-00748 canary).
  const url = `https://inventory.dearsystems.com/ExternalApi/v2/${path}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    meter.calls++;
    const r = await fetch(url, {
      method,
      headers: { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID!, 'api-auth-applicationkey': process.env.CIN7_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status === 429) {
      meter.rateLimited++;
      const wait = Number((r.headers.get('retry-after') || '60').split(' ')[0]) || 60;
      if (attempt === 3) throw new Cin7RateLimitError(`429 on ${method} ${path} [gave up]`, attempt, true);
      await new Promise((res) => setTimeout(res, (wait + 1) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`CIN7 ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
}

/** Units on an Amazon inbound plan (authoritative). Used when a pre-10/15 row has no stored label_set.units. */
export async function amazonPlanUnits(planId: string): Promise<number | null> {
  const { callAmazonSpApi } = await import('./amazon-sp-api-client');
  const r: any = await callAmazonSpApi<any>({ method: 'GET', path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/items` });
  const items = r?.data?.items ?? r?.items;
  return Array.isArray(items) ? items.reduce((s: number, i: any) => s + Number(i?.quantity || 0), 0) : null;
}

export async function gatherCloseoutFacts(db: SupabaseClient, shToken: string, bridgeRow: any, meter: Cin7CallMeter, unitsForPlan: (planId: string) => Promise<number | null> = amazonPlanUnits): Promise<CloseoutFacts> {
  const tr = extractTransferNumber(bridgeRow.cin7_transfer_number) || bridgeRow.cin7_transfer_number;
  const cin7: any = await executeCIN7Request('/stockTransfer', { TaskID: bridgeRow.cin7_transfer_id }, { meter, maxRetries: 1 });
  const order = cin7?.Order ?? {};
  const cin7Lines = (order.Lines ?? []).map((l: any) => ({ sku: l.SKU, qty: Number(l.TransferQuantity ?? l.Quantity ?? 0), productId: l.ProductID, comments: l.Comments ?? null }));

  let shipheroFulfilled = false; let shipheroShipDate: string | null = null; const shipheroShippedBySku: Record<string, number> = {};
  if (bridgeRow.shiphero_order_id) {
    const q = `{ order(id:"${bridgeRow.shiphero_order_id}"){ data { fulfillment_status shipments{ created_date } line_items{ edges{ node{ sku quantity quantity_shipped } } } } } }`;
    const r = await fetch('https://public-api.shiphero.com/graphql', { method: 'POST', headers: { Authorization: `Bearer ${shToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const o: any = ((await r.json()) as any)?.data?.order?.data;
    if (o) {
      shipheroFulfilled = String(o.fulfillment_status).toLowerCase() === 'fulfilled';
      for (const e of o.line_items?.edges ?? []) shipheroShippedBySku[e.node.sku] = (shipheroShippedBySku[e.node.sku] ?? 0) + Number(e.node.quantity_shipped ?? 0);
      const dates = (o.shipments ?? []).map((s: any) => s.created_date).filter(Boolean).sort();
      shipheroShipDate = dates.length ? dates[dates.length - 1] : null;
    }
  }

  const { data: rows } = await db.from('fba_shipments')
    .select('id, cin7_transfer_number, cin7_sku, cin7_lot, lot_expiration, amazon_status, prep_instructions, status, plan_id')
    .like('cin7_transfer_number', `%${tr}%`).neq('status', 'cancelled');
  const lots: CloseoutLot[] = [];
  for (const r of rows ?? []) {
    if (extractTransferNumber(r.cin7_transfer_number) !== tr) continue;
    let units = Number((r.prep_instructions as any)?.label_set?.units ?? 0);
    if (!units && r.plan_id && r.cin7_lot) {
      // Pre-10/15 row: no stored label_set. Read Amazon once and persist so the next tick is free.
      const fromAmazon = await unitsForPlan(r.plan_id).catch(() => null);
      if (fromAmazon) {
        units = fromAmazon;
        const prep = (r.prep_instructions && typeof r.prep_instructions === 'object') ? r.prep_instructions : {};
        await db.from('fba_shipments').update({ prep_instructions: { ...prep, label_set: { ...((prep as any).label_set ?? {}), units, lot: r.cin7_lot, expiration: r.lot_expiration ?? null, source: 'amazon_plan_items', backfilled_at: new Date().toISOString() } } }).eq('id', r.id);
      }
    }
    lots.push({ sku: r.cin7_sku, lot: r.cin7_lot, expiry: r.lot_expiration ?? null, units, amazonStatus: r.amazon_status ?? null });
  }
  return {
    transfer: tr,
    cin7Status: cin7?.Status ?? null,
    cin7CompletionDate: cin7?.CompletionDate ?? null,
    cin7Lines,
    shipheroFulfilled, shipheroShippedBySku, shipheroShipDate,
    coverageWhole: bridgeRow.request_payload?.coverage?.whole ?? null,
    lots,
  };
}

export async function completeInCin7(bridgeRow: any, d: Extract<CloseoutDecision, { action: 'complete' }>, meter: Cin7CallMeter): Promise<{ status: string; completionDate: string | null }> {
  const taskId = bridgeRow.cin7_transfer_id;
  // Re-read AT the write (gate again): still open?
  const live: any = await executeCIN7Request('/stockTransfer', { TaskID: taskId }, { meter, maxRetries: 1 });
  if (!CIN7_OPEN_STATUSES.has(String(live?.Status).toUpperCase())) return { status: live?.Status, completionDate: live?.CompletionDate ?? null };
  const lines = d.lines.map((l) => ({ ProductID: l.productId, SKU: l.sku, TransferQuantity: l.qty, BatchSN: l.lot, ExpiryDate: l.expiry }));
  // ONE write. /stockTransfer/order is locked once the task is IN TRANSIT ("Cannot change Stock
  // Transfer Order. Task status is IN TRANSIT." — TR-00748 canary); the header PUT carries Lines
  // with BatchSN/ExpiryDate itself (it demanded them in the first probe).
  const hdr: any = {};
  for (const k of ['TaskID', 'From', 'To', 'DepartureDate', 'RequiredByDate', 'Reference', 'InTransitAccount', 'SkipOrder', 'CostDistributionType']) if (k in live) hdr[k] = live[k];
  hdr.Status = 'COMPLETED'; hdr.CompletionDate = d.completionDate; hdr.Lines = lines;
  await cin7Write('PUT', 'stockTransfer', hdr, meter);
  const after: any = await executeCIN7Request('/stockTransfer', { TaskID: taskId }, { meter, maxRetries: 1 });
  return { status: after?.Status, completionDate: after?.CompletionDate ?? null };
}

export interface CloseoutRunResult { considered: number; completed: string[]; alreadyComplete: string[]; waiting: Array<{ transfer: string; reason: string }>; held: Array<{ transfer: string; reason: string }>; errors: Array<{ transfer: string; error: string }>; cin7Calls: number; deferred: boolean }

/** One tick. Candidates: dispatched bridge rows not yet closed out. */
export async function runCin7Closeout(db: SupabaseClient, shToken: string, opts: { limit?: number; only?: string; dryRun?: boolean; notify?: (html: string) => Promise<unknown> } = {}): Promise<CloseoutRunResult> {
  const meter = newCin7Meter();
  const res: CloseoutRunResult = { considered: 0, completed: [], alreadyComplete: [], waiting: [], held: [], errors: [], cin7Calls: 0, deferred: false };
  // Candidates = bridge rows whose transfer has at least one ACTIVE fba_shipments
  // row with labels. The handoff status is NOT the truth: TR-00699 shipped with
  // last_fba_handoff_status=work_order_failed (WO cancelled after a hand-built
  // shipment). Rows with no labelled lot never qualify; decideCloseout gates
  // the rest on ShipHero/Amazon/coverage facts.
  // Paginated too: PostgREST caps a response at 1000 rows whatever limit you ask for.
  const lotRows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: lotErr } = await db.from('fba_shipments')
      .select('cin7_transfer_number').in('status', ['labels_ready', 'shipped', 'in_transit', 'complete'])
      .order('id', { ascending: true }).range(from, from + 999);
    if (lotErr) throw new Error(`fba_shipments query failed: ${lotErr.message}`);
    lotRows.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  const labelledTrs = new Set((lotRows ?? []).map((r: any) => extractTransferNumber(r.cin7_transfer_number)).filter(Boolean));
  // PAGINATE. 2026-11-17: this was oldest-first with a 500-row limit. Once the
  // bridge passed 500 synced rows the window held only the OLDEST 500 — all
  // already completed/held — so every tick considered 0 and returned 200 OK.
  // Silent from 11/13 01:30 UTC; ~80 shipped transfers stayed open in CIN7.
  const data: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from('cin7_transfer_shiphero_orders')
      .select('id, cin7_transfer_number, cin7_transfer_id, cin7_destination, shiphero_order_id, shiphero_order_number, request_payload, last_fba_handoff_status, synced_at')
      .eq('status', 'synced')
      .order('synced_at', { ascending: true })
      .range(from, from + 999);
    if (opts.only) q = q.eq('cin7_transfer_number', opts.only);
    const { data: page, error } = await q;
    if (error) throw new Error(`bridge query failed: ${error.message}`);
    data.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  const candidates = (data ?? []).filter((r: any) => {
    if (!labelledTrs.has(r.cin7_transfer_number)) return false;
    if (!/amazon|fba/i.test(String(r.cin7_destination || ''))) return false;
    const c = r.request_payload?.cin7_closeout;
    if (!c) return true;
    if (c.state === 'completed' || c.state === 'already_complete') return false;
    if (c.state === 'hold' && !opts.only) return false;        // held rows wait for a human (or an explicit ?only=)
    if (c.state === 'wait' && !opts.only && Date.now() - Date.parse(c.at) < WAIT_RECHECK_MS) return false; // re-check waiting rows every 6h, not every tick
    return true;
  }).slice(0, opts.limit ?? CLOSEOUT_PER_TICK);

  for (const row of candidates as any[]) {
    res.considered++;
    const tr = row.cin7_transfer_number;
    const mark = async (state: string, extra: Record<string, unknown> = {}) => {
      if (opts.dryRun) return;
      await db.from('cin7_transfer_shiphero_orders').update({ request_payload: { ...(row.request_payload ?? {}), cin7_closeout: { state, at: new Date().toISOString(), ...extra } } }).eq('id', row.id);
    };
    try {
      const facts = await gatherCloseoutFacts(db, shToken, row, meter);
      const d = decideCloseout(facts);
      if (d.action === 'already_complete') { res.alreadyComplete.push(tr); await mark('already_complete', { cin7CompletionDate: facts.cin7CompletionDate }); continue; }
      if (d.action === 'wait') { res.waiting.push({ transfer: tr, reason: d.reason }); await mark('wait', { reason: d.reason }); continue; }
      if (d.action === 'hold') {
        res.held.push({ transfer: tr, reason: d.reason });
        const prev = row.request_payload?.cin7_closeout;
        await mark('hold', { reason: d.reason });
        // LOG ONLY. 2026-11-11: eleven 🗂 posts in one tick for transfers that shipped fine months ago
        // (Weston: "why are you sending notifications?"). A hold is bookkeeping; the reason is on the row
        // and in ?dry=1 output. Nobody on the floor acts on it.
        void prev;
        console.log(`[cin7-closeout] hold ${tr}: ${d.reason}`);
        continue;
      }
      if (opts.dryRun) { res.completed.push(`${tr} (dry-run: ${d.lines.map((l) => `${l.sku} ${l.qty}@${l.lot}`).join(', ')} on ${d.completionDate.slice(0, 10)})`); continue; }
      const out = await completeInCin7(row, d, meter);
      if (String(out.status).toUpperCase() === 'COMPLETED') { res.completed.push(tr); await mark('completed', { cin7CompletionDate: out.completionDate, lines: d.lines }); }
      else { res.errors.push({ transfer: tr, error: `CIN7 status after write: ${out.status}` }); await mark('error', { error: `status after write ${out.status}` }); }
    } catch (e: any) {
      if (e instanceof Cin7RateLimitError) { res.deferred = true; break; }
      res.errors.push({ transfer: tr, error: e?.message ?? String(e) });
      await mark('error', { error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  res.cin7Calls = meter.calls;
  return res;
}
