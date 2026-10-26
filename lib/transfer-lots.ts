/**
 * Transfer lots AS WRITTEN (2026-10-26, Katherine Bravo: "they have to go out
 * according to how they are written").
 *
 * The office allocates every Vegas → FBA transfer to specific lots on the CIN7
 * lines (BatchSN), after checking bins, expiry and B-bin exclusions. Until now
 * the FBA pipeline threw that away: partnerLineItems carried sku + qty only and
 * auto-submit re-ran its own FEFO across ShipHero's lot breakdown. Two failure
 * classes came out of that:
 *
 *   1. WRONG LOTS LABELLED. TR-00664 (CN-CAP-WILDYAMHOR-60CT) was written
 *      2512043A 1512 + 2604120A 378. Amazon got 2512043A 1638 + 2604120A 252 —
 *      FEFO counted 126 units in a B bin the office had excluded. The floor
 *      picks the CIN7 lots, so one box carried the wrong lot's labels.
 *   2. LOST LOTS. TR-00678 (CN-DRP-BLOODSUGAR-2OZ) was written TN080726-N19
 *      7380 + CN92572601 2700. Lot 1 finished, lot 2 was deferred to a
 *      self-chained run that never happened, and nothing noticed: the
 *      shortfall/coverage checks only run when nothing is deferred, and the
 *      reconciler skipped the transfer because it had "an active row".
 *      30 boxes, no labels.
 *
 * This module is the pure core: read the lot off a CIN7 line, turn transfer
 * lines into per-lot FBA items, and work out which written lots still have no
 * active fba_shipments row.
 */

export interface LotLine {
  sku: string;
  quantity: number;
  lot?: string | null;
}

export interface LotItem {
  sku: string;
  quantity: number;
  lot?: string;
}

/** CIN7 line → lot name. CIN7 v2 stock-transfer lines use `BatchSN`. */
export function readCin7LineLot(raw: Record<string, any> | null | undefined): string | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const k of ['BatchSN', 'Batch', 'BatchNumber', 'Lot', 'LotNumber', 'SerialNumber']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) return isPlaceholderLot(v) ? null : v.trim();
  }
  return null;
}

/**
 * CIN7 placeholder batches (FEFO-CONV-YYYYMMDD from the Sept FEFO conversion)
 * are not physical lots — ShipHero has no such lot. Treat as "no lot" so the
 * line falls back to FEFO instead of failing on a lot that cannot be found.
 */
export function isPlaceholderLot(name: string | null | undefined): boolean {
  return /^FEFO-CONV/i.test(String(name || '').trim());
}

/** CIN7 line → expiry (YYYY-MM-DD) when present. */
export function readCin7LineExpiry(raw: Record<string, any> | null | undefined): string | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const k of ['ExpiryDate', 'Expiry', 'ExpirationDate']) {
    const v = raw[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

/**
 * Transfer lines → FBA items. Lines that carry a lot keep it (one item per
 * sku+lot; same-lot lines summed). Lines without a lot are passed through
 * without one, so auto-submit falls back to FEFO for them exactly as before.
 *
 * If ANY line of a SKU has no lot, the whole SKU goes un-pinned (summed, plain
 * FEFO — the pre-2026-10-26 behaviour). Mixing a pinned lot with an un-pinned
 * line of the same SKU would let FEFO land on the pinned lot, collide on the
 * (transfer, sku, lot) dedup index and silently drop units (TR-00566 class).
 * Order of first appearance is preserved; non-positive quantities dropped.
 */
export function toLotItems(lines: LotLine[]): LotItem[] {
  const unpinnedSkus = new Set<string>();
  for (const l of lines || []) {
    if ((Number(l.quantity) || 0) > 0 && !(l.lot && String(l.lot).trim())) unpinnedSkus.add(String(l.sku));
  }
  const out: LotItem[] = [];
  const byKey = new Map<string, LotItem>();
  for (const l of lines || []) {
    const sku = String(l.sku);
    const qty = Number(l.quantity) || 0;
    if (!sku || qty <= 0) continue;
    const lot = !unpinnedSkus.has(sku) && l.lot ? String(l.lot).trim() : '';
    const key = `${sku}\u0000${lot}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.quantity += qty;
    } else {
      const item: LotItem = lot ? { sku, quantity: qty, lot } : { sku, quantity: qty };
      byKey.set(key, item);
      out.push(item);
    }
  }
  return out;
}

/** Every line carries a lot → the transfer can be labelled exactly as written. */
export function allLinesHaveLots(lines: LotLine[]): boolean {
  const live = (lines || []).filter((l) => Number(l.quantity) > 0);
  return live.length > 0 && live.every((l) => !!(l.lot && String(l.lot).trim()));
}

/**
 * Which written (sku, lot) items have NO active fba_shipments row yet.
 * `activeRows` = fba_shipments rows for the transfer with status NOT IN
 * cancelled/failed/voided. A needs_review/draft row still holds its slot, so it
 * counts as present (never re-fire over it — duplicate-shipment risk).
 */
export function missingLotItems(
  written: LotItem[],
  activeRows: Array<{ cin7_sku: string | null; cin7_lot: string | null }>
): LotItem[] {
  const have = new Set(activeRows.map((r) => `${r.cin7_sku ?? ''}\u0000${r.cin7_lot ?? ''}`));
  return written.filter((i) => i.lot && !have.has(`${i.sku}\u0000${i.lot}`));
}

export type TopUpVerdict =
  | { kind: 'whole'; detail: string }
  | { kind: 'over'; detail: string }
  | { kind: 'in_flight'; detail: string }
  | { kind: 'skip'; detail: string } // transient / not fireable — no alert
  | { kind: 'unknown_lots'; detail: string }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'top_up'; items: LotItem[]; detail: string };

export interface ActiveRow {
  cin7_sku: string | null;
  cin7_lot: string | null;
  status: string;
  units: number | null; // label_set.units on the row (null = not labelled yet)
  updated_at: string;
}

const IN_FLIGHT_MS = 30 * 60 * 1000;

/**
 * Pure decision for a transfer that already has ≥1 active fba_shipments row.
 * Only ever proposes the EXACT written lots that have no row, and only when
 * their units equal the transfer's shortfall — so a top-up can never label
 * more than the CIN7 transfer says.
 *
 *   ordered  : units per SKU on the CIN7 transfer
 *   written  : lot items as written on the CIN7 lines (toLotItems)
 *   active   : active fba_shipments rows (not cancelled/failed/voided)
 */
export function planTopUp(
  ordered: Record<string, number>,
  written: LotItem[],
  active: ActiveRow[],
  now = Date.now()
): TopUpVerdict {
  const labelled: Record<string, number> = {};
  for (const r of active) {
    const sku = r.cin7_sku ?? '';
    labelled[sku] = (labelled[sku] ?? 0) + (Number(r.units) || 0);
  }
  const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ');

  // A row still being worked (no label units yet) — a chained run may be on it.
  const busy = active.filter((r) => r.units == null && now - new Date(r.updated_at).getTime() < IN_FLIGHT_MS);
  if (busy.length) return { kind: 'in_flight', detail: `${busy.length} row(s) still being built (${busy.map((r) => r.cin7_lot).join(', ')})` };

  const short: Record<string, number> = {};
  for (const [sku, o] of Object.entries(ordered)) {
    const l = labelled[sku] ?? 0;
    if (l > o) return { kind: 'over', detail: `${sku}: labelled ${l} > ordered ${o} — never top up` };
    if (l < o) short[sku] = o - l;
  }
  if (Object.keys(short).length === 0) return { kind: 'whole', detail: `labelled == ordered (${fmt(ordered)})` };

  // An un-labelled row that is NOT in flight (stale draft / needs_review) holds
  // its slot: the frozen-draft sweep owns it. Never fire over it.
  const stuck = active.filter((r) => r.units == null);
  if (stuck.length) return { kind: 'in_flight', detail: `short ${fmt(short)} but ${stuck.length} unlabelled row(s) hold the slot (${stuck.map((r) => `${r.cin7_lot}:${r.status}`).join(', ')}) — frozen-draft sweep owns these` };

  if (!written.length || written.some((i) => !i.lot)) {
    return { kind: 'unknown_lots', detail: `short ${fmt(short)} and the CIN7 lines do not name every lot — will not guess with FEFO` };
  }
  const missing = missingLotItems(written, active);
  const missingBySku: Record<string, number> = {};
  for (const m of missing) missingBySku[m.sku] = (missingBySku[m.sku] ?? 0) + m.quantity;
  const agrees =
    Object.keys(short).length === Object.keys(missingBySku).length &&
    Object.entries(short).every(([sku, n]) => missingBySku[sku] === n);
  if (!missing.length || !agrees) {
    return { kind: 'mismatch', detail: `short ${fmt(short)} but un-labelled written lots = ${fmt(missingBySku) || 'none'} — needs a human` };
  }
  return {
    kind: 'top_up',
    items: missing,
    detail: `missing lot(s) ${missing.map((m) => `${m.sku}/${m.lot}=${m.quantity}`).join(', ')} (short ${fmt(short)})`,
  };
}
