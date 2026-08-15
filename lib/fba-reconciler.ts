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

const ALERT_AT_ATTEMPT = 3; // first Telegram alert
const ALERT_EVERY_AFTER = 6; // then every Nth attempt
const RETRY_GAP_EARLY_MS = 60 * 60 * 1000; // 1 hour (attempts 1-3)
const RETRY_GAP_LATE_MS = 4 * 60 * 60 * 1000; // 4 hours (attempts 4+)
const LOOKBACK_HOURS = 24 * 7;
const BATCH_SIZE = 10;

interface ReconcileResult {
  scanned: number;
  reFired: number;
  throttled: number;
  exhausted: string[]; // kept for response-shape compat; no longer used to stop retries
  errors: string[];
  duration_ms: number;
}

interface BridgeRow {
  id: string;
  cin7_transfer_number: string;
  cin7_destination: string;
  synced_at: string;
  last_fba_handoff_at: string | null;
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
// (e.g. 300s maxDuration hit mid-Amazon-workflow). Such rows permanently
// block the (transfer,sku,lot) dedup index → the reconciler's re-fires all
// report "skipped" and self-healing never happens (TR-00337/00338, 2026-08-14).
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
    .select('id, status, cin7_transfer_number, cin7_sku, cin7_lot, amazon_shipment_ids, updated_at')
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
      const { error: cancelErr } = await db
        .from('fba_shipments')
        .update({
          status: 'cancelled',
          error_message: `frozen draft auto-swept by reconciler (no shipments, stale ${Math.round((now - new Date(f.updated_at).getTime()) / 60000)}min) — run likely died mid-workflow`,
          error_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', f.id)
        .eq('status', 'draft')
        .is('amazon_shipment_ids', null);
      if (cancelErr) {
        console.warn(`[reconciler] failed to sweep frozen draft ${f.id}: ${cancelErr.message}`);
        // Couldn't cancel → still blocking; treat as existing to avoid a
        // guaranteed-skipped re-fire.
        live.push(f);
      } else {
        sweptAny = true;
        console.log(
          `[reconciler] swept frozen draft ${f.id} (${f.cin7_transfer_number} ${f.cin7_sku} lot ${f.cin7_lot})`
        );
      }
    }

    // If we swept anything, DO NOT auto-re-fire. A "frozen draft" can mean
    // the run died AFTER creating the Amazon plan/shipments/labels but BEFORE
    // persisting amazon_shipment_ids — auto-re-firing then creates a real
    // duplicate FBA shipment with extra partnered UPS labels at the warehouse.
    // (Incident 2026-08-14/15: TR-00336/337/338 got 2-4 duplicate shipments
    // each from sweep→re-fire loops.) Instead alert for manual verification:
    // a human must confirm on Amazon Seller Central / SP-API that no live plan
    // exists before re-firing via /api/fba/auto-submit.
    if (sweptAny) {
      await sendTelegramAlert(
        `🧊 *FBA reconciler: swept frozen draft(s) for ${transferNumber}*\n\n` +
          `Run died mid-workflow. NOT auto-retrying (duplicate-shipment risk — ` +
          `the crashed run may have already created Amazon shipments/labels).\n\n` +
          `Manual step: check Seller Central for an existing shipment for this ` +
          `transfer. If none exists, re-fire /api/fba/auto-submit manually.`
      );
      return true; // block auto-re-fire
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

async function findCandidates(db: SupabaseClient): Promise<BridgeRow[]> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  const { data, error } = await db
    .from('cin7_transfer_shiphero_orders')
    .select(
      'id, cin7_transfer_number, cin7_destination, synced_at, last_fba_handoff_at, fba_handoff_attempts, request_payload, shiphero_order_number'
    )
    .eq('status', 'synced')
    .gte('synced_at', since)
    .order('synced_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`bridge query failed: ${error.message}`);
  if (!data) return [];

  // Filter to FBA-bound transfers only (cin7_destination contains amazon/fba)
  return data.filter((row: any) => isFbaDestination(row.cin7_destination));
}

function shouldRetryNow(row: BridgeRow): {retry: boolean; reason?: string} {
  // No hard cap — re-fires are dedup-idempotent, so we keep trying with
  // backoff until the fba_shipments row exists. A cap only converts a long
  // outage into a permanent silent failure (see 2026-08-04..07 incident).
  if (row.last_fba_handoff_at) {
    const gap =
      row.fba_handoff_attempts >= 3 ? RETRY_GAP_LATE_MS : RETRY_GAP_EARLY_MS;
    const last = new Date(row.last_fba_handoff_at).getTime();
    if (Date.now() - last < gap) {
      return { retry: false, reason: 'throttled' };
    }
  }
  return { retry: true };
}

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID?.trim();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    });
  } catch (err: any) {
    console.warn('[reconciler] Telegram alert failed:', err?.message || err);
  }
}

export async function reconcileFbaHandoffs(
  options: { supabase?: SupabaseClient; dryRun?: boolean } = {}
): Promise<ReconcileResult> {
  const startedAt = Date.now();
  const db = getSupabase(options.supabase);
  const result: ReconcileResult = {
    scanned: 0,
    reFired: 0,
    throttled: 0,
    exhausted: [],
    errors: [],
    duration_ms: 0,
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
      // Has an active fba_shipments row? If yes, skip — pipeline already ran.
      const exists = await fbaRecordExists(db, row.cin7_transfer_number);
      if (exists) continue;

      const decision = shouldRetryNow(row);
      if (!decision.retry) {
        if (decision.reason === 'max_attempts') {
          result.exhausted.push(row.cin7_transfer_number);
        } else {
          result.throttled++;
        }
        continue;
      }

      processed++;

      // Extract items from the bridge's request_payload (partnerLineItems)
      const items = row.request_payload?.partnerLineItems;
      if (!Array.isArray(items) || items.length === 0) {
        result.errors.push(
          `${row.cin7_transfer_number}: no partnerLineItems in request_payload`
        );
        continue;
      }

      const fbaItems = items.map((it: any) => ({
        sku: it.sku,
        quantity: it.quantity,
      }));

      console.log(
        `[reconciler] Re-firing FBA handoff for ${row.cin7_transfer_number} ` +
          `(attempt ${row.fba_handoff_attempts + 1}, ${fbaItems.length} items)`
      );

      if (!options.dryRun) {
        // fire-and-forget (fireFbaAutoSubmit is non-blocking, returns Promise<void>)
        void fireFbaAutoSubmit({
          cin7TransferNumber: row.cin7_transfer_number,
          items: fbaItems,
        });

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
