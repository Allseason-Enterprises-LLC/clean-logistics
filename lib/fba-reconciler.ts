/**
 * FBA Reconciler
 *
 * Finds CIN7 transfer bridge rows that successfully created a ShipHero order
 * destined for Amazon FBA but have NO corresponding `fba_shipments` row.
 * These are transfers where the original `fireFbaAutoSubmit` handoff failed
 * silently (e.g. proxy down, Vercel timeout) and the system needs to retry.
 *
 * Behavior:
 *   - Only considers bridges synced in the last 24h
 *   - Throttles per-bridge: re-fire at most once per hour
 *   - Caps at 3 attempts per bridge before alerting via Telegram and stopping
 *   - Uses the same `fireFbaAutoSubmit` path the cron uses for first-time fires
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { fireFbaAutoSubmit, isFbaDestination } from './cin7-fba-handoff';

const MAX_ATTEMPTS = 3;
const MIN_RETRY_GAP_MS = 60 * 60 * 1000; // 1 hour
const LOOKBACK_HOURS = 24;
const BATCH_SIZE = 10;

interface ReconcileResult {
  scanned: number;
  reFired: number;
  throttled: number;
  exhausted: string[]; // transfer numbers that hit MAX_ATTEMPTS
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

async function fbaRecordExists(
  db: SupabaseClient,
  transferNumber: string
): Promise<boolean> {
  // Check the new columns first (post-migration writes will populate these)
  const { data: byColumn, error: colErr } = await db
    .from('fba_shipments')
    .select('id, status')
    .eq('cin7_transfer_number', transferNumber)
    .not('status', 'in', '("failed","voided","cancelled")')
    .limit(1);

  if (colErr) {
    console.warn(`[reconciler] cin7_transfer_number lookup failed: ${colErr.message}`);
  } else if (byColumn && byColumn.length > 0) {
    return true;
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
  if (row.fba_handoff_attempts >= MAX_ATTEMPTS) {
    return { retry: false, reason: 'max_attempts' };
  }
  if (row.last_fba_handoff_at) {
    const last = new Date(row.last_fba_handoff_at).getTime();
    if (Date.now() - last < MIN_RETRY_GAP_MS) {
      return { retry: false, reason: 'throttled' };
    }
  }
  return { retry: true };
}

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID;
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
          `(attempt ${row.fba_handoff_attempts + 1}/${MAX_ATTEMPTS}, ${fbaItems.length} items)`
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

      // Alert on the LAST attempt — let the team know we're giving up after this
      if (row.fba_handoff_attempts + 1 >= MAX_ATTEMPTS) {
        await sendTelegramAlert(
          `⚠️ *FBA reconciler: final retry for ${row.cin7_transfer_number}*\n\n` +
            `Bridge synced ${row.synced_at}, ShipHero order ${row.shiphero_order_number}. ` +
            `Attempt ${MAX_ATTEMPTS}/${MAX_ATTEMPTS} firing now. ` +
            `If this fails, manual intervention required.`
        );
      }
    } catch (err: any) {
      result.errors.push(`${row.cin7_transfer_number}: ${err?.message || String(err)}`);
    }
  }

  // Alert on any exhausted transfers
  if (result.exhausted.length > 0) {
    await sendTelegramAlert(
      `🚨 *FBA reconciler: ${result.exhausted.length} transfer(s) exhausted retries*\n\n` +
        result.exhausted.map((t) => `• ${t}`).join('\n') +
        `\n\nManual investigation required. Check fba_shipments for failures and Amazon SP-API status.`
    );
  }

  result.duration_ms = Date.now() - startedAt;
  console.log(`[reconciler] done:`, result);
  return result;
}
