import { supabase } from './supabase';
import type { FbaShipmentStatus, SkuMaster } from './fba-types';

const BRANDMIND_API_URL = process.env.BRANDMIND_API_URL || 'https://brandmind-api.vercel.app';
const MARKETPLACE_ID = 'ATVPDKIKX0DER'; // US

/**
 * Look up Amazon SKU mapping using the EXISTING sku_master table.
 * Schema: cin7_sku, amazon_seller_sku (not amz_sku)
 */
export async function lookupSkuMapping(cin7Sku: string): Promise<SkuMaster | null> {
  // First try sku_master (has cin7_sku → amazon_seller_sku)
  // Note: sku_master can have multiple rows per cin7_sku (FBA + FBM + master-file imports),
  // so we fetch all matches and prefer FBA (non-FBM) SKUs. .maybeSingle() errors on >1 rows.
  const { data: skuRows } = await supabase
    .from('sku_master')
    .select('cin7_sku, amazon_seller_sku, amazon_asin, notes')
    .eq('cin7_sku', cin7Sku);

  // Prefer rows that are NOT FBM (merchant-fulfilled) — we want FBA SKUs for FBA inbound
  const preferred = (skuRows || []).find(r =>
    r.amazon_seller_sku && !r.amazon_seller_sku.toUpperCase().includes('-FBM-')
  ) || (skuRows || []).find(r => r.amazon_seller_sku);

  if (preferred?.amazon_seller_sku) {
    // Look up FNSKU from amazon_products table
    const { data: amzRows } = await supabase
      .from('amazon_products')
      .select('seller_sku, fnsku, asin')
      .eq('seller_sku', preferred.amazon_seller_sku)
      .eq('marketplace_id', MARKETPLACE_ID)
      .limit(1);

    const amzData = amzRows?.[0];

    return {
      cin7_sku: cin7Sku,
      product_name: preferred.notes?.split('cin7Name:')[1]?.split('|')[0]?.trim() || cin7Sku,
      amz_sku: preferred.amazon_seller_sku,
      amz_asin: amzData?.asin || preferred.amazon_asin || null,
      amz_fnsku: amzData?.fnsku || null,
    };
  }

  // Fallback: search amazon_products directly by seller_sku patterns
  // Some CIN7 SKUs might map directly
  const { data: directRows } = await supabase
    .from('amazon_products')
    .select('seller_sku, fnsku, asin')
    .eq('marketplace_id', MARKETPLACE_ID)
    .eq('seller_sku', cin7Sku)
    .limit(1);

  const directMatch = directRows?.[0];

  if (directMatch) {
    return {
      cin7_sku: cin7Sku,
      product_name: cin7Sku,
      amz_sku: directMatch.seller_sku,
      amz_asin: directMatch.asin || null,
      amz_fnsku: directMatch.fnsku || null,
    };
  }

  return null;
}

/**
 * Create a new FBA shipment record in the EXISTING fba_shipments table.
 * Adds cin7_transfer fields to link to the transfer pipeline.
 */
export async function createFbaRecord(
  cin7TransferNumber: string,
  shipheroOrderId?: string,
  shipheroOrderNumber?: string,
  items?: Array<{ sellerSku: string; quantity: number }>,
  box?: { length: number; width: number; height: number },
  weightLbs?: number
): Promise<any> {
  const { data, error } = await supabase
    .from('fba_shipments')
    .insert([{
      name: `CIN7-${cin7TransferNumber}`,
      marketplace_id: MARKETPLACE_ID,
      ship_from_warehouse_id: process.env.SHIPHERO_WAREHOUSE_ID,
      status: 'draft',
      box_length: box?.length || 20,
      box_width: box?.width || 15,
      box_height: box?.height || 12,
      box_weight_lbs: weightLbs || 25,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }])
    .select()
    .single();

  if (error) throw new Error(`Failed to create FBA record: ${error.message}`);
  return data;
}

/**
 * Update FBA shipment status
 */
export async function updateFbaStatus(
  id: string,
  status: string,
  updates?: Record<string, any>
): Promise<any> {
  const { data, error } = await supabase
    .from('fba_shipments')
    .update({
      status,
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`Failed to update FBA record: ${error.message}`);
  return data;
}

/**
 * Get pending FBA shipments
 */
export async function getPendingFbaShipments(): Promise<any[]> {
  const { data, error } = await supabase
    .from('fba_shipments')
    .select('*')
    .eq('status', 'draft')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) throw new Error(`Failed to fetch FBA shipments: ${error.message}`);
  return data || [];
}

/**
 * Check if a transfer already has an FBA record
 */
export async function getFbaByTransferName(transferNumber: string): Promise<any | null> {
  const { data } = await supabase
    .from('fba_shipments')
    .select('*')
    .eq('name', `CIN7-${transferNumber}`)
    .maybeSingle();

  return data;
}

/**
 * Submit FBA inbound shipment via clean-logistics' own endpoint
 * (which runs the 13-step workflow locally and proxies Amazon calls
 * through the amazon-sp-api Supabase edge function).
 */
export async function createFbaInboundShipment(
  shipFromWarehouseId: string,
  items: Array<{ sellerSku: string; quantity: number; casePack?: number; cases?: number; expiration?: string }>,
  boxDimensions: { length: number; width: number; height: number },
  weightLbs: number,
  options?: {
    shipFromAddressId?: string;
    boxQuantity?: number;
    casePack?: number;
  }
): Promise<any> {
  const baseUrl = process.env.SELF_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://shiphero-shipstation-bridge.vercel.app');
  const url = `${baseUrl}/api/fba/direct-submit`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shipFromWarehouseId,
      marketplaceId: MARKETPLACE_ID,
      items,
      box: boxDimensions,
      weightLbs,
      ...(options?.boxQuantity ? { boxQuantity: options.boxQuantity } : {}),
      ...(options?.casePack ? { casePack: options.casePack } : {}),
    }),
  });

  const json: any = await response.json();
  if (!response.ok) {
    throw new Error(`FBA create failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Fetch FBA labels via clean-logistics' own endpoint (proxied through edge function).
 */
export async function fetchFbaLabels(
  shipmentId: string
): Promise<{ downloadUrl: string | null }> {
  const baseUrl = process.env.SELF_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://shiphero-shipstation-bridge.vercel.app');
  const url = `${baseUrl}/api/fba/get-labels?shipmentId=${shipmentId}`;

  const response = await fetch(url);
  const json: any = await response.json();

  if (!response.ok || !json.success) {
    console.error('[fba] Label fetch failed:', json);
    return { downloadUrl: null };
  }

  return { downloadUrl: json.downloadUrl || null };
}

/**
 * Resolve CIN7 line items to Amazon MSKUs
 */
export async function resolveTransferItems(
  cin7Items: Array<{ sku: string; quantity: number }>
): Promise<{
  resolved: Array<{ sellerSku: string; cin7Sku: string; productName: string; quantity: number; fnsku: string }>;
  unresolved: Array<{ sku: string; quantity: number; reason: string }>;
}> {
  const resolved: Array<{ sellerSku: string; cin7Sku: string; productName: string; quantity: number; fnsku: string }> = [];
  const unresolved: Array<{ sku: string; quantity: number; reason: string }> = [];

  for (const item of cin7Items) {
    const mapping = await lookupSkuMapping(item.sku);
    
    if (!mapping) {
      unresolved.push({ ...item, reason: 'CIN7 SKU not found in sku_master or amazon_products' });
      continue;
    }
    
    if (!mapping.amz_sku) {
      unresolved.push({ ...item, reason: 'No Amazon seller SKU mapped' });
      continue;
    }

    resolved.push({
      sellerSku: mapping.amz_sku,
      cin7Sku: item.sku,
      productName: mapping.product_name || item.sku,
      quantity: item.quantity,
      fnsku: mapping.amz_fnsku || '',
    });
  }

  return { resolved, unresolved };
}
