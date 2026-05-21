/**
 * One-shot backfill: apply channel tags to all eligible orders since a given date.
 *
 * Uses order_bulk_add_tags (50 orders per call) for efficiency.
 * Idempotent — order_bulk_add_tags only adds, never removes existing tags.
 *
 * Usage:
 *   set -a && source .env.prod.local && set +a
 *   SINCE=2026-04-25 npx tsx scripts/backfill_tags.ts
 */
import { supabase } from '../lib/supabase';
import { classifyOrderChannel } from '../lib/channel-tagging';
import * as fs from 'fs';

const BATCH_SIZE = 50;
const SLEEP_MS = 400;

async function getToken(): Promise<string> {
  const { data } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function gql(token: string, q: string, vars: any = {}): Promise<any> {
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: vars }),
  });
  return r.json();
}

async function main() {
  const since = process.env.SINCE || '2026-04-25';
  console.log(`Backfill channel tags for orders since ${since}`);

  const token = await getToken();

  // Fetch all
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
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`Fetched ${all.length} orders`);

  // Group orders by tag-set so we can bulk-add efficiently
  // Map<sortedTagsString, OrderId[]>
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

  console.log(`\nSkipped: ${skipped}  Already tagged: ${alreadyTagged}`);
  for (const [key, group] of byTagSet.entries()) {
    console.log(`  [${key}] → ${group.orderIds.length} orders`);
  }

  // Apply via order_bulk_add_tags
  const m = `
    mutation($data: BulkUpdateTagsInput!) {
      order_bulk_add_tags(data: $data) {
        request_id
      }
    }`;

  const results: any[] = [];
  let totalApplied = 0;
  let totalErrors = 0;

  for (const [key, group] of byTagSet.entries()) {
    console.log(`\n=== Applying [${key}] to ${group.orderIds.length} orders ===`);
    for (let i = 0; i < group.orderIds.length; i += BATCH_SIZE) {
      const chunk = group.orderIds.slice(i, i + BATCH_SIZE);
      try {
        const j = await gql(token, m, {
          data: { orders_ids: chunk, tags: group.tags },
        });
        if (j.errors) throw new Error(JSON.stringify(j.errors));
        totalApplied += chunk.length;
        results.push({ tags: group.tags, count: chunk.length, ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ERROR on batch: ${msg.slice(0, 200)}`);
        totalErrors += chunk.length;
        results.push({ tags: group.tags, count: chunk.length, ok: false, error: msg });
      }
      console.log(`  Progress: ${i + chunk.length}/${group.orderIds.length}`);
      fs.writeFileSync('/tmp/backfill_tag_results.json', JSON.stringify(results, null, 2));
      await new Promise(r => setTimeout(r, SLEEP_MS));
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Applied:    ${totalApplied}`);
  console.log(`Errors:     ${totalErrors}`);
  console.log(`Skipped:    ${skipped}`);
  console.log(`Already:    ${alreadyTagged}`);
}

main().catch(e => { console.error(e); process.exit(1); });
