/**
 * ShipHero order-number naming
 * ============================
 *
 * WHY THIS EXISTS
 *
 * The ShipHero order used to be named `CIN7-<TR number>` (e.g. `CIN7-TR-00477`).
 * CIN7's transfer number is native, sequential and uneditable, so the warehouse
 * saw a wall of near-identical numbers with no hint of what was in the box or
 * where it was going. Requested 2026-09-21 (Weston): encode the destination
 * platform and the SKU in the name so the floor can identify and assign work at
 * a glance.
 *
 * FORMAT
 *
 *   <PLATFORM>_<SKU>_<TR number>
 *   AMZ_CN-CAP-SAFFRON-60CT_TR-00477
 *
 * ⚠️ The trailing TR number is NOT decoration — it is required for uniqueness.
 * 36 of 135 SKUs in the live data have shipped on more than one transfer
 * (`CN-POW-WMNSCREATIORA-30SV` on five: TR-00266/272/340/370/458). A bare
 * `AMZ_<SKU>` would name five different pallets identically, which is worse for
 * the warehouse than the sequential numbers it replaced. Keep the suffix.
 *
 * SOURCE OF TRUTH
 *
 * The name is DERIVED from data the pipeline already has (destination → platform,
 * line items → SKU). No human data entry, so it cannot be forgotten or typo'd,
 * and it applies retroactively to every transfer.
 *
 * The CIN7 `Reference` field is an OVERRIDE: when ops types something there it
 * wins verbatim. `Reference` is one of the few editable *and* searchable fields
 * on a CIN7 stock transfer, which makes it the right escape hatch for bundles,
 * split shipments and special handling — without making it a required step for
 * the other ~98% of transfers.
 */

/**
 * Destination name (CIN7) → platform code.
 *
 * ⚠️ Deliberately an explicit table, NOT `destination.slice(0, 3)`.
 * First-three-characters gives the WRONG codes for the ones we actually want:
 * "Amazon FBA Warehouse" → `AMA` (not AMZ), "iHerb" → `IHE` (not HRB).
 *
 * Matching is by substring on the lowercased name because real CIN7
 * destinations are messy — there are 14 distinct TikTok spellings in the live
 * data (`TikTok Warehouse`, `TikTok Warehouse - FC02_ORD1`,
 * `TikTok Warehouse - FC36_ONT10`, ...). Order matters: first match wins.
 */
export const PLATFORM_CODES: ReadonlyArray<{ match: string; code: string }> = [
  { match: 'amazon', code: 'AMZ' },
  { match: 'fba', code: 'AMZ' },
  { match: 'tiktok', code: 'TIK' },
  { match: 'tik tok', code: 'TIK' },
  { match: 'iherb', code: 'HRB' },
  { match: 'herb', code: 'HRB' },
  { match: 'target', code: 'TAR' },
  { match: 'walmart', code: 'WMT' },
  { match: 'costco', code: 'CST' },
  { match: 'faire', code: 'FAI' },
  { match: 'shopify', code: 'DTC' },
  { match: 'direct', code: 'DTC' },
  // Internal / back-to-warehouse movements. These are not a sales platform;
  // they show up on older LV-inbound transfers (e.g. "Allseason Enterprises
  // LLC", "Clean Nutra ASE Warehouse - Vegas") which become ShipHero purchase
  // orders rather than FBA outbounds. Mapped explicitly so they read as WHS
  // instead of the XXX "we don't know" marker.
  { match: 'allseason', code: 'WHS' },
  { match: 'clean nutra', code: 'WHS' },
  { match: 'ase warehouse', code: 'WHS' },
  { match: 'vegas', code: 'WHS' },
];

/** Used when no table entry matches — visible on purpose, so it gets reported. */
export const UNKNOWN_PLATFORM_CODE = 'XXX';

export function resolvePlatformCode(destinationName: string | null | undefined): string {
  if (!destinationName) return UNKNOWN_PLATFORM_CODE;
  const lower = destinationName.toLowerCase();
  for (const { match, code } of PLATFORM_CODES) {
    if (lower.includes(match)) return code;
  }
  return UNKNOWN_PLATFORM_CODE;
}

/**
 * Normalize the TR number to its bare form (`TR-00477`), tolerating the legacy
 * `CIN7-` prefix. The two forms have caused real bugs before — `fba_shipments`
 * stores the prefixed form while `cin7_transfer_shiphero_orders` stores the bare
 * one — so every entry point funnels through here.
 */
export function bareTransferNumber(transferNumber: string): string {
  return String(transferNumber || '').replace(/^CIN7-/i, '').trim();
}

/**
 * Pull the `TR-XXXXX` token out of ANY order-number format: legacy
 * `CIN7-TR-00477`, new `AMZ_CN-CAP-SAFFRON-60CT_TR-00477`, per-lot children
 * like `CIN7-TR-00477-<LOT>`, or a custom Reference that merely contains it.
 *
 * This is what keeps old and new names resolvable by the same lookup.
 */
export function extractTransferNumber(orderNumber: string | null | undefined): string | null {
  if (!orderNumber) return null;
  const m = String(orderNumber).match(/TR-\d{3,}/i);
  return m ? m[0].toUpperCase() : null;
}

export interface BuildOrderNumberInput {
  transferNumber: string;
  destinationName?: string | null;
  /** Distinct SKUs on the transfer. */
  skus?: Array<string | null | undefined>;
  /** CIN7 `Reference` field — when non-empty it wins verbatim. */
  reference?: string | null;
}

/**
 * Build the ShipHero order number.
 *
 * Precedence:
 *   1. a non-empty CIN7 `Reference` (sanitized) — ops override
 *   2. `<PLATFORM>_<SKU>_<TR>` for a single-SKU transfer
 *   3. `<PLATFORM>_MULTI-<n>SKU_<TR>` when the transfer has several SKUs
 *   4. `<PLATFORM>_<TR>` when no SKU is known
 */
export function buildShipHeroOrderNumber(input: BuildOrderNumberInput): string {
  const tr = bareTransferNumber(input.transferNumber);

  const ref = sanitizeSegment(input.reference ?? '');
  if (ref) {
    // Guarantee the TR number is present so the order stays traceable and
    // every downstream lookup keeps working, even on a hand-typed reference.
    return extractTransferNumber(ref) ? ref : `${ref}_${tr}`;
  }

  const platform = resolvePlatformCode(input.destinationName);
  const distinct = Array.from(
    new Set((input.skus ?? []).map((s) => sanitizeSegment(s ?? '')).filter(Boolean))
  );

  if (distinct.length === 1) return `${platform}_${distinct[0]}_${tr}`;
  if (distinct.length > 1) return `${platform}_MULTI-${distinct.length}SKU_${tr}`;
  return `${platform}_${tr}`;
}

/**
 * Keep segments safe for an order number that also becomes a storage path and a
 * printed label: allow alphanumerics, dash, dot; collapse everything else to a
 * dash. Spaces in particular would break path-style consumers.
 */
function sanitizeSegment(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
