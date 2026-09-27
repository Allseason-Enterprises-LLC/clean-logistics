/**
 * Product identity + barcode for a kit work order.
 *
 * What the floor needs to kit a multi-pack for Amazon (Weston 2026-09-27):
 *   • the product name, CIN7 SKU, Amazon MSKU/ASIN
 *   • the barcode that goes ON the finished pack — FNSKU (Code128) if Amazon
 *     has assigned one, else the ASIN's UPC (UPC-A)
 *   • Transparency stickers (from Amazon; we can only instruct)
 * If neither barcode is known, the notice tells them to download it from
 * Seller Central rather than guessing.
 *
 * FNSKU truth = Amazon FBA inventory summaries (memory rule: page fully, pg1
 * lies). UPC truth = Amazon catalog item identifiers. Both are read-only.
 * TR-00484's bundle ASIN had never been in FBA → UPC only, no FNSKU.
 */
import { callAmazonSpApi } from './amazon-sp-api-client';

export interface KitProductIdentity {
  cin7Sku: string;
  amazonMsku: string | null;
  asin: string | null;
  productName: string | null;
  fnsku: string | null;
  upc: string | null;
  /** which barcode the floor should put on the pack */
  barcode: { kind: 'FNSKU' | 'UPC'; value: string; bcid: 'code128' | 'upca' } | null;
  notes: string[];
}

const MARKETPLACE = 'ATVPDKIKX0DER';

/** Find the FNSKU for an MSKU or ASIN by paging FBA inventory fully. */
export async function findFnsku(args: { msku?: string | null; asin?: string | null }, api = callAmazonSpApi): Promise<{ fnsku: string; msku: string; asin: string } | null> {
  if (!args.msku && !args.asin) return null;
  let nextToken: string | undefined;
  for (let page = 0; page < 30; page++) {
    const r: any = await api({
      method: 'GET', path: '/fba/inventory/v1/summaries',
      query: { details: true, granularityType: 'Marketplace', granularityId: MARKETPLACE, marketplaceIds: MARKETPLACE,
        ...(args.msku && !nextToken ? { sellerSkus: args.msku } : {}), ...(nextToken ? { nextToken } : {}) },
    });
    const body = r?.body ?? r?.data ?? r;
    for (const s of body?.payload?.inventorySummaries || []) {
      const hit = (args.msku && s.sellerSku === args.msku) || (args.asin && s.asin === args.asin);
      if (hit && s.fnSku) return { fnsku: s.fnSku, msku: s.sellerSku, asin: s.asin };
    }
    nextToken = body?.pagination?.nextToken;
    if (!nextToken || args.msku) break; // sellerSkus filter is exact — one page is the answer
  }
  return null;
}

/** ASIN → { name, upc } from the catalog. */
export async function catalogIdentity(asin: string, api = callAmazonSpApi): Promise<{ name: string | null; upc: string | null; ean: string | null }> {
  const r: any = await api({ method: 'GET', path: `/catalog/2022-04-01/items/${asin}`, query: { marketplaceIds: MARKETPLACE, includedData: 'identifiers,summaries' } });
  const body = r?.body ?? r?.data ?? r;
  const ids: Array<{ identifierType: string; identifier: string }> = (body?.identifiers || []).flatMap((m: any) => m.identifiers || []);
  const upc = ids.find((i) => i.identifierType === 'UPC')?.identifier ?? null;
  const ean = ids.find((i) => i.identifierType === 'EAN')?.identifier ?? null;
  const name = (body?.summaries || [])[0]?.itemName ?? null;
  return { name, upc, ean };
}

export async function resolveKitProductIdentity(args: {
  cin7Sku: string; amazonMsku?: string | null; asin?: string | null;
  api?: typeof callAmazonSpApi;
}): Promise<KitProductIdentity> {
  const api = args.api ?? callAmazonSpApi;
  const out: KitProductIdentity = { cin7Sku: args.cin7Sku, amazonMsku: args.amazonMsku ?? null, asin: args.asin ?? null,
    productName: null, fnsku: null, upc: null, barcode: null, notes: [] };

  try {
    const f = await findFnsku({ msku: out.amazonMsku, asin: out.asin }, api);
    if (f) { out.fnsku = f.fnsku; out.amazonMsku = out.amazonMsku ?? f.msku; out.asin = out.asin ?? f.asin; }
    else out.notes.push('No FNSKU in FBA inventory — this ASIN has not been sent to FBA before.');
  } catch (e: any) { out.notes.push(`FNSKU lookup failed: ${e?.message || e}`); }

  if (out.asin) {
    try {
      const c = await catalogIdentity(out.asin, api);
      out.productName = c.name; out.upc = c.upc ?? (c.ean ? c.ean.replace(/^0/, '') : null);
    } catch (e: any) { out.notes.push(`Catalog lookup failed: ${e?.message || e}`); }
  }

  if (out.fnsku) out.barcode = { kind: 'FNSKU', value: out.fnsku, bcid: 'code128' };
  else if (out.upc && /^\d{12}$/.test(out.upc)) out.barcode = { kind: 'UPC', value: out.upc, bcid: 'upca' };
  return out;
}

/** Render the barcode as a PNG (bwip-js). Pure: no I/O besides the render. */
export async function renderBarcodePng(barcode: NonNullable<KitProductIdentity['barcode']>, caption?: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bwip = require('bwip-js');
  return bwip.toBuffer({ bcid: barcode.bcid, text: barcode.value, scale: 4, height: 14, includetext: true, textxalign: 'center',
    ...(caption ? { alttext: `${caption}  ${barcode.value}` } : {}) });
}

/** Pull an ASIN out of a free-text CIN7 Reference like "FBA B0HJN6KKVK - Cellnova 2PK". */
export function extractAsin(text: string | null | undefined): string | null {
  const m = /\b(B0[A-Z0-9]{8})\b/.exec(String(text || ''));
  return m ? m[1] : null;
}
