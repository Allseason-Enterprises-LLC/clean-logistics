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
 * Self URL: prefer VERCEL_URL (production deployment URL), fall back to the canonical
 * prod domain. Both paths are HTTPS.
 */
function getSelfBaseUrl(): string {
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
 * Fire (do not await). Logs results; returns nothing.
 * Timeout after 8s so we don't block the sync cron — the FBA workflow continues
 * running even after we disconnect.
 */
export function fireFbaAutoSubmit(input: FbaHandoffInput): Promise<void> {
  return triggerFbaAutoSubmit(input).catch((err) => {
    console.error(
      `[cin7-fba-handoff] FBA handoff failed for ${input.cin7TransferNumber} (non-fatal):`,
      err?.message || err
    );
  });
}

async function triggerFbaAutoSubmit(input: FbaHandoffInput): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.warn('[cin7-fba-handoff] CRON_SECRET not set — skipping FBA handoff');
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

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
      return;
    }

    const json = await res.json().catch(() => null);
    console.log(
      `[cin7-fba-handoff] FBA handoff accepted for ${payload.cin7_transfer_number}: ${JSON.stringify(json)?.slice(0, 300)}`
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.log(
        `[cin7-fba-handoff] FBA handoff kicked off for ${payload.cin7_transfer_number} (disconnected after 8s; FBA pipeline continues)`
      );
      return;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
