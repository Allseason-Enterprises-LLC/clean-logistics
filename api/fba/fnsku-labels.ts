import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 60 };

/**
 * Download FNSKU barcode labels from Amazon for product units.
 *
 * POST /api/fba/fnsku-labels
 * {
 *   "msku": "CN-CAP-METHYLATEDB-60BG",
 *   "quantity": 2000,
 *   "labelType": "THERMAL_PRINTING"  // or "STANDARD_FORMAT" for letter paper
 * }
 *
 * Returns a download URL for the FNSKU label PDF.
 * Proxied through the amazon-sp-api Supabase edge function — no direct Amazon calls.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { msku, quantity = 1, labelType = 'THERMAL_PRINTING' } = req.body || {};

  if (!msku) return res.status(400).json({ error: 'Missing msku' });

  try {
    console.log(`[fnsku-labels] Requesting FNSKU labels for ${msku}, qty=${quantity}, type=${labelType}`);

    const bodyParams: any = {
      marketplaceId: 'ATVPDKIKX0DER',
      labelType,
      mskuQuantities: [{ msku, quantity: Number(quantity) }],
    };

    // Thermal printing requires width/height (in inches)
    if (labelType === 'THERMAL_PRINTING') {
      bodyParams.width = req.body?.width || 89;  // 3.5 inches = 89mm
      bodyParams.height = req.body?.height || 29;  // 1.125 inches = 29mm
      bodyParams.pageType = req.body?.pageType || undefined;
    }

    // createMarketplaceItemLabels → POST /inbound/fba/2024-03-20/items/labels
    const result = await callAmazonSpApi<any>({
      method: 'POST',
      path: '/inbound/fba/2024-03-20/items/labels',
      body: bodyParams,
    });

    const downloads = (result.data as any)?.documentDownloads || [];
    console.log(`[fnsku-labels] Got ${downloads.length} download(s)`);

    if (downloads.length === 0) {
      return res.json({ success: false, error: 'No download URL returned' });
    }

    // Download URL might be a direct URL or need to be fetched
    const downloadUrl = downloads[0]?.downloadUrl || downloads[0]?.url;

    return res.json({
      success: true,
      msku,
      quantity,
      downloadUrl,
      downloads,
    });
  } catch (err: any) {
    const errData = err.details ?? err.response?.data ?? err.message;
    console.error('[fnsku-labels] Error:', JSON.stringify(errData));
    return res.status(500).json({
      success: false,
      error: err.message,
      details: errData,
    });
  }
}
