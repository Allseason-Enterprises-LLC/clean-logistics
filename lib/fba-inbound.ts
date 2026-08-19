/**
 * FBA Inbound workflow (Fulfillment Inbound API v2024-03-20).
 *
 * ARCHITECTURE: All Amazon SP-API calls route through the Supabase edge function
 * proxy (`amazon-sp-api`) via `callAmazonSpApi()`. No direct calls to
 * sellingpartnerapi-*.amazon.com — the proxy owns auth, token refresh, and logging.
 *
 * Orchestrates: createInboundPlan -> packing -> setPackingInformation -> placement
 * -> transport -> labels/prep.
 */

import { callAmazonSpApi, SpApiError, type Region } from './amazon-sp-api-client';

const MARKETPLACE_TO_REGION: Record<string, Region> = {
  ATVPDKIKX0DER: 'na', A2EUQ1WTGCTBG2: 'na', A1AM78C64UM0Y8: 'na',
  A1F83G8C2ARO7P: 'eu', A1PA6795UKMFR9: 'eu', A13V1IB3VIYBER: 'eu',
  A1RKKUPIHCS9HS: 'eu', APJ6JRA9NG5V4: 'eu', A21TJRUUN4KGV: 'fe',
  A1VC38T7YXB528: 'fe', AAHKV2X7AFYLW: 'fe', A39IBJ37TRP1C6: 'fe',
};

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 60; // 3 min

export interface FbaInboundOptions {
  /**
   * @deprecated Amazon credentials now live in the Supabase edge function proxy.
   * This field is kept for backward compatibility with existing callers but is ignored.
   */
  credentials?: { clientId: string; clientSecret: string; refreshToken: string };
  marketplaceId: string;
  /**
   * Optional callback fired immediately after the inbound plan is created (Step 1).
   * Use this to persist the planId early so retries can detect the in-progress plan
   * and avoid creating duplicates even if later steps fail (e.g. FBA_INB_0117).
   */
  onPlanCreated?: (planId: string) => Promise<void>;
  sourceAddress: {
    addressLine1: string;
    city: string;
    countryCode: string;
    name: string;
    phoneNumber: string;
    postalCode: string;
    stateOrProvinceCode?: string;
    addressLine2?: string;
    companyName?: string;
    email?: string;
  };
  items: Array<{ sellerSku: string; quantity: number; expiration?: string; prepOwner?: 'SELLER' | 'AMAZON' | 'NONE' }>;
  box: { length: number; width: number; height: number; weightLbs: number };
  boxQuantity?: number; // Number of boxes (cases). Defaults to 1.
  casePack?: number; // Units per box. If set, items quantity = casePack per box.
}

export interface FbaInboundResult {
  planId: string;
  shipmentIds: string[]; // v2024-03-20 internal shipment IDs (sh... format)
  shipmentConfirmationIds: string[]; // Confirmation IDs needed for labels (FBA... format)
  boxIds: string[]; // Box/carton IDs needed for UNIQUE labels (bxi... or similar format)
  labelsUrl: string | null;
  prepInstructions: Record<string, unknown> | null;
}

/**
 * Thrown when none of the placement options Amazon offered have AMAZON_PARTNERED_CARRIER
 * (UPS Ground SPD) coverage on EVERY shipment.
 *
 * Carries a structured diagnostic payload so the outer retry/alert layer can decide
 * whether to re-roll (cancel + retry with a fresh plan) or escalate to humans.
 *
 * Background: prior to commit shipping this class, the workflow blindly picked the
 * cheapest placement and only THEN checked partnered availability — failing the
 * whole workflow if that one placement had no partnered, even when other placements
 * did. The 2026-06-11 rescue (TR-00121, TR-00129) exposed this. The fix pre-vets
 * every placement and only throws when ALL fail.
 */
export class PartneredUnavailableError extends Error {
  constructor(
    public readonly diagnostics: {
      planId: string;
      placements: Array<{
        placementOptionId: string;
        fee: number;
        currency: string;
        shipments: number;
        partneredCoverage: number; // 0..1 = fraction of shipments with ≥1 partnered SPD
        carrierBreakdown: string[]; // sample of carriers offered (USE_YOUR_OWN_CARRIER suffix)
      }>;
    },
  ) {
    const summary = diagnostics.placements
      .map(p => `${p.placementOptionId.slice(0, 12)}…(fee=$${p.fee},ships=${p.shipments},partnered=${(p.partneredCoverage * 100).toFixed(0)}%)`)
      .join(' | ');
    super(
      `No placement has AMAZON_PARTNERED_CARRIER coverage on all shipments. ` +
      `Amazon offered ${diagnostics.placements.length} placement(s): ${summary}. ` +
      `Per Clean Nutra policy we never use our own carrier.`
    );
    this.name = 'PartneredUnavailableError';
  }
}

function getRegion(marketplaceId: string): Region {
  return MARKETPLACE_TO_REGION[marketplaceId] ?? 'na';
}

const FBA_INBOUND_BASE = '/inbound/fba/2024-03-20';

async function pollUntilSuccess(
  region: Region,
  operationId: string
): Promise<void> {
  console.log(`[fba-inbound] Polling operation ${operationId}...`);
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    try {
      const res = await callAmazonSpApi<any>({
        method: 'GET',
        region,
        path: `${FBA_INBOUND_BASE}/operations/${operationId}`,
      });
      const status = res.data?.operationStatus;
      console.log(`[fba-inbound] Poll ${i + 1}/${MAX_POLL_ATTEMPTS}: status=${status}`);
      if (status === 'SUCCESS') {
        console.log(`[fba-inbound] Operation ${operationId} succeeded`);
        return;
      }
      if (status === 'FAILED') {
        const problems = res.data?.operationProblems ?? [];
        console.error(`[fba-inbound] Operation ${operationId} FAILED:`, JSON.stringify(problems));
        throw new Error(`FBA operation failed: ${JSON.stringify(problems)}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    } catch (pollErr) {
      console.error(`[fba-inbound] Poll error for ${operationId}:`, pollErr);
      throw pollErr;
    }
  }
  throw new Error(`FBA operation timed out (operationId: ${operationId})`);
}

// Helper to extract detailed error from Amazon API responses
function extractAmazonError(e: unknown): string {
  const errObj = e as any;

  try {
    const fullError = JSON.stringify(errObj, Object.getOwnPropertyNames(errObj || {}), 2);
    console.log('[fba-inbound] Full error structure:', fullError);
  } catch {
    console.log('[fba-inbound] Could not stringify error object');
  }

  // 0. Our own SpApiError (from proxy): details holds Amazon's response body
  if (errObj instanceof SpApiError || errObj?.name === 'SpApiError') {
    const details = errObj.details;
    if (details?.errors && Array.isArray(details.errors)) {
      return JSON.stringify(details.errors);
    }
    if (details?.message) {
      return `${details.message}${details.code ? ` (${details.code})` : ''}`;
    }
    if (details) return JSON.stringify(details);
    return errObj.message || String(errObj);
  }

  // 1. Axios-style error with response.data
  if (errObj?.response?.data) {
    const data = errObj.response.data;
    if (data.errors && Array.isArray(data.errors)) {
      return JSON.stringify(data.errors);
    }
    if (data.message) {
      return `${data.message}${data.code ? ` (${data.code})` : ''}`;
    }
    return JSON.stringify(data);
  }

  // 2. Check response.body
  if (errObj?.response?.body) {
    try {
      const body = typeof errObj.response.body === 'string' ? JSON.parse(errObj.response.body) : errObj.response.body;
      if (body.errors) return JSON.stringify(body.errors);
      if (body.message) return body.message;
      return JSON.stringify(body);
    } catch {
      return String(errObj.response.body);
    }
  }

  // 3. 'body' directly
  if (errObj?.body) {
    try {
      const body = typeof errObj.body === 'string' ? JSON.parse(errObj.body) : errObj.body;
      if (body.errors) return JSON.stringify(body.errors);
      if (body.message) return body.message;
      return JSON.stringify(body);
    } catch {
      return String(errObj.body);
    }
  }

  // 4. ES2022 error cause
  if (errObj?.cause) {
    return extractAmazonError(errObj.cause);
  }

  // 5. 'data' directly on error
  if (errObj?.data) {
    return JSON.stringify(errObj.data);
  }

  // 6. statusCode + message
  if (errObj?.statusCode && errObj?.message) {
    return `${errObj.statusCode}: ${errObj.message}`;
  }

  // 7. Standard Error
  if (e instanceof Error) {
    return e.message;
  }

  return String(e);
}

export async function runFbaInboundWorkflow(
  options: FbaInboundOptions
): Promise<FbaInboundResult> {
  const startTime = Date.now();
  const region = getRegion(options.marketplaceId);

  console.log('[fba-inbound] [0.0s] Starting workflow (via amazon-sp-api proxy)');
  console.log('[fba-inbound] Creating inbound plan with options:', JSON.stringify({
    marketplaceId: options.marketplaceId,
    sourceAddress: options.sourceAddress,
    items: options.items,
    box: options.box,
  }, null, 2));

  // Step 0: Look up each MSKU's owner constraints.
  //
  // The source of truth for what we must send as `prepOwner`/`labelOwner` is
  // Amazon's `prepOwnerConstraint` / `labelOwnerConstraint` fields, NOT the
  // `prepCategory`. Subtle but critical: an MSKU can have `prepCategory=NONE`
  // (no prep work required) but still demand `prepOwnerConstraint=SELLER_ONLY`
  // (the seller must register as the owner of that no-op prep). We learned
  // this from CLN-MULTIMAG-01 (TR-00107):
  //   { prepCategory: NONE, prepOwnerConstraint: SELLER_ONLY,
  //     labelOwnerConstraint: SELLER_ONLY, allOwnersConstraint: MUST_MATCH }
  //
  // Constraint mapping → value we must send:
  //   prepOwnerConstraint=NONE_ONLY   → prepOwner=NONE
  //   prepOwnerConstraint=SELLER_ONLY → prepOwner=SELLER
  //   prepOwnerConstraint=AMAZON_ONLY → prepOwner=AMAZON
  // (Same for labelOwnerConstraint.)
  //
  // Amazon enforces this in BOTH createInboundPlan and setPackingInformation,
  // so we cache the resolved owners up-front and reuse in both steps.
  //
  // Default for unknown/missing constraint: SELLER. This is safe because:
  //   (a) SELLER was the historical default before any of this branching
  //   (b) Amazon will accept SELLER for any item that ALLOWS seller-owned
  //       prep or labeling; we'd rather over-attribute than under-attribute.
  console.log('[fba-inbound] Resolving owner constraints for MSKUs...');
  type OwnerVal = 'NONE' | 'SELLER' | 'AMAZON';
  const prepOwnerByMsku: Record<string, OwnerVal> = {};
  const labelOwnerByMsku: Record<string, OwnerVal> = {};

  function constraintToOwner(c: string | undefined | null): OwnerVal | null {
    if (!c) return null;
    if (c === 'NONE_ONLY') return 'NONE';
    if (c === 'SELLER_ONLY') return 'SELLER';
    if (c === 'AMAZON_ONLY') return 'AMAZON';
    return null; // unknown constraint shape — fall through to default
  }

  // Fetch an MSKU's prep details; shared by the loop below and the
  // UNKNOWN-prep auto-remediation re-fetch.
  const fetchPrepDetail = async (msku: string): Promise<any | undefined> => {
    const prepRes = await callAmazonSpApi<any>({
      method: 'GET',
      region,
      path: `${FBA_INBOUND_BASE}/items/prepDetails`,
      query: {
        marketplaceId: options.marketplaceId,
        mskus: msku,
      },
    });
    return (prepRes.data?.mskuPrepDetails ?? []).find((d: any) => d.msku === msku);
  };

  // New-SKU auto-remediation. Newly created listings have prepCategory=UNKNOWN
  // (nobody set prep classification in Seller Central), and createInboundPlan
  // hard-fails with FBA_INB_0182 (Prep classification missing) for such MSKUs.
  // Fix it the way we fixed CN-POW-WMNSCREATISW-30SV (TR-00341, 2026-08-19):
  // POST setPrepDetails with prepCategory=NONE. Amazon quirk: for category
  // NONE it requires prepTypes=[ITEM_NO_PREP] EXACTLY (ITEM_LABELING is
  // rejected with 400; Amazon adds ITEM_LABELING itself afterwards).
  const fixUnknownPrep = async (msku: string): Promise<any | undefined> => {
    console.warn(`[fba-inbound] ${msku}: prepCategory=UNKNOWN — auto-setting prep classification (NONE/ITEM_NO_PREP)`);
    const setRes = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/items/prepDetails`,
      body: {
        marketplaceId: options.marketplaceId,
        mskuPrepDetails: [{ msku, prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] }],
      },
    });
    const opId = setRes.data?.operationId;
    if (opId) await pollUntilSuccess(region, opId);
    const detail = await fetchPrepDetail(msku);
    console.log(`[fba-inbound] ${msku}: prep classification set → ${JSON.stringify(detail ?? null)}`);
    return detail;
  };

  for (const item of options.items) {
    try {
      let detail = await fetchPrepDetail(item.sellerSku);
      if (detail?.prepCategory === 'UNKNOWN') {
        try {
          detail = (await fixUnknownPrep(item.sellerSku)) ?? detail;
        } catch (fixErr: unknown) {
          console.warn(`[fba-inbound] ${item.sellerSku}: UNKNOWN-prep auto-fix failed (continuing; createInboundPlan may reject):`, fixErr);
        }
      }
      const prepCategory = detail?.prepCategory;
      const prepOwnerC = detail?.prepOwnerConstraint;
      const labelOwnerC = detail?.labelOwnerConstraint;

      const resolvedPrepOwner = constraintToOwner(prepOwnerC);
      const resolvedLabelOwner = constraintToOwner(labelOwnerC);
      if (resolvedPrepOwner) prepOwnerByMsku[item.sellerSku] = resolvedPrepOwner;
      if (resolvedLabelOwner) labelOwnerByMsku[item.sellerSku] = resolvedLabelOwner;

      console.log(
        `[fba-inbound] ${item.sellerSku}: prepCategory=${prepCategory ?? '-'} ` +
        `prepOwnerConstraint=${prepOwnerC ?? '-'} → prepOwner=${prepOwnerByMsku[item.sellerSku] ?? 'default=SELLER'}, ` +
        `labelOwnerConstraint=${labelOwnerC ?? '-'} → labelOwner=${labelOwnerByMsku[item.sellerSku] ?? 'default=SELLER'}`
      );
    } catch (prepErr: unknown) {
      console.warn(`[fba-inbound] Could not fetch prepDetails for ${item.sellerSku} — defaulting to SELLER:`, prepErr);
      // Fall through with no entries — items.map below defaults to SELLER for both.
    }
  }

  // Step 1: Create Inbound Plan
  let createRes: any;
  console.log('[fba-inbound] Calling createInboundPlan...');

  // Helper to build the item list — reused if we need to retry with corrected owners.
  const buildItems = () => options.items.map((i) => ({
    msku: i.sellerSku,
    quantity: i.quantity,
    // Use Amazon's per-MSKU owner constraints (resolved in Step 0).
    // Default to SELLER for both when we couldn't resolve — historically
    // safe, accepted by Amazon for items that allow seller ownership.
    labelOwner: (labelOwnerByMsku[i.sellerSku] ?? 'SELLER') as OwnerVal,
    prepOwner: (prepOwnerByMsku[i.sellerSku] ?? 'SELLER') as OwnerVal,
    ...(i.expiration ? { expiration: i.expiration } : {}),
  }));

  const doCreatePlan = async () => callAmazonSpApi<any>({
    method: 'POST',
    region,
    path: `${FBA_INBOUND_BASE}/inboundPlans`,
    body: {
      destinationMarketplaces: [options.marketplaceId],
      sourceAddress: {
        addressLine1: options.sourceAddress.addressLine1,
        city: options.sourceAddress.city,
        countryCode: options.sourceAddress.countryCode,
        name: options.sourceAddress.name,
        phoneNumber: options.sourceAddress.phoneNumber,
        postalCode: options.sourceAddress.postalCode,
        stateOrProvinceCode: options.sourceAddress.stateOrProvinceCode,
        addressLine2: options.sourceAddress.addressLine2,
        companyName: options.sourceAddress.companyName,
        email: options.sourceAddress.email,
      },
      items: buildItems(),
    },
  });

  try {
    const res = await doCreatePlan();
    createRes = res.data;
    console.log('[fba-inbound] createInboundPlan response:', JSON.stringify(createRes));
  } catch (e: unknown) {
    console.error('[fba-inbound] createInboundPlan EXCEPTION:', e);
    const errDetail = extractAmazonError(e);
    console.error('[fba-inbound] Extracted error:', errDetail);

    // Owner-mismatch recovery. Amazon returns messages like:
    //   "ERROR: <MSKU> does not require prepOwner but SELLER was assigned. Accepted values: [NONE]"
    //   "ERROR: <MSKU> does not require labelOwner but SELLER was assigned. Accepted values: [NONE]"
    // This happens when `/items/prepDetails` didn't return a constraint (e.g.
    // inactive listing) and we fell back to SELLER, but Amazon actually wants NONE.
    // Parse the accepted value from the error and retry once.
    const ownerErrRe = /([A-Z0-9\-_]+)\s+does not require (prepOwner|labelOwner) but \w+ was assigned\.\s*Accepted values:\s*\[([A-Z, ]+)\]/gi;
    let m: RegExpExecArray | null;
    let correctedAny = false;
    const errStr = String(errDetail);
    while ((m = ownerErrRe.exec(errStr)) !== null) {
      const [, msku, ownerField, acceptedRaw] = m;
      const accepted = acceptedRaw.split(',').map(s => s.trim()).filter(Boolean)[0];
      if (msku && accepted && (accepted === 'NONE' || accepted === 'SELLER' || accepted === 'AMAZON')) {
        if (ownerField === 'prepOwner') prepOwnerByMsku[msku] = accepted as OwnerVal;
        else labelOwnerByMsku[msku] = accepted as OwnerVal;
        console.warn(`[fba-inbound] Owner-mismatch recovery: setting ${ownerField}=${accepted} for ${msku}`);
        correctedAny = true;
      }
    }

    if (correctedAny) {
      console.log('[fba-inbound] Retrying createInboundPlan with corrected owners...');
      try {
        const res2 = await doCreatePlan();
        createRes = res2.data;
        console.log('[fba-inbound] createInboundPlan (retry) response:', JSON.stringify(createRes));
      } catch (e2: unknown) {
        const errDetail2 = extractAmazonError(e2);
        console.error('[fba-inbound] Retry also failed:', errDetail2);
        throw new Error(`createInboundPlan failed: ${errDetail2}`);
      }
    } else if (/FBA_INB_0182/i.test(errStr) && /[Pp]rep classi/.test(errStr)) {
      // Prep-classification safety net. The pre-flight UNKNOWN-prep fix above
      // should normally prevent this, but if the prepDetails fetch failed (so
      // we never saw UNKNOWN) Amazon still rejects the plan with FBA_INB_0182.
      // Fix every item's prep classification and retry once.
      console.warn('[fba-inbound] FBA_INB_0182 prep-classification error — auto-fixing prep for all items and retrying once...');
      for (const item of options.items) {
        try {
          // Only overwrite prep for SKUs that are genuinely unclassified —
          // never clobber a legit existing prep category.
          const cur = await fetchPrepDetail(item.sellerSku).catch(() => undefined);
          if (cur && cur.prepCategory && cur.prepCategory !== 'UNKNOWN') {
            console.log(`[fba-inbound] ${item.sellerSku}: prepCategory=${cur.prepCategory} already set — skipping auto-fix`);
            continue;
          }
          const d = await fixUnknownPrep(item.sellerSku);
          const rp = constraintToOwner(d?.prepOwnerConstraint);
          const rl = constraintToOwner(d?.labelOwnerConstraint);
          if (rp) prepOwnerByMsku[item.sellerSku] = rp;
          if (rl) labelOwnerByMsku[item.sellerSku] = rl;
        } catch (fixErr: unknown) {
          console.warn(`[fba-inbound] prep auto-fix failed for ${item.sellerSku}:`, fixErr);
        }
      }
      try {
        const res2 = await doCreatePlan();
        createRes = res2.data;
        console.log('[fba-inbound] createInboundPlan (post-prep-fix retry) response:', JSON.stringify(createRes));
      } catch (e2: unknown) {
        const errDetail2 = extractAmazonError(e2);
        console.error('[fba-inbound] Post-prep-fix retry also failed:', errDetail2);
        throw new Error(`createInboundPlan failed (after prep auto-fix): ${errDetail2}`);
      }
    } else {
      throw new Error(`createInboundPlan failed: ${errDetail}`);
    }
  }

  const { inboundPlanId, operationId: createOpId } = createRes ?? {};
  if (!inboundPlanId || !createOpId) throw new Error('createInboundPlan: missing inboundPlanId or operationId');
  await pollUntilSuccess(region, createOpId);
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 1 COMPLETE: createInboundPlan`);

  // Fire early-persistence callback so callers can record the planId before later steps
  // fail. This prevents duplicate plan creation on retries (e.g. FBA_INB_0117).
  if (options.onPlanCreated) {
    try {
      await options.onPlanCreated(inboundPlanId);
    } catch (cbErr: unknown) {
      console.warn('[fba-inbound] onPlanCreated callback failed (non-fatal):', cbErr);
    }
  }

  // Step 2: Generate Packing Options
  console.log('[fba-inbound] Step 2: generatePackingOptions...');
  let packGenData: any;
  try {
    const res = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/packingOptions`,
      body: {},
    });
    packGenData = res.data;
    console.log('[fba-inbound] generatePackingOptions response:', JSON.stringify(packGenData));
  } catch (e) {
    console.error('[fba-inbound] generatePackingOptions failed:', e);
    throw new Error(`generatePackingOptions failed: ${extractAmazonError(e)}`);
  }
  const packGenOpId = packGenData?.operationId;
  if (!packGenOpId) throw new Error('generatePackingOptions: missing operationId');
  await pollUntilSuccess(region, packGenOpId);
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 2 COMPLETE: generatePackingOptions`);

  // Step 3: List Packing Options
  console.log('[fba-inbound] Step 3: listPackingOptions...');
  let packListData: any;
  try {
    const res = await callAmazonSpApi<any>({
      method: 'GET',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/packingOptions`,
    });
    packListData = res.data;
    console.log('[fba-inbound] listPackingOptions response:', JSON.stringify(packListData));
  } catch (e) {
    console.error('[fba-inbound] listPackingOptions failed:', e);
    throw new Error(`listPackingOptions failed: ${extractAmazonError(e)}`);
  }
  const packOpts = packListData?.packingOptions ?? [];
  if (packOpts.length === 0) throw new Error('listPackingOptions: no options');
  const first = packOpts[0];
  const packingOptionId = first.packingOptionId;
  const packingGroupId = (first.packingGroups ?? [])[0];
  if (!packingOptionId || !packingGroupId) throw new Error('Packing option missing packingOptionId or packingGroups');

  // Step 4: Confirm Packing Option
  console.log('[fba-inbound] Step 4: confirmPackingOption...');
  try {
    const res = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/packingOptions/${packingOptionId}/confirmation`,
      body: {},
    });
    console.log('[fba-inbound] confirmPackingOption response:', JSON.stringify(res.data));
    const confirmPackOpId = res.data?.operationId;
    if (confirmPackOpId) await pollUntilSuccess(region, confirmPackOpId);
  } catch (e) {
    console.error('[fba-inbound] confirmPackingOption failed:', e);
    throw new Error(`confirmPackingOption failed: ${extractAmazonError(e)}`);
  }
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 4 COMPLETE: confirmPackingOption`);

  // Step 5: Set Packing Information
  console.log('[fba-inbound] Step 5: setPackingInformation...');
  try {
    const res = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/packingInformation`,
      // CASE-PACKED submission: ONE Box entry with quantity = total boxes.
      // Every box has identical contents (single MSKU, `casePack` units per box).
      // Sending N separate Box entries (quantity:1 each) puts Amazon into the
      // "mixed individual units" workflow even when boxes are identical, which
      // makes Seller Central show pack_mixed_unit_step instead of case-packed.
      // Reference: SP-API FBA Inbound 2024-03-20 setPackingInformation — Box.quantity
      // is the number of IDENTICAL boxes when items are uniform.
      body: {
        packageGroupings: [
          {
            packingGroupId,
            boxes: [
              {
                contentInformationSource: 'BOX_CONTENT_PROVIDED',
                dimensions: {
                  length: options.box.length,
                  width: options.box.width,
                  height: options.box.height,
                  unitOfMeasurement: 'IN',
                },
                weight: { value: options.box.weightLbs, unit: 'LB' },
                quantity: options.boxQuantity || 1,
                items: options.items.map((i) => ({
                  msku: i.sellerSku,
                  quantity: options.casePack || i.quantity,
                  // Reuse the resolved owners from Step 0. Amazon validates these
                  // against the plan's recorded values and rejects packing with
                  // "Package group ... did not contain expected items" if they
                  // don't match what was registered in createInboundPlan.
                  labelOwner: (labelOwnerByMsku[i.sellerSku] ?? 'SELLER') as OwnerVal,
                  prepOwner: (prepOwnerByMsku[i.sellerSku] ?? 'SELLER') as OwnerVal,
                  ...(i.expiration ? { expiration: i.expiration } : {}),
                })),
              },
            ],
          },
        ],
      },
    });
    console.log('[fba-inbound] setPackingInformation response:', JSON.stringify(res.data));
    const setPackOpId = res.data?.operationId;
    if (setPackOpId) await pollUntilSuccess(region, setPackOpId);
  } catch (e) {
    console.error('[fba-inbound] setPackingInformation failed:', e);
    throw new Error(`setPackingInformation failed: ${extractAmazonError(e)}`);
  }
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 5 COMPLETE: setPackingInformation`);

  // Step 6: Generate Placement Options
  console.log('[fba-inbound] Step 6: generatePlacementOptions...');
  let placeGenData: any;
  try {
    const res = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/placementOptions`,
      body: {},
    });
    placeGenData = res.data;
    console.log('[fba-inbound] generatePlacementOptions response:', JSON.stringify(placeGenData));
  } catch (e) {
    console.error('[fba-inbound] generatePlacementOptions failed:', e);
    throw new Error(`generatePlacementOptions failed: ${extractAmazonError(e)}`);
  }
  const placeGenOpId = placeGenData?.operationId;
  if (!placeGenOpId) throw new Error('generatePlacementOptions: missing operationId');
  await pollUntilSuccess(region, placeGenOpId);
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 6 COMPLETE: generatePlacementOptions`);

  // Step 7: List Placement Options
  console.log('[fba-inbound] Step 7: listPlacementOptions...');
  let placeListData: any;
  try {
    const res = await callAmazonSpApi<any>({
      method: 'GET',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/placementOptions`,
    });
    placeListData = res.data;
    console.log('[fba-inbound] listPlacementOptions response:', JSON.stringify(placeListData));
  } catch (e) {
    console.error('[fba-inbound] listPlacementOptions failed:', e);
    throw new Error(`listPlacementOptions failed: ${extractAmazonError(e)}`);
  }
  const placeOpts = placeListData?.placementOptions ?? [];
  if (placeOpts.length === 0) throw new Error('listPlacementOptions: no options');

  // Log every placement option for cost transparency
  const placementSummary = placeOpts.map((p: any) => {
    const fees = p.fees ?? [];
    const totalFee = fees.reduce((sum: number, f: any) => sum + (f?.value?.amount ?? 0), 0);
    const currency = fees[0]?.value?.code ?? 'USD';
    return {
      placementOptionId: p.placementOptionId,
      shipments: p.shipmentIds?.length ?? 0,
      totalFee,
      currency,
      discounts: p.discounts?.length ?? 0,
    };
  });
  console.log('[fba-inbound] Placement options:', JSON.stringify(placementSummary));

  // Pre-vet ALL placements before picking. The old logic blindly picked the cheapest
  // placement, then failed at Step 9 if that placement happened to have zero
  // AMAZON_PARTNERED_CARRIER (UPS SPD) options — even when OTHER placements would have
  // worked fine. This broke TR-00121 and TR-00129 on 2026-06-11 because Amazon offered
  // multiple $0-fee splits with different partnered coverage and the picker tie-broke
  // on array order.
  //
  // Strategy now:
  //   1. For EVERY placement Amazon offered, generate + list transportation options.
  //   2. A placement is "viable" if EVERY shipment under it has ≥1 partnered SPD option.
  //   3. Among viable placements, pick lowest fee → fewest shipments → cheapest partnered total cost.
  //   4. If NO placement is viable, throw PartneredUnavailableError with full diagnostics.
  //      The outer retry layer in auto-submit decides whether to re-roll or escalate.
  //
  // Cost: O(N) more SP-API calls (one TO probe per placement). Typical workflows have
  // 3-5 placements, adding ~30-60s. The existing workflow budget is 300s (Vercel maxDuration),
  // so this is well within bounds.

  console.log('[fba-inbound] Step 7.5: pre-vetting ALL placements for partnered SPD coverage...');

  // Shared transportation-options inputs (same for every placement probe)
  const contactInformation = {
    name: options.sourceAddress.name,
    phoneNumber: options.sourceAddress.phoneNumber,
    email: options.sourceAddress.email || 'shipping@cleannutra.com',
  };
  const readyStart = new Date();
  readyStart.setDate(readyStart.getDate() + 1);
  const readyEnd = new Date(readyStart);
  readyEnd.setDate(readyEnd.getDate() + 7);
  const readyStartIso = readyStart.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const readyEndIso = readyEnd.toISOString().replace(/\.\d{3}Z$/, 'Z');

  type PlacementProbe = {
    placement: any;
    fee: number;
    optsByShipment: Map<string, any[]>; // shipmentId → all transport options
    partneredViable: boolean; // true if EVERY shipment has ≥1 partnered SPD
  };

  // Probe placements sequentially to stay under SP-API rate limits. The transportationOptions
  // POST is rate-limited at 0.025 req/sec (1 per 40s) per Amazon docs — but typical workflows
  // have ≤5 placements so this is fine. Parallel calls have historically caused 429s.
  const LTL_MODES = new Set(['FREIGHT_LTL', 'FREIGHT_FTL_PALLET', 'FREIGHT_FTL_NONPALLET', 'PARTIAL_TRUCK_LOAD', 'FULL_TRUCK_LOAD']);
  const placementProbes: PlacementProbe[] = [];

  for (const p of placeOpts) {
    const fee = (p.fees ?? []).reduce((s: number, f: any) => s + (f?.value?.amount ?? 0), 0);
    const shipIds: string[] = p.shipmentIds ?? [];
    if (shipIds.length === 0) {
      placementProbes.push({ placement: p, fee, optsByShipment: new Map(), partneredViable: false });
      continue;
    }

    // generateTransportationOptions for this placement
    try {
      const gen = await callAmazonSpApi<any>({
        method: 'POST',
        region,
        path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/transportationOptions`,
        body: {
          placementOptionId: p.placementOptionId,
          shipmentTransportationConfigurations: shipIds.map((sid) => ({
            shipmentId: sid,
            contactInformation,
            readyToShipWindow: { start: readyStartIso, end: readyEndIso },
          })),
        },
      });
      const opId = gen.data?.operationId;
      if (opId) await pollUntilSuccess(region, opId);
    } catch (e) {
      console.warn(`[fba-inbound] pre-vet generateTransportationOptions failed for placement ${p.placementOptionId}: ${extractAmazonError(e)}`);
      placementProbes.push({ placement: p, fee, optsByShipment: new Map(), partneredViable: false });
      continue;
    }

    // listTransportationOptions for each shipment under this placement, with pagination
    const optsByShipment = new Map<string, any[]>();
    let perPlacementError = false;
    for (const sid of shipIds) {
      try {
        let allOpts: any[] = [];
        let nextToken: string | undefined;
        do {
          const qp: Record<string, string> = { shipmentId: sid };
          if (nextToken) qp.paginationToken = nextToken;
          const r = await callAmazonSpApi<any>({
            method: 'GET',
            region,
            path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/transportationOptions`,
            query: qp,
          });
          allOpts = allOpts.concat(r.data?.transportationOptions ?? []);
          nextToken = r.data?.pagination?.nextToken;
        } while (nextToken);
        optsByShipment.set(sid, allOpts.filter((o: any) => !LTL_MODES.has(o.shippingMode)));
      } catch (e) {
        console.warn(`[fba-inbound] pre-vet listTransportationOptions failed for placement ${p.placementOptionId} shipment ${sid}: ${extractAmazonError(e)}`);
        perPlacementError = true;
        optsByShipment.set(sid, []);
      }
    }
    if (perPlacementError) {
      placementProbes.push({ placement: p, fee, optsByShipment, partneredViable: false });
      continue;
    }

    // Viability = EVERY shipment has ≥1 AMAZON_PARTNERED_CARRIER option (any mode)
    const partneredCounts = shipIds.map((sid) => {
      const opts = optsByShipment.get(sid) ?? [];
      return opts.filter((o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER').length;
    });
    const partneredViable = partneredCounts.every((n) => n > 0);
    placementProbes.push({ placement: p, fee, optsByShipment, partneredViable });

    const partneredSummary = partneredCounts.join('/');
    console.log(
      `[fba-inbound]   placement ${p.placementOptionId.slice(0, 12)}… ` +
      `fee=$${fee} ships=${shipIds.length} partneredPerShipment=[${partneredSummary}] viable=${partneredViable}`
    );
  }

  // Pick the best placement among viable ones
  const viable = placementProbes.filter((pr) => pr.partneredViable);
  if (viable.length === 0) {
    // Build diagnostic for the outer layer to log/alert/retry
    const diagPlacements = placementProbes.map((pr) => {
      const shipIds: string[] = pr.placement.shipmentIds ?? [];
      const partneredCount = shipIds.filter((sid) => (pr.optsByShipment.get(sid) ?? []).some((o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER')).length;
      const carriers = new Set<string>();
      for (const sid of shipIds) {
        for (const o of pr.optsByShipment.get(sid) ?? []) {
          carriers.add(`${o.shippingSolution}/${o.carrier?.name ?? '?'}`);
        }
      }
      return {
        placementOptionId: pr.placement.placementOptionId,
        fee: pr.fee,
        currency: (pr.placement.fees?.[0]?.value?.code as string) ?? 'USD',
        shipments: shipIds.length,
        partneredCoverage: shipIds.length > 0 ? partneredCount / shipIds.length : 0,
        carrierBreakdown: Array.from(carriers).slice(0, 10),
      };
    });
    throw new PartneredUnavailableError({ planId: inboundPlanId, placements: diagPlacements });
  }

  // Sort viable: lowest fee → fewest shipments → cheapest total partnered cost
  viable.sort((a, b) => {
    if (a.fee !== b.fee) return a.fee - b.fee;
    const sA = a.placement.shipmentIds?.length ?? 99;
    const sB = b.placement.shipmentIds?.length ?? 99;
    if (sA !== sB) return sA - sB;
    // Tie-break: cheapest sum of cheapest-per-shipment partnered SPD costs
    const cheapestPartneredSum = (pr: PlacementProbe): number => {
      let sum = 0;
      for (const sid of pr.placement.shipmentIds ?? []) {
        const partnered = (pr.optsByShipment.get(sid) ?? []).filter((o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER');
        const costs = partnered.map((o: any) => (typeof o.quote?.cost?.amount === 'number' ? o.quote.cost.amount : Number.POSITIVE_INFINITY));
        sum += Math.min(...(costs.length ? costs : [Number.POSITIVE_INFINITY]));
      }
      return sum;
    };
    return cheapestPartneredSum(a) - cheapestPartneredSum(b);
  });

  const chosen = viable[0];
  const place = chosen.placement;
  const placeFee = chosen.fee;
  console.log(
    `[fba-inbound] Selected placement: ${place.placementOptionId} with ${place.shipmentIds?.length} shipment(s), ` +
    `placement fee: $${placeFee} (out of ${placeOpts.length} options, ${viable.length} viable for partnered)`
  );
  const placementOptionId = place.placementOptionId;
  const shipmentIds: string[] = place.shipmentIds ?? [];
  if (!placementOptionId || shipmentIds.length === 0) throw new Error('Placement option missing placementOptionId or shipmentIds');
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 7.5 COMPLETE: placement vetting`);

  // Cache the transportation options for the chosen placement so Step 9 doesn't re-fetch.
  const cachedOptsByShipment = chosen.optsByShipment;

  // Step 8 (formerly): Transportation options were already generated during pre-vet.
  // We just need to pick the cheapest AMAZON_PARTNERED_CARRIER option per shipment
  // from the cached results. No additional Amazon API calls needed here.
  console.log('[fba-inbound] Step 9: selecting partnered transport option per shipment (from cache)...');
  const transportSelections: Array<{ shipmentId: string; transportationOptionId: string }> = [];
  const shipmentsNeedingDeliveryWindow: Array<{ shipmentId: string; transportationOptionId: string }> = [];

  for (const sid of shipmentIds) {
    const nonLtlOpts = cachedOptsByShipment.get(sid) ?? [];
    const partneredOpts = nonLtlOpts.filter((o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER');

    if (partneredOpts.length === 0) {
      // Should be unreachable — pre-vet guarantees viable placements have ≥1 partnered per shipment.
      // Defensive throw in case Amazon's offered set changes between pre-vet and now.
      throw new Error(
        `Defensive failure: chosen placement has no partnered option for shipment ${sid}. ` +
        `This indicates a race between pre-vet and selection. Cancel the plan and retry.`
      );
    }

    partneredOpts.sort((a: any, b: any) => {
      const costA = typeof a.quote?.cost?.amount === 'number' ? a.quote.cost.amount : Number.POSITIVE_INFINITY;
      const costB = typeof b.quote?.cost?.amount === 'number' ? b.quote.cost.amount : Number.POSITIVE_INFINITY;
      return costA - costB;
    });

    const preferred = partneredOpts[0];
    if (!preferred?.transportationOptionId) throw new Error(`No transportation option for shipment ${sid}`);
    console.log(
      `[fba-inbound] Selected transport for ${sid}: ${preferred.transportationOptionId} ` +
      `(mode=${preferred.shippingMode}, carrier=${preferred.carrier?.name}, cost=$${preferred.quote?.cost?.amount}, preconditions=${JSON.stringify(preferred.preconditions)})`
    );
    transportSelections.push({ shipmentId: sid, transportationOptionId: preferred.transportationOptionId });

    const preconditions = preferred.preconditions ?? [];
    if (preconditions.includes('CONFIRMED_DELIVERY_WINDOW')) {
      console.log(`[fba-inbound] Shipment ${sid} requires CONFIRMED_DELIVERY_WINDOW`);
      shipmentsNeedingDeliveryWindow.push({ shipmentId: sid, transportationOptionId: preferred.transportationOptionId });
    }
  }

  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 9 COMPLETE: listTransportationOptions`);

  // Step 10: Generate + List Delivery Window Options (if required)
  const confirmedDeliveryWindows: Array<{ shipmentId: string; deliveryWindowOptionId: string }> = [];

  if (shipmentsNeedingDeliveryWindow.length > 0) {
    console.log(`[fba-inbound] Step 10: Generating delivery windows for ${shipmentsNeedingDeliveryWindow.length} shipment(s)...`);

    for (const { shipmentId } of shipmentsNeedingDeliveryWindow) {
      try {
        console.log(`[fba-inbound] generateDeliveryWindowOptions for ${shipmentId}...`);
        const genRes = await callAmazonSpApi<any>({
          method: 'POST',
          region,
          path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/deliveryWindowOptions`,
          body: {},
        });
        console.log(`[fba-inbound] generateDeliveryWindowOptions response for ${shipmentId}:`, JSON.stringify(genRes.data));

        const genDwOpId = genRes.data?.operationId;
        if (genDwOpId) {
          await pollUntilSuccess(region, genDwOpId);
        }
        console.log(`[fba-inbound] Delivery window options generated for ${shipmentId}`);

        console.log(`[fba-inbound] listDeliveryWindowOptions for ${shipmentId}...`);
        let dwOpts: any[] = [];
        const maxRetries = 3;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          const dwRes = await callAmazonSpApi<any>({
            method: 'GET',
            region,
            path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/deliveryWindowOptions`,
          });
          console.log(`[fba-inbound] listDeliveryWindowOptions for ${shipmentId} (attempt ${attempt + 1}):`, JSON.stringify(dwRes.data));

          dwOpts = dwRes.data?.deliveryWindowOptions ?? [];
          if (dwOpts.length > 0) {
            console.log(`[fba-inbound] Found ${dwOpts.length} delivery window options for ${shipmentId}`);
            break;
          }

          if (attempt < maxRetries - 1) {
            const waitTime = 5000 * (attempt + 1); // 5s, 10s, 15s
            console.log(`[fba-inbound] No delivery windows yet for ${shipmentId}, waiting ${waitTime}ms before retry...`);
            await new Promise(r => setTimeout(r, waitTime));
          }
        }

        if (dwOpts.length === 0) {
          console.error(`[fba-inbound] CRITICAL: No delivery window options available for ${shipmentId} after ${maxRetries} attempts`);
          throw new Error(`No delivery window options available for shipment ${shipmentId} after retries. Please try again later.`);
        }

        const selectedDw = dwOpts[0];
        const deliveryWindowOptionId = selectedDw.deliveryWindowOptionId;
        console.log(`[fba-inbound] Selected delivery window ${deliveryWindowOptionId} for ${shipmentId}:`, JSON.stringify(selectedDw));

        confirmedDeliveryWindows.push({ shipmentId, deliveryWindowOptionId });
      } catch (e) {
        console.error(`[fba-inbound] Failed to generate/list delivery windows for ${shipmentId}:`, e);
        throw new Error(`generateDeliveryWindowOptions failed for ${shipmentId}: ${extractAmazonError(e)}`);
      }
    }

    console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 10 COMPLETE: generateDeliveryWindowOptions`);
  }

  // Step 11: Confirm Placement Option
  console.log('[fba-inbound] Step 11: confirmPlacementOption...');
  try {
    const res = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/placementOptions/${placementOptionId}/confirmation`,
      body: {},
    });
    console.log('[fba-inbound] confirmPlacementOption response:', JSON.stringify(res.data));
    const confirmPlaceOpId = res.data?.operationId;
    if (confirmPlaceOpId) await pollUntilSuccess(region, confirmPlaceOpId);
  } catch (e) {
    console.error('[fba-inbound] confirmPlacementOption failed:', e);
    throw new Error(`confirmPlacementOption failed: ${extractAmazonError(e)}`);
  }

  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 11 COMPLETE: confirmPlacementOption`);

  // Step 12: Confirm Delivery Window Options (if any)
  if (confirmedDeliveryWindows.length > 0) {
    console.log(`[fba-inbound] Step 12: Confirming ${confirmedDeliveryWindows.length} delivery window(s)...`);

    for (const { shipmentId, deliveryWindowOptionId } of confirmedDeliveryWindows) {
      try {
        console.log(`[fba-inbound] confirmDeliveryWindowOptions for ${shipmentId}...`);
        const res = await callAmazonSpApi<any>({
          method: 'POST',
          region,
          path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/deliveryWindowOptions/${deliveryWindowOptionId}/confirmation`,
          body: {},
        });
        console.log(`[fba-inbound] confirmDeliveryWindowOptions response for ${shipmentId}:`, JSON.stringify(res.data));

        const confirmDwOpId = res.data?.operationId;
        if (confirmDwOpId) await pollUntilSuccess(region, confirmDwOpId);
        console.log(`[fba-inbound] Delivery window confirmed for shipment ${shipmentId}`);
      } catch (e) {
        console.error(`[fba-inbound] Failed to confirm delivery window for ${shipmentId}:`, e);
        throw new Error(`confirmDeliveryWindowOptions failed for ${shipmentId}: ${extractAmazonError(e)}`);
      }
    }

    console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 12 COMPLETE: confirmDeliveryWindowOptions`);
  }

  // Step 13: Confirm Transportation Options
  console.log('[fba-inbound] Step 13: confirmTransportationOptions...');
  try {
    const res = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/transportationOptions/confirmation`,
      body: { transportationSelections: transportSelections },
    });
    console.log('[fba-inbound] confirmTransportationOptions response:', JSON.stringify(res.data));
    const confirmTransOpId = res.data?.operationId;
    if (confirmTransOpId) await pollUntilSuccess(region, confirmTransOpId);
  } catch (e) {
    console.error('[fba-inbound] confirmTransportationOptions failed:', e);
    throw new Error(`confirmTransportationOptions failed: ${extractAmazonError(e)}`);
  }

  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 13 COMPLETE: confirmTransportationOptions`);

  // Get prep instructions (non-fatal)
  let prepInstructions: Record<string, unknown> | null = null;
  try {
    const res = await callAmazonSpApi<any>({
      method: 'GET',
      region,
      path: `${FBA_INBOUND_BASE}/items/prepDetails`,
      query: {
        marketplaceId: options.marketplaceId,
        mskus: options.items.map((i) => i.sellerSku).join(','),
      },
    });
    prepInstructions = res.data ?? null;
  } catch {
    // non-fatal
  }

  // Fetch shipmentConfirmationIds (FBA... format) for v0 labels API
  console.log('[fba-inbound] Fetching shipmentConfirmationIds via getShipment...');
  const shipmentConfirmationIds: string[] = [];
  for (const shipmentId of shipmentIds) {
    try {
      const res = await callAmazonSpApi<any>({
        method: 'GET',
        region,
        path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}`,
      });
      const confirmationId = res.data?.shipmentConfirmationId;
      if (confirmationId) {
        shipmentConfirmationIds.push(confirmationId);
        console.log(`[fba-inbound] Shipment ${shipmentId} -> confirmationId: ${confirmationId}`);
      } else {
        console.log(`[fba-inbound] Shipment ${shipmentId} has no confirmationId yet`);
      }
    } catch (e) {
      console.error(`[fba-inbound] Failed to get shipment ${shipmentId}:`, e);
    }
  }

  // Note: v2024-03-20 API does not include getLabels — use v0 with shipmentConfirmationId
  const labelsUrl: string | null = null;

  // Fetch box IDs for UNIQUE labels
  console.log('[fba-inbound] Waiting 3 seconds for Amazon to process shipment before fetching box IDs...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('[fba-inbound] Fetching box IDs via listShipmentBoxes...');
  const boxIds: string[] = [];

  const maxBoxRetries = 3;
  for (let attempt = 1; attempt <= maxBoxRetries && boxIds.length === 0; attempt++) {
    for (const shipmentId of shipmentIds) {
      try {
        let paginationToken: string | undefined;
        do {
          const boxesRes = await callAmazonSpApi<any>({
            method: 'GET',
            region,
            path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/boxes`,
            query: paginationToken ? { paginationToken } : undefined,
          });
          const boxes = boxesRes.data?.boxes || [];
          console.log(`[fba-inbound] listShipmentBoxes response for ${shipmentId} (attempt ${attempt})${paginationToken ? ' (continued)' : ''}:`,
            `${boxes.length} boxes, pagination: ${JSON.stringify(boxesRes.data?.pagination)}`);

          for (const box of boxes) {
            const boxId = box.boxId || box.packageId || box.cartonId || box.contentId || box.id;
            if (boxId) {
              boxIds.push(boxId);
            } else {
              console.warn(`[fba-inbound] Box has no recognizable ID field:`, Object.keys(box));
            }
          }

          paginationToken = boxesRes.data?.pagination?.nextToken;
          if (paginationToken) {
            console.log(`[fba-inbound] More boxes available, fetching next page...`);
          }
        } while (paginationToken);

      } catch (e) {
        console.error(`[fba-inbound] Failed to get boxes for shipment ${shipmentId} (attempt ${attempt}):`, e);
        // Continue - boxes might not be available immediately
      }
    }

    if (boxIds.length === 0 && attempt < maxBoxRetries) {
      console.log(`[fba-inbound] No box IDs found, waiting 3 seconds before retry ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`[fba-inbound] Found ${boxIds.length} total box IDs:`, boxIds);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[fba-inbound] ✅ WORKFLOW COMPLETE in ${totalTime}s!`);
  console.log(`[fba-inbound] Plan ID: ${inboundPlanId}`);
  console.log(`[fba-inbound] Shipment IDs (v2024-03-20): ${shipmentIds.join(', ')}`);
  console.log(`[fba-inbound] Shipment Confirmation IDs (for labels): ${shipmentConfirmationIds.join(', ')}`);
  console.log(`[fba-inbound] Box IDs (for UNIQUE labels): ${boxIds.join(', ')}`);

  return {
    planId: inboundPlanId,
    shipmentIds,
    shipmentConfirmationIds,
    boxIds,
    labelsUrl,
    prepInstructions,
  };
}
