/**
 * Cancel ONE native dupe + verify TikTok side unaffected.
 * Test before bulk-cancelling the remaining 93.
 */
import { supabase } from '../lib/supabase';
import { getTikTokCredentials, getOrderDetail } from '../lib/tiktok-api';
import * as fs from 'fs';

async function main() {
  const data = JSON.parse(fs.readFileSync('/tmp/dupe_analysis.json', 'utf-8'));
  const test = data[0];
  console.log(`TEST CASE:`);
  console.log(`  TikTok order id: ${test.partner_order_id}`);
  console.log(`  Bridge:  ${test.bridge_order_number}  (shipped, tracking=${test.bridge_tracking})`);
  console.log(`  Native:  ${test.native_order_number}  (id=${test.native_id}, will cancel)`);

  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  // 1. Snapshot TikTok status BEFORE
  const creds = await getTikTokCredentials();
  const before = await getOrderDetail(creds, [test.partner_order_id]);
  const ttBefore = before[0];
  console.log(`\nTikTok status BEFORE: ${ttBefore?.status}`);
  console.log(`TikTok tracking BEFORE: ${ttBefore?.tracking_number || '(none)'}`);

  // 2. Cancel native side
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
      variables: { data: { order_id: test.native_id, fulfillment_status: 'canceled' } },
    }),
  });
  const j: any = await r.json();
  console.log(`\nShipHero cancel result:`, JSON.stringify(j.data?.order_update?.order, null, 2));
  if (j.errors) { console.error('ERRORS:', JSON.stringify(j.errors)); process.exit(1); }

  // 3. Wait + check TikTok side AFTER
  console.log(`\nWaiting 15s for any sync to propagate to TikTok...`);
  await new Promise(r => setTimeout(r, 15000));
  const after = await getOrderDetail(creds, [test.partner_order_id]);
  const ttAfter = after[0];
  console.log(`\nTikTok status AFTER: ${ttAfter?.status}`);
  console.log(`TikTok tracking AFTER: ${ttAfter?.tracking_number || '(none)'}`);

  if (ttBefore?.status === ttAfter?.status) {
    console.log(`\n✅ SAFE: TikTok status unchanged (${ttBefore?.status}). Bulk cancel approved.`);
  } else {
    console.log(`\n🚨 STOP: TikTok status changed ${ttBefore?.status} → ${ttAfter?.status}. DO NOT BULK CANCEL.`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
