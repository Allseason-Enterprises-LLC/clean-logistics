/**
 * fix_addresses_from_csv.ts
 *
 * For each order in /tmp/order_numbers.txt:
 *   1. Fetch shipping_address from ShipHero
 *   2. Look up the OFFICIAL city name for the ZIP from USPS's free zippopotam.us API
 *   3. If the city name differs (e.g. "Powder Spgs" vs "Powder Springs"),
 *      update the order's shipping_address via order_update.
 *
 * Output: a CSV listing all fixed orders + a summary count.
 *
 * Safe: only updates city when there's a mismatch and the ZIP is valid.
 * Dry-run mode: pass --dry-run to see what would change without writing.
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';
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

// Zip → official city name from zippopotam.us (free, no auth)
const zipCache = new Map<string, { city: string; state: string } | null>();
async function lookupZip(zip: string): Promise<{ city: string; state: string } | null> {
  const z5 = zip.replace(/-.*$/, '').trim();
  if (zipCache.has(z5)) return zipCache.get(z5)!;
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${z5}`);
    if (!r.ok) { zipCache.set(z5, null); return null; }
    const j: any = await r.json();
    const place = j?.places?.[0];
    if (!place) { zipCache.set(z5, null); return null; }
    const result = {
      city: place['place name'],
      state: place['state abbreviation'],
    };
    zipCache.set(z5, result);
    return result;
  } catch {
    zipCache.set(z5, null);
    return null;
  }
}

interface OrderAddr {
  id: string;
  order_number: string;
  shipping: any;
  billing: any;
}

async function getOrder(orderNumber: string): Promise<OrderAddr | null> {
  const q = `query { orders(order_number: "${orderNumber}") { data(first:1) { edges { node {
    id order_number
    shipping_address { first_name last_name company address1 address2 city state zip country phone email }
    billing_address  { first_name last_name company address1 address2 city state zip country phone email }
  } } } } }`;
  const d = await shGql(q);
  const node = d?.orders?.data?.edges?.[0]?.node;
  if (!node) return null;
  return { id: node.id, order_number: node.order_number, shipping: node.shipping_address, billing: node.billing_address };
}

async function updateAddress(orderId: string, addr: any, billing: any): Promise<void> {
  const cleanAddr = {
    first_name: addr.first_name || '',
    last_name: addr.last_name || '',
    company: addr.company || '',
    address1: addr.address1 || '',
    address2: addr.address2 || '',
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    country: addr.country || 'US',
    phone: addr.phone || '',
    email: addr.email || '',
  };
  const cleanBilling = billing ? {
    first_name: billing.first_name || '',
    last_name: billing.last_name || '',
    company: billing.company || '',
    address1: billing.address1 || '',
    address2: billing.address2 || '',
    city: billing.city,
    state: billing.state,
    zip: billing.zip,
    country: billing.country || 'US',
    phone: billing.phone || '',
    email: billing.email || '',
  } : null;

  await shGql(`
    mutation($d: UpdateOrderInput!) {
      order_update(data: $d) { request_id }
    }
  `, { d: { order_id: orderId, shipping_address: cleanAddr, ...(cleanBilling ? { billing_address: cleanBilling } : {}) } });
}

function normalize(s: string | null | undefined): string {
  return (s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

async function main() {
  const orderNumbers = fs.readFileSync('/tmp/order_numbers.txt', 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);

  console.log(`\nValidating addresses on ${orderNumbers.length} orders... ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'}\n`);

  const fixes: any[] = [];
  let processed = 0, fixed = 0, skipped = 0, badZip = 0;

  for (const orderNumber of orderNumbers) {
    processed++;
    process.stdout.write(`\r  [${processed}/${orderNumbers.length}] fixed=${fixed} skipped=${skipped} badZip=${badZip}   `);

    try {
      const order = await getOrder(orderNumber);
      if (!order || !order.shipping) { skipped++; continue; }
      const a = order.shipping;
      const uspsZip = await lookupZip(a.zip || '');
      if (!uspsZip) { badZip++; continue; }
      if (normalize(uspsZip.city) === normalize(a.city)) { skipped++; continue; }

      // Mismatch found
      const fix = {
        order_number: orderNumber,
        zip: a.zip,
        was_city: a.city,
        usps_city: uspsZip.city,
        state: a.state,
      };
      fixes.push(fix);

      if (!DRY_RUN) {
        const newAddr = { ...a, city: uspsZip.city };
        const newBilling = order.billing ? { ...order.billing, city: order.billing.zip === a.zip ? uspsZip.city : order.billing.city } : null;
        await updateAddress(order.id, newAddr, newBilling);
      }
      fixed++;
      await new Promise(r => setTimeout(r, 80));
    } catch (e) {
      process.stdout.write(`\n  ✗ ${orderNumber}: ${e}\n`);
      skipped++;
    }
  }

  console.log(`\n\n=== Summary ===`);
  console.log(`Processed:        ${processed}`);
  console.log(`City corrected:   ${fixed}`);
  console.log(`Already correct:  ${skipped}`);
  console.log(`Invalid ZIP:      ${badZip}`);

  // Write CSV
  const out = '/tmp/address_fixes.csv';
  const header = 'order_number,zip,was_city,usps_city,state\n';
  const rows = fixes.map(f => `${f.order_number},${f.zip},"${f.was_city}","${f.usps_city}",${f.state}`).join('\n');
  fs.writeFileSync(out, header + rows);
  console.log(`\nDetails written to ${out}`);

  if (DRY_RUN) {
    console.log('\n[Dry run — no changes made. Re-run without --dry-run to apply.]');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
