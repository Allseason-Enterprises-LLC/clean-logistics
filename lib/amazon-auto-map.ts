/**
 * Auto-resolve an Amazon MSKU for a CIN7 SKU from Amazon's OWN records when
 * sku_master has no row — the fix for "No Amazon MSKU mapped" holds that a
 * human then clears by reading the listings report and typing the same thing
 * back in (TR-00484/00489/00508/00497..00501, 2026-10-01..03).
 *
 * Rule (Weston: match by ASIN + UPC, never by name):
 *   1. Listings API: does Amazon have an offer whose seller SKU == the CIN7 SKU?
 *      (Clean Nutra's newer listings are created with MSKU = CIN7 SKU.)
 *   2. If yes, read its UPC/EAN and compare to the ShipHero product barcode
 *      (digits-only, EAN leading 0 == UPC-A). Match → accept; record the row in
 *      sku_master (verified=false, notes say how) so the next tick is a plain
 *      lookup; mismatch → do NOT accept (that's the UPC_MISMATCH conflict; the
 *      floor WO handles it) → return null.
 *   3. No such offer → null → marketing hold as before.
 *
 * Nothing here guesses by name. Fail-open to null on any API/DB error.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callAmazonSpApi } from './amazon-sp-api-client';
import { barcodesMatch } from './fba-preflight';

export const SELLER_ID = 'A2JBR7QMN8UCHF';
const MARKETPLACE_ID = 'ATVPDKIKX0DER';

export interface AutoMapping { msku: string; asin: string | null; upc: string | null; fnsku: string | null }

/**
 * Pure: exact FNSKU compare (case-insensitive, trimmed).
 *
 * ⚠️ Do NOT route FNSKUs through `barcodesMatch` — that strips non-digits and
 * leading zeros, so `X005CNC45Z` collapses to `5` and would "match" any other
 * FNSKU with a single 5 in it. FNSKUs are alphanumeric identifiers and must be
 * compared whole.
 */
export function fnskusMatch(a: string | null | undefined, b: string | null | undefined): boolean | undefined {
  const na = String(a ?? '').trim().toUpperCase(); const nb = String(b ?? '').trim().toUpperCase();
  if (!na || !nb) return undefined;
  return na === nb;
}

/**
 * Pure: does Amazon's listing for this MSKU identify the same physical product
 * as ShipHero?
 *
 * ShipHero's barcode field carries **either** the product's UPC **or** its
 * Amazon FNSKU, depending on how the product was set up — Weston 2026-10-07:
 * *"in many scenarios we're using FNSKU so if the FNSKU matches then we should
 * be using that."* An FNSKU match is a STRONGER identity proof than a UPC match
 * (it is Amazon's own per-offer identifier), so either one accepts.
 *
 * Only a barcode that matches NEITHER — while we have something to compare it
 * against — is a genuine conflict. Before this, an FNSKU in the barcode field
 * was read as a UPC conflict and parked the transfer on a marketing hold for a
 * listing that was never broken (TR-00517/00518/00519, 2PK/3PK/4PK).
 */
export function acceptAutoMapping(
  listingUpc: string | null | undefined,
  listingFnsku: string | null | undefined,
  shipheroBarcode: string | null | undefined,
): 'accept' | 'conflict' | 'unverifiable' {
  const byUpc = barcodesMatch(listingUpc, shipheroBarcode);
  if (byUpc === true) return 'accept';
  const byFnsku = fnskusMatch(listingFnsku, shipheroBarcode);
  if (byFnsku === true) return 'accept';
  // Conflict only if at least one comparison was actually possible and failed.
  if (byUpc === false || byFnsku === false) return 'conflict';
  return 'unverifiable';
}

export async function fetchListingByMsku(msku: string, api: typeof callAmazonSpApi = callAmazonSpApi): Promise<AutoMapping | null> {
  try {
    const r = await api<any>({
      method: 'GET', region: 'na',
      path: `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(msku)}`,
      query: { marketplaceIds: MARKETPLACE_ID, includedData: 'summaries,attributes,fulfillmentAvailability' },
    });
    const d = r.data ?? r;
    const s = (d.summaries || [])[0];
    if (!s) return null;
    const ids: any[] = d.attributes?.externally_assigned_product_identifier || [];
    const upc = ids.find((i) => /^(upc|ean|gtin)$/i.test(i.type))?.value ?? null;
    // FNSKU lives on summaries[0].fnSku. `fulfillmentAvailability` entries come
    // back as bare {fulfillmentChannelCode:'AMAZON_NA'} with NO fnSku key, so
    // reading it from there always yielded null and the FNSKU comparison below
    // could never fire (verified live on all 5 NMN multi-packs 2026-10-07).
    const fnsku = s.fnSku
      ?? (d.fulfillmentAvailability || []).find((f: any) => f.fulfillmentChannelCode === 'AMAZON_NA')?.fnSku
      ?? null;
    return { msku, asin: s.asin ?? null, upc, fnsku };
  } catch (err: any) {
    if (err?.status === 404) return null;
    console.warn(`[auto-map] Listings API for ${msku} inconclusive (${err?.status ?? ''} ${err?.message ?? err})`);
    return null;
  }
}

export async function autoResolveAmazonSku(args: {
  cin7Sku: string;
  shipheroBarcode: string | null | undefined;
  db: SupabaseClient;
  fetchListing?: typeof fetchListingByMsku;
}): Promise<{ amz_sku: string; amz_asin: string | null; amz_fnsku: string | null } | null> {
  let listing: AutoMapping | null = null;
  try { listing = await (args.fetchListing ?? fetchListingByMsku)(args.cin7Sku); }
  catch (e: any) { console.warn(`[auto-map] ${args.cin7Sku}: listing lookup threw (${e?.message || e}) — not auto-mapping`); return null; }
  if (!listing) return null;
  const verdict = acceptAutoMapping(listing.upc, listing.fnsku, args.shipheroBarcode);
  if (verdict !== 'accept') {
    console.warn(`[auto-map] ${args.cin7Sku}: Amazon has an offer with that MSKU but ShipHero barcode ${args.shipheroBarcode ?? '?'} matches neither UPC ${listing.upc ?? '?'} nor FNSKU ${listing.fnsku ?? '?'} — ${verdict}, not auto-mapping`);
    return null;
  }
  const matchedOn = barcodesMatch(listing.upc, args.shipheroBarcode) === true ? `UPC ${listing.upc}` : `FNSKU ${listing.fnsku}`;
  try {
    await args.db.from('sku_master').insert({
      cin7_sku: args.cin7Sku, amazon_seller_sku: listing.msku, amazon_asin: listing.asin, verified: false,
      notes: `auto-mapped ${new Date().toISOString().slice(0, 10)} by preflight: Amazon offer MSKU == CIN7 SKU and listing ${matchedOn} == ShipHero barcode`,
    });
    console.log(`[auto-map] ${args.cin7Sku} → ${listing.msku} (${listing.asin}) matched on ${matchedOn}, recorded in sku_master`);
  } catch (e: any) {
    console.warn(`[auto-map] ${args.cin7Sku}: mapping accepted but sku_master insert failed (will re-resolve next tick): ${e?.message || e}`);
  }
  return { amz_sku: listing.msku, amz_asin: listing.asin, amz_fnsku: listing.fnsku };
}
