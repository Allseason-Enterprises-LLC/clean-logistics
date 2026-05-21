/**
 * mark_tiktok_urgent.ts
 *
 * Read TikTok order IDs from /tmp/eligible_orders.json
 * For each: look up in ShipHero, set fulfillment_status to "TikTok URGENT"
 * Report orders not found in ShipHero.
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const CLEAN_NUTRA_LV_WAREHOUSE = 'V2FyZWhvdXNlOjEzNTg3Mg==';
const DRY_RUN = process.argv.includes('--dry-run');

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

async function findOrder(tiktokId: string): Promise<any> {
  // Try TT- prefix first (bridge-imported)
  let d = await shGql(`{ orders(order_number: "TT-${tiktokId}") { data(first:1) { edges { node {
    id order_number fulfillment_status shop_name allocations { warehouse_id }
  } } } } }`);
  let node = d?.orders?.data?.edges?.[0]?.node;
  if (node) return node;

  // Try raw TikTok id (native ShipHero TikTok integration)
  d = await shGql(`{ orders(order_number: "${tiktokId}") { data(first:1) { edges { node {
    id order_number fulfillment_status shop_name allocations { warehouse_id }
  } } } } }`);
  node = d?.orders?.data?.edges?.[0]?.node;
  if (node) return node;

  // Try partner_order_id as fallback
  d = await shGql(`{ orders(partner_order_id: "${tiktokId}") { data(first:1) { edges { node {
    id order_number fulfillment_status shop_name allocations { warehouse_id }
  } } } } }`);
  return d?.orders?.data?.edges?.[0]?.node || null;
}

async function setStatus(orderId: string): Promise<void> {
  await shGql(`
    mutation($d: UpdateOrderInput!) {
      order_update(data: $d) { request_id }
    }
  `, { d: { order_id: orderId, fulfillment_status: 'TikTok URGENT' } });
}

async function main() {
  const eligible: { order_id: string; warehouse: string; created: string }[] =
    JSON.parse(fs.readFileSync('/tmp/eligible_orders.json', 'utf8'));

  console.log(`\nProcessing ${eligible.length} eligible orders... ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'}\n`);

  const updated: string[] = [];
  const alreadyUrgent: string[] = [];
  const notInLV: any[] = [];
  const notFound: any[] = [];
  const errors: string[] = [];

  for (let i = 0; i < eligible.length; i++) {
    const o = eligible[i];
    process.stdout.write(`\r  [${i+1}/${eligible.length}] updated=${updated.length} not_found=${notFound.length}    `);

    try {
      const node = await findOrder(o.order_id);
      if (!node) {
        notFound.push({ ...o });
        continue;
      }

      // Check if in Clean Nutra LV warehouse
      const lvAllocation = node.allocations?.find((a: any) => a.warehouse_id === CLEAN_NUTRA_LV_WAREHOUSE);
      if (!lvAllocation) {
        notInLV.push({
          tiktok_id: o.order_id,
          shiphero_order: node.order_number,
          status: node.fulfillment_status,
          warehouses: node.allocations?.map((a:any) => a.warehouse_id) || [],
          tiktok_warehouse: o.warehouse,
        });
        continue;
      }

      if (node.fulfillment_status === 'TikTok URGENT') {
        alreadyUrgent.push(node.order_number);
        continue;
      }

      if (!DRY_RUN) {
        await setStatus(node.id);
        await new Promise(r => setTimeout(r, 100));
      }
      updated.push(`${node.order_number} (was: ${node.fulfillment_status})`);
    } catch (e) {
      errors.push(`${o.order_id}: ${e}`);
    }
  }

  console.log(`\n\n=== SUMMARY ===\n`);
  console.log(`Updated → TikTok URGENT: ${updated.length}`);
  console.log(`Already TikTok URGENT:   ${alreadyUrgent.length}`);
  console.log(`In ShipHero but not LV:  ${notInLV.length}`);
  console.log(`Not in ShipHero:         ${notFound.length}`);
  console.log(`Errors:                  ${errors.length}`);

  if (updated.length > 0) {
    console.log(`\n--- Updated orders ---`);
    for (const u of updated.slice(0, 20)) console.log(`  ✓ ${u}`);
    if (updated.length > 20) console.log(`  ... and ${updated.length - 20} more`);
  }

  if (notInLV.length > 0) {
    console.log(`\n--- In ShipHero but NOT Clean Nutra LV (skipped) ---`);
    for (const n of notInLV) {
      console.log(`  ${n.tiktok_id} → ShipHero: ${n.shiphero_order} (TikTok says: ${n.tiktok_warehouse}, status: ${n.status})`);
    }
  }

  if (notFound.length > 0) {
    console.log(`\n--- Not in ShipHero ---`);
    for (const nf of notFound) {
      console.log(`  ${nf.order_id} (TikTok warehouse: ${nf.warehouse})`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n--- Errors ---`);
    for (const e of errors) console.log(`  ${e}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
