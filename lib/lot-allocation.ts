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
