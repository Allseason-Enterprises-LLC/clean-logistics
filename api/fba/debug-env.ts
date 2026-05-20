import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const debug: any = {
    env: {
      SUPABASE_URL_raw: process.env.SUPABASE_URL,
      SUPABASE_URL_length: process.env.SUPABASE_URL?.length,
      SUPABASE_URL_first10: process.env.SUPABASE_URL?.slice(0, 10),
      SUPABASE_URL_last10: process.env.SUPABASE_URL?.slice(-10),
      AMAZON_PROXY_SHARED_SECRET_set: !!process.env.AMAZON_PROXY_SHARED_SECRET,
      AMAZON_PROXY_SHARED_SECRET_length: process.env.AMAZON_PROXY_SHARED_SECRET?.length || 0,
      CRON_SECRET_set: !!process.env.CRON_SECRET,
    },
    calls: {},
  };

  // Test direct edge function URL
  try {
    const url = `${process.env.SUPABASE_URL}/functions/v1/amazon-sp-api`;
    debug.computed_url = url;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      },
      body: JSON.stringify({
        method: 'GET',
        path: '/inbound/fba/2024-03-20/inboundPlans?pageSize=1',
        region: 'na',
      }),
    });
    const text = await r.text();
    const respHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => { respHeaders[k] = v; });
    debug.calls.directFetch = {
      status: r.status,
      bodyPreview: text.slice(0, 300),
      respHeaders,
    };
  } catch (e: any) {
    debug.calls.directFetch = { error: e?.message || String(e) };
  }

  // Test via callAmazonSpApi (the production code path)
  try {
    const r = await callAmazonSpApi<any>({
      method: 'GET',
      path: '/inbound/fba/2024-03-20/inboundPlans',
      query: { pageSize: 1 },
    });
    debug.calls.viaClient = {
      status: r.status,
      dataKeys: Object.keys(r.data || {}),
    };
  } catch (e: any) {
    debug.calls.viaClient = {
      error: e?.message || String(e),
      name: e?.name,
      status: e?.status,
      details: e?.details ? JSON.stringify(e.details).slice(0, 300) : null,
    };
  }

  res.status(200).json(debug);
}
