/**
 * Pure FEFO lot allocator for FBA lot-split shipments.
 *
 * Splits a requested quantity across expiration lots, First-Expired-First-Out,
 * in FULL-CASE multiples (Amazon case-pack rule). Lots expiring inside the
 * 105-day FBA window (FBA_INB_0181) are skipped.
 */

export interface LotAvailability {
  name: string;
  expiresAt: string;      // ISO date or datetime from ShipHero
  availableQty: number;
}

export interface LotAllocation {
  name: string;
  expiresAt: string;      // normalized YYYY-MM-DD
  qty: number;            // always a multiple of caseQty
  cases: number;
}

const FBA_MIN_DAYS = 105;

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Sanitize a lot name for use in order numbers / partner ids / file paths. */
export function sanitizeLotName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Split requestedQty across lots FEFO, in full-case multiples.
 * - Filters lots with qty <= 0, missing expiry, or expiring < 105 days from `today`.
 * - Sorts by expires_at asc, then name (stable tiebreak).
 * - Throws if eligible full-case capacity < requestedQty.
 */
export function allocateFefoByLot(
  lots: LotAvailability[],
  requestedQty: number,
  caseQty: number,
  today: string = new Date().toISOString().slice(0, 10),
): LotAllocation[] {
  if (caseQty <= 0) throw new Error('caseQty must be positive');
  if (requestedQty <= 0) throw new Error('requestedQty must be positive');

  const eligible = lots
    .filter((l) => l.availableQty > 0 && l.expiresAt)
    .filter((l) => daysBetween(today, toDateOnly(l.expiresAt)) >= FBA_MIN_DAYS)
    .sort(
      (a, b) =>
        toDateOnly(a.expiresAt).localeCompare(toDateOnly(b.expiresAt)) ||
        a.name.localeCompare(b.name),
    );

  const allocations: LotAllocation[] = [];
  let remaining = requestedQty;

  for (const lot of eligible) {
    if (remaining <= 0) break;
    const lotCases = Math.floor(lot.availableQty / caseQty);
    if (lotCases === 0) continue;
    const wantCases = Math.ceil(remaining / caseQty);
    const cases = Math.min(lotCases, wantCases);
    const qty = cases * caseQty;
    allocations.push({
      name: lot.name,
      expiresAt: toDateOnly(lot.expiresAt),
      qty,
      cases,
    });
    remaining -= qty;
  }

  if (remaining > 0) {
    throw new Error(
      `Insufficient lot-tracked stock: requested ${requestedQty}, ` +
        `short ${remaining} (case size ${caseQty}). Eligible lots: ` +
        (eligible.map((l) => `${l.name}=${l.availableQty}`).join(', ') || 'none'),
    );
  }
  return allocations;
}

export interface FbaItem {
  sku: string;
  quantity: number;
  lot?: string;
}

/**
 * Collapse CIN7 lines of the same SKU into one item before lot allocation.
 *
 * CIN7 splits one SKU across several lines, usually one per lot the office
 * picked. Allocating each line separately sends every line to the same oldest
 * lot, and every line after the first is dropped by the (transfer, sku, lot)
 * dedup index. That shipped TR-00533, TR-00535, TR-00566 and TR-00567 short.
 *
 * Keyed on (sku, lot): lines with an explicit `lot` (supplemental top-ups)
 * stay separate per lot, so a pinned lot is never re-spread by FEFO.
 * Order of first appearance is preserved. Non-positive quantities are dropped.
 */
export function mergeSameSkuItems(items: Array<{ sku: unknown; quantity: unknown; lot?: unknown }>): FbaItem[] {
  const out: FbaItem[] = [];
  const byKey = new Map<string, FbaItem>();
  for (const raw of items) {
    const sku = String(raw.sku);
    const qty = Number(raw.quantity) || 0;
    if (qty <= 0) continue;
    const lot = raw.lot ? String(raw.lot) : undefined;
    const key = `${sku}\u0000${lot ?? ''}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.quantity += qty;
    } else {
      const entry: FbaItem = lot ? { sku, quantity: qty, lot } : { sku, quantity: qty };
      byKey.set(key, entry);
      out.push(entry);
    }
  }
  return out;
}

export interface Shortfall {
  sku: string;
  requested: number;
  covered: number;
  short: number;
}

/**
 * Compare ordered units against units actually covered by an Amazon plan
 * (created this run, or already done by an earlier run of the same payload).
 * Any SKU short by one unit or more is a shortfall.
 */
export function findShortfalls(requested: Map<string, number>, covered: Map<string, number>): Shortfall[] {
  const out: Shortfall[] = [];
  for (const [sku, req] of requested) {
    const cov = covered.get(sku) ?? 0;
    if (cov < req) out.push({ sku, requested: req, covered: cov, short: req - cov });
  }
  return out;
}
