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
  const boxIdsParam = req.query.boxIds
    ? (Array.isArray(req.query.boxIds) ? req.query.boxIds : (req.query.boxIds as string).split(','))
    : req.body?.boxIds || [];

  if (!shipmentId) {
    return res.status(400).json({ error: 'Missing shipmentId' });
  }

  try {
    // v0 FBA Inbound getLabels API — proxied through amazon-sp-api edge function
    const query: Record<string, string> = {
      PageType: pageType,
      LabelType: 'UNIQUE',
      NumberOfPackages: String(boxIdsParam.length || 1),
    };

    // PackageLabelsToPrint can be multi-valued; our proxy query-builder doesn't support arrays
    // so we encode repeated params as a comma-joined string in a single field.
    // Amazon v0 accepts repeated params via URL — we include them as repeated query params by
    // relying on the edge function's URL builder (which calls .append for each entry).
    // To support repeated params, pass them as an array of [key, value] pairs via URLSearchParams.
    const searchParams = new URLSearchParams();
    searchParams.set('PageType', pageType);
    searchParams.set('LabelType', 'UNIQUE');
    searchParams.set('NumberOfPackages', String(boxIdsParam.length || 1));
    for (const boxId of boxIdsParam) {
      searchParams.append('PackageLabelsToPrint', String(boxId));
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
