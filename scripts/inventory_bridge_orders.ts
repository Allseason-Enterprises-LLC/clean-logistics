/**
 * inventory_bridge_orders.ts
 *
 * Builds a complete inventory of all 617 awaiting-shipment bridge orders.
 * For each: ShipHero order id, ShipHero order number, TikTok order id,
 * line items (sku + qty), addresses, expected ship date.
 *
 * Output: /tmp/bridge_inventory.csv + summary stats so we can plan
 * the cancel + native-reimport approach.
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}
let _tok: string | null = null;
async function tok() { return (_tok ??= await getToken()); }

async function shGql(query: string, variables?: any): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.errors?.find((e: any) => e.code === 30)) {
      const wait = (parseInt(json.errors[0]?.time_remaining) || 15) + 2;
      process.stdout.write(`\r  ⏳ rate-limited ${wait}s   `);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
  throw new Error('Max retries');
}

async function main() {
  // 1. Read TikTok status report — only keep AWAITING_SHIPMENT
  const statusCsv = fs.readFileSync('/tmp/tiktok_status.csv', 'utf8');
  const lines = statusCsv.split('\n').slice(1);  // skip header
  const awaiting: string[] = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts[1] === 'AWAITING_SHIPMENT') awaiting.push(parts[0]);
  }
  console.log(`${awaiting.length} bridge orders awaiting shipment on TikTok.\n`);

  // 2. Pull each one from ShipHero
  const out = ['shiphero_id,shiphero_order_number,tiktok_order_id,status,first_name,last_name,city,state,zip,sku,qty,product_name,weight_oz'];
  let missing = 0;
  let i = 0;

  for (const orderNum of awaiting) {
    i++;
    process.stdout.write(`\r  [${i}/${awaiting.length}] processing...   `);
    const q = `{ orders(order_number: "${orderNum}") { data(first:1) { edges { node {
      id order_number partner_order_id fulfillment_status expected_weight_in_oz
      shipping_address { first_name last_name city state zip }
      line_items(first: 20) { edges { node { sku quantity product { name } } } }
    } } } } }`;
    try {
      const d = await shGql(q);
      const node = d?.orders?.data?.edges?.[0]?.node;
      if (!node) { missing++; continue; }
      const a = node.shipping_address || {};
      const items = node.line_items?.edges || [];
      if (items.length === 0) {
        out.push(`${node.id},${node.order_number},${node.partner_order_id},${node.fulfillment_status},"${a.first_name||''}","${a.last_name||''}","${a.city||''}",${a.state||''},${a.zip||''},,,,${node.expected_weight_in_oz||''}`);
      } else {
        for (const e of items) {
          const li = e.node;
          out.push(`${node.id},${node.order_number},${node.partner_order_id},${node.fulfillment_status},"${a.first_name||''}","${a.last_name||''}","${a.city||''}",${a.state||''},${a.zip||''},${li.sku},${li.quantity},"${(li.product?.name||'').replace(/"/g,'""').slice(0,80)}",${node.expected_weight_in_oz||''}`);
        }
      }
      await new Promise(r => setTimeout(r, 80));
    } catch (e) {
      process.stdout.write(`\n  ✗ ${orderNum}: ${e}\n`);
    }
  }

  fs.writeFileSync('/tmp/bridge_inventory.csv', out.join('\n'));
  console.log(`\n\nWrote ${out.length - 1} line-items to /tmp/bridge_inventory.csv`);
  console.log(`Orders not found in ShipHero: ${missing}`);
}

main().catch(e => { console.error(e); process.exit(1); });
