/**
 * find_shipped_vs_failing.ts
 *
 * Find one bridge order that successfully shipped + one failing order,
 * pull EVERY field on both, and print a diff.
 */
import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const CLEAN_NUTRA_LV_UUID = '22e17170-af72-4bf8-b77c-d73c86b06765';

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', CLEAN_NUTRA_LV_UUID).single();
  return (data?.api_credentials as any)?.accessToken;
}
let _tok: string | null = null;
async function tok() { return (_tok ??= await getToken()); }

async function shGql(query: string, variables?: any): Promise<any> {
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(SHIPHERO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tok()}` },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await resp.json();
    if (json.errors?.find((e: any) => e.code === 30)) {
      const wait = (parseInt(json.errors[0]?.time_remaining) || 15) + 2;
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
}

async function findShippedBridgeOrder() {
  // Find a bridge order (shop_name="TikTok Shop") that has shipments
  const q = `{
    orders(shop_name: "TikTok Shop", fulfillment_status: "fulfilled") {
      data(first: 5) {
        edges { node { id order_number fulfillment_status shipments { id } } }
      }
    }
  }`;
  const d = await shGql(q);
  const edges = d?.orders?.data?.edges || [];
  for (const e of edges) {
    if (e.node.shipments?.length > 0) return e.node.order_number;
  }
  return null;
}

async function fetchDetailed(orderNumber: string) {
  const q = `{ orders(order_number: "${orderNumber}") { data(first:1) { edges { node {
    id order_number partner_order_id shop_name fulfillment_status source partner_source_name profile
    flagged saturday_delivery require_signature adult_signature_required alcohol
    allow_partial allow_split insurance has_dry_ice priority_flag allocation_priority
    expected_weight_in_oz ignore_address_validation_errors skip_address_validation
    ignore_payment_capture_errors tote_qa do_not_print_invoice insurance_amount
    box_name required_ship_date order_date custom_invoice_url incoterms address_is_business
    gift_invoice currency tax_id tax_type dry_ice_weight_in_lbs ftr_exemption
    total_tax subtotal total_discounts total_price email packing_note gift_note
    tags
    shipping_lines { title carrier method price }
    shipping_address { first_name last_name company address1 address2 city state zip country phone email }
    billing_address { first_name last_name company address1 address2 city state zip country phone email }
    line_items(first:5) { edges { node { sku quantity barcode partner_line_item_id warehouse } } }
    allocations { warehouse_id }
    holds { fraud_hold address_hold operator_hold payment_hold }
  } } } } }`;
  const d = await shGql(q);
  return d?.orders?.data?.edges?.[0]?.node;
}

function flatten(obj: any, prefix = ''): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else if (Array.isArray(v)) {
      out[key] = JSON.stringify(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

async function main() {
  const FAILING = 'TT-577383290317148773';

  // Find an order shipped successfully  
  let shippedNumber = process.argv[2];
  if (!shippedNumber) {
    console.log('Searching for a shipped bridge order...');
    shippedNumber = await findShippedBridgeOrder();
    if (!shippedNumber) { console.log('No shipped bridge order found'); return; }
  }
  console.log('Shipped order:', shippedNumber);
  console.log('Failing order:', FAILING);

  const shipped = await fetchDetailed(shippedNumber);
  const failing = await fetchDetailed(FAILING);

  const sFlat = flatten(shipped);
  const fFlat = flatten(failing);

  // Compare
  const allKeys = new Set([...Object.keys(sFlat), ...Object.keys(fFlat)]);
  console.log('\n=== DIFFERENCES ===\n');
  for (const k of Array.from(allKeys).sort()) {
    const sv = sFlat[k];
    const fv = fFlat[k];
    if (JSON.stringify(sv) !== JSON.stringify(fv)) {
      console.log(`${k}:`);
      console.log(`  shipped: ${JSON.stringify(sv)}`);
      console.log(`  failing: ${JSON.stringify(fv)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
