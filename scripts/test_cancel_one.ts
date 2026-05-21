// Test cancel on ONE bridge dupe before running the full batch
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  const plan = JSON.parse(fs.readFileSync('/tmp/cancel_plan.json', 'utf-8')).plan;
  const test = plan[0];
  console.log(`Testing cancel on:`);
  console.log(`  partner_order_id: ${test.partnerId}`);
  console.log(`  KEEP:   ${test.keep.shop_name} | ${test.keep.order_number} (id=${test.keep.id})`);
  console.log(`  CANCEL: ${test.cancel.shop_name} | ${test.cancel.order_number} (id=${test.cancel.id})`);

  const m = `
    mutation($data: UpdateOrderInput!) {
      order_update(data: $data) {
        request_id
        order { id order_number fulfillment_status }
      }
    }`;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: m,
      variables: { data: { order_id: test.cancel.id, fulfillment_status: 'canceled' } },
    }),
  });
  const j: any = await r.json();
  console.log('\nResult:', JSON.stringify(j, null, 2));

  // Verify
  const r2 = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query { order(id: "${test.cancel.id}") { data { id order_number fulfillment_status } } }` }),
  });
  const j2: any = await r2.json();
  console.log('\nVerify:', JSON.stringify(j2, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
