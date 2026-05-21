/**
 * audit_clearship_orders.ts
 *
 * For each ClearShip order in the CSV:
 *   1. Check if it exists in our ShipHero (by exact order_number or partner_order_id)
 *   2. If found: where is it allocated, what status
 *   3. Aggregate SKU counts so we know what inventory is needed at LV
 *   4. Pull recipient address from TikTok (the source of truth, not the CSV)
 *
 * Output: JSON + console summary.
 */
import { supabase } from '../lib/supabase';
import { getTikTokCredentials, getOrderDetail } from '../lib/tiktok-api';
import * as fs from 'fs';

// Minimal CSV parser (no external deps)
function parseCsv(text: string): any[] {
  const lines = text.split(/\r?\n/);
  const rows: any[] = [];
  // Split a CSV line respecting quoted fields
  function splitLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        out.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out;
  }
  const header = splitLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitLine(lines[i]);
    const row: any = {};
    header.forEach((h, j) => { row[h] = cells[j] || ''; });
    rows.push(row);
  }
  return rows;
}

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
const CLEAN_NUTRA_LV_WAREHOUSE = 'V2FyZWhvdXNlOjEzNTg3Mg==';

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
}

async function findInShipHero(tiktokId: string): Promise<any> {
  // Try TT- prefix
  let d = await shGql(`{ orders(order_number: "TT-${tiktokId}") { data(first:1) { edges { node {
    id order_number fulfillment_status allocations { warehouse_id }
  } } } } }`);
  let node = d?.orders?.data?.edges?.[0]?.node;
  if (node) return node;
  // Try raw
  d = await shGql(`{ orders(order_number: "${tiktokId}") { data(first:1) { edges { node {
    id order_number fulfillment_status allocations { warehouse_id }
  } } } } }`);
  node = d?.orders?.data?.edges?.[0]?.node;
  if (node) return node;
  // Try partner_order_id
  d = await shGql(`{ orders(partner_order_id: "${tiktokId}") { data(first:1) { edges { node {
    id order_number fulfillment_status allocations { warehouse_id }
  } } } } }`);
  return d?.orders?.data?.edges?.[0]?.node || null;
}

async function main() {
  const path = process.argv[2];
  if (!path) { console.error('Usage: audit_clearship_orders.ts <csv>'); process.exit(1); }

  const text = fs.readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
  const records: any[] = parseCsv(text);

  // Dedupe by Order ID (csv has 1 row per line item)
  const ordersMap = new Map<string, any[]>();
  for (const r of records) {
    const oid = (r['Order ID'] || '').trim();
    if (!oid) continue;
    if (!ordersMap.has(oid)) ordersMap.set(oid, []);
    ordersMap.get(oid)!.push(r);
  }
  const orderIds = Array.from(ordersMap.keys());
  console.log(`\nAuditing ${orderIds.length} unique ClearShip orders\n`);

  // 1. Find existing in ShipHero
  const inShipHero: any[] = [];
  const notInShipHero: any[] = [];
  for (let i = 0; i < orderIds.length; i++) {
    process.stdout.write(`\r  [1/3] ShipHero lookup ${i+1}/${orderIds.length}   `);
    const tiktokId = orderIds[i];
    const node = await findInShipHero(tiktokId);
    if (node) inShipHero.push({ tiktokId, node });
    else notInShipHero.push(tiktokId);
  }

  console.log(`\n\nIn ShipHero:     ${inShipHero.length}`);
  console.log(`Not in ShipHero: ${notInShipHero.length}\n`);

  if (inShipHero.length > 0) {
    console.log('=== Existing ShipHero orders (warehouses) ===');
    const byWh: Record<string, number> = {};
    for (const x of inShipHero) {
      const wh = x.node.allocations?.[0]?.warehouse_id || '(none)';
      byWh[wh] = (byWh[wh] || 0) + 1;
    }
    for (const [wh, c] of Object.entries(byWh)) {
      const label = wh === CLEAN_NUTRA_LV_WAREHOUSE ? wh + ' (Clean Nutra LV)' : wh;
      console.log(`  ${label}: ${c}`);
    }
    console.log();
  }

  // 2. SKU aggregation from CSV (gives us what's needed at LV)
  const skuCounts: Record<string, number> = {};
  for (const lineItems of Array.from(ordersMap.values())) {
    for (const li of lineItems) {
      const sku = (li['Seller SKU'] || '').trim();
      const qty = parseInt(li['Quantity'] || '0') || 0;
      if (!sku) continue;
      skuCounts[sku] = (skuCounts[sku] || 0) + qty;
    }
  }
  console.log('=== SKUs needed at Clean Nutra LV ===');
  const sortedSkus = Object.entries(skuCounts).sort((a,b) => b[1]-a[1]);
  for (const [sku, c] of sortedSkus) console.log(`  ${sku}: ${c}`);
  console.log();

  // 3. Cross-check inventory at LV
  console.log('=== Inventory check at Clean Nutra LV ===');
  const inventory: any[] = [];
  for (let i = 0; i < sortedSkus.length; i++) {
    const [sku, needed] = sortedSkus[i];
    process.stdout.write(`\r  [3/3] Inventory ${i+1}/${sortedSkus.length}   `);
    const d = await shGql(`query { product(sku: "${sku}") { data { sku name warehouse_products { warehouse_id available on_hand } } } }`);
    const wp = d?.product?.data?.warehouse_products?.find((w:any) => w.warehouse_id === CLEAN_NUTRA_LV_WAREHOUSE);
    inventory.push({ sku, needed, name: d?.product?.data?.name, available: wp?.available ?? 'NOT FOUND', on_hand: wp?.on_hand ?? 'NOT FOUND' });
  }
  console.log('\n');
  console.log('SKU                                   | Needed | Avail at LV | OnHand | Status');
  console.log('--------------------------------------|--------|-------------|--------|-------');
  for (const inv of inventory) {
    const sku = inv.sku.padEnd(38);
    const need = String(inv.needed).padStart(6);
    const avail = String(inv.available).padStart(11);
    const onhand = String(inv.on_hand).padStart(6);
    let status = '✓ OK';
    if (inv.available === 'NOT FOUND') status = '✗ NOT IN CATALOG';
    else if (typeof inv.available === 'number' && inv.available < inv.needed) status = `⚠ short by ${inv.needed - inv.available}`;
    console.log(`${sku}| ${need} | ${avail} | ${onhand} | ${status}`);
  }

  // Save full report
  fs.writeFileSync('/tmp/clearship_audit.json', JSON.stringify({
    total_orders: orderIds.length,
    in_shiphero: inShipHero.length,
    not_in_shiphero: notInShipHero.length,
    not_in_shiphero_ids: notInShipHero,
    in_shiphero_orders: inShipHero.map(x => ({ tiktok_id: x.tiktokId, order_number: x.node.order_number, status: x.node.fulfillment_status, warehouses: x.node.allocations?.map((a:any)=>a.warehouse_id) || [] })),
    sku_demand: skuCounts,
    inventory,
  }, null, 2));
  console.log(`\nFull report: /tmp/clearship_audit.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
