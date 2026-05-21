import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').single();
  return (data?.api_credentials as any)?.accessToken;
}

let _tok: string | null = null;
async function tok() { return (_tok ??= await getToken()); }

async function shGql(query: string, variables?: any) {
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.errors?.find((e:any) => e.code === 30)) {
      const wait = (parseInt(json.errors[0].time_remaining) || 15) + 2;
      process.stdout.write(`\r  rate-limited, waiting ${wait}s... `);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
}

async function main() {
  const statuses: Record<string, number> = {};
  let cursor: string | undefined;
  let total = 0;

  do {
    const data = await shGql(`
      query($after: String) {
        orders(shop_name: "TikTok Shop", tag: "TikTok") {
          data(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { fulfillment_status } }
          }
        }
      }
    `, { after: cursor || null });

    const edges = data?.orders?.data?.edges || [];
    for (const e of edges) {
      const s = e.node.fulfillment_status;
      statuses[s] = (statuses[s] || 0) + 1;
      total++;
    }
    process.stdout.write(`\r  scanned ${total}...`);
    cursor = data?.orders?.data?.pageInfo?.hasNextPage ? data.orders.data.pageInfo.endCursor : undefined;
  } while (cursor);

  console.log(`\n\nTotal bridge orders still with shop_name="TikTok Shop": ${total}`);
  console.log('\nBreakdown by fulfillment_status:');
  for (const [k, v] of Object.entries(statuses).sort((a,b) => b[1]-a[1])) {
    const tag = ['pending','TikTok','TikTok URGENT'].includes(k) ? ' ← NEEDS SHIPPING' : '';
    console.log(`  ${k}: ${v}${tag}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
