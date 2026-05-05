/**
 * POST /api/fba/full-pipeline
 * 
 * Complete FBA shipment pipeline that orchestrates all steps:
 * 1. Create CIN7 Transfer Order (Vegas → FBA)
 * 2. Create ShipHero Wholesale Order
 * 3. Submit Amazon FBA Shipment
 * 4. Fetch Labels from Amazon
 * 5. Persist Labels to Supabase Storage
 * 6. Attach Labels to ShipHero Order
 * 7. Save complete shipment record to Supabase
 * 8. Return all data for Telegram notification
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTransferOrder, CIN7_BRANCHES } from '../../lib/cin7';
import {
  createWholesaleOrder,
  autoAllocateWholesaleOrder,
  setReadyToPick,
  addOrderAttachment,
  updateOrderPackingNote,
} from '../../lib/shiphero-wholesale';
import { runFbaInboundWorkflow } from '../../lib/fba-inbound';
import { supabase } from '../../lib/supabase';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';
import axios from 'axios';

export const config = { maxDuration: 300 }; // 5 minute timeout

// Placeholder Vegas address for ShipHero (will be updated when FBA assigns destination)
const VEGAS_WAREHOUSE_ADDRESS = {
  firstName: 'Amazon',
  lastName: 'FBA',
  company: 'Amazon Fulfillment',
  address1: '6425 S Jones Blvd',
  city: 'Las Vegas',
  state: 'NV',
  zip: '89118',
  country: 'US',
  phone: '7027108850',
};

interface PipelineRequest {
  product: {
    cin7Sku: string;
    amazonMsku: string;
    cin7ProductId: string;
    name: string;
  };
  quantity: number;
  casePack: number;
  cases: number;
  box: {
    length: number;
    width: number;
    height: number;
  };
  weightLbs: number;
  expiration: string; // YYYY-MM-DD
}

interface PipelineResponse {
  success: boolean;
  cin7Transfer?: {
    taskId: string;
    status: string;
  };
  shipheroOrder?: {
    orderId: string;
    orderNumber: string;
    wholesaleOrderId: string;
  };
  fbaShipment?: {
    planId: string;
    shipmentIds: string[];
    confirmationIds: string[];
    boxIds: string[];
  };
  labels?: {
    supabaseUrl: string;
    pageCount: number;
  };
  summary?: string;
  error?: string;
  step?: string;
  labelAttachmentPending?: boolean;
  attachLabelsPayload?: Record<string, any>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = req.body as PipelineRequest;
  const response: PipelineResponse = { success: false };

  // Validate required fields
  if (!body.product?.cin7ProductId || !body.product?.amazonMsku) {
    return res.status(400).json({
      success: false,
      error: 'Missing required product fields: cin7ProductId and amazonMsku are required',
    });
  }

  if (!body.quantity || !body.cases || !body.casePack) {
    return res.status(400).json({
      success: false,
      error: 'Missing required quantity fields: quantity, cases, and casePack are required',
    });
  }

  if (!body.box?.length || !body.box?.width || !body.box?.height || !body.weightLbs) {
    return res.status(400).json({
      success: false,
      error: 'Missing required box dimensions: length, width, height, and weightLbs are required',
    });
  }

  console.log('[full-pipeline] Starting full FBA pipeline...');
  console.log('[full-pipeline] Request:', JSON.stringify(body, null, 2));

  let cin7TaskId: string | undefined;
  let shipheroOrderId: string | undefined;
  let shipheroOrderNumber: string | undefined;
  let fbaResult: any;

  try {
    // ========================================
    // STEP 1: Create CIN7 Transfer Order
    // ========================================
    console.log('[full-pipeline] Step 1: Creating CIN7 transfer order...');
    response.step = 'cin7_transfer';

    const cin7Result = await createTransferOrder({
      fromBranchId: CIN7_BRANCHES.VEGAS,
      toBranchId: CIN7_BRANCHES.AMAZON_FBA,
      items: [{
        productId: body.product.cin7ProductId,
        quantity: body.quantity,
      }],
      reference: `FBA-${body.product.cin7Sku}-${Date.now()}`,
    });

    cin7TaskId = cin7Result.taskId;
    response.cin7Transfer = {
      taskId: cin7Result.taskId,
      status: cin7Result.status,
    };
    console.log('[full-pipeline] Step 1 COMPLETE: CIN7 transfer created:', cin7TaskId);

    // ========================================
    // STEP 2: Wait for ShipHero Wholesale Order (auto-created by CIN7 bridge)
    // ========================================
    console.log('[full-pipeline] Step 2: Waiting for ShipHero wholesale order from CIN7 bridge...');
    response.step = 'shiphero_order';

    // The CIN7→ShipHero bridge auto-creates wholesale orders from CIN7 transfers.
    // Poll for up to 60 seconds for it to appear, then fall back to creating one.
    let shipheroFound = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log(`[full-pipeline] Step 2: Polling for ShipHero order (attempt ${attempt}/6)...`);
      try {
        // Search by partner_order_id or recent orders
        const { findOrderByPartnerIdOrRecent } = await import('../../lib/shiphero-wholesale');
        const existingOrder = await findOrderByPartnerIdOrRecent(cin7TaskId, body.product.cin7Sku);
        if (existingOrder) {
          shipheroOrderId = existingOrder.orderId;
          shipheroOrderNumber = existingOrder.orderNumber;
          response.shipheroOrder = existingOrder;
          shipheroFound = true;
          console.log(`[full-pipeline] Step 2 COMPLETE: Found existing ShipHero order ${shipheroOrderNumber}`);
          break;
        }
      } catch (lookupErr) {
        console.warn('[full-pipeline] Step 2: Lookup error:', lookupErr);
      }
      if (attempt < 6) {
        console.log('[full-pipeline] Step 2: Order not found yet, waiting 10s...');
        await new Promise(r => setTimeout(r, 10000));
      }
    }

    // Fallback: create the order if bridge hasn't run
    if (!shipheroFound) {
      console.log('[full-pipeline] Step 2: Bridge order not found, creating manually...');
      const orderNumber = `FBA-${cin7TaskId.slice(0, 8)}-${Date.now()}`;
      const packingNote = `FBA Shipment - ${body.product.name} - ${body.cases} cases`;

      const shipheroResult = await createWholesaleOrder({
        orderNumber,
        items: [{
          sku: body.product.cin7Sku,
          quantity: body.quantity,
          productName: body.product.name,
        }],
        packingNote,
        shippingAddress: VEGAS_WAREHOUSE_ADDRESS,
        warehouseId: process.env.SHIPHERO_WAREHOUSE_ID || 'V2FyZWhvdXNlOjEzNTg3Mg==',
        customerAccountId: process.env.SHIPHERO_CUSTOMER_ACCOUNT_ID || '95145',
      });

      shipheroOrderId = shipheroResult.orderId;
      shipheroOrderNumber = shipheroResult.orderNumber;
      response.shipheroOrder = shipheroResult;
      console.log('[full-pipeline] Step 2 COMPLETE: Manually created order:', shipheroOrderId);

      try {
        await autoAllocateWholesaleOrder(shipheroOrderId);
        await setReadyToPick(shipheroOrderId);
      } catch (allocErr) {
        console.warn('[full-pipeline] Step 2: Allocation/pick warning:', allocErr);
      }
    }

    // ========================================
    // STEP 3: Submit Amazon FBA Shipment
    // ========================================
    console.log('[full-pipeline] Step 3: Submitting Amazon FBA shipment...');
    response.step = 'fba_shipment';

    const credentials = {
      clientId: process.env.AMAZON_CLIENT_ID!,
      clientSecret: process.env.AMAZON_CLIENT_SECRET!,
      refreshToken: process.env.AMAZON_REFRESH_TOKEN!,
    };

    if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
      throw new Error('Missing Amazon SP-API credentials');
    }

    fbaResult = await runFbaInboundWorkflow({
      credentials,
      marketplaceId: 'ATVPDKIKX0DER', // US marketplace
      sourceAddress: {
        name: 'Clean Nutra',
        addressLine1: '6425 S Jones Blvd',
        city: 'Las Vegas',
        stateOrProvinceCode: 'NV',
        postalCode: '89118',
        countryCode: 'US',
        phoneNumber: '7027108850',
        companyName: 'Clean Nutra',
        email: 'shipping@cleannutra.com',
      },
      items: [{
        sellerSku: body.product.amazonMsku,
        quantity: body.quantity,
        expiration: body.expiration,
        prepOwner: 'SELLER',
      }],
      box: {
        length: body.box.length,
        width: body.box.width,
        height: body.box.height,
        weightLbs: body.weightLbs,
      },
      boxQuantity: body.cases,
      casePack: body.casePack,
    });

    response.fbaShipment = {
      planId: fbaResult.planId,
      shipmentIds: fbaResult.shipmentIds,
      confirmationIds: fbaResult.shipmentConfirmationIds,
      boxIds: fbaResult.boxIds,
    };
    console.log('[full-pipeline] Step 3 COMPLETE: FBA shipment created:', fbaResult.planId);

    // ========================================
    // STEP 4: Fetch Labels from Amazon
    // ========================================
    console.log('[full-pipeline] Step 4: Fetching labels from Amazon...');
    response.step = 'fetch_labels';

    // We need to use the v0 API with shipmentConfirmationId (FBA format)
    // and boxIds for UNIQUE labels
    const shipmentConfirmationId = fbaResult.shipmentConfirmationIds[0];
    const boxIds = fbaResult.boxIds;

    if (!shipmentConfirmationId) {
      console.warn('[full-pipeline] No shipmentConfirmationId yet - labels may not be ready');
    }

    let labelDownloadUrl: string | null = null;
    let pdfContent: string | null = null;

    if (shipmentConfirmationId && boxIds.length > 0) {
      try {
        // Build query string for v0 getLabels API
        const queryParams = new URLSearchParams();
        queryParams.set('ShipmentId', shipmentConfirmationId);
        queryParams.set('PageType', 'PackageLabel_Thermal'); // 4x6 thermal format
        queryParams.set('LabelType', 'UNIQUE');
        queryParams.set('PackageLabelsToPrint', boxIds.join(','));

        const labelPath = `/fba/inbound/v0/shipments/${shipmentConfirmationId}/labels?${queryParams.toString()}`;
        console.log('[full-pipeline] Calling v0 getLabels via proxy:', labelPath);

        const labelResponse = await callAmazonSpApi<any>({
          method: 'GET',
          path: labelPath,
        });

        const payload = labelResponse.data?.payload;
        labelDownloadUrl = payload?.DownloadURL || payload?.downloadURL || payload?.downloadUrl;
        pdfContent = payload?.PdfDocument || payload?.pdfDocument;

        console.log('[full-pipeline] Step 4 COMPLETE: Got labels URL:', labelDownloadUrl ? 'YES' : 'NO');
      } catch (labelErr: any) {
        console.error('[full-pipeline] Label fetch failed (non-fatal):', labelErr?.details ?? labelErr?.response?.data ?? labelErr?.message);
        // Continue - labels can be fetched later via /api/fba/labels endpoint
      }
    } else {
      console.log('[full-pipeline] Skipping label fetch - missing shipmentConfirmationId or boxIds');
    }

    // ========================================
    // STEP 5: Persist Labels to Supabase Storage
    // ========================================
    let supabaseUrl: string | null = null;
    let pageCount = 0;

    if (labelDownloadUrl || pdfContent) {
      console.log('[full-pipeline] Step 5: Persisting labels to Supabase...');
      response.step = 'persist_labels';

      try {
        let pdfBuffer: Buffer;

        if (labelDownloadUrl) {
          // Download from Amazon S3 URL
          const pdfResponse = await axios.get(labelDownloadUrl, {
            responseType: 'arraybuffer',
          });
          pdfBuffer = Buffer.from(pdfResponse.data);
        } else if (pdfContent) {
          // Decode base64 PDF content
          pdfBuffer = Buffer.from(pdfContent, 'base64');
        } else {
          throw new Error('No label content available');
        }

        // Estimate page count (rough estimate: ~3KB per label page)
        pageCount = Math.max(1, Math.round(pdfBuffer.length / 3000));

        // Upload to Supabase storage
        const storagePath = `${shipheroOrderNumber}/${shipmentConfirmationId}-labels.pdf`;
        const { error: uploadError } = await supabase.storage
          .from('shipment-labels')
          .upload(storagePath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });

        if (uploadError) {
          throw new Error(`Supabase upload failed: ${uploadError.message}`);
        }

        // Get public URL
        const { data: urlData } = supabase.storage
          .from('shipment-labels')
          .getPublicUrl(storagePath);

        supabaseUrl = urlData?.publicUrl || null;
        response.labels = {
          supabaseUrl: supabaseUrl || '',
          pageCount,
        };

        console.log('[full-pipeline] Step 5 COMPLETE: Labels saved to Supabase:', supabaseUrl);
      } catch (uploadErr: any) {
        console.error('[full-pipeline] Label upload failed (non-fatal):', uploadErr?.message);
        // Continue - can be handled manually
      }
    } else {
      console.log('[full-pipeline] Step 5 SKIPPED: No labels to persist');
    }

    // ========================================
    // STEP 6: Attach Labels to ShipHero Order
    // ========================================
    if (supabaseUrl && shipheroOrderId) {
      console.log('[full-pipeline] Step 6: Attaching labels to ShipHero order...');
      response.step = 'attach_labels';

      try {
        // Add attachment
        await addOrderAttachment(
          shipheroOrderId,
          supabaseUrl,
          `FBA Labels - ${shipmentConfirmationId} (${boxIds.length} boxes)`
        );

        // Update packing note with label URL
        const updatedPackingNote = `FBA Shipment - ${body.product.name} - ${body.cases} cases\nLabels: ${supabaseUrl}\nAmazon Shipment: ${shipmentConfirmationId}`;
        await updateOrderPackingNote(shipheroOrderId, updatedPackingNote);

        console.log('[full-pipeline] Step 6 COMPLETE: Labels attached to ShipHero order');
      } catch (attachErr: any) {
        console.error('[full-pipeline] Attachment failed (non-fatal):', attachErr?.message);
      }
    } else if (supabaseUrl && !shipheroOrderId) {
      // ShipHero order not created yet by CIN7 bridge — schedule a retry
      console.log('[full-pipeline] Step 6: ShipHero order not found yet. Will retry via /api/fba/attach-labels.');
      response.labelAttachmentPending = true;
      response.attachLabelsPayload = {
        sku: body.product.cin7Sku,
        labelsUrl: supabaseUrl,
        shipmentId: shipmentConfirmationId,
        productName: body.product.name,
        cases: body.cases,
        units: body.quantity,
        expiration: body.expiration,
        lot: '',
      };
    } else {
      console.log('[full-pipeline] Step 6 SKIPPED: No labels URL');
    }

    // ========================================
    // STEP 7: Save to Supabase Database
    // ========================================
    console.log('[full-pipeline] Step 7: Saving shipment record to Supabase...');
    response.step = 'save_record';

    try {
      const { error: insertError } = await supabase
        .from('fba_shipments')
        .insert({
          plan_id: fbaResult.planId,
          amazon_shipment_ids: fbaResult.shipmentConfirmationIds,
          amazon_internal_shipment_ids: fbaResult.shipmentIds,
          box_ids: fbaResult.boxIds,
          cin7_transfer_id: cin7TaskId,
          shiphero_order_id: shipheroOrderId,
          shiphero_order_number: shipheroOrderNumber,
          product_sku: body.product.cin7Sku,
          product_msku: body.product.amazonMsku,
          product_name: body.product.name,
          quantity: body.quantity,
          cases: body.cases,
          case_pack: body.casePack,
          expiration: body.expiration,
          labels_url: supabaseUrl,
          status: 'SUBMITTED',
          created_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error('[full-pipeline] Failed to save shipment record:', insertError.message);
      } else {
        console.log('[full-pipeline] Step 7 COMPLETE: Shipment record saved');
      }
    } catch (dbErr: any) {
      console.error('[full-pipeline] Database save failed (non-fatal):', dbErr?.message);
    }

    // ========================================
    // STEP 8: Build Summary for Telegram
    // ========================================
    const primaryShipmentId = fbaResult.shipmentConfirmationIds[0] || fbaResult.shipmentIds[0] || fbaResult.planId;
    response.summary = `${body.product.name} - ${body.cases} cases (${body.quantity.toLocaleString()} units) - ${primaryShipmentId}`;

    // Mark success
    response.success = true;
    response.step = 'complete';

    console.log('[full-pipeline] ✅ PIPELINE COMPLETE');
    console.log('[full-pipeline] Summary:', response.summary);

    return res.status(200).json(response);

  } catch (err: any) {
    console.error(`[full-pipeline] Error at step ${response.step}:`, err?.message);
    response.error = `Pipeline failed at ${response.step}: ${err?.message}`;
    return res.status(500).json(response);
  }
}
