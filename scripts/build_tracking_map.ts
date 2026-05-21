/**
 * For each shipped TT- order, fetch tracking + carrier from ShipHero.
 * Output: /tmp/shiphero_tracking_map.json (input format for push_tracking_from_csv.ts)
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

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
  const orders = JSON.parse(fs.readFileSync('/tmp/plan_a_shipped_tt_with_shids.json', 'utf8'));
  console.log(`Fetching tracking for ${orders.length} shipped TT- orders...`);

  const token = await getToken();
  const trackingMap: Record<string, any> = {};
  let withTracking = 0, noTracking = 0;

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const q = `query($id: String!) {
      order(id: $id) {
        data {
          shipments { id completed
            shipping_labels { tracking_number carrier shipping_name status }
          }
        }
      }
    }`;
    try {
      const j = await gql(token, q, { id: o.shiphero_id });
      const data = j.data?.order?.data;
      const labels = data?.shipments?.flatMap((s: any) => s.shipping_labels || []) || [];
      // Find a usable label
      const label = labels.find((l: any) => l.tracking_number);
      if (label) {
        trackingMap[o.tiktok_id] = {
          tracking: label.tracking_number,
          carrier: label.carrier || label.shipping_name || 'usps',
          sh_order_number: o.shiphero_order_number,
        };
        withTracking++;
      } else {
        noTracking++;
      }
    } catch (e: any) {
      console.error(`Error for ${o.tiktok_id}: ${e.message}`);
    }
    if ((i + 1) % 20 === 0) {
      process.stdout.write(`\r  ${i + 1}/${orders.length}  (with_tracking=${withTracking}, no_tracking=${noTracking})  `);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  console.log('');

  fs.writeFileSync('/tmp/shiphero_tracking_map.json', JSON.stringify(trackingMap, null, 2));
  console.log(`\nWrote ${Object.keys(trackingMap).length} tracking entries → /tmp/shiphero_tracking_map.json`);
  console.log(`  With tracking:  ${withTracking}`);
  console.log(`  No tracking:    ${noTracking} (shipped but no shipping_labels — unusual)`);
}

main().catch(e => { console.error(e); process.exit(1); });
