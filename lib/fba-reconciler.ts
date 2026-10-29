/**
 * FBA Reconciler
 *
 * Finds CIN7 transfer bridge rows that successfully created a ShipHero order
 * destined for Amazon FBA but have NO corresponding `fba_shipments` row.
 * These are transfers where the original `fireFbaAutoSubmit` handoff failed
 * silently (e.g. proxy down, Vercel timeout) and the system needs to retry.
 *
 * Behavior:
 *   - Considers bridges synced in the last 7 days (was 24h — outages like the
 *     2026-08-04..07 401/credit-exhaustion window outlasted both the 3-attempt
 *     cap AND the 24h lookback, so 5 transfers went silently dark forever)
 *   - NEVER stops retrying: re-fires are dedup-idempotent (the (transfer,sku,lot)
 *     unique index makes retrying a completed transfer a no-op), so a hard
 *     attempt cap only creates permanent silent failures. Instead, backoff:
 *     attempts 1-3 → retry hourly; attempts 4+ → retry every 4h.
 *   - Alerts via Telegram at attempt 3, then every 6th attempt thereafter,
 *     so a persistent failure stays visible without spamming.
 *   - Uses the same `fireFbaAutoSubmit` path the cron uses for first-time fires
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { fireFbaAutoSubmit, isFbaDestination } from './cin7-fba-handoff';
import { readWorkOrderState } from './kit-work-order-gate';
import { applyPreflightGate, clearMarketingHold, type PreflightGateResult } from './fba-preflight-gate';
import { gatherPreflightFacts, hasPriorFbaShipmentRow } from './fba-preflight-facts';
import { sendTelegram as sendFbaTelegram, sendTelegramMarkdown } from './fba-post-process';
import { autoResolveAmazonSku } from './amazon-auto-map';
import { getShipHeroToken } from './shiphero-product-data';
import { attemptTransportRecovery } from './fba-transport-recovery';
import { callAmazonSpApi } from './amazon-sp-api-client';
import { fetchCIN7TransferDetail, extractDetailLines } from './cin7-transfer-sync';
import { planTopUp, toLotItems, type ActiveRow } from './transfer-lots';
import { extractTransferNumber } from './order-naming';

/**
 * CIN7 statuses a transfer must be in for the reconciler to (re)fire it.
 * Mirrors the sync's defaultEligibleStatuses. Anything else — DRAFT, VOIDED,
 * COMPLETED, RECEIVED — means the source of truth has moved on and firing
 * would create an Amazon plan CIN7 no longer stands behind.
 *
 * 2026-09-30 incident: TR-00479 was edited back to DRAFT in CIN7 while its
 * bridge row stayed `synced`. When the old shipment was cancelled (freeing the
 * dedup slot) the reconciler re-fired it from a DRAFT — 2,040 units Amazon
 * expected and CIN7 did not authorise. The reconciler trusted a status it
 * had cached days earlier. Now it asks CIN7 at the moment of firing.
 */
export const CIN7_FIREABLE_STATUSES = new Set(['AUTHORISED', 'AUTHORIZED', 'ORDERED', 'PICKING', 'PACKED', 'IN TRANSIT', 'NOT RECEIVED']);

/** Pure: is this CIN7 status one the reconciler may fire from? */
export function isCin7StatusFireable(status: string | null | undefined): boolean {
  return CIN7_FIREABLE_STATUSES.has(String(status || '').trim().toUpperCase());
}

/**
 * Live CIN7 status for a bridge row, or null if it cannot be read.
 * Injected for tests via `deps`. Fail CLOSED: null → do not fire.
 */
// maxRetries 0: the reconciler must not spend 60s+ of its own 300s budget per
// row on a CIN7 Retry-After. A 429 here reads as null → fail CLOSED → next tick
// (behaviour unchanged by the 2026-10-19 sync retry).
const readDetailNoWait = (taskId: string) => fetchCIN7TransferDetail(taskId, { maxRetries: 0 });
export async function readLiveCin7Status(row: { request_payload?: any; cin7_transfer_id?: string | null }, fetchDetail: (taskId: string) => Promise<Record<string, any>> = readDetailNoWait): Promise<string | null> {
  const taskId = row?.request_payload?.rawTransfer?.TaskID || row?.cin7_transfer_id;
  if (!taskId) return null;
  try {
    const d = await fetchDetail(String(taskId));
    const s = d?.Status ?? d?.status ?? null;
    return s ? String(s) : null;
  } catch {
    return null;
  }
}

/**
 * Live CIN7 read for the top-up path: status AND the lot-bearing lines, from ONE
 * detail call. Lots come from CIN7 at the fire decision (never from a cached
 * bridge row) — the transfer goes out exactly as it is written right now.
 * Fail CLOSED: any error → null.
 */
export async function readLiveCin7Transfer(
  row: { request_payload?: any; cin7_transfer_id?: string | null; cin7_transfer_number?: string },
  fetchDetail: (taskId: string) => Promise<Record<string, any>> = readDetailNoWait
): Promise<{ status: string | null; lines: Array<{ sku: string; quantity: number; lot?: string | null }> } | null> {
  const taskId = row?.request_payload?.rawTransfer?.TaskID || row?.cin7_transfer_id;
  if (!taskId) return null;
  try {
    const d = await fetchDetail(String(taskId));
    const status = d?.Status ?? d?.status ?? null;
    const lines = extractDetailLines(d, row?.cin7_transfer_number || String(taskId)).map((l) => ({ sku: l.sku, quantity: l.quantity, lot: l.lot ?? null }));
    return { status: status ? String(status) : null, lines };
  } catch {
    return null;
  }
}

/**
 * Active fba_shipments rows for a transfer — EVERY naming form, matched the
 * same way lib/fba-coverage.ts does: TR-00665, CIN7-TR-00665, and top-up rows
 * like CIN7-CIN7-TR-00665-S1 (an exact `.in()` match missed these and read a
 * whole transfer as short). Units = Amazon plan items (authoritative); falls
 * back to the stored label_set.units; null = not labelled yet.
 */
async function activeRowsFor(
  db: SupabaseClient,
  transferNumber: string,
  unitsForPlan: (planId: string) => Promise<number | null> = amazonPlanUnits
): Promise<ActiveRow[]> {
  const tr = extractTransferNumber(transferNumber) || transferNumber;
  const { data, error } = await db
    .from('fba_shipments')
    .select('cin7_transfer_number, cin7_sku, cin7_lot, status, plan_id, amazon_shipment_ids, prep_instructions, updated_at')
    .like('cin7_transfer_number', `%${tr}%`)
    .not('status', 'in', '("failed","voided","cancelled")');
  if (error) throw new Error(`active-row query failed: ${error.message}`);
  const out: ActiveRow[] = [];
  for (const r of data || []) {
    if (extractTransferNumber((r as any).cin7_transfer_number) !== tr) continue; // %TR-00591% must not match TR-005910
    let units: number | null = null;
    const hasShipments = Array.isArray((r as any).amazon_shipment_ids) && (r as any).amazon_shipment_ids.length > 0;
    if ((r as any).plan_id && hasShipments) units = await unitsForPlan((r as any).plan_id).catch(() => null);
    if (units == null && hasShipments) {
      const u = (r as any)?.prep_instructions?.label_set?.units;
      if (u != null) units = Number(u);
    }
    out.push({ cin7_sku: (r as any).cin7_sku, cin7_lot: (r as any).cin7_lot, status: (r as any).status, units, updated_at: (r as any).updated_at });
  }
  return out;
}

async function amazonPlanUnits(planId: string): Promise<number | null> {
  const r = await callAmazonSpApi<any>({ method: 'GET', path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/items` });
  const items = (r as any)?.data?.items ?? (r as any)?.items;
  return Array.isArray(items) ? items.reduce((n: number, i: any) => n + Number(i?.quantity || 0), 0) : null;
}

const FBA_INBOUND_BASE = '/inbound/fba/2024-03-20';

const ALERT_AT_ATTEMPT = 3; // first Telegram alert
const ALERT_EVERY_AFTER = 6; // then every Nth attempt
const RETRY_GAP_EARLY_MS = 60 * 60 * 1000; // 1 hour (attempts 1-3)
const RETRY_GAP_LATE_MS = 4 * 60 * 60 * 1000; // 4 hours (attempts 4+)
const LOOKBACK_HOURS = 24 * 7;
// Lowered from 10 on 2026-09-21: each re-fire runs the full ~6-call Amazon
// inbound workflow. Ten of those per tick saturated the SP-API quota and left
// half-built plans. Smaller batches + spacing; the cron runs every 15 min so
// throughput is still ~16/hour, and nothing is dropped.
const BATCH_SIZE = 4;
const RE_FIRE_STAGGER_MS = 8_000;

interface ReconcileResult {
  scanned: number;
  reFired: number;
  throttled: number;
  exhausted: string[]; // kept for response-shape compat; no longer used to stop retries
  errors: string[];
  duration_ms: number;
  /**
   * Per-transfer disposition — why each candidate was NOT fired.
   *
   * ⚠️ 2026-09-22: `throttled: N` alone cost 40 minutes of debugging on
   * TR-00464. The row was excluded every tick by the backoff window and
   * NOTHING in the response named it, so the transfer looked simply ignored.
   * Counts tell you something was skipped; only names tell you WHICH and WHY.
   */
  skipped: Array<{ transfer: string; reason: string; detail?: string }>;
}

interface BridgeRow {
  id: string;
  cin7_transfer_number: string;
  cin7_destination: string;
  synced_at: string;
  last_fba_handoff_at: string | null;
  /** Needed to classify permanent config errors (401/403) vs transient ones. */
  last_fba_handoff_detail: string | null;
  fba_handoff_attempts: number;
  request_payload: any;
  shiphero_order_number: string | null;
}

function getSupabase(supabase?: SupabaseClient): SupabaseClient {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

// A draft row is considered FROZEN (crashed run residue) when it has no
// amazon_shipment_ids and hasn't been touched for this long. Normal runs
// update the row every few minutes (plan bind, shipment ids, labels), so
// 30 min of silence on a shipment-less draft means the serverless run died
// (e.g. 300s maxDuration hit mid-Amazon-workflow). Such rows CANNOT be
// blindly cancelled + re-fired: the crashed run may have already created
// the Amazon plan/shipments/labels before dying (incident 2026-08-14/15:
// TR-00336/337/338 → 20 duplicate shipments, extra UPS labels at warehouse).
// Instead we mark them 'needs_review' — a status that still satisfies the
// partial unique index (WHERE status NOT IN cancelled/failed/voided), so it
// KEEPS holding the (transfer,sku,lot) dedup slot and permanently blocks
// auto-re-fires until a human resolves it:
//   - plan real on Amazon → update row with plan_id/shipment ids, status onward
//   - plan dead/absent   → set status='cancelled', reconciler re-fires next tick
const FROZEN_DRAFT_MS = 30 * 60 * 1000;

async function fbaRecordExists(
  db: SupabaseClient,
  transferNumber: string
): Promise<boolean> {
  // The bridge table stores `cin7_transfer_number` as the bare CIN7 number
  // (e.g. "TR-00079"), but the FBA workflow writes rows with the ShipHero
  // order-number form ("CIN7-TR-00079"). Historically this caused
  // `fbaRecordExists` to always return false for cron-created rows, so the
  // reconciler kept firing already-completed transfers until they hit
  // `MAX_ATTEMPTS`. Query both forms.
  const candidates = Array.from(
    new Set([
      transferNumber,
      transferNumber.startsWith('CIN7-') ? transferNumber.slice(5) : `CIN7-${transferNumber}`,
    ])
  );

  const { data: byColumn, error: colErr } = await db
    .from('fba_shipments')
    .select('id, status, cin7_transfer_number, cin7_sku, cin7_lot, amazon_shipment_ids, updated_at, plan_id')
    .in('cin7_transfer_number', candidates)
    .not('status', 'in', '("failed","voided","cancelled")');

  if (colErr) {
    console.warn(`[reconciler] cin7_transfer_number lookup failed: ${colErr.message}`);
  } else if (byColumn && byColumn.length > 0) {
    // Sweep frozen drafts: crashed runs leave status='draft' rows with no
    // amazon_shipment_ids that never progress. They hold the dedup index
    // hostage, so cancel them and treat them as non-existent (→ re-fire).
    const now = Date.now();
    const frozen = byColumn.filter(
      (r: any) =>
        r.status === 'draft' &&
        !(r.amazon_shipment_ids as any[] | null)?.length &&
        now - new Date(r.updated_at).getTime() > FROZEN_DRAFT_MS
    );
    const live = byColumn.filter((r: any) => !frozen.includes(r));
    let sweptAny = false;

    for (const f of frozen as any[]) {
      // FIRST: attempt safe in-place recovery. The most common frozen-draft
      // cause (TR-00370, 2026-08-31) is a run that died AFTER shipments were
      // created but BEFORE confirmTransportationOptions — fully recoverable
      // against the existing plan with zero duplicate risk (read-only checks +
      // idempotent confirmations only; never creates or cancels plans).
      if (f.plan_id) {
        try {
          const rec = await attemptTransportRecovery(db, {
            id: f.id,
            plan_id: f.plan_id,
            cin7_transfer_number: f.cin7_transfer_number,
            cin7_sku: f.cin7_sku,
            cin7_lot: f.cin7_lot,
          });
          if (rec.recovered) {
            // Log only — NO Telegram alert. The FBA channel is for shipping
            // notifications (label posts), not engineering chatter. The relabel
            // step already posts the normal label message when it succeeds;
            // recovery details live in the row's error_message + logs.
            console.log(
              `[reconciler] auto-recovered frozen draft ${f.id} (${f.cin7_transfer_number} lot ${f.cin7_lot}): ${rec.detail}`
            );
            live.push(f);
            continue; // recovered — do NOT flag needs_review
          }
          console.log(
            `[reconciler] transport recovery not applicable for ${f.id}: ${rec.detail} — falling back to needs_review`
          );
        } catch (recErr: any) {
          console.warn(
            `[reconciler] transport recovery threw for ${f.id}: ${recErr?.message} — falling back to needs_review`
          );
        }
      }

      const { error: cancelErr } = await db
        .from('fba_shipments')
        .update({
          status: 'needs_review',
          error_message: `frozen draft flagged by reconciler (no shipment ids persisted, stale ${Math.round((now - new Date(f.updated_at).getTime()) / 60000)}min) — run died mid-workflow. DO NOT auto-retry: the run may have already created Amazon shipments/labels. Check Seller Central; if a live shipment exists, bind its plan_id/ids to this row; if not, set status='cancelled' to let the reconciler re-fire.`,
          error_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', f.id)
        .eq('status', 'draft')
        .is('amazon_shipment_ids', null);
      if (cancelErr) {
        console.warn(`[reconciler] failed to flag frozen draft ${f.id}: ${cancelErr.message}`);
      } else {
        sweptAny = true;
        console.log(
          `[reconciler] flagged frozen draft ${f.id} as needs_review (${f.cin7_transfer_number} ${f.cin7_sku} lot ${f.cin7_lot})`
        );
      }
      // Either way the row still holds the dedup slot → treat as existing.
      live.push(f);
    }

    // If we flagged anything, DO NOT auto-re-fire. A "frozen draft" can mean
    // the run died AFTER creating the Amazon plan/shipments/labels but BEFORE
    // persisting amazon_shipment_ids — auto-re-firing then creates a real
    // duplicate FBA shipment with extra partnered UPS labels at the warehouse.
    // (Incident 2026-08-14/15: TR-00336/337/338 got 2-4 duplicate shipments
    // each from sweep→re-fire loops.) The needs_review row keeps holding the
    // dedup slot, so even future reconciler ticks can't re-fire until a human
    // resolves it (bind real plan ids, or set cancelled to allow retry).
    if (sweptAny) {
      await sendTelegramAlert(
        `🧊 *FBA reconciler: frozen draft(s) flagged for ${transferNumber}*\n\n` +
          `Run died mid-workflow. NOT auto-retrying (duplicate-shipment risk — ` +
          `the crashed run may have already created Amazon shipments/labels).\n\n` +
          `Rows set to status=needs_review. Manual step: check Seller Central ` +
          `for an existing shipment. If one exists, bind its plan/shipment ids ` +
          `to the row; if not, set the row to cancelled and the reconciler ` +
          `will re-fire automatically.`
      );
    }
    if (live.length > 0) return true;
  }

  // Fallback: legacy rows didn't populate cin7_transfer_number.
  // The `name` field has the FBA workflow name; the `prep_instructions` JSON
  // doesn't carry transfer number either. The most reliable legacy check is
  // looking for Amazon plans created around the bridge's synced_at via the
  // shipping-labels Storage prefix. For simplicity we treat absence of a
  // populated column row as "no record" — the reconciler creates new ones
  // with the column populated going forward, so this branch only matters
  // until the backlog clears.
  return false;
}

/** Handoff statuses that mean "this row is still waiting on us or the floor". */
export const UNRESOLVED_HANDOFF_STATUSES = ['pending', 'awaiting_work_order', 'awaiting_listing', 'handoff_failed', 'dispatch_failed'] as const;

/**
 * Unresolved rows older than this are RETIRED, not worked. 2026-10-06 widened
 * the view to every unresolved row regardless of age so nine-day kit WOs
 * would fire; the same change surfaced June/August rows whose transfers had
 * long since shipped by other means. The reconciler re-preflighted them,
 * found (of course) no bulk stock / no case pack for a product nobody ships
 * any more, and raised MOVE STOCK / DATA FIX work orders to the floor:
 * WOs 173636/37/39/40 (Mike, 2026-10-15) and WO 179440 for TR-00331
 * (Weston, 2026-10-28: "stop trying to process this work order — shipped
 * back in August"). A transfer that has waited this long is not waiting on
 * the floor; it is dead. Mark it `stale_retired` with the reason, once, and
 * never raise anything for it. The office can set it back to `pending` if
 * it is genuinely live.
 */
export const STALE_UNRESOLVED_DAYS = 30;

/** Terminal-but-unshipped statuses that also age out (TR-00331: WO cancelled → work_order_failed, still re-queried every tick). */
export const STALE_ELIGIBLE_STATUSES: readonly string[] = [...UNRESOLVED_HANDOFF_STATUSES, 'work_order_failed', 'voided_by_user'];

export function isStaleUnresolved(row: { synced_at: string | null; last_fba_handoff_status: string | null }, now = Date.now()): boolean {
  if (!row.synced_at) return false;
  if (!STALE_ELIGIBLE_STATUSES.includes(String(row.last_fba_handoff_status))) return false;
  return now - new Date(row.synced_at).getTime() > STALE_UNRESOLVED_DAYS * 24 * 3600 * 1000;
}

async function retireStaleRows(db: SupabaseClient, rows: BridgeRow[]): Promise<BridgeRow[]> {
  const keep: BridgeRow[] = [];
  const retired: string[] = [];
  for (const r of rows as any[]) {
    if (!isStaleUnresolved(r)) { keep.push(r); continue; }
    const ageDays = Math.round((Date.now() - new Date(r.synced_at).getTime()) / 86400000);
    const { error } = await db
      .from('cin7_transfer_shiphero_orders')
      .update({
        last_fba_handoff_status: 'stale_retired',
        last_fba_handoff_detail: `retired by reconciler ${new Date().toISOString().slice(0, 10)}: unresolved (${r.last_fba_handoff_status}) ${ageDays} days after sync — not worked, no work orders raised. Set last_fba_handoff_status='pending' to revive.`,
      })
      .eq('id', r.id)
      .eq('last_fba_handoff_status', r.last_fba_handoff_status);
    if (error) { console.warn(`[reconciler] could not retire stale ${r.cin7_transfer_number}: ${error.message}`); keep.push(r); continue; }
    retired.push(`${r.cin7_transfer_number} (${ageDays}d, ${r.last_fba_handoff_status})`);
  }
  if (retired.length) {
    console.log(`[reconciler] retired ${retired.length} stale unresolved bridge(s): ${retired.join(', ')}`);
    await sendFbaTelegram(
      `🗄 <b>Reconciler retired ${retired.length} stale transfer${retired.length === 1 ? '' : 's'}</b>\n` +
      `Unresolved for over ${STALE_UNRESOLVED_DAYS} days — treated as shipped by other means. No work orders raised; nothing to do.\n` +
      retired.slice(0, 20).map((x) => `• ${x}`).join('\n') + (retired.length > 20 ? `\n… +${retired.length - 20} more` : '')
    );
  }
  return keep;
}

const SELECT_COLS =
  'id, cin7_transfer_number, cin7_transfer_id, cin7_destination, synced_at, last_fba_handoff_at, last_fba_handoff_detail, fba_handoff_attempts, request_payload, shiphero_order_number, last_fba_handoff_status';

/**
 * Candidates = recent FBA bridges (lookback window) UNION every FBA bridge
 * that is still unresolved, however old.
 *
 * 2026-10-06 (Weston: "Wendy's work orders are complete. Why are shipments
 * not firing?"): TR-00490/00491 synced 2026-09-27, kit work orders took nine
 * days, and the rows had aged past LOOKBACK_HOURS — the reconciler never saw
 * the release. Six rows were invisible this way (00481/00484/00489-00492). A
 * parked or failed row stays a candidate until it is resolved or cancelled.
 */
async function findCandidates(db: SupabaseClient): Promise<BridgeRow[]> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  const recent = await db
    .from('cin7_transfer_shiphero_orders')
    .select(SELECT_COLS)
    .eq('status', 'synced')
    .gte('synced_at', since)
    .order('synced_at', { ascending: false })
    .limit(50);
  if (recent.error) throw new Error(`bridge query failed: ${recent.error.message}`);

  const unresolved = await db
    .from('cin7_transfer_shiphero_orders')
    .select(SELECT_COLS)
    .eq('status', 'synced')
    .lt('synced_at', since)
    // STALE_ELIGIBLE (not just UNRESOLVED) so retireStaleRows actually sees
    // work_order_failed / voided_by_user rows; they are retired, never fired
    // (the fire path below still requires an UNRESOLVED status).
    .in('last_fba_handoff_status', [...STALE_ELIGIBLE_STATUSES])
    .order('synced_at', { ascending: false })
    .limit(50);
  if (unresolved.error) throw new Error(`bridge query (unresolved) failed: ${unresolved.error.message}`);

  const seen = new Set<string>();
  const all = [...(recent.data || []), ...(unresolved.data || [])].filter((r: any) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  if ((unresolved.data || []).length > 0) {
    console.log(`[reconciler] +${unresolved.data!.length} unresolved FBA bridge(s) older than ${LOOKBACK_HOURS}h kept in view: ${unresolved.data!.map((r: any) => r.cin7_transfer_number).join(', ')}`);
  }

  // Filter to FBA-bound transfers only (cin7_destination contains amazon/fba),
  // then retire anything unresolved for > STALE_UNRESOLVED_DAYS before it can
  // be preflighted or fired.
  return retireStaleRows(db, all.filter((row: any) => isFbaDestination(row.cin7_destination)));
}

/**
 * Detect failures that are CONFIGURATION errors, not transient outages.
 *
 * ⚠️ 2026-09-21: a 401 on the self-POST means the handoff is hitting a
 * Deployment-Protection-walled URL or the secret doesn't match. No amount of
 * retrying fixes that, yet the uncapped loop hammered it forever — TR-00408
 * reached 77 attempts, TR-00352 70, two rows hit 99 — burning quota and
 * drowning real signals. 28 of 47 failed handoffs were this one error.
 *
 * These need a HUMAN, so cap them and escalate loudly instead of retrying.
 */
export function isPermanentConfigError(detail: string | null | undefined): boolean {
  const d = String(detail || '');
  return (
    d.includes('HTTP 401') ||
    d.includes('"Unauthorized"') ||
    d.includes('CRON_SECRET not set') ||
    d.includes('HTTP 403') ||
    // 2026-10-01: data errors a retry can never fix. TR-00497..00501 were
    // re-fired 6× each over 24h with "No Amazon SKU mapping"; nobody was told.
    d.includes('No Amazon SKU mapping') ||
    d.includes('not available for inbound')
  );
}

/** Human-readable hint for the capped-error alert, by error class. */
export function configErrorHint(detail: string | null | undefined): string {
  const d = String(detail || '');
  if (d.includes('No Amazon SKU mapping')) {
    return 'The CIN7 SKU has no row in sku_master (amazon_seller_sku). Find the MSKU in the Seller Central listings report, add the mapping, then set the bridge row handoff status back to allow a re-fire.';
  }
  if (d.includes('not available for inbound')) {
    return 'Amazon has the MSKU but the FBA offer is not registered for inbound (no FNSKU / barcode type unset). Fix in Seller Central: Edit listing → Offer → fulfilled by Amazon → barcode type. Re-fires resume automatically once Amazon accepts.';
  }
  return 'A 401/403 means the self-POST is hitting a Deployment-Protection-walled URL or CRON_SECRET does not match. Retrying cannot fix it. Check FBA_SELF_BASE_URL / CRON_SECRET in the Vercel project env.';
}

/** Attempts allowed for a config error before we stop and escalate. */
const CONFIG_ERROR_MAX_ATTEMPTS = 3;

/**
 * Third error class: RATE LIMIT / QUOTA (added 2026-09-22).
 *
 * ShipHero's GraphQL credit pool is shared with the live pipeline. A lot
 * breakdown costs ~1006 credits against a 4004 ceiling, so roughly every
 * fourth transfer in a burst fails with `code 30 … not enough credits`. The
 * pool refills in minutes.
 *
 * Before this class existed these fell into the generic transient branch and
 * waited the full RETRY_GAP_EARLY_MS (1 hour) — and because the backoff
 * outlived the condition by ~55 minutes, a human had to null
 * last_fba_handoff_at to release each one. On 2026-09-22 that happened SIX
 * times in one night (TR-00460, 00464, 00465, 00472, 00477, 00462), every one
 * self-resolving within minutes of the retry.
 *
 * These are safe to retry fast: the credit error happens BEFORE any Amazon
 * plan is created (it kills the ShipHero lot breakdown), so there is nothing
 * to duplicate — and the last-moment duplicate gate re-checks Amazon anyway.
 */
function isRateLimitError(detail: string | null | undefined): boolean {
  const d = String(detail || '');
  return (
    d.includes('not enough credits') ||
    d.includes('"code":30') ||
    d.includes('rate limit') ||
    d.includes('HTTP 429')
  );
}

/** Backoff for rate-limit/quota errors — the pool refills in minutes. */
const RATE_LIMIT_GAP_MS = 5 * 60 * 1000;

/**
 * The backoff window for a row, by error class. Single source of truth so the
 * retry DECISION and the skipped[] ledger can never report different numbers.
 */
function retryGapFor(row: BridgeRow): number {
  if (isRateLimitError(row.last_fba_handoff_detail)) return RATE_LIMIT_GAP_MS;
  return row.fba_handoff_attempts >= 3 ? RETRY_GAP_LATE_MS : RETRY_GAP_EARLY_MS;
}

function shouldRetryNow(row: BridgeRow): {retry: boolean; reason?: string} {
  // Config errors (401/403) are NOT transient — cap them so a permanent
  // misconfiguration escalates to a human instead of looping forever.
  if (
    isPermanentConfigError(row.last_fba_handoff_detail) &&
    row.fba_handoff_attempts >= CONFIG_ERROR_MAX_ATTEMPTS
  ) {
    return { retry: false, reason: 'config_error' };
  }

  // Otherwise: no hard cap — re-fires are dedup-idempotent, so we keep trying
  // with backoff until the fba_shipments row exists. A cap only converts a long
  // outage into a permanent silent failure (see 2026-08-04..07 incident).
  if (row.last_fba_handoff_at) {
    const gap = retryGapFor(row);
    const last = new Date(row.last_fba_handoff_at).getTime();
    if (Date.now() - last < gap) {
      return { retry: false, reason: 'throttled' };
    }
  }
  return { retry: true };
}

/**
 * Duplicate-safety check for re-fires (TR-00464, 2026-09-22).
 *
 * We treat a `cancelled` fba_shipments row as "the previous attempt left
 * nothing on Amazon". That is a SNAPSHOT and it can go stale: on TR-00464 the
 * plan reported 0 shipments when inspected, then completed generateShipments
 * moments later. The re-fire produced a second plan and Amazon held 2 x 1750
 * units, one with a live IN_TRANSIT shipment.
 *
 * So before firing, re-read every plan referenced by this transfer's cancelled
 * rows. If any now has live (non-CANCELLED) shipments, the earlier run actually
 * succeeded and re-firing would duplicate real inbound inventory.
 *
 * Returns the offending plan, or null when it is genuinely safe to fire.
 * Throws on verification failure so the caller can fail CLOSED.
 */
async function findLivePlanOnCancelledRows(
  db: SupabaseClient,
  transferNumber: string
): Promise<{ planId: string; liveShipments: number } | null> {
  const candidates = Array.from(
    new Set([
      transferNumber,
      transferNumber.startsWith('CIN7-') ? transferNumber.slice(5) : `CIN7-${transferNumber}`,
    ])
  );

  const { data, error } = await db
    .from('fba_shipments')
    .select('plan_id, status')
    .in('cin7_transfer_number', candidates)
    .not('plan_id', 'is', null);

  if (error) throw new Error(`duplicate-gate query failed: ${error.message}`);

  const planIds = Array.from(
    new Set((data || []).map((r: any) => r.plan_id as string).filter(Boolean))
  );
  if (planIds.length === 0) return null;

  for (const planId of planIds) {
    const resp = await callAmazonSpApi<any>({
      method: 'GET',
      path: `${FBA_INBOUND_BASE}/inboundPlans/${planId}`,
    });
    const plan = resp?.data;
    // A voided/cancelled PLAN commits nothing.
    const planStatus = String(plan?.status || '').toUpperCase();
    if (planStatus === 'VOIDED' || planStatus === 'CANCELLED') continue;

    const live = (plan?.shipments || []).filter(
      (s: any) => String(s?.status || '').toUpperCase() !== 'CANCELLED'
    );
    if (live.length > 0) return { planId, liveShipments: live.length };
  }
  return null;
}

/** All reconciler alerts go through the ONE channel sender (hardcoded chat id).
 *  The old inline fetch read TELEGRAM_FBA_CHAT_ID from env — stale on Vercel —
 *  so config-error escalations were silently lost. */
async function sendTelegramAlert(message: string): Promise<void> {
  try {
    const ok = await sendTelegramMarkdown(message);
    if (!ok) console.warn('[reconciler] Telegram alert was not delivered');
  } catch (err: any) {
    console.warn('[reconciler] Telegram alert failed:', err?.message || err);
  }
}

/**
 * Partial-transfer top-up decision (2026-10-26, TR-00678). Called only for a
 * transfer that already has ≥1 active fba_shipments row. Every gate a
 * first-time fire has applies here too, and all of them fail CLOSED:
 *   - the work-order gate already ran above (no top-up before kits exist);
 *   - lots + quantities come from the LIVE CIN7 transfer at this moment;
 *   - live CIN7 status must be fireable;
 *   - CIN7 totals must equal the bridge row's (a transfer edited after sync is
 *     a human decision, never auto-topped);
 *   - labelled must be < ordered, and the un-labelled WRITTEN lots must equal
 *     the shortfall exactly (planTopUp) — so a top-up can never over-label;
 *   - the stale-cancelled-plan duplicate gate must pass.
 */
export async function planPartialTopUp(
  db: SupabaseClient,
  row: BridgeRow & { cin7_transfer_id?: string | null },
  deps: { readCin7Transfer?: (row: any) => Promise<{ status: string | null; lines: Array<{ sku: string; quantity: number; lot?: string | null }> } | null> } = {}
): Promise<ReturnType<typeof planTopUp>> {
  const lines: Array<{ sku: string; quantity: number }> = row.request_payload?.partnerLineItems ?? [];
  const ordered: Record<string, number> = {};
  for (const l of lines) ordered[l.sku] = (ordered[l.sku] ?? 0) + (Number(l.quantity) || 0);
  if (!Object.keys(ordered).length) return { kind: 'skip', detail: 'bridge row has no partnerLineItems' };

  let active: ActiveRow[];
  try {
    active = await activeRowsFor(db, row.cin7_transfer_number);
  } catch (e: any) {
    return { kind: 'skip', detail: `fail-closed: ${e?.message || e}` };
  }
  // Cheap pre-check on cached data — whole/over/in-flight need no CIN7 call.
  const pre = planTopUp(ordered, [], active);
  if (pre.kind === 'whole' || pre.kind === 'over' || pre.kind === 'in_flight') return pre;

  const live = await (deps.readCin7Transfer ?? readLiveCin7Transfer)(row);
  if (!live) return { kind: 'skip', detail: 'fail-closed: live CIN7 transfer unreadable' };
  if (!isCin7StatusFireable(live.status)) {
    return { kind: 'skip', detail: `CIN7 says ${live.status ?? 'UNREADABLE'} — not topping up` };
  }
  const liveOrdered: Record<string, number> = {};
  for (const l of live.lines) liveOrdered[l.sku] = (liveOrdered[l.sku] ?? 0) + (Number(l.quantity) || 0);
  const same =
    Object.keys(liveOrdered).length === Object.keys(ordered).length &&
    Object.entries(ordered).every(([k, v]) => liveOrdered[k] === v);
  if (!same) {
    return {
      kind: 'mismatch',
      detail: `CIN7 transfer now ${JSON.stringify(liveOrdered)} but it was synced as ${JSON.stringify(ordered)} — edited after sync; a human decides`,
    };
  }
  const verdict = planTopUp(ordered, toLotItems(live.lines), active);
  if (verdict.kind !== 'top_up') return verdict;

  try {
    const stale = await findLivePlanForMissingLots(db, row.cin7_transfer_number, verdict.items);
    if (stale) {
      return { kind: 'mismatch', detail: `cancelled row for lot ${stale.lot} points at plan ${stale.planId} with ${stale.liveShipments} live shipment(s) — bind, do not top up` };
    }
  } catch (e: any) {
    return { kind: 'skip', detail: `duplicate gate unavailable — fail-closed: ${e?.message || e}` };
  }
  return verdict;
}

/**
 * Top-up duplicate gate. findLivePlanOnCancelledRows looks at EVERY plan on the
 * transfer, which on a partial transfer always includes the lot that is already
 * labelled — so it would block every top-up. Here: only cancelled/failed/voided
 * rows FOR THE LOTS ABOUT TO BE TOPPED UP. If any of those plans is in fact
 * live on Amazon, a previous attempt for that lot succeeded → never re-create.
 * Throws on verification failure (caller fails CLOSED).
 */
async function findLivePlanForMissingLots(
  db: SupabaseClient,
  transferNumber: string,
  items: Array<{ sku: string; lot?: string }>
): Promise<{ lot: string; planId: string; liveShipments: number } | null> {
  const tr = extractTransferNumber(transferNumber) || transferNumber;
  const lots = items.map((i) => i.lot).filter(Boolean) as string[];
  if (!lots.length) return null;
  const { data, error } = await db
    .from('fba_shipments')
    .select('cin7_transfer_number, cin7_sku, cin7_lot, plan_id, status')
    .like('cin7_transfer_number', `%${tr}%`)
    .in('cin7_lot', lots)
    .in('status', ['cancelled', 'failed', 'voided'])
    .not('plan_id', 'is', null);
  if (error) throw new Error(`top-up duplicate-gate query failed: ${error.message}`);
  for (const r of (data || []) as any[]) {
    if (extractTransferNumber(r.cin7_transfer_number) !== tr) continue;
    if (!items.some((i) => i.sku === r.cin7_sku && i.lot === r.cin7_lot)) continue;
    const resp = await callAmazonSpApi<any>({ method: 'GET', path: `${FBA_INBOUND_BASE}/inboundPlans/${r.plan_id}` });
    const plan = resp?.data;
    const planStatus = String(plan?.status || '').toUpperCase();
    if (planStatus === 'VOIDED' || planStatus === 'CANCELLED') continue;
    const live = (plan?.shipments || []).filter((s: any) => String(s?.status || '').toUpperCase() !== 'CANCELLED');
    if (live.length > 0) return { lot: r.cin7_lot, planId: r.plan_id, liveShipments: live.length };
  }
  return null;
}

/** Alert the FBA channel ONCE per (transfer, verdict) for a partial transfer a
 *  human must resolve. Recorded on request_payload.partial_alert (no DDL). */
async function alertPartialOnce(db: SupabaseClient, row: BridgeRow, kind: string, detail: string): Promise<void> {
  // Only transfers synced inside the lookback window alert — August history
  // that is already over/short is in the skipped[] ledger, not the channel.
  if (!row.synced_at || Date.now() - new Date(row.synced_at).getTime() > LOOKBACK_HOURS * 3600e3) return;
  const key = `${kind}:${detail}`.slice(0, 300);
  if (row.request_payload?.partial_alert === key) return;
  await sendTelegramAlert(
    `⚠️ *FBA: ${row.cin7_transfer_number} is not fully labelled and will NOT be auto-topped*\n\n${detail}\n\n` +
      `Labels already made are correct. Nothing new was created on Amazon.`
  );
  try {
    await db
      .from('cin7_transfer_shiphero_orders')
      .update({ request_payload: { ...(row.request_payload ?? {}), partial_alert: key } })
      .eq('id', row.id);
  } catch { /* best-effort */ }
}

/**
 * The reconciler's branch for a transfer that already has ≥1 active
 * fba_shipments row. Returns:
 *   'whole'   → caller ledgers 'already_has_active_shipment_row' (unchanged)
 *   'fired'   → only the missing written lot(s) were sent to auto-submit
 *   'skipped' → a named partial_* disposition was pushed to result.skipped
 */
async function handlePartialTransfer(
  db: SupabaseClient,
  row: BridgeRow,
  deps: { readCin7Transfer?: (row: any) => Promise<any> },
  result: ReconcileResult,
  options: { dryRun?: boolean }
): Promise<'whole' | 'fired' | 'skipped'> {
  const topUp = await planPartialTopUp(db, row, deps);
  if (topUp.kind === 'whole') return 'whole';
  if (topUp.kind !== 'top_up') {
    result.skipped.push({ transfer: row.cin7_transfer_number, reason: `partial_${topUp.kind}`, detail: topUp.detail });
    if (!options.dryRun && (topUp.kind === 'over' || topUp.kind === 'mismatch' || topUp.kind === 'unknown_lots')) {
      await alertPartialOnce(db, row, topUp.kind, topUp.detail);
    }
    return 'skipped';
  }
  // Same backoff as first-time fires.
  if (!shouldRetryNow(row).retry) {
    result.throttled++;
    result.skipped.push({ transfer: row.cin7_transfer_number, reason: 'partial_top_up_throttled', detail: topUp.detail });
    return 'skipped';
  }
  console.log(`[reconciler] TOP-UP ${row.cin7_transfer_number}: ${topUp.detail}`);
  if (!options.dryRun) {
    if (result.reFired > 0) await new Promise((r) => setTimeout(r, RE_FIRE_STAGGER_MS));
    try {
      await fireFbaAutoSubmit({ cin7TransferNumber: row.cin7_transfer_number, items: topUp.items });
    } catch (err: any) {
      console.warn(`[reconciler] top-up handoff threw for ${row.cin7_transfer_number}: ${err?.message || err}`);
    }
    await db
      .from('cin7_transfer_shiphero_orders')
      .update({ last_fba_handoff_at: new Date().toISOString(), fba_handoff_attempts: row.fba_handoff_attempts + 1 })
      .eq('id', row.id);
  }
  result.reFired++;
  return 'fired';
}

/** Same rule as lookupSkuMapping (fba-orchestrator) but on the reconciler's own
 *  client — that module instantiates Supabase at import time and cannot be
 *  loaded offline. Prefer a non-FBM amazon_seller_sku; FNSKU from amazon_products. */
async function resolveMappingWith(db: SupabaseClient, cin7Sku: string): Promise<{ amz_sku: string | null; amz_fnsku?: string | null; amz_asin?: string | null } | null> {
  const { data: rows, error } = await db.from('sku_master').select('amazon_seller_sku, amazon_asin').eq('cin7_sku', cin7Sku);
  if (error) throw new Error(`sku_master read failed: ${error.message}`);
  const preferred = (rows || []).find((r: any) => r.amazon_seller_sku && !String(r.amazon_seller_sku).toUpperCase().includes('-FBM-'))
    || (rows || []).find((r: any) => r.amazon_seller_sku);
  if (!preferred?.amazon_seller_sku) return null;
  const { data: amz } = await db.from('amazon_products').select('fnsku, asin').eq('seller_sku', preferred.amazon_seller_sku).eq('marketplace_id', 'ATVPDKIKX0DER').limit(1);
  return { amz_sku: preferred.amazon_seller_sku, amz_fnsku: amz?.[0]?.fnsku || null, amz_asin: amz?.[0]?.asin || (preferred as any).amazon_asin || null };
}

/** Live preflight for a bridge row: same gate the sync uses. Fail CLOSED on
 *  error (return a synthetic 'floor' hold with no WO so the row is skipped and
 *  the error is in the ledger, rather than firing blind). */
export async function livePreflight(db: SupabaseClient, row: any): Promise<PreflightGateResult | null> {
  const lines: Array<{ sku: string; quantity: number }> = Array.isArray(row.request_payload?.partnerLineItems)
    ? row.request_payload.partnerLineItems.map((l: any) => ({ sku: String(l.sku), quantity: Number(l.quantity) || 0 }))
    : [];
  if (lines.length === 0) return null; // nothing to check; legacy row
  try {
    const token = await getShipHeroToken(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, process.env.SHIPHERO_WAREHOUSE_ID || '22e17170-af72-4bf8-b77c-d73c86b06765');
    return await applyPreflightGate(
      {
        supabase: db,
        shipheroToken: token,
        gatherFacts: (sku, qty) => gatherPreflightFacts(
          { shipheroToken: token, resolveAmazonSku: (s) => resolveMappingWith(db, s), hasPriorShipmentRow: (s) => hasPriorFbaShipmentRow(db, s, row.cin7_transfer_number), autoResolve: (s, bc) => autoResolveAmazonSku({ cin7Sku: s, shipheroBarcode: bc, db }) },
          sku, qty
        ),
        // FBA channel, HTML — the same proven sender post-process uses. NOT
        // sendTelegramAlert: that reads TELEGRAM_FBA_CHAT_ID from env (stale on
        // Vercel) and sends Markdown, so the HTML hold notices for TR-00484 /
        // TR-00508 on 2026-10-03 were silently dropped. Nobody was told.
        sendTelegram: (html) => sendFbaTelegram(html),
      },
      {
        id: row.cin7_transfer_id, transferNumber: row.cin7_transfer_number, destinationName: row.cin7_destination,
        lines, shipheroOrderNumber: row.shiphero_order_number ?? null,
        existingHold: row.request_payload?.preflight_hold ?? null,
        existingWorkOrder: readWorkOrderState(row.request_payload),
      }
    );
  } catch (e: any) {
    console.error(`[reconciler] preflight threw for ${row.cin7_transfer_number} — NOT firing: ${e?.message || e}`);
    return { gated: true, hold: 'floor', result: { ok: false, blockers: [], floor: [], marketing: [] } } as PreflightGateResult;
  }
}

export async function reconcileFbaHandoffs(
  options: {
    supabase?: SupabaseClient;
    dryRun?: boolean;
    readCin7Status?: (row: any) => Promise<string | null>;
    /** Live CIN7 status + lot lines for the partial top-up path (tests inject). */
    readCin7Transfer?: (row: any) => Promise<{ status: string | null; lines: Array<{ sku: string; quantity: number; lot?: string | null }> } | null>;
    /** Re-run preflight for a row at the fire decision. Default = live gate;
     *  pass `null` to disable (tests of unrelated paths). */
    preflight?: ((row: any) => Promise<PreflightGateResult | null>) | null;
  } = {}
): Promise<ReconcileResult> {
  const startedAt = Date.now();
  const db = getSupabase(options.supabase);
  const deps = {
    readCin7Status: options.readCin7Status,
    readCin7Transfer: options.readCin7Transfer,
    preflight: options.preflight === null ? undefined : (options.preflight ?? ((row: any) => livePreflight(db, row))),
  };
  const result: ReconcileResult = {
    scanned: 0,
    reFired: 0,
    throttled: 0,
    exhausted: [],
    errors: [],
    duration_ms: 0,
    skipped: [],
  };

  let candidates: BridgeRow[];
  try {
    candidates = await findCandidates(db);
  } catch (err: any) {
    result.errors.push(err?.message || String(err));
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  console.log(`[reconciler] ${candidates.length} FBA-bound bridges synced in last ${LOOKBACK_HOURS}h`);
  result.scanned = candidates.length;

  let processed = 0;
  for (const row of candidates) {
    if (processed >= BATCH_SIZE) break;

    try {
      // ── KIT WORK-ORDER GATE (2026-09-26) — checked FIRST, before any retry
      // logic. A multi-pack transfer parks here (status stays 'synced', the
      // status column is CHECK-constrained) until the warehouse marks its
      // ShipHero work order COMPLETED and api/cron/poll-work-orders flips
      // request_payload.work_order.status. Firing before that would create an
      // Amazon plan against kits that do not physically exist yet — a plan we
      // cannot cancel with the warehouse. Costs zero I/O: it reads the row.
      const wo = readWorkOrderState(row.request_payload);
      if (wo && wo.status !== 'COMPLETED') {
        const ageH = Math.round((Date.now() - new Date(wo.created_at).getTime()) / 36e5);
        result.skipped.push({
          transfer: row.cin7_transfer_number,
          reason: wo.status === 'CANCELED' || wo.status === 'CLOSED' ? 'work_order_failed' : 'awaiting_work_order',
          detail: `work order ${wo.ids.join(',')} is ${wo.status} (${ageH}h old) — ${wo.kit_qty} × ${wo.kit_sku}; fires automatically once COMPLETED`,
        });
        continue;
      }

      // Has an active fba_shipments row? Before 2026-10-26 that alone meant
      // "pipeline already ran, skip" — so a transfer with ONE lot labelled and
      // another lost (TR-00678: 7,380 of 10,080; the chained run for lot
      // CN92572601 never happened) was skipped forever. Now a whole transfer
      // is skipped as before; a PARTIAL one is handed to handlePartialTransfer
      // (lib/transfer-lots.ts rules: only the written lots with no row, never
      // more than the CIN7 transfer, every gate fail-closed).
      const exists = await fbaRecordExists(db, row.cin7_transfer_number);
      if (exists) {
        const partial = await handlePartialTransfer(db, row, deps, result, options);
        if (partial === 'whole') {
          result.skipped.push({
            transfer: row.cin7_transfer_number,
            reason: 'already_has_active_shipment_row',
          });
        } else if (partial === 'fired') {
          processed++; // ledgered as reFired (non-whole skips are pushed by the helper)
        }
        continue;
      }

      // ── CIN7 STATUS GATE — re-read the source of truth AT the fire decision.
      // Cached `synced` rows lie: a transfer can be pulled back to DRAFT or
      // VOIDED after we synced it. Fail CLOSED on an unreadable status.
      const liveCin7 = await (deps?.readCin7Status ?? readLiveCin7Status)(row);
      if (!isCin7StatusFireable(liveCin7)) {
        result.skipped.push({
          transfer: row.cin7_transfer_number,
          reason: 'cin7_status_not_fireable',
          detail: `CIN7 says ${liveCin7 ?? 'UNREADABLE'} — only ${[...CIN7_FIREABLE_STATUSES].join('/')} may fire. Not touching Amazon.`,
        });
        continue;
      }

      // ── PREFLIGHT AT THE FIRE DECISION (2026-10-01). The sync ran it once;
      //    re-run here because (a) a "DATA FIX" work order was just marked
      //    COMPLETED and the floor may not have actually fixed the data, and
      //    (b) a marketing hold clears only when Amazon says ready. A failed
      //    preflight re-parks via the same gate (new WO naming what is still
      //    missing, or hold refreshed) — it never fires into a known failure.
      //    Injected for tests; undefined dep = skip (legacy behaviour).
      if (deps?.preflight) {
        const pf = await deps.preflight(row);
        if (pf && pf.gated) {
          result.skipped.push({
            transfer: row.cin7_transfer_number,
            reason: pf.hold === 'floor' ? 'awaiting_work_order' : 'awaiting_listing',
            detail: `preflight: ${pf.result.blockers.map((b) => b.code).join('+')}` + (pf.workOrder ? ` — work order ${pf.workOrder.ids.join(',')}` : ' — marketing notified, no floor action'),
          });
          continue;
        }
        if (pf && !pf.gated && row.request_payload?.preflight_hold) {
          // Hold cleared on its own (Amazon now accepts the MSKU).
          await clearMarketingHold(db, row.id, row.request_payload);
        }
      }

      const decision = shouldRetryNow(row);
      if (!decision.retry) {
        if (decision.reason === 'config_error') {
          // Permanent misconfiguration — stop retrying and make it VISIBLE.
          // Silently giving up is how 28 of these went unnoticed for weeks.
          result.exhausted.push(row.cin7_transfer_number);
          const msg =
            `🔴 FBA handoff BLOCKED by a configuration error — needs a human\n\n` +
            `Transfer: ${row.cin7_transfer_number}\n` +
            `Attempts: ${row.fba_handoff_attempts} (capped at ${CONFIG_ERROR_MAX_ATTEMPTS})\n` +
            `Error: ${String(row.last_fba_handoff_detail || '').slice(0, 200)}\n\n` +
            configErrorHint(row.last_fba_handoff_detail);
          console.error(`[reconciler] ${msg.replace(/\n/g, ' ')}`);
          await sendTelegramAlert(msg);
          // Also record it in the unified ledger so `scanned` reconciles
          // exactly: scanned == reFired + skipped.length. Before this, the two
          // config-error rows appeared ONLY in `exhausted` and silently broke
          // the accounting (29 scanned = 0 fired + 27 skipped, 2 missing).
          result.skipped.push({
            transfer: row.cin7_transfer_number,
            reason: 'config_error_capped',
            detail: `${row.fba_handoff_attempts} attempts (cap ${CONFIG_ERROR_MAX_ATTEMPTS}) — needs a human: ${String(row.last_fba_handoff_detail || '').slice(0, 80)}`,
          });
        } else {
          result.throttled++;
          const gap = retryGapFor(row);
          const waitedMs = row.last_fba_handoff_at
            ? Date.now() - new Date(row.last_fba_handoff_at).getTime()
            : 0;
          const remainingMin = Math.max(0, Math.ceil((gap - waitedMs) / 60000));
          const cls = isRateLimitError(row.last_fba_handoff_detail)
            ? 'rate_limit'
            : 'transient';
          result.skipped.push({
            transfer: row.cin7_transfer_number,
            reason: 'backoff_throttled',
            detail: `${remainingMin}min remaining (class ${cls}, attempt ${row.fba_handoff_attempts}, gap ${Math.round(gap / 60000)}min, last_fba_handoff_at=${row.last_fba_handoff_at ?? 'null'})`,
          });
        }
        continue;
      }

      processed++;

      // ⚠️ LAST-MOMENT DUPLICATE GATE (added 2026-09-22 after TR-00464).
      //
      // A cancelled `fba_shipments` row is our signal that the previous attempt
      // left nothing on Amazon — but that snapshot can be STALE. On TR-00464
      // the 06:00 plan had 0 shipments when it was inspected, then finished
      // generateShipments moments later; the re-fire built a SECOND plan and
      // Amazon ended up holding 2 x 1750 units with a live IN_TRANSIT shipment
      // on the first. Cancelling a draft is therefore not proof of absence.
      //
      // Re-read the Amazon plan RIGHT BEFORE firing. If any cancelled row for
      // this transfer points at a plan that now has live (non-CANCELLED)
      // shipments, the previous run actually succeeded: rebind instead of
      // re-firing, and escalate so a human confirms.
      try {
        const stale = await findLivePlanOnCancelledRows(db, row.cin7_transfer_number);
        if (stale) {
          const msg =
            `🔴 FBA re-fire ABORTED — the previous attempt actually succeeded\n\n` +
            `Transfer: ${row.cin7_transfer_number}\n` +
            `Plan: ${stale.planId} now has ${stale.liveShipments} live shipment(s)\n\n` +
            `A cancelled fba_shipments row said "nothing on Amazon", but the plan ` +
            `completed after that check. Re-firing would create DUPLICATE inbound ` +
            `shipments. Bind this plan's ids to the row instead.`;
          console.error(`[reconciler] ${msg.replace(/\n/g, ' ')}`);
          await sendTelegramAlert(msg);
          result.errors.push(
            `${row.cin7_transfer_number}: re-fire aborted — plan ${stale.planId} has ${stale.liveShipments} live shipments`
          );
          result.skipped.push({
            transfer: row.cin7_transfer_number,
            reason: 'duplicate_gate_aborted',
            detail: `plan ${stale.planId} has ${stale.liveShipments} live shipment(s) — bind, do not re-fire`,
          });
          continue;
        }
      } catch (err: any) {
        // Fail CLOSED: if we cannot verify, do NOT fire. A missed re-fire is
        // recoverable next tick; a duplicate inbound shipment is not.
        console.error(
          `[reconciler] duplicate gate failed for ${row.cin7_transfer_number} (${err?.message || err}) — skipping this tick`
        );
        result.errors.push(
          `${row.cin7_transfer_number}: duplicate gate unavailable — skipped (fail-closed)`
        );
        result.skipped.push({
          transfer: row.cin7_transfer_number,
          reason: 'duplicate_gate_unavailable',
          detail: `fail-closed: ${err?.message || String(err)}`,
        });
        continue;
      }

      // Extract items from the bridge's request_payload (partnerLineItems)
      const items = row.request_payload?.partnerLineItems;
      if (!Array.isArray(items) || items.length === 0) {
        result.errors.push(
          `${row.cin7_transfer_number}: no partnerLineItems in request_payload`
        );
        continue;
      }

      // Lots as written (bridge rows synced after 2026-10-26 carry them; older
      // rows have none and fall back to FEFO exactly as before).
      const fbaItems = toLotItems(items.map((it: any) => ({ sku: it.sku, quantity: it.quantity, lot: it.lot ?? null })));

      console.log(
        `[reconciler] Re-firing FBA handoff for ${row.cin7_transfer_number} ` +
          `(attempt ${row.fba_handoff_attempts + 1}, ${fbaItems.length} items)`
      );

      if (!options.dryRun) {
        // ⚠️ 2026-09-21: this was `void fireFbaAutoSubmit(...)` — up to
        // BATCH_SIZE (10) concurrent Amazon inbound workflows per tick, which
        // is the same stampede that stranded 11 transfers from the sync side.
        // Await it and space the next one so the SP-API quota survives.
        if (result.reFired > 0) {
          await new Promise((r) => setTimeout(r, RE_FIRE_STAGGER_MS));
        }
        try {
          await fireFbaAutoSubmit({
            cin7TransferNumber: row.cin7_transfer_number,
            items: fbaItems,
          });
        } catch (err: any) {
          console.warn(
            `[reconciler] handoff threw for ${row.cin7_transfer_number}: ${err?.message || err}`
          );
        }

        // Increment attempt counter immediately (the handoff is async, but we
        // need the throttle to take effect right now).
        const { error: updErr } = await db
          .from('cin7_transfer_shiphero_orders')
          .update({
            last_fba_handoff_at: new Date().toISOString(),
            fba_handoff_attempts: row.fba_handoff_attempts + 1,
          })
          .eq('id', row.id);
        if (updErr) {
          result.errors.push(
            `${row.cin7_transfer_number}: failed to update bridge: ${updErr.message}`
          );
        }
      }

      result.reFired++;

      // Alert at attempt 3, then every 6th attempt after — retries never stop
      // (dedup-idempotent), but a persistent failure must stay visible.
      const attemptNum = row.fba_handoff_attempts + 1;
      const shouldAlert =
        attemptNum === ALERT_AT_ATTEMPT ||
        (attemptNum > ALERT_AT_ATTEMPT &&
          (attemptNum - ALERT_AT_ATTEMPT) % ALERT_EVERY_AFTER === 0);
      if (shouldAlert) {
        await sendTelegramAlert(
          `⚠️ *FBA reconciler: ${row.cin7_transfer_number} still failing*\n\n` +
            `Bridge synced ${row.synced_at}, ShipHero order ${row.shiphero_order_number}. ` +
            `Retry attempt ${attemptNum} firing now (retries continue every 4h). ` +
            `Check last_fba_handoff_detail on the bridge row for the failure reason.`
        );
      }
    } catch (err: any) {
      result.errors.push(`${row.cin7_transfer_number}: ${err?.message || String(err)}`);
    }
  }

  result.duration_ms = Date.now() - startedAt;
  console.log(`[reconciler] done:`, result);
  return result;
}
