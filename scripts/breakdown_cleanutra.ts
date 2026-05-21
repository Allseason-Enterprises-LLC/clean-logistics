/**
 * Break down the 1,080 "Clean Nutra" shop_name orders by what's actually in them.
 */
import { supabase } from '../lib/supabase';

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  const all: any[] = [];
  let after: string | null = null;
  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "2026-04-25", shop_name: "Clean Nutra") {
          data(first: 100, after: $after) {
            edges { node { id order_number tags } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { after } }),
    });
    const j: any = await r.json();
    if (j.errors) { console.error(JSON.stringify(j.errors)); return; }
    const data = j.data?.orders?.data;
    (data?.edges || []).forEach((e: any) => all.push(e.node));
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`'Clean Nutra' shop orders: ${all.length}\n`);

  const buckets = {
    tiktok_pickable: [] as any[],
    tiktok_fbt: [] as any[],
    cin7_transfer: [] as any[],
    influencer: [] as any[],
    no_tags: [] as any[],
    other: [] as any[],
  };

  for (const o of all) {
    const tags = (o.tags || []) as string[];
    const tagsLc = tags.map(t => t.toLowerCase());
    if (tagsLc.includes('fulfilled_by_tiktok')) buckets.tiktok_fbt.push(o);
    else if (tagsLc.some(t => t.startsWith('tiktok_'))) buckets.tiktok_pickable.push(o);
    else if (tagsLc.includes('cin7-transfer')) buckets.cin7_transfer.push(o);
    else if (tagsLc.includes('influencer-sample')) buckets.influencer.push(o);
    else if (tags.length === 0) buckets.no_tags.push(o);
    else buckets.other.push(o);
  }

  for (const [k, v] of Object.entries(buckets)) {
    console.log(`${k}: ${v.length}`);
    v.slice(0, 3).forEach((o: any) => {
      console.log(`  • ${o.order_number}  tags=${JSON.stringify(o.tags || [])}`);
    });
  }
}
main().catch(e => { console.error(e); process.exit(1); });
