/**
 * Bulk-add a single tag to a pre-resolved list of ShipHero order IDs.
 *
 * Reads:  /tmp/urgent_tag_sh_ids.json  (array of ShipHero internal order IDs)
 * Tag:    TAG env var (default: "TikTok URGENT")
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const BATCH_SIZE = 50;
const SLEEP_MS = 400;
const TAG = process.env.TAG || 'TikTok URGENT';

async function getToken(): Promise<string> {
  const { data } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', CLEAN_NUTRA_LV_UUID).eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function gql(token: string, q: string, vars: any = {}): Promise<any> {
  while (true) {
    const r = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: vars }),
    });
    const json = await r.json();
    if (json.errors?.[0]?.code === 30) {
      const wait = parseInt((json.errors[0].time_remaining || '2').toString().replace(/\D/g, '') || '2');
      await new Promise(res => setTimeout(res, (wait + 1) * 1000));
      continue;
    }
    return json;
  }
}

async function main() {
  const ids: string[] = JSON.parse(fs.readFileSync('/tmp/urgent_tag_sh_ids.json', 'utf8'));
  console.log(`Tagging ${ids.length} ShipHero orders with "${TAG}"`);

  const token = await getToken();
  const mutation = `
    mutation($data: BulkUpdateTagsInput!) {
      order_bulk_add_tags(data: $data) {
        request_id
      }
    }`;

  let applied = 0, errors = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    try {
      const j = await gql(token, mutation, { data: { orders_ids: chunk, tags: [TAG] } });
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      applied += chunk.length;
    } catch (err: any) {
      console.error(`  ERROR on batch ${i}-${i + chunk.length}: ${err.message.slice(0, 200)}`);
      errors += chunk.length;
    }
    process.stdout.write(`\r  ${applied + errors}/${ids.length}  (applied=${applied}, errors=${errors})  `);
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }
  console.log(`\n\n=== DONE ===`);
  console.log(`Applied: ${applied}`);
  console.log(`Errors:  ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
