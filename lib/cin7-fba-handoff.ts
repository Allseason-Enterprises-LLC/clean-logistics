/**
 * Fire-and-forget handoff from the CIN7 transfer sync to the FBA auto-submit pipeline.
 *
 * When the sync creates a ShipHero order for a CIN7 transfer destined for Amazon FBA,
 * we POST to this same app's /api/fba/auto-submit so the Amazon shipment gets created
 * immediately. Both live in clean-logistics, so this is a self-POST over the Vercel
 * function URL — keeps failure domains isolated and preserves the 13-step FBA workflow
 * as a single atomic unit.
 *
 * Non-fatal: if the handoff fails, the CIN7 sync still succeeds. A later retry will
 * pick up the transfer (because no FBA shipment exists yet in fba_shipments).
 */

export interface FbaTransferItem {
  sku: string;
  quantity: number;
}

export interface FbaHandoffInput {
  cin7TransferNumber: string;
  items: FbaTransferItem[];
}

/**
 * Self URL resolution.
 *
 * IMPORTANT: inside a Vercel function, `process.env.VERCEL_URL` is the per-deployment
 * hostname (e.g. `shiphero-shipstation-bridge-<hash>-wcoricas-projects.vercel.app`),
 * which is gated by Vercel Deployment Protection (SSO). Requests to that host get a
 * 401 HTML wall at the edge regardless of `Authorization: Bearer $CRON_SECRET` — the
 * protection runs BEFORE the function handler. The public alias
 * `shiphero-shipstation-bridge.vercel.app` is not protected, so all self-POSTs must
 * target the alias (or a custom domain) instead of `VERCEL_URL`.
 *
 * Resolution order:
 *   1. `FBA_SELF_BASE_URL` — explicit override (custom domain, or any unprotected host).
 *   2. In production (`VERCEL_ENV === 'production'`) — always the prod alias, NEVER
 *      `VERCEL_URL`, because the latter is protected.
 *   3. `VERCEL_URL` — for preview/dev where Deployment Protection is fine.
 *   4. Hardcoded prod alias — last-resort fallback for local dev.
 */
function getSelfBaseUrl(): string {
  if (process.env.FBA_SELF_BASE_URL) {
    return process.env.FBA_SELF_BASE_URL.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_ENV === 'production') {
    return 'https://shiphero-shipstation-bridge.vercel.app';
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/+$/, '')}`;
  }
  return 'https://shiphero-shipstation-bridge.vercel.app';
}

/**
 * Destination-matching: a CIN7 transfer is FBA-bound if the destination warehouse
 * name contains "amazon" or "fba" (case-insensitive).
 */
export function isFbaDestination(destinationName: string | null | undefined): boolean {
  if (!destinationName) return false;
  const lower = destinationName.toLowerCase();
  return lower.includes('amazon') || lower.includes('fba');
}

/**
 * Fire (do not await). Logs results AND records dispatch state on the bridge
 * row so the reconciler can see "we tried, here's when" rather than treating
 * never-attempted and attempted-but-failed rows identically.
 *
 * The actual /api/fba/auto-submit call runs in its OWN Vercel function
 * invocation (separate container, separate timeout budget). Our AbortController
 * only governs how long we wait for that function to accept the request — once
 * Vercel routes the POST and the auto-submit container starts, it runs
 * independently for up to its own maxDuration=300s.
 */
export function fireFbaAutoSubmit(input: FbaHandoffInput): Promise<void> {
  return triggerFbaAutoSubmit(input).catch((err) => {
    console.error(
      `[cin7-fba-handoff] FBA handoff failed for ${input.cin7TransferNumber} (non-fatal):`,
      err?.message || err
    );
  });
}

async function recordHandoffDispatch(
  cin7TransferNumber: string,
  status: 'dispatched' | 'dispatch_failed',
  details?: string
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(url, key, { auth: { persistSession: false } });

    // Bump fba_handoff_attempts and stamp the time. The reconciler uses these
    // to know whether to retry. By recording dispatch_failed eagerly here, the
    // reconciler can immediately pick up the slack on its next 15-min tick
    // rather than waiting a full hour after a never-attempted state.
    const { data: existing } = await db
      .from('cin7_transfer_shiphero_orders')
      .select('id, fba_handoff_attempts')
      .eq('cin7_transfer_number', cin7TransferNumber)
      .maybeSingle();

    if (!existing) return;

    await db
      .from('cin7_transfer_shiphero_orders')
      .update({
        last_fba_handoff_at: new Date().toISOString(),
        fba_handoff_attempts: (existing.fba_handoff_attempts || 0) + 1,
        last_fba_handoff_status: status,
        last_fba_handoff_detail: details ? details.slice(0, 500) : null,
      })
      .eq('id', existing.id);
  } catch (err: any) {
    console.warn(
      `[cin7-fba-handoff] Failed to record handoff dispatch for ${cin7TransferNumber}: ${err?.message || err}`
    );
  }
}

async function triggerFbaAutoSubmit(input: FbaHandoffInput): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.warn('[cin7-fba-handoff] CRON_SECRET not set — skipping FBA handoff');
    await recordHandoffDispatch(input.cin7TransferNumber, 'dispatch_failed', 'CRON_SECRET not set');
    return;
  }

  const url = `${getSelfBaseUrl()}/api/fba/auto-submit`;

  // The FBA auto-submit endpoint expects the CIN7 transfer number WITH the CIN7- prefix
  // because that's how the ShipHero order was named (CIN7-TR-XXXXX).
  const payload = {
    cin7_transfer_number: input.cin7TransferNumber.startsWith('CIN7-')
      ? input.cin7TransferNumber
      : `CIN7-${input.cin7TransferNumber}`,
    items: input.items.map((i) => ({
      sku: i.sku,
      quantity: i.quantity,
    })),
  };

  console.log(
    `[cin7-fba-handoff] Firing FBA handoff to ${url}: ${payload.cin7_transfer_number} (${input.items.length} items)`
  );

  // 30s timeout — generous for Vercel cold starts but still bounded so the
  // parent sync cron doesn't sit forever. The auto-submit function itself has
  // its own maxDuration=300s and keeps running after we disconnect.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[cin7-fba-handoff] FBA handoff returned HTTP ${res.status}: ${body.slice(0, 500)}`
      );
      await recordHandoffDispatch(
        input.cin7TransferNumber,
        'dispatch_failed',
        `HTTP ${res.status}: ${body.slice(0, 200)}`
      );
      return;
    }

    const json = await res.json().catch(() => null);
    console.log(
      `[cin7-fba-handoff] FBA handoff accepted for ${payload.cin7_transfer_number}: ${JSON.stringify(json)?.slice(0, 300)}`
    );
    await recordHandoffDispatch(input.cin7TransferNumber, 'dispatched', 'auto-submit returned 200');
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      // The 30s timeout fired before auto-submit returned. The auto-submit
      // function is still running in its own Vercel invocation, but we don't
      // know if it'll succeed. Record as dispatched-but-unverified — the
      // reconciler's existence check will catch true failures.
      console.log(
        `[cin7-fba-handoff] FBA handoff kicked off for ${payload.cin7_transfer_number} (disconnected after 30s; FBA pipeline continues)`
      );
      await recordHandoffDispatch(
        input.cin7TransferNumber,
        'dispatched',
        'aborted after 30s — auto-submit still running independently'
      );
      return;
    }
    await recordHandoffDispatch(
      input.cin7TransferNumber,
      'dispatch_failed',
      `fetch error: ${err?.message || String(err)}`
    );
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
