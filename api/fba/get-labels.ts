import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 60 };

/**
 * Fetch FBA shipping labels via the amazon-sp-api Supabase edge function proxy.
 * GET /api/fba/get-labels?shipmentId=FBA19CBZ0CPX&boxIds=FBA19CBZ0CPXU000001&pageType=PackageLabel_Thermal
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const shipmentId = (req.query.shipmentId || req.body?.shipmentId) as string;
  const pageType = (req.query.pageType || req.body?.pageType || 'PackageLabel_Thermal') as string;
  // LabelType=UNIQUE + PackageLabel_Thermal gives the correct 2-in-1 label PDF:
  // page 1 = FBA box label (portrait 4×6), page 2 = carrier shipping label (portrait 4×6).
  // Do NOT default to BARCODE_2D (omits carrier label) or PackageLabel_Thermal_No_Carrier_Rotation
  // (carrier rotated 90° — confirmed broken on TR-00104, 2026-06-01).
  const labelType = (req.query.labelType || req.body?.labelType || 'UNIQUE') as string;
  const numberOfPackages = req.query.numberOfPackages || req.body?.numberOfPackages;
  const boxIdsParam = req.query.boxIds
    ? (Array.isArray(req.query.boxIds) ? req.query.boxIds : (req.query.boxIds as string).split(','))
    : req.body?.boxIds || [];

  if (!shipmentId) {
    return res.status(400).json({ error: 'Missing shipmentId' });
  }

  try {
    const searchParams = new URLSearchParams();
    searchParams.set('PageType', pageType);
    searchParams.set('LabelType', labelType);

    if (labelType === 'UNIQUE') {
      // UNIQUE requires explicit carton list
      searchParams.set('NumberOfPackages', String(boxIdsParam.length || 1));
      for (const boxId of boxIdsParam) {
        searchParams.append('PackageLabelsToPrint', String(boxId));
      }
    } else {
      // BARCODE_2D uses NumberOfPackages only (returns one PDF with all labels)
      const n = numberOfPackages || boxIdsParam.length;
      if (!n) {
        return res.status(400).json({ error: 'numberOfPackages or boxIds required for BARCODE_2D' });
      }
      searchParams.set('NumberOfPackages', String(n));
    }

    const pathWithQuery = `/fba/inbound/v0/shipments/${shipmentId}/labels?${searchParams.toString()}`;
    console.log(`[get-labels] Fetching labels via proxy: ${pathWithQuery}`);

    const response = await callAmazonSpApi<any>({
      method: 'GET',
      path: pathWithQuery,
    });

    const downloadUrl = response.data?.payload?.DownloadURL;
    console.log(`[get-labels] Got download URL: ${downloadUrl ? 'yes' : 'no'}`);

    return res.json({
      success: true,
      shipmentId,
      downloadUrl,
      raw: response.data,
    });
  } catch (err: any) {
    const errData = err.details || err.message;
    console.error('[get-labels] Error:', JSON.stringify(errData));
    return res.status(500).json({
      success: false,
      error: err.message,
      details: errData,
    });
  }
}
