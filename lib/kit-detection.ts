/**
 * Kit / bundle detection for the FBA work-order gate.
 *
 * WHY THIS EXISTS (2026-09-22): multi-pack transfers (CN-BDL-*-3PK, CN-KIT-*)
 * ship goods that do not physically exist until the warehouse ASSEMBLES them.
 * Firing an Amazon inbound plan before assembly means any build problem lands
 * AFTER Amazon has a plan we cannot cancel with the warehouse. So kit transfers
 * must create a ShipHero work order first and only ship once it is COMPLETED.
 *
 * Detection uses TWO signals and fails TOWARD gating:
 *   1. SKU prefix  — `CN-BDL-` / `CN-KIT-` (fast, no network)
 *   2. ShipHero    — `product.kit === true` (authoritative; catches a kit that
 *                    was named without the prefix)
 * A plain SKU that is neither → not gated. A non-kit accidentally prefixed →
 * gated; the resulting work order simply completes trivially. That asymmetry
 * is deliberate: the cost of a needless WO is a day, the cost of a missed one
 * is an uncancellable Amazon plan against phantom inventory.
 */

const KIT_PREFIX = /^CN-(BDL|KIT)-/i;

/** Pure, synchronous prefix check. */
export function isKitSku(sku: string | null | undefined): boolean {
  return KIT_PREFIX.test((sku || '').trim());
}

export interface KitTransferVerdict {
  isKit: boolean;
  /** Every line SKU judged to be a kit (by prefix OR ShipHero flag). */
  kitSkus: string[];
  /** Which signal fired per SKU — surfaced in logs so a miss is diagnosable. */
  reasons: Record<string, 'prefix' | 'shiphero_kit_flag'>;
}

/**
 * Decide whether a transfer must be gated behind a work order.
 *
 * `lookupKitFlag` is injected so tests never hit the network. In production
 * pass `getProductKitFlag` from lib/shiphero-product-data.ts. A lookup FAILURE
 * (network, token) is treated as "unknown" and does NOT gate on its own — the
 * prefix still can. We log it; we do not throw, because a flaky ShipHero call
 * must not stall every non-kit transfer.
 */
export async function isKitTransfer(
  lines: Array<{ sku: string }>,
  lookupKitFlag: (sku: string) => Promise<boolean>
): Promise<KitTransferVerdict> {
  const kitSkus: string[] = [];
  const reasons: KitTransferVerdict['reasons'] = {};

  for (const line of lines) {
    const sku = (line.sku || '').trim();
    if (!sku) continue;

    if (isKitSku(sku)) {
      kitSkus.push(sku);
      reasons[sku] = 'prefix';
      continue;
    }

    let flagged = false;
    try {
      flagged = await lookupKitFlag(sku);
    } catch (err: any) {
      console.warn(
        `[kit-detection] ShipHero kit-flag lookup failed for ${sku}: ${err?.message || err} — relying on prefix only`
      );
    }
    if (flagged) {
      kitSkus.push(sku);
      reasons[sku] = 'shiphero_kit_flag';
    }
  }

  return { isKit: kitSkus.length > 0, kitSkus, reasons };
}
