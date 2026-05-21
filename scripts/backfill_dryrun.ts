// Dry-run: import ONE oldest missing order and verify the address landed correctly
import * as fs from 'fs';
import { importOrder } from '../lib/tiktok-bridge';
import { getTikTokCredentials, getOrderDetail } from '../lib/tiktok-api';
import { getLasVegasSkuPatterns } from '../lib/tiktok-routing';
import { supabase } from '../lib/supabase';

async function main() {
  const ids: string[] = JSON.parse(fs.readFileSync('/tmp/missing_orders_dryrun.json', 'utf-8'));
  const creds = await getTikTokCredentials();
  const patterns = await getLasVegasSkuPatterns();

  console.log(`Dry-run with ID: ${ids[0]}`);
  const details = await getOrderDetail(creds, ids);
  if (!details.length) { console.log('No detail returned — order may be cancelled'); return; }
  const detail = details[0];

  console.log('\n=== TikTok detail (relevant fields) ===');
  const addr = detail.recipient_address || detail.shipping_address || {};
  console.log(JSON.stringify({
    id: detail.id || detail.order_id,
    fulfillment_type: detail.fulfillment_type,
    line_items_count: (detail.line_items || []).length,
    address: {
      full_name: addr.full_name,
      first_name: addr.first_name,
      last_name: addr.last_name,
      address_line1: addr.address_line1,
      address_line2: addr.address_line2,
      city: addr.city,
      state: addr.state,
      postal_code: addr.postal_code,
      region_code: addr.region_code,
      phone_number: addr.phone_number,
      district_info: addr.district_info,
    }
  }, null, 2));

  console.log('\n=== Calling importOrder ===');
  const outcome = await importOrder(creds, detail, patterns);
  console.log(`Outcome: ${outcome}`);

  // Pull the order back out of ShipHero to verify what landed
  const { data: bridgeRow } = await supabase
    .from('tiktok_shiphero_orders')
    .select('shiphero_order_id, shiphero_order_number, status, error_message')
    .eq('tiktok_order_id', detail.id || detail.order_id)
    .single();
  console.log('\nBridge row:', bridgeRow);

  if (bridgeRow?.shiphero_order_id) {
    const { data: wh } = await supabase
      .from('warehouses').select('api_credentials')
      .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
    const token = (wh?.api_credentials as any)?.accessToken;
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `
        query { order(id: "${bridgeRow.shiphero_order_id}") {
          data {
            order_number shop_name fulfillment_status tags
            shipping_address { first_name last_name address1 address2 city state zip country phone email }
            line_items { edges { node { sku quantity product_name } } }
          }
        }}` }),
    });
    const j: any = await r.json();
    console.log('\n=== ShipHero order as-stored ===');
    console.log(JSON.stringify(j.data?.order?.data, null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
