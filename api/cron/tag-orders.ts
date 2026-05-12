/**
 * Cron: every 5 minutes, scan recent orders and apply channel tags to any
 * that need them.
 *
 * Mirrors the FBT-hold cron pattern. Idempotent — order_bulk_add_tags only
 * adds, never removes.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase';
import { classifyOrderChannel } from '../../lib/channel-tagging';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const BATCH_SIZE = 50;

async function getToken(): Promise<string> {
  const { data, error } = await supabase
    .from('warehouses').select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID).eq('provider', 'shiphero').single();
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
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getToken();

    // Last 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Fetch + classify
    const all: any[] = [];
    let after: string | null = null;
    while (true) {
      const q = `
        query($after: String) {
          orders(order_date_from: "${since}") {
            data(first: 100, after: $after) {
              edges { node { id order_number partner_order_id shop_name source partner_source_name tags } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`;
      const j = await gql(token, q, { after });
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      const data = j.data?.orders?.data;
      (data?.edges || []).forEach((e: any) => all.push(e.node));
      if (!data?.pageInfo?.hasNextPage) break;
      after = data.pageInfo.endCursor;
    }

    // Group by tag-set
    const byTagSet = new Map<string, { tags: string[]; orderIds: string[] }>();
    let skipped = 0;
    let alreadyTagged = 0;

    for (const o of all) {
      const result = classifyOrderChannel({
        order_number: o.order_number,
        partner_order_id: o.partner_order_id,
        shop_name: o.shop_name,
        source: o.source,
        partner_source_name: o.partner_source_name,
        tags: o.tags || [],
      });
      if (result.skip) { skipped++; continue; }

      const existingLc = (o.tags || []).map((t: string) => t.toLowerCase());
      const tagsToAdd = result.tags.filter(t => !existingLc.includes(t.toLowerCase()));
      if (tagsToAdd.length === 0) { alreadyTagged++; continue; }

      const key = [...tagsToAdd].sort().join('|');
      if (!byTagSet.has(key)) byTagSet.set(key, { tags: tagsToAdd, orderIds: [] });
      byTagSet.get(key)!.orderIds.push(o.id);
    }

    // Apply
    const m = `
      mutation($data: BulkUpdateTagsInput!) {
        order_bulk_add_tags(data: $data) { request_id }
      }`;

    let applied = 0;
    let errors = 0;
    const tagSummary: Record<string, number> = {};

    for (const [key, group] of byTagSet.entries()) {
      for (let i = 0; i < group.orderIds.length; i += BATCH_SIZE) {
        const chunk = group.orderIds.slice(i, i + BATCH_SIZE);
        try {
          const j = await gql(token, m, {
            data: { orders_ids: chunk, tags: group.tags },
          });
          if (j.errors) throw new Error(JSON.stringify(j.errors));
          applied += chunk.length;
          tagSummary[key] = (tagSummary[key] || 0) + chunk.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[tag-cron] Batch failed (${key}, ${chunk.length}): ${msg.slice(0, 200)}`);
          errors += chunk.length;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      scanned_since: since,
      orders_scanned: all.length,
      tags_applied: applied,
      tag_summary: tagSummary,
      errors,
      skipped_internal: skipped,
      already_tagged: alreadyTagged,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[tag-cron] Fatal:', msg);
    return res.status(500).json({ error: msg });
  }
}
