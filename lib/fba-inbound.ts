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

  // Step 0: Ensure prep details are set for each MSKU
  console.log('[fba-inbound] Checking prep details for MSKUs...');
  for (const item of options.items) {
    try {
      const prepRes = await callAmazonSpApi<any>({
        method: 'GET',
        region,
        path: `${FBA_INBOUND_BASE}/items/prepDetails`,
        query: {
          marketplaceId: options.marketplaceId,
          mskus: item.sellerSku,
        },
      });
      const mskuPrepDetail = (prepRes.data?.mskuPrepDetails ?? []);
      const detail = mskuPrepDetail.find((d: any) => d.msku === item.sellerSku);
      const prepCategory = detail?.prepCategory;
      console.log(`[fba-inbound] Prep details for ${item.sellerSku}: category=${prepCategory}`);

      if (!prepCategory || prepCategory === 'UNKNOWN') {
        console.log(`[fba-inbound] Setting prep category for ${item.sellerSku} to NONE...`);
        try {
          await callAmazonSpApi<any>({
            method: 'POST',
            region,
            path: `${FBA_INBOUND_BASE}/items/prepDetails`,
            body: {
              marketplaceId: options.marketplaceId,
              mskuPrepDetails: [{
                msku: item.sellerSku,
                prepCategory: 'NONE',
                prepTypes: ['ITEM_NO_PREP'],
              }],
            },
          });
          console.log(`[fba-inbound] Successfully set prep category for ${item.sellerSku}`);
        } catch (setPrepErr: unknown) {
          console.error(`[fba-inbound] Failed to set prep category for ${item.sellerSku}:`, setPrepErr);
          // Continue anyway — createInboundPlan might still work
        }
      }
    } catch (prepErr: unknown) {
      console.warn(`[fba-inbound] Could not check prep details for ${item.sellerSku}:`, prepErr);
      console.log(`[fba-inbound] Attempting to set prep category for ${item.sellerSku} to NONE (fallback)...`);
      try {
        await callAmazonSpApi<any>({
          method: 'POST',
          region,
          path: `${FBA_INBOUND_BASE}/items/prepDetails`,
          body: {
            marketplaceId: options.marketplaceId,
            mskuPrepDetails: [{
              msku: item.sellerSku,
              prepCategory: 'NONE',
              prepTypes: ['ITEM_NO_PREP'],
            }],
          },
        });
        console.log(`[fba-inbound] Successfully set prep category for ${item.sellerSku} (fallback)`);
      } catch (fallbackErr: unknown) {
        console.error(`[fba-inbound] Fallback setPrepDetails also failed for ${item.sellerSku}:`, fallbackErr);
      }
    }
  }

  // Step 1: Create Inbound Plan
  let createRes: any;
  console.log('[fba-inbound] Calling createInboundPlan...');
  try {
    const res = await callAmazonSpApi<any>({
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
        items: options.items.map((i) => ({
          msku: i.sellerSku,
          quantity: i.quantity,
          labelOwner: 'SELLER' as const,
          prepOwner: 'SELLER' as const,
          ...(i.expiration ? { expiration: i.expiration } : {}),
        })),
      },
    });
    createRes = res.data;
    console.log('[fba-inbound] createInboundPlan response:', JSON.stringify(createRes));
  } catch (e: unknown) {
    console.error('[fba-inbound] createInboundPlan EXCEPTION:', e);
    const errDetail = extractAmazonError(e);
    console.error('[fba-inbound] Extracted error:', errDetail);
    throw new Error(`createInboundPlan failed: ${errDetail}`);
  }

  const { inboundPlanId, operationId: createOpId } = createRes ?? {};
  if (!inboundPlanId || !createOpId) throw new Error('createInboundPlan: missing inboundPlanId or operationId');
  await pollUntilSuccess(region, createOpId);
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 1 COMPLETE: createInboundPlan`);

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
      body: {
        packageGroupings: [
          {
            packingGroupId,
            boxes: Array.from({ length: options.boxQuantity || 1 }, () => ({
              contentInformationSource: 'BOX_CONTENT_PROVIDED',
              dimensions: {
                length: options.box.length,
                width: options.box.width,
                height: options.box.height,
                unitOfMeasurement: 'IN',
              },
              weight: { value: options.box.weightLbs, unit: 'LB' },
              quantity: 1,
              items: options.items.map((i) => ({
                msku: i.sellerSku,
                quantity: options.casePack || i.quantity,
                labelOwner: 'SELLER' as const,
                prepOwner: (i.prepOwner || 'SELLER') as 'SELLER' | 'AMAZON' | 'NONE',
                ...(i.expiration ? { expiration: i.expiration } : {}),
              })),
            })),
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
  // Sort by fewest shipments (typically lowest total cost) then pick first
  placeOpts.sort((a: any, b: any) => (a.shipmentIds?.length ?? 99) - (b.shipmentIds?.length ?? 99));
  const place = placeOpts[0];
  console.log(`[fba-inbound] Selected placement: ${place.placementOptionId} with ${place.shipmentIds?.length} shipment(s) (out of ${placeOpts.length} options)`);
  const placementOptionId = place.placementOptionId;
  const shipmentIds: string[] = place.shipmentIds ?? [];
  if (!placementOptionId || shipmentIds.length === 0) throw new Error('Placement option missing placementOptionId or shipmentIds');
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 7 COMPLETE: listPlacementOptions`);

  const readyStart = new Date();
  readyStart.setDate(readyStart.getDate() + 1);
  const readyIso = readyStart.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Step 8: Generate Transportation Options
  console.log('[fba-inbound] Step 8: generateTransportationOptions...');
  let transGenData: any;
  try {
    const res = await callAmazonSpApi<any>({
      method: 'POST',
      region,
      path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/transportationOptions`,
      body: {
        placementOptionId,
        shipmentTransportationConfigurations: shipmentIds.map((sid) => ({
          shipmentId: sid,
          readyToShipWindow: { start: readyIso },
        })),
      },
    });
    transGenData = res.data;
    console.log('[fba-inbound] generateTransportationOptions response:', JSON.stringify(transGenData));
  } catch (e) {
    console.error('[fba-inbound] generateTransportationOptions failed:', e);
    throw new Error(`generateTransportationOptions failed: ${extractAmazonError(e)}`);
  }
  const transGenOpId = transGenData?.operationId;
  if (!transGenOpId) throw new Error('generateTransportationOptions: missing operationId');
  await pollUntilSuccess(region, transGenOpId);
  console.log(`[fba-inbound] [${((Date.now() - startTime) / 1000).toFixed(1)}s] Step 8 COMPLETE: generateTransportationOptions`);

  // Step 9: List and Select Transportation Options (with pagination)
  console.log('[fba-inbound] Step 9: listTransportationOptions...');
  const transportSelections: Array<{ shipmentId: string; transportationOptionId: string }> = [];
  const shipmentsNeedingDeliveryWindow: Array<{ shipmentId: string; transportationOptionId: string }> = [];

  for (const sid of shipmentIds) {
    try {
      let allTransportOpts: any[] = [];
      let nextToken: string | undefined;

      do {
        const queryParams: Record<string, string> = { shipmentId: sid };
        if (nextToken) queryParams.paginationToken = nextToken;
        const res = await callAmazonSpApi<any>({
          method: 'GET',
          region,
          // SDK path: /inboundPlans/{id}/transportationOptions with shipmentId as QUERY param, NOT path segment.
          // (Wrong path returns 403 Unauthorized, not 404 — took a while to track down.)
          path: `${FBA_INBOUND_BASE}/inboundPlans/${inboundPlanId}/transportationOptions`,
          query: queryParams,
        });
        console.log(`[fba-inbound] listTransportationOptions for ${sid}${nextToken ? ' (page)' : ''}:`, JSON.stringify(res.data));

        const opts = res.data?.transportationOptions ?? [];
        allTransportOpts = allTransportOpts.concat(opts);
        nextToken = res.data?.pagination?.nextToken;

        if (nextToken) {
          console.log(`[fba-inbound] Fetching next page of transportation options for ${sid}...`);
        }
      } while (nextToken);

      console.log(`[fba-inbound] Found ${allTransportOpts.length} total transportation options for ${sid}`);

      // Priority 1: Amazon Partnered Carrier (small parcel) without delivery window requirement (ideal)
      let preferred = allTransportOpts.find(
        (o: any) =>
          (o.shippingMode === 'GROUND_SMALL_PARCEL' || o.shippingMode === 'AIR_SMALL_PARCEL') &&
          o.shippingSolution === 'AMAZON_PARTNERED_CARRIER' &&
          !(o.preconditions ?? []).includes('CONFIRMED_DELIVERY_WINDOW')
      );

      if (preferred) {
        console.log(`[fba-inbound] Found ideal option: Amazon Partnered Carrier without delivery window requirement`);
      }

      // Priority 2: ANY option without delivery window requirement
      if (!preferred) {
        preferred = allTransportOpts.find(
          (o: any) => !(o.preconditions ?? []).includes('CONFIRMED_DELIVERY_WINDOW')
        );
        if (preferred) {
          console.log(`[fba-inbound] Selected option without delivery window requirement (mode=${preferred.shippingMode}, solution=${preferred.shippingSolution})`);
        }
      }

      // Priority 3: Amazon Partnered Carrier with delivery window
      if (!preferred) {
        console.log(`[fba-inbound] All options require CONFIRMED_DELIVERY_WINDOW - will generate and confirm delivery windows`);
        preferred = allTransportOpts.find(
          (o: any) =>
            (o.shippingMode === 'GROUND_SMALL_PARCEL' || o.shippingMode === 'AIR_SMALL_PARCEL') &&
            o.shippingSolution === 'AMAZON_PARTNERED_CARRIER'
        );
      }

      // Priority 4: Any small parcel option with delivery window
      if (!preferred) {
        preferred = allTransportOpts.find(
          (o: any) => o.shippingMode === 'GROUND_SMALL_PARCEL' || o.shippingMode === 'AIR_SMALL_PARCEL'
        );
      }

      // Priority 5: Fallback to first option
      if (!preferred) {
        console.warn(`[fba-inbound] WARNING: Using fallback first option`);
        preferred = allTransportOpts[0];
      }

      if (!preferred?.transportationOptionId) throw new Error(`No transportation option for shipment ${sid}`);
      console.log(`[fba-inbound] Selected transport option for ${sid}: ${preferred.transportationOptionId} (mode=${preferred.shippingMode}, solution=${preferred.shippingSolution}, preconditions=${JSON.stringify(preferred.preconditions)})`);
      transportSelections.push({ shipmentId: sid, transportationOptionId: preferred.transportationOptionId });

      const preconditions = preferred.preconditions ?? [];
      if (preconditions.includes('CONFIRMED_DELIVERY_WINDOW')) {
        console.log(`[fba-inbound] Shipment ${sid} requires CONFIRMED_DELIVERY_WINDOW`);
        shipmentsNeedingDeliveryWindow.push({ shipmentId: sid, transportationOptionId: preferred.transportationOptionId });
      }
    } catch (e) {
      console.error(`[fba-inbound] listTransportationOptions failed for ${sid}:`, e);
      throw new Error(`listTransportationOptions failed: ${extractAmazonError(e)}`);
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
