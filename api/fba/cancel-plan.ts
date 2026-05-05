import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 60 };

/**
 * Cancel an FBA inbound plan.
 * POST /api/fba/cancel { "planId": "wf..." }
 *
 * Proxied through the amazon-sp-api Supabase edge function — no direct Amazon calls.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const planId = req.body?.planId as string;
  if (!planId) return res.status(400).json({ error: 'Missing planId' });

  try {
    const response = await callAmazonSpApi<any>({
      method: 'PUT',
      path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/cancellation`,
      body: {},
    });

    return res.json({ success: true, planId, data: response.data });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message,
      details: err.details ?? err.response?.data,
    });
  }
}
