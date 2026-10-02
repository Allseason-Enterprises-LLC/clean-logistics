/**
 * Live fact-gathering for fba-preflight. Each read is independent and
 * individually fail-safe in the direction the check needs:
 *   • ShipHero reads that fail → facts stay null → preflight blocks (fail closed:
 *     we cannot build a shipment on data we could not read).
 *   • Amazon readiness probe that fails for any reason OTHER than the explicit
 *     "not available for inbound" → inboundReady=undefined → preflight does
 *     not block (fail open: an Amazon hiccup must not park a transfer).
 */
import { getShipHeroProductData } from './shiphero-product-data';
import { callAmazonSpApi, SpApiError } from './amazon-sp-api-client';
import type { PreflightFacts } from './fba-preflight';

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

export interface GatherDeps {
  shipheroToken: string;
  resolveAmazonSku: (cin7Sku: string) => Promise<{ amz_sku: string | null; amz_fnsku?: string | null } | null>;
  getProductData?: typeof getShipHeroProductData;
  probeReadiness?: typeof probeAmazonReadiness;
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
    facts.lotNumber = p.lotNumber ?? null;
    facts.expirationDate = p.expirationDate ?? null;
  } catch (e: any) {
    console.warn(`[preflight] ShipHero product read failed for ${sku} — treating as missing: ${e?.message || e}`);
  }

  // sku_master — null row = NO_AMAZON_MAPPING.
  try {
    const m = await deps.resolveAmazonSku(sku);
    facts.amazonMsku = m?.amz_sku ?? null;
    facts.fnsku = m?.amz_fnsku ?? null;
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
  }
  return facts;
}
