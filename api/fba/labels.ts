/**
 * GET /api/shipments/fba/labels?shipmentId=<amazon_shipment_id>&pageType=<type>&labelType=<type>
 * Returns a presigned URL to download FBA box/pallet labels using the v0 API.
 *
 * For UNIQUE labels, we need carton IDs. We fetch these from the v2024-03-20 API
 * using listShipmentBoxes, then pass them to the v0 getLabels API.
 *
 * All Amazon SP-API traffic is proxied through the amazon-sp-api Supabase edge
 * function via `callAmazonSpApi` — no direct calls to sellingpartnerapi-*.amazon.com.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { shipmentId, pageType, labelType, numberOfPackages, packageLabelsToPrint, numberOfPallets, inboundPlanId, internalShipmentId } = req.query;

  if (!shipmentId || typeof shipmentId !== 'string') {
    return res.status(400).json({ success: false, error: 'shipmentId is required' });
  }

  // For fetching carton IDs, we need the inbound plan ID and internal shipment ID
  let planId = inboundPlanId as string | undefined;
  let internalId = internalShipmentId as string | undefined;

  // Box IDs stored in database (preferred source for UNIQUE labels)
  let storedBoxIds: string[] = [];

  // If planId and internalId not provided, look them up from the database
  if (!planId || !internalId) {
    console.log(`[fba-labels] Looking up shipment ${shipmentId} from database...`);
    console.log(`[fba-labels] SUPABASE_URL exists: ${!!SUPABASE_URL}, SUPABASE_SERVICE_ROLE_KEY exists: ${!!SUPABASE_SERVICE_ROLE_KEY}`);
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        // Use filter with cs (contains) operator for JSONB array matching
        // This is more explicit than .contains() method
        const { data: shipmentRecords, error: dbError } = await supabase
          .from('fba_shipments')
          .select('plan_id, amazon_internal_shipment_ids, box_ids, amazon_shipment_ids')
          .filter('amazon_shipment_ids', 'cs', JSON.stringify([shipmentId]));

        console.log(`[fba-labels] DB query returned ${shipmentRecords?.length || 0} records, error: ${dbError?.message || 'none'}`);

        if (dbError) {
          console.error('[fba-labels] Database query error:', dbError.message, dbError.code, dbError.details);
        } else if (shipmentRecords && shipmentRecords.length > 0) {
          const shipmentRecord = shipmentRecords[0];
          console.log(`[fba-labels] Found shipment record:`, JSON.stringify(shipmentRecord));

          planId = shipmentRecord.plan_id || undefined;
          // Get the first internal shipment ID (typically there's only one)
          const internalIds = shipmentRecord.amazon_internal_shipment_ids as string[] | null;
          if (internalIds && internalIds.length > 0) {
            internalId = internalIds[0];
          }
          // Get stored box IDs (saved during shipment creation)
          // Filter to only box IDs belonging to the requested shipmentId
          // Amazon box IDs are formatted as {shipmentId}U{number}, e.g. FBA19C6GYS2TU000001
          const boxIdsFromDb = shipmentRecord.box_ids as string[] | null;
          if (boxIdsFromDb && boxIdsFromDb.length > 0) {
            const filtered = boxIdsFromDb.filter(id => id.startsWith(shipmentId));
            storedBoxIds = filtered.length > 0 ? filtered : boxIdsFromDb;
            console.log(`[fba-labels] Found ${boxIdsFromDb.length} total box IDs, ${filtered.length} matching shipment ${shipmentId}:`, storedBoxIds);
          }
          console.log(`[fba-labels] Looked up from DB: planId=${planId}, internalId=${internalId}, boxIds=${storedBoxIds.length}`);
        } else {
          console.log(`[fba-labels] No shipment record found for ${shipmentId}`);
        }
      } catch (dbErr: any) {
        console.error('[fba-labels] Failed to look up shipment from DB:', dbErr?.message, dbErr?.stack);
        // Continue without - will try listShipmentBoxes fallback
      }
    } else {
      console.error('[fba-labels] Missing Supabase credentials - cannot look up shipment from DB');
    }
  }

  // Page type for labels - default to 4x6 thermal for warehouse printing
  const effectivePageType = (pageType as string) || 'PackageLabel_Thermal';
  // LabelType=UNIQUE + PackageLabel_Thermal: correct 2-in-1 combined label.
  // page 1 = FBA box label (portrait 4×6), page 2 = carrier shipping label (portrait 4×6).
  // PackageLabel_Thermal_No_Carrier_Rotation rotates the carrier 90° — broken (TR-00104, 2026-06-01).
  const effectiveLabelType = (labelType as string) || 'UNIQUE';

  try {
    // #region agent log - H1: Check which params were passed from frontend
  fetch('http://127.0.0.1:7242/ingest/07bf603a-ecf9-4bf9-897f-63b1386ff0e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'labels.ts:entry',message:'Entry params check',data:{shipmentId,planId:planId||null,internalId:internalId||null,numberOfPackages:numberOfPackages||null,packageLabelsToPrint:packageLabelsToPrint||null},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
  // #endregion

  // Fetch carton/box IDs if we have plan ID and internal shipment ID
    // Skip if we already have stored box IDs from the database
    let fetchedCartonIds: string[] = [];

    if (storedBoxIds.length > 0) {
      console.log(`[fba-labels] Using ${storedBoxIds.length} box IDs from database (skipping API call)`);
      fetchedCartonIds = storedBoxIds;
    } else if (planId && internalId && !packageLabelsToPrint) {
      // Fallback: Fetch from API if not stored in database
      console.log(`[fba-labels] No stored box IDs, fetching from API...`);

      // Try with retry logic - boxes might not be immediately available after workflow
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`[fba-labels] Fetching box IDs from plan ${planId}, shipment ${internalId} (attempt ${attempt}/${maxRetries})...`);
          // listShipmentBoxes → GET /inbound/fba/2024-03-20/inboundPlans/{id}/shipments/{sid}/boxes
          const boxesRes = await callAmazonSpApi<any>({
            method: 'GET',
            path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments/${internalId}/boxes`,
          });
          const boxes = (boxesRes.data as any)?.boxes || [];
          console.log(`[fba-labels] listShipmentBoxes response:`, JSON.stringify(boxesRes.data));

          // Try multiple possible property names for box ID
          for (const box of boxes) {
            console.log(`[fba-labels] Box structure:`, JSON.stringify(box));
            const boxId = box.boxId || box.packageId || box.cartonId || box.contentId || box.id;
            if (boxId) {
              fetchedCartonIds.push(boxId);
            }
          }

          if (fetchedCartonIds.length > 0) {
            console.log(`[fba-labels] Found ${fetchedCartonIds.length} box IDs from API:`, fetchedCartonIds);

            // Save the fetched box IDs to the database for future requests
            if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
              try {
                const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
                const { error: updateErr } = await supabase
                  .from('fba_shipments')
                  .update({ box_ids: fetchedCartonIds })
                  .contains('amazon_shipment_ids', [shipmentId]);

                if (updateErr) {
                  console.error('[fba-labels] Failed to save box IDs to database:', updateErr.message);
                } else {
                  console.log('[fba-labels] Successfully saved box IDs to database for future requests');
                }
              } catch (saveErr: any) {
                console.error('[fba-labels] Error saving box IDs:', saveErr?.message);
              }
            }
            break; // Found boxes, exit retry loop
          } else if (attempt < maxRetries) {
            // Wait before retrying - boxes might not be ready yet
            const waitTime = attempt * 2000; // 2s, 4s
            console.log(`[fba-labels] No boxes found, waiting ${waitTime}ms before retry...`);
            await new Promise(r => setTimeout(r, waitTime));
          }
        } catch (boxErr: any) {
          console.error(`[fba-labels] Failed to fetch box IDs (attempt ${attempt}):`, boxErr?.message);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      if (fetchedCartonIds.length === 0) {
        console.log('[fba-labels] No box IDs found after all retries');
      }
    } else {
      console.log(`[fba-labels] Skipping box ID lookup - missing params: hasPlanId=${!!planId}, hasInternalId=${!!internalId}, hasPackageLabelsToPrint=${!!packageLabelsToPrint}`);
    }

    // For UNIQUE labels, we need to specify numberOfPackages
    // Default to 1 if not provided (user can override via query param)
    const effectiveNumPackages = numberOfPackages
      ? parseInt(numberOfPackages as string, 10)
      : (effectiveLabelType === 'UNIQUE' ? 1 : undefined);

    console.log(`[fba-labels] Fetching labels for shipmentId=${shipmentId}, pageType=${effectivePageType}, labelType=${effectiveLabelType}, numPackages=${effectiveNumPackages}`);

    // #region agent log - H1: Check if numberOfPackages is being passed correctly
    fetch('http://127.0.0.1:7242/ingest/07bf603a-ecf9-4bf9-897f-63b1386ff0e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'labels.ts:H1',message:'Input params check',data:{shipmentId,numberOfPackages,effectiveNumPackages,effectivePageType,effectiveLabelType,packageLabelsToPrint:packageLabelsToPrint||null},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

    // Check shipment ID format - must be FBA... format for v0 API
    const isValidFormat = shipmentId.startsWith('FBA') || shipmentId.match(/^[A-Z0-9]{10,}$/);
    console.log(`[fba-labels] Shipment ID format check: ${shipmentId} - valid=${isValidFormat}`);

    if (!isValidFormat) {
      return res.status(400).json({
        success: false,
        error: `Invalid shipment ID format. Expected FBA confirmation ID (e.g., FBA1234ABCD), got: ${shipmentId}. This shipment may need to be recreated to get proper confirmation IDs.`,
        shipmentId,
      });
    }

    // Build the request parameters - simplified for SELLER_LABEL
    const labelParams: any = {
      shipmentId,
      pageType: effectivePageType,
      labelType: effectiveLabelType,
    };

    // Add required params based on label type
    if (effectiveLabelType === 'UNIQUE') {
      // UNIQUE labels require packageLabelsToPrint (carton/box IDs)
      if (packageLabelsToPrint) {
        // Use explicitly provided carton IDs from query param
        labelParams.packageLabelsToPrint = (packageLabelsToPrint as string).split(',');
        console.log('[fba-labels] Using carton IDs from query param:', labelParams.packageLabelsToPrint);
      } else if (fetchedCartonIds.length > 0) {
        // Use carton IDs from database or API
        labelParams.packageLabelsToPrint = fetchedCartonIds;
        console.log('[fba-labels] Using carton IDs (from DB or API):', fetchedCartonIds);
      } else {
        // No box IDs available - return helpful error instead of failing with cryptic Amazon error
        console.error('[fba-labels] CRITICAL: No box/carton IDs available for UNIQUE labels');
        return res.status(400).json({
          success: false,
          error: 'Box IDs are required for shipping labels but none were found. This shipment may need to be recreated, or you can try again in a few minutes as Amazon may still be processing the shipment.',
          shipmentId,
          debug: {
            hadStoredBoxIds: storedBoxIds.length > 0,
            hadFetchedBoxIds: fetchedCartonIds.length > 0,
            planIdFound: !!planId,
            internalIdFound: !!internalId,
          }
        });
      }
    } else if (effectiveLabelType === 'PALLET' && numberOfPallets) {
      labelParams.numberOfPallets = parseInt(numberOfPallets as string, 10);
    }

    console.log('[fba-labels] Request params:', JSON.stringify(labelParams, null, 2));

    // #region agent log - H2/H3/H4: Check final request params before proxy call
    fetch('http://127.0.0.1:7242/ingest/07bf603a-ecf9-4bf9-897f-63b1386ff0e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'labels.ts:H2-H4',message:'Final labelParams before proxy call',data:{labelParams,shipmentIdFormat:shipmentId.startsWith('FBA')?'FBA_CONFIRMATION':'INTERNAL_ID'},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2-H4'})}).catch(()=>{});
    // #endregion

    // Call v0 getLabels via the amazon-sp-api proxy
    let payload: any = null;
    try {
      // Build query string (PackageLabelsToPrint can be multi-valued — use URLSearchParams)
      const searchParams = new URLSearchParams();
      searchParams.set('ShipmentId', shipmentId);
      searchParams.set('PageType', labelParams.pageType);
      searchParams.set('LabelType', labelParams.labelType);

      if (labelParams.packageLabelsToPrint && labelParams.packageLabelsToPrint.length > 0) {
        // Amazon v0 accepts repeated PackageLabelsToPrint params; the SDK previously
        // sent a comma-joined list in one param, which Amazon also accepts — preserve that.
        searchParams.set('PackageLabelsToPrint', labelParams.packageLabelsToPrint.join(','));
      } else if (labelParams.numberOfPackages) {
        searchParams.set('NumberOfPackages', String(labelParams.numberOfPackages));
      }

      if (labelParams.numberOfPallets) {
        searchParams.set('NumberOfPallets', String(labelParams.numberOfPallets));
      }

      const pathWithQuery = `/fba/inbound/v0/shipments/${shipmentId}/labels?${searchParams.toString()}`;
      console.log('[fba-labels] Proxy path:', pathWithQuery);

      const response = await callAmazonSpApi<any>({
        method: 'GET',
        path: pathWithQuery,
      });

      payload = response.data?.payload;
      console.log('[fba-labels] Proxy response status:', response.status);

      // #region agent log - H5: Check successful response
      fetch('http://127.0.0.1:7242/ingest/07bf603a-ecf9-4bf9-897f-63b1386ff0e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'labels.ts:success',message:'getLabels succeeded',data:{hasPayload:!!payload,responseStatus:response.status},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
    } catch (apiErr: any) {
      // #region agent log - API error details
      const errData = {errorMessage:apiErr?.message,responseData:apiErr?.details ?? apiErr?.response?.data,responseStatus:apiErr?.status ?? apiErr?.response?.status};
      fetch('http://127.0.0.1:7242/ingest/07bf603a-ecf9-4bf9-897f-63b1386ff0e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'labels.ts:api-error',message:'Proxy getLabels failed',data:errData,timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'ALL'})}).catch(()=>{});
      // #endregion

      // Extract error details (SpApiError.details holds Amazon's response body)
      const errorDetails = apiErr?.details?.errors || apiErr?.details || apiErr?.response?.data?.errors || apiErr?.response?.data;
      if (errorDetails) {
        throw new Error(typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails));
      }
      throw apiErr;
    }

    // Payload was already extracted above
    const payloadKeys = payload ? Object.keys(payload) : [];
    console.log('[fba-labels] payload keys:', payloadKeys);
    console.log('[fba-labels] payload values:', payload ? JSON.stringify(payload) : 'null');

    // #region agent log - H6: Check actual payload from Amazon
    fetch('http://127.0.0.1:7242/ingest/07bf603a-ecf9-4bf9-897f-63b1386ff0e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'labels.ts:payload',message:'Amazon getLabels payload',data:{payloadKeys,payload:payload||null,hasDownloadURL:!!(payload?.DownloadURL||payload?.downloadURL||payload?.downloadUrl),hasPdfDocument:!!(payload?.PdfDocument||payload?.pdfDocument)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H6'})}).catch(()=>{});
    // #endregion

    if (!payload) {
      return res.status(404).json({
        success: false,
        error: 'No label data returned from Amazon',
      });
    }

    // Check various possible property names (API may use different casing)
    const downloadUrl = payload.DownloadURL || payload.downloadURL || payload.downloadUrl || null;
    const pdfDocument = payload.PdfDocument || payload.pdfDocument || null;

    console.log('[fba-labels] downloadUrl:', downloadUrl);
    console.log('[fba-labels] pdfDocument exists:', !!pdfDocument);

    if (!downloadUrl && !pdfDocument) {
      // #region agent log - H7: Labels returned but no URL/PDF
      fetch('http://127.0.0.1:7242/ingest/07bf603a-ecf9-4bf9-897f-63b1386ff0e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'labels.ts:no-url',message:'No download URL or PDF in payload',data:{payloadKeys:Object.keys(payload),payloadStringified:JSON.stringify(payload)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H7'})}).catch(()=>{});
      // #endregion

      // Return the actual payload so we can debug what Amazon sent
      return res.status(200).json({
        success: false,
        error: 'Labels returned but download URL not found in expected location. Check amazonPayload for actual response structure.',
        payloadKeys: Object.keys(payload),
        amazonPayload: payload,
        shipmentId,
        usedParams: { pageType: effectivePageType, labelType: effectiveLabelType },
      });
    }

    return res.status(200).json({
      success: true,
      downloadUrl,
      pdfContent: pdfDocument ? `data:application/pdf;base64,${pdfDocument}` : null,
      shipmentId,
    });
  } catch (err: any) {
    console.error('[fba-labels] Error fetching labels:', err?.message || err);

    // Extract detailed Amazon error if available (safely, avoiding circular refs)
    let errorMessage = err?.message || 'Unknown error';
    try {
      if (err?.details?.errors) {
        errorMessage = JSON.stringify(err.details.errors);
      } else if (err?.details) {
        errorMessage = typeof err.details === 'string' ? err.details : JSON.stringify(err.details);
      } else if (err?.response?.data?.errors) {
        errorMessage = JSON.stringify(err.response.data.errors);
      } else if (err?.response?.data) {
        errorMessage = JSON.stringify(err.response.data);
      }
    } catch (jsonErr) {
      // If stringify fails (circular ref), just use the message
      errorMessage = err?.message || 'Unknown error (could not serialize details)';
    }

    return res.status(500).json({
      success: false,
      error: `Failed to fetch labels: ${errorMessage}`,
    });
  }
}
