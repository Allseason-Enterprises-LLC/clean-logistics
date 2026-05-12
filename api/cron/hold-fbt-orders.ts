/**
 * Cron: every 5 minutes, find any FBT order from the last 24h that is NOT
 * on operator_hold and apply hold.
 *
 * This is a safety net behind the (currently broken) Order Allocated webhook.
 * FBT orders never allocate (TikTok ships them) so the webhook never fires.
 * This cron catches them.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken(): Promise<string> {
  const { data, error } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID)
    .eq('provider', 'shiphero')
    .single();
  if (error) throw new Error(`Failed to read warehouses row: ${error.message}`);
  const token = (data?.api_credentials as any)?.accessToken;
  if (!token) throw new Error('No accessToken on Clean Nutra warehouses row');
  return token;
}

async function gql(token: string, query: string, variables: any = {}): Promise<any> {
  const r = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron auth
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getToken();

    // Look at last 24h to catch any FBT we missed
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const fbtNotHeld: any[] = [];
    let after: string | null = null;
    while (true) {
      const q = `
        query($after: String) {
          orders(order_date_from: "${since}", source: "tiktok") {
            data(first: 100, after: $after) {
              edges { node {
                id order_number tags fulfillment_status
                holds { operator_hold }
              } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`;
      const j = await gql(token, q, { after });
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      const data = j.data?.orders?.data;
      for (const e of data?.edges || []) {
        const n = e.node;
        const tags = (n.tags || []) as string[];
        const isFbt = tags.includes('fulfilled_by_tiktok');
        const held = n.holds?.operator_hold === true;
        const cancelled = n.fulfillment_status === 'canceled' || n.fulfillment_status === 'cancelled';
        if (isFbt && !held && !cancelled) fbtNotHeld.push(n);
      }
      if (!data?.pageInfo?.hasNextPage) break;
      after = data.pageInfo.endCursor;
    }

    console.log(`[fbt-hold-cron] Found ${fbtNotHeld.length} FBT orders needing hold`);

    let held = 0;
    let errors = 0;
    for (const o of fbtNotHeld) {
      try {
        const m = `
          mutation($data: UpdateOrderHoldsInput!) {
            order_update_holds(data: $data) {
              request_id
              order { id holds { operator_hold } }
            }
          }`;
        const j = await gql(token, m, { data: { order_id: o.id, operator_hold: true } });
        if (j.errors) throw new Error(JSON.stringify(j.errors));
        held++;
        console.log(`[fbt-hold-cron] Held ${o.order_number}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[fbt-hold-cron] Failed to hold ${o.order_number}: ${msg}`);
        errors++;
      }
    }

    return res.status(200).json({
      ok: true,
      scanned_since: since,
      fbt_found_unheld: fbtNotHeld.length,
      held,
      errors,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[fbt-hold-cron] Fatal:', msg);
    return res.status(500).json({ error: msg });
  }
}
