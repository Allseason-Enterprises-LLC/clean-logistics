/**
 * Dry-run channel-tag backfill.
 *
 * Pulls all orders since a given date, runs them through classifyOrderChannel(),
 * outputs a CSV showing what would be tagged. NO writes.
 */
import { supabase } from '../lib/supabase';
import { classifyOrderChannel } from '../lib/channel-tagging';
import * as fs from 'fs';

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
  const sinceDate = process.env.SINCE || '2026-04-25';
  console.log(`Dry-run channel tagging for orders since ${sinceDate}...`);

  const token = await getToken();
  const all: any[] = [];
  let after: string | null = null;
  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "${sinceDate}") {
          data(first: 100, after: $after) {
            edges { node {
              id order_number partner_order_id shop_name source partner_source_name tags
            } }
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

  // Classify each
  type Row = {
    order_number: string;
    shop_name: string;
    source: string;
    existing_tags: string;
    new_tags: string;
    reason: string;
    skip: boolean;
  };
  const rows: Row[] = [];

  const tagCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  let skipped = 0;
  let alreadyTagged = 0;
  let needsTagging = 0;

  for (const o of all) {
    const result = classifyOrderChannel({
      order_number: o.order_number,
      partner_order_id: o.partner_order_id,
      shop_name: o.shop_name,
      source: o.source,
      partner_source_name: o.partner_source_name,
      tags: o.tags || [],
    });

    if (result.skip) {
      skipped++;
      reasonCounts[`SKIP: ${result.reason}`] = (reasonCounts[`SKIP: ${result.reason}`] || 0) + 1;
      continue;
    }

    // Already has these tags?
    const existingTagsLc = (o.tags || []).map((t: string) => t.toLowerCase());
    const tagsToAdd = result.tags.filter(t => !existingTagsLc.includes(t.toLowerCase()));

    if (tagsToAdd.length === 0) {
      alreadyTagged++;
      continue;
    }

    needsTagging++;
    rows.push({
      order_number: o.order_number,
      shop_name: o.shop_name || '',
      source: o.source || '',
      existing_tags: (o.tags || []).join('|'),
      new_tags: tagsToAdd.join('|'),
      reason: result.reason,
      skip: false,
    });
    for (const t of tagsToAdd) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1;
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total orders:           ${all.length}`);
  console.log(`Would tag:              ${needsTagging}`);
  console.log(`Already tagged:         ${alreadyTagged}`);
  console.log(`Skipped (internal):     ${skipped}`);

  console.log(`\n=== TAGS THAT WOULD BE ADDED ===`);
  for (const [tag, count] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${count}`);
  }

  console.log(`\n=== REASONS ===`);
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  [${count}] ${reason}`);
  }

  // Show sample of each tag-set so user can sanity check
  console.log(`\n=== SAMPLE PER TAG ===`);
  const seenTags = new Set<string>();
  for (const r of rows) {
    if (!seenTags.has(r.new_tags)) {
      seenTags.add(r.new_tags);
      console.log(`  [${r.new_tags}]  order=${r.order_number}  shop="${r.shop_name}"  source=${r.source}`);
      console.log(`    existing tags: [${r.existing_tags}]`);
      console.log(`    reason: ${r.reason}`);
    }
  }

  // Write full CSV
  const csvHeader = 'order_number,shop_name,source,existing_tags,new_tags,reason';
  const csvLines = rows.map(r =>
    [r.order_number, r.shop_name, r.source, r.existing_tags, r.new_tags, r.reason]
      .map(x => `"${String(x ?? '').replace(/"/g, '""')}"`)
      .join(',')
  );
  fs.writeFileSync('/tmp/tag_dryrun.csv', [csvHeader, ...csvLines].join('\n'));
  console.log(`\nFull CSV: /tmp/tag_dryrun.csv (${rows.length} rows)`);
}
main().catch(e => { console.error(e); process.exit(1); });
