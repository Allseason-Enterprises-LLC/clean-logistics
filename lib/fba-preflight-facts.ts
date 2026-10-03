/**
 * Live fact-gathering for fba-preflight. Each read is independent and
 * individually fail-safe in the direction the check needs:
 *   • ShipHero reads that fail → facts stay null → preflight blocks (fail closed:
 *     we cannot build a shipment on data we could not read).
 *   • Amazon readiness probe that fails for any reason OTHER than the explicit
 *     "not available for inbound" → inboundReady=undefined → preflight does
 *     not block (fail open: an Amazon hiccup must not park a transfer).
 */
import { getShipHeroProductData, getLotBreakdown } from './shiphero-product-data';
import { callAmazonSpApi, SpApiError } from './amazon-sp-api-client';
import type { PreflightFacts } from './fba-preflight';
import { catalogIdentity } from './kit-product-identity';

async function defaultAmazonUpc(asin: string): Promise<string | null> {
  const c = await catalogIdentity(asin);
  return c.upc ?? (c.ean ? c.ean.replace(/^0/, '') : null);
}
import type { SupabaseClient } from '@supabase/supabase-js';

const MARKETPLACE_ID = 'ATVPDKIKX0DER';
const FBA_INBOUND_BASE = '/inbound/fba/2024-03-20';
const NOT_AVAILABLE = /not available for inbound/i;

export interface AmazonReadiness {
  /** false ONLY when Amazon said "not available for inbound". */
  inboundReady: boolean | undefined;
  labelOwnerConstraint: string | null;
  prepCategory?: string | null;
}

/** Probe the same gate createInboundPlan uses. Pure wrt. inputs; injectable api for tests. */
export async function probeAmazonReadiness(msku: string, api: typeof callAmazonSpApi = callAmazonSpApi): Promise<AmazonReadiness> {
  try {
    const res = await api<any>({
      method: 'GET', region: 'na', path: `${FBA_INBOUND_BASE}/items/prepDetails`,
      query: { marketplaceId: MARKETPLACE_ID, mskus: msku },
    });
    const d = (res.data?.mskuPrepDetails ?? []).find((x: any) => x.msku === msku);
    return { inboundReady: true, labelOwnerConstraint: d?.labelOwnerConstraint ?? null, prepCategory: d?.prepCategory ?? null };
  } catch (err: any) {
    const text = `${err?.message ?? ''} ${JSON.stringify((err as SpApiError)?.details ?? '')}`;
    if (err instanceof SpApiError && err.status === 400 && NOT_AVAILABLE.test(text)) {
      return { inboundReady: false, labelOwnerConstraint: null };
    }
    console.warn(`[preflight] Amazon readiness probe for ${msku} inconclusive (${err?.status ?? ''} ${err?.message ?? err}) — not blocking`);
    return { inboundReady: undefined, labelOwnerConstraint: null };
  }
}

/**
 * Has Amazon EVER held FBA inventory for this MSKU? The FBA inventory summary
 * lists an MSKU as soon as any inbound has been received (even if 0 now). This
 * is Amazon's own record of "we've sent this in before".
 *   true  → a summary row exists for the MSKU
 *   false → Amazon returned OK and no row
 *   undefined → call failed (caller treats as shipped-before: no WO)
 */
export async function amazonHasShippedBefore(msku: string, api: typeof callAmazonSpApi = callAmazonSpApi): Promise<boolean | undefined> {
  try {
    const res = await api<any>({
      method: 'GET', region: 'na', path: '/fba/inventory/v1/summaries',
      query: { granularityType: 'Marketplace', granularityId: MARKETPLACE_ID, marketplaceIds: MARKETPLACE_ID, sellerSkus: msku, details: 'false' },
    });
    const rows: any[] = res.data?.payload?.inventorySummaries ?? [];
    return rows.some((r) => r.sellerSku === msku);
  } catch (err: any) {
    console.warn(`[preflight] FBA inventory history probe for ${msku} failed (${err?.status ?? ''} ${err?.message ?? err}) — assuming shipped before`);
    return undefined;
  }
}

/** Our record: any non-cancelled fba_shipments row for this CIN7 SKU on a
 *  transfer other than the one being evaluated. */
export async function hasPriorFbaShipmentRow(db: SupabaseClient, cin7Sku: string, excludeTransferNumber: string): Promise<boolean> {
  const bare = excludeTransferNumber.replace(/^CIN7-/, '');
  const { data, error } = await db.from('fba_shipments').select('id')
    .eq('cin7_sku', cin7Sku).not('status', 'in', '("cancelled","failed","voided")')
    .neq('cin7_transfer_number', `CIN7-${bare}`).limit(1);
  if (error) throw new Error(`fba_shipments history read failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export interface GatherDeps {
  shipheroToken: string;
  resolveAmazonSku: (cin7Sku: string) => Promise<{ amz_sku: string | null; amz_fnsku?: string | null; amz_asin?: string | null } | null>;
  /** ASIN → Amazon catalog UPC/EAN. Defaults to kit-product-identity.catalogIdentity. Fail-open. */
  amazonUpcForAsin?: (asin: string) => Promise<string | null>;
  /** Our own record: a non-cancelled fba_shipments row exists for this CIN7 SKU
   *  on a DIFFERENT transfer. Injected (DB). Optional. */
  hasPriorShipmentRow?: (cin7Sku: string) => Promise<boolean>;
  getProductData?: typeof getShipHeroProductData;
  /** Lot-tracked stock by lot. Called twice: bulk-only and including pickable;
   *  the difference is what sits in DTC pick bins. Fail-open (undefined). */
  getLots?: typeof getLotBreakdown;
  probeReadiness?: typeof probeAmazonReadiness;
  shippedBeforeOnAmazon?: typeof amazonHasShippedBefore;
}

export async function gatherPreflightFacts(deps: GatherDeps, sku: string, quantity: number): Promise<PreflightFacts> {
  const facts: PreflightFacts = { cin7Sku: sku, quantity, casePack: null, productNote: null, lotNumber: null, expirationDate: null, amazonMsku: null };

  // ShipHero — fail closed.
  try {
    const p = await (deps.getProductData ?? getShipHeroProductData)(deps.shipheroToken, sku);
    facts.productNote = (p as any).productNote ?? null;
    facts.isKit = p.isKit;
    // ProductData.casePack is null when the note parse found NO usable
    // case-pack; otherwise a partially-filled object (0 for missing fields).
    facts.casePack = p.casePack
      ? {
          caseQuantity: Number(p.casePack.caseQuantity) || 0,
          boxLength: Number(p.casePack.boxLength) || 0, boxWidth: Number(p.casePack.boxWidth) || 0, boxHeight: Number(p.casePack.boxHeight) || 0,
          boxWeightLbs: Number(p.casePack.boxWeightLbs) || 0,
        }
      : null;
    facts.shipheroBarcode = p.barcode ?? null;
    facts.lotNumber = p.lotNumber ?? null;
    facts.expirationDate = p.expirationDate ?? null;
  } catch (e: any) {
    console.warn(`[preflight] ShipHero product read failed for ${sku} — treating as missing: ${e?.message || e}`);
  }

  // Stock position — bulk (non-pickable) is what FBA plans against. Fail-open:
  // if the read fails we leave bulkLots undefined and the allocator decides.
  try {
    const lots = deps.getLots ?? getLotBreakdown;
    const bulk = await lots(deps.shipheroToken, sku);
    const all = await lots(deps.shipheroToken, sku, { includePickable: true });
    facts.bulkLots = bulk.map((l) => ({ name: l.name, availableQty: l.availableQty, expiresAt: l.expiresAt }));
    const bulkTotal = bulk.reduce((n, l) => n + l.availableQty, 0);
    const allTotal = all.reduce((n, l) => n + l.availableQty, 0);
    facts.pickableUnits = Math.max(0, allTotal - bulkTotal);
  } catch (e: any) {
    console.warn(`[preflight] lot breakdown failed for ${sku} — not blocking on stock: ${e?.message || e}`);
  }

  // sku_master — null row = NO_AMAZON_MAPPING.
  let asin: string | null = null;
  try {
    const m = await deps.resolveAmazonSku(sku);
    facts.amazonMsku = m?.amz_sku ?? null;
    facts.fnsku = m?.amz_fnsku ?? null;
    asin = m?.amz_asin ?? null;
  } catch (e: any) {
    // Lookup failure is NOT "no mapping" — leave undefined so preflight doesn't post to marketing on a DB blip.
    facts.amazonMsku = undefined;
    console.warn(`[preflight] sku_master lookup failed for ${sku} — mapping unknown: ${e?.message || e}`);
  }

  // Amazon — fail open.
  if (facts.amazonMsku) {
    const r = await (deps.probeReadiness ?? probeAmazonReadiness)(facts.amazonMsku);
    facts.inboundReady = r.inboundReady;
    facts.labelOwnerConstraint = r.labelOwnerConstraint;

    // Amazon's UPC for the listing (barcode-conflict check on UPC listings).
    // Fail-open: no UPC → no comparison → no blocker.
    if (r.inboundReady === true && asin) {
      try { facts.amazonUpc = await (deps.amazonUpcForAsin ?? defaultAmazonUpc)(asin); }
      catch (e: any) { console.warn(`[preflight] catalog UPC lookup failed for ${asin}: ${e?.message || e}`); }
    }

    // First-shipment detection — now for BOTH label types (verify-and-branch
    // WO). Either record (ours or Amazon's) saying "shipped before" wins; an
    // inconclusive probe also counts as shipped-before (no needless WO).
    if (r.inboundReady === true) {
      let ours: boolean | undefined;
      try { ours = deps.hasPriorShipmentRow ? await deps.hasPriorShipmentRow(sku) : undefined; }
      catch (e: any) { console.warn(`[preflight] prior-shipment lookup failed for ${sku}: ${e?.message || e}`); }
      const amazon = await (deps.shippedBeforeOnAmazon ?? amazonHasShippedBefore)(facts.amazonMsku);
      facts.shippedBefore = ours === true || amazon === true ? true : (ours === false && amazon === false) ? false : undefined;
    }
  }
  return facts;
}
