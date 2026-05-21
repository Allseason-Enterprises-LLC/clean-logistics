/**
 * One-shot: bulk-tag a specific list of TikTok orders as "TikTok" in ShipHero.
 *
 * Reads TikTok Order IDs from /tmp/tiktok_order_ids.txt (one per line),
 * looks them up in ShipHero by partner_order_id, then applies the "TikTok" tag
 * using order_bulk_add_tags.
 *
 * Usage:
 *   set -a && source .env.prod.local && set +a
 *   npx tsx scripts/tag_tiktok_orders_from_csv.ts
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const BATCH_SIZE = 50;
const SLEEP_MS = 400;
const TAG = 'TikTok';

async function getToken(): Promise<string> {
  const { data } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function gql(token: string, q: string, vars: any = {}): Promise<any> {
  while (true) {
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: vars }),
    });
    const json = await r.json();
    // Rate limit: auto-retry after waiting
    if (json.errors?.[0]?.code === 30) {
      const wait = (json.errors[0].time_remaining?.replace(/\D/g, '') || '2');
      const ms = (parseInt(wait) + 1) * 1000;
      process.stdout.write(`\n  [rate-limit] waiting ${ms}ms...\n`);
      await new Promise(res => setTimeout(res, ms));
      continue;
    }
    return json;
  }
}

async function main() {
  const tiktokOrderIds = fs.readFileSync('/tmp/tiktok_order_ids.txt', 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);

  console.log(`Loaded ${tiktokOrderIds.length} TikTok order IDs from CSV`);

  const token = await getToken();
  if (!token) throw new Error('No ShipHero token found');

  // ShipHero lookup: query by partner_order_id in batches
  // We'll search orders using order_number / partner_order_id filters
  // Use a date range that covers all these orders (May 2026)
  const since = '2026-05-10'; // CSV orders are from May 10-11

  console.log(`Fetching ShipHero orders since ${since}...`);

  const all: any[] = [];
  let after: string | null = null;
  let page = 0;

  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "${since}") {
          data(first: 100, after: $after) {
            edges { node { id order_number partner_order_id shop_name source tags } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const j = await gql(token, q, { after });
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    const data = j.data?.orders?.data;
    (data?.edges || []).forEach((e: any) => all.push(e.node));
    page++;
    process.stdout.write(`\r  Page ${page}: ${all.length} orders fetched...`);
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\nFetched ${all.length} ShipHero orders total`);

  // Build lookup: partner_order_id → ShipHero internal id
  const partnerIdToShipHeroId = new Map<string, string>();
  const partnerIdToTags = new Map<string, string[]>();
  for (const o of all) {
    if (o.partner_order_id) {
      partnerIdToShipHeroId.set(o.partner_order_id, o.id);
      partnerIdToTags.set(o.partner_order_id, o.tags || []);
    }
  }

  console.log(`Built lookup for ${partnerIdToShipHeroId.size} orders with partner_order_id`);

  // Match CSV order IDs
  const toTag: string[] = [];
  const alreadyTagged: string[] = [];
  const notFound: string[] = [];

  for (const tiktokId of tiktokOrderIds) {
    const shipheroId = partnerIdToShipHeroId.get(tiktokId);
    if (!shipheroId) {
      notFound.push(tiktokId);
      continue;
    }
    const existingTags = (partnerIdToTags.get(tiktokId) || []).map(t => t.toLowerCase());
    if (existingTags.includes(TAG.toLowerCase())) {
      alreadyTagged.push(tiktokId);
    } else {
      toTag.push(shipheroId);
    }
  }

  console.log(`\nMatch results:`);
  console.log(`  To tag:        ${toTag.length}`);
  console.log(`  Already tagged: ${alreadyTagged.length}`);
  console.log(`  Not found:     ${notFound.length}`);

  if (notFound.length > 0) {
    console.log(`\nNot found in ShipHero (first 20):`, notFound.slice(0, 20));
    fs.writeFileSync('/tmp/tiktok_not_found.json', JSON.stringify(notFound, null, 2));
    console.log(`Full list saved to /tmp/tiktok_not_found.json`);
  }

  if (toTag.length === 0) {
    console.log('\nNothing to tag. Done.');
    return;
  }

  // Apply via order_bulk_add_tags
  const mutation = `
    mutation($data: BulkUpdateTagsInput!) {
      order_bulk_add_tags(data: $data) {
        request_id
      }
    }`;

  let totalApplied = 0;
  let totalErrors = 0;

  console.log(`\nApplying "${TAG}" tag to ${toTag.length} orders in batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < toTag.length; i += BATCH_SIZE) {
    const chunk = toTag.slice(i, i + BATCH_SIZE);
    try {
      const j = await gql(token, mutation, {
        data: { orders_ids: chunk, tags: [TAG] },
      });
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      totalApplied += chunk.length;
      process.stdout.write(`\r  Progress: ${totalApplied}/${toTag.length} tagged...`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ERROR on batch ${i}-${i + chunk.length}: ${msg.slice(0, 200)}`);
      totalErrors += chunk.length;
    }
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }

  console.log(`\n\n=== DONE ===`);
  console.log(`Tagged:        ${totalApplied}`);
  console.log(`Errors:        ${totalErrors}`);
  console.log(`Already had:   ${alreadyTagged.length}`);
  console.log(`Not found:     ${notFound.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
