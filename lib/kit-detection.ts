/**
 * Kit / multi-pack detection for the FBA work-order gate.
 *
 * WHY THIS EXISTS (2026-09-22): multi-pack transfers ship goods that do not
 * physically exist until the warehouse ASSEMBLES them. Firing an Amazon inbound
 * plan before assembly means any build problem lands AFTER Amazon has a plan we
 * cannot cancel with the warehouse. So multi-pack transfers must create a
 * ShipHero work order first and only ship once it is COMPLETED.
 *
 * ─── Weston's rules (2026-09-26) ────────────────────────────────────────────
 *  • SKU numbers are FIXED. We never rename; we recognise what's there.
 *  • A multi-pack is a trailing pack count of 2 or more:  -2 -3 -4 -5 -6 …
 *    CIN7 writes it  -3PK ;  Amazon MSKUs write it  -3  or  -03 .  All gate.
 *  • "-R<n>" means RETRY — a re-listing that does NOT need kitting. -R2 ships
 *    straight through. The R is the only difference.
 *  • A trailing 1 (-1, -01, -R1) is a SINGLE, never a kit.  -90 / -60 etc are
 *    counts, never packs. (190+ real singles end in -1/-01; a naive "ends in a
 *    digit" rule would gate all of them.)
 *  • CN-KIT- / CN-BDL- prefixes are kits regardless of suffix.
 *
 * Detection is a pure string function over BOTH the CIN7 SKU and the Amazon
 * MSKU (the suffix usually lives on the MSKU, not the CIN7 SKU). The ShipHero
 * `kit` flag is NOT used: 744 of our multi-packs are modelled there as virtual
 * component-kits and 29 as real products, and that modelling is what we're
 * working around, not a signal we can trust.
 */

/** Verified real suffix shapes from sku_master, 2026-09-26. */
const KIT_PREFIX = /^CN-(BDL|KIT)-/i;
/** -2 -02 -2PK -3pk … (count >= 2). Rejects -1 / -01 / -R2 / -90. */
const MULTIPACK_SUFFIX = /-0?([2-9])(PK)?$/i;
/** -R1 -R2 -R3PK … the retry marker. Always wins over MULTIPACK. */
const RETRY_SUFFIX = /-R\d+(PK)?$/i;

export type KitReason = 'prefix' | 'multipack_suffix';
export type NoKitReason = 'retry_suffix' | 'single' | 'no_signal';

export interface SkuKitVerdict {
  needsKitting: boolean;
  reason: KitReason | NoKitReason;
  /** The pack count when a multipack suffix matched (e.g. 3 for -3PK). */
  packCount?: number;
}

/**
 * Decide whether ONE sku string needs kitting. Pure, synchronous.
 * Order matters: RETRY beats everything, then prefix, then multipack suffix.
 */
export function classifyKitSku(sku: string | null | undefined): SkuKitVerdict {
  const s = (sku || '').trim();
  if (!s) return { needsKitting: false, reason: 'no_signal' };

  // -R2 / -R3PK: a RETRY listing of something already built. Never gate.
  // Checked FIRST so "CN-BDL-X-R2" (kit prefix + retry) still ships through —
  // the R is the only thing Weston said matters.
  if (RETRY_SUFFIX.test(s)) return { needsKitting: false, reason: 'retry_suffix' };

  // Read the pack count whenever a multipack suffix is present, even when the
  // prefix is what decides — the WO name/instructions want "3-pack", not "kit".
  const m = MULTIPACK_SUFFIX.exec(s);
  const packCount = m ? Number(m[1]) : undefined;

  if (KIT_PREFIX.test(s)) return { needsKitting: true, reason: 'prefix', ...(packCount ? { packCount } : {}) };
  if (m) return { needsKitting: true, reason: 'multipack_suffix', packCount };

  // -1 / -01 / -90 / no suffix → a single or a count, not a pack.
  return { needsKitting: false, reason: 'single' };
}

/** Back-compat convenience. */
export function isKitSku(sku: string | null | undefined): boolean {
  return classifyKitSku(sku).needsKitting;
}

export interface KitTransferVerdict {
  isKit: boolean;
  /** CIN7 line SKUs judged to need kitting. */
  kitSkus: string[];
  /** Per CIN7 sku: which string (cin7 or amazon) and which rule decided it. */
  reasons: Record<string, { via: 'cin7_sku' | 'amazon_msku'; reason: KitReason | NoKitReason; packCount?: number }>;
}

/**
 * Decide whether a TRANSFER must be gated. Looks at the CIN7 sku AND the
 * Amazon MSKU for each line (resolved by the caller from sku_master — the
 * suffix normally lives on the MSKU). A RETRY on either side wins.
 */
export function isKitTransfer(
  lines: Array<{ sku: string; amazonSku?: string | null }>
): KitTransferVerdict {
  const kitSkus: string[] = [];
  const reasons: KitTransferVerdict['reasons'] = {};

  for (const line of lines) {
    const sku = (line.sku || '').trim();
    if (!sku) continue;

    const c7 = classifyKitSku(sku);
    const am = classifyKitSku(line.amazonSku);

    // Retry on either side → no kitting, full stop.
    if (c7.reason === 'retry_suffix' || am.reason === 'retry_suffix') {
      reasons[sku] = { via: c7.reason === 'retry_suffix' ? 'cin7_sku' : 'amazon_msku', reason: 'retry_suffix' };
      continue;
    }
    if (c7.needsKitting) {
      kitSkus.push(sku);
      reasons[sku] = { via: 'cin7_sku', reason: c7.reason as KitReason, packCount: c7.packCount };
    } else if (am.needsKitting) {
      kitSkus.push(sku);
      reasons[sku] = { via: 'amazon_msku', reason: am.reason as KitReason, packCount: am.packCount };
    } else {
      reasons[sku] = { via: 'cin7_sku', reason: 'single' };
    }
  }

  return { isKit: kitSkus.length > 0, kitSkus, reasons };
}
