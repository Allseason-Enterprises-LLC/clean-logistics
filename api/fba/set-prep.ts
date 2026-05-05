import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 60 };

/**
 * Diagnostic / admin endpoint: list → set → verify prep details for an MSKU.
 * Proxied through the amazon-sp-api Supabase edge function — no direct Amazon calls.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const msku = (req.body?.msku || 'CN--ASHWAMACAF-VEG-BAG') as string;
  const marketplaceId = 'ATVPDKIKX0DER';

  try {
    // Step 1: List current prep details
    let listResult: any = null;
    try {
      const listRes = await callAmazonSpApi<any>({
        method: 'GET',
        path: '/inbound/fba/2024-03-20/items/prepDetails',
        query: {
          marketplaceId,
          mskus: msku,
        },
      });
      listResult = listRes.data;
    } catch (listErr: any) {
      listResult = {
        error: listErr.message,
        status: listErr.status ?? listErr.response?.status,
        body: listErr.details ?? listErr.response?.data,
      };
    }

    // Step 2: Set prep to NONE
    let setResult: any = null;
    try {
      const setRes = await callAmazonSpApi<any>({
        method: 'POST',
        path: '/inbound/fba/2024-03-20/items/prepDetails',
        body: {
          marketplaceId,
          mskuPrepDetails: [{
            msku,
            prepCategory: 'NONE',
            prepTypes: ['ITEM_NO_PREP'],
          }],
        },
      });
      setResult = setRes.data;
    } catch (setErr: any) {
      setResult = {
        error: setErr.message,
        status: setErr.status ?? setErr.response?.status,
        body: setErr.details ?? setErr.response?.data,
      };
    }

    // Step 3: List again to verify
    let verifyResult: any = null;
    try {
      const verifyRes = await callAmazonSpApi<any>({
        method: 'GET',
        path: '/inbound/fba/2024-03-20/items/prepDetails',
        query: {
          marketplaceId,
          mskus: msku,
        },
      });
      verifyResult = verifyRes.data;
    } catch (verifyErr: any) {
      verifyResult = {
        error: verifyErr.message,
        status: verifyErr.status ?? verifyErr.response?.status,
        body: verifyErr.details ?? verifyErr.response?.data,
      };
    }

    return res.json({
      msku,
      step1_listPrepDetails: listResult,
      step2_setPrepDetails: setResult,
      step3_verifyPrepDetails: verifyResult,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
