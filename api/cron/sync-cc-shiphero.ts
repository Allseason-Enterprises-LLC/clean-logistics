import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase';
import { ccApiCall } from '../../lib/cc-api';
import { mapSku, CARRIER_MAP } from '../../lib/cc-sku-mapping';

const SH_API = 'https://public-api.shiphero.com/graphql';

async function getShipHeroToken(): Promise<string> {
  const { data, error } = await supabase
    .from('warehouses')
    .select('api_credentials')
    .eq('id', process.env.SHIPHERO_WAREHOUSE_ID!)
    .eq('provider', 'shiphero')
    .single();

  if (error) throw new Error(`Failed to get ShipHero token: ${error.message}`);
  const creds = data?.api_credentials as any;
  if (!creds?.accessToken) throw new Error('No ShipHero access token in api_credentials');
  return creds.accessToken;
}

async function shGraphQL(query: string): Promise<any> {
  const token = await getShipHeroToken();
  const resp = await fetch(SH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  return resp.json();
}

function formatDate(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function esc(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function extractOrders(data: any): any[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return Object.values(data);
}

function extractItems(items: any): any[] {
  if (!items) return [];
  if (Array.isArray(items)) return items;
  return Object.values(items);
}

const CUSTOMER_ACCOUNT_ID = process.env.SHIPHERO_CUSTOMER_ACCOUNT_ID || '95145';

// ─── Phase 1: Push CC orders to ShipHero ───

async function pushOrders(log: string[]) {
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const startDate = formatDate(threeDaysAgo);
  const endDate = formatDate(now);

  log.push(`[PUSH] Querying CC orders ${startDate} - ${endDate}`);

  let allOrders: any[] = [];
  let page = 1;
  while (page <= 10) {
    const resp = await ccApiCall('order/query', {
      startDate,
      endDate,
      orderStatus: 'COMPLETE',
      resultsPerPage: 200,
      page,
    });

    if (resp.result !== 'SUCCESS' || !resp.message?.data) {
      const msg = typeof resp.message === 'string' ? resp.message : JSON.stringify(resp.message || 'no data');
      log.push(`[PUSH] CC query page ${page}: ${resp.result} - ${msg}`);
      break;
    }

    const orders = extractOrders(resp.message.data);
    allOrders.push(...orders);

    const total = resp.message.totalResults || 0;
    if (allOrders.length >= total) break;
    page++;
  }

  log.push(`[PUSH] Found ${allOrders.length} CC orders`);

  let pushed = 0, skipped = 0, failed = 0, alreadyExists = 0;
  const errors: Array<{ orderId: string; error: string }> = [];

  for (const order of allOrders) {
    const orderId = order.orderId || order.orderID;
    if (!orderId) continue;

    const items = extractItems(order.items);
    if (items.length === 0) { skipped++; continue; }

    const mappedItems: Array<{ sku: string; quantity: number; name: string }> = [];
    let hasUnmapped = false;
    for (const item of items) {
      const ccSku = item.productSku || item.sku || item.SKU || '';
      const name = item.name || item.productName || '';
      const qty = parseInt(item.qty || item.quantity || 1);
      const shSku = mapSku(ccSku, name, qty);

      if (!shSku) {
        hasUnmapped = true;
        break;
      }
      mappedItems.push({ sku: shSku, quantity: qty, name });
    }

    if (hasUnmapped || mappedItems.length === 0) { skipped++; continue; }

    try {
      const checkResult = await shGraphQL(`{ orders(order_number: "${esc(orderId)}", customer_account_id: "${CUSTOMER_ACCOUNT_ID}") { data(first: 3) { edges { node { shop_name } } } } }`);
      const existingShops = checkResult.data?.orders?.data?.edges?.map((e: any) => e.node.shop_name) || [];
      if (existingShops.includes('CheckoutChamp') || existingShops.includes('Checkout Champ') || existingShops.includes('CC-Bridge')) {
        alreadyExists++;
        continue;
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (_) {}

    const shipFirst = order.shipFirstName || order.firstName || '';
    const shipLast = order.shipLastName || order.lastName || '';
    const addr1 = order.shipAddress1 || order.shippingAddress1 || '';
    const city = order.shipCity || order.shippingCity || '';
    const state = order.shipState || order.shippingState || '';
    const zip = order.shipPostalCode || order.shippingZip || order.postalCode || '';

    if (!city || !addr1) { skipped++; continue; }

    const lineItemsStr = mappedItems.map((item, idx) =>
      `{ sku: "${esc(item.sku)}", partner_line_item_id: "${orderId}-${idx}", quantity: ${item.quantity}, price: "0.00", product_name: "${esc(item.name)}" }`
    ).join(', ');

    const orderDate = isoDate(now);
    const shipByDate = isoDate(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000));

    const mutation = `mutation {
      order_create(data: {
        order_number: "${esc(orderId)}"
        partner_order_id: "${esc(orderId)}"
        shop_name: "CheckoutChamp"
        fulfillment_status: "pending"
        order_date: "${orderDate}"
        required_ship_date: "${shipByDate}"
        customer_account_id: "${CUSTOMER_ACCOUNT_ID}"
        shipping_lines: { title: "Standard Shipping", price: "0.00", carrier: "USPS", method: "Ground" }
        shipping_address: {
          first_name: "${esc(shipFirst)}"
          last_name: "${esc(shipLast)}"
          address1: "${esc(addr1)}"
          address2: "${esc(order.shipAddress2 || order.shippingAddress2 || '')}"
          city: "${esc(city)}"
          state: "${esc(state)}"
          zip: "${esc(zip)}"
          country: "${esc(order.shipCountry || order.shippingCountry || 'US')}"
          phone: "${esc(order.phoneNumber || '')}"
          email: "${esc(order.emailAddress || '')}"
        }
        line_items: [${lineItemsStr}]
      }) {
        request_id
        order { id order_number }
      }
    }`;

    try {
      const result = await shGraphQL(mutation);
      if (result.errors) {
        const errMsg = result.errors.map((e: any) => e.message).join('; ');
        if (errMsg.includes('already')) {
          alreadyExists++;
        } else {
          failed++;
          errors.push({ orderId, error: errMsg });
        }
      } else {
        pushed++;
      }
    } catch (e: any) {
      failed++;
      errors.push({ orderId, error: e.message });
    }

    await new Promise(r => setTimeout(r, 300));
  }

  log.push(`[PUSH] Pushed: ${pushed}, Already existed: ${alreadyExists}, Skipped: ${skipped}, Failed: ${failed}`);
  if (errors.length > 0 && errors.length <= 10) {
    for (const e of errors) log.push(`[PUSH] FAIL ${e.orderId}: ${e.error}`);
  }

  return { pushed, alreadyExists, skipped, failed, errors };
}

// ─── Phase 2: Sync tracking from ShipHero to CC ───

async function syncTracking(log: string[]) {
  log.push('[TRACK] Querying ShipHero for shipped orders...');

  const SHOP_NAMES = ['CheckoutChamp', 'Checkout Champ', 'CC-Bridge'];
  let allOrders: any[] = [];

  for (const shopName of SHOP_NAMES) {
    let cursor = '';
    let pages = 0;

    while (pages < 5) {
      const afterClause = cursor ? `after: "${cursor}"` : '';
      const query = `{
        orders(shop_name: "${shopName}", customer_account_id: "${CUSTOMER_ACCOUNT_ID}") {
          request_id
          complexity
          data(first: 50 ${afterClause}) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                order_number
                fulfillment_status
                shipping_lines { carrier }
                shipments {
                  id
                  created_date
                  shipping_labels {
                    tracking_number
                    carrier
                    status
                    created_date
                  }
                }
              }
            }
          }
        }
      }`;

      const result = await shGraphQL(query);
      if (result.errors) {
        log.push(`[TRACK] SH query error (${shopName}): ${result.errors.map((e: any) => e.message).join('; ')}`);
        break;
      }

      const data = result.data?.orders?.data;
      const edges = data?.edges || [];
      allOrders.push(...edges.map((e: any) => e.node));

      if (!data?.pageInfo?.hasNextPage) break;
      cursor = data.pageInfo.endCursor;
      pages++;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const orderMap = new Map<string, any>();
  for (const o of allOrders) {
    const existing = orderMap.get(o.order_number);
    const hasTracking = o.shipments?.some((s: any) => s.shipping_labels?.some((l: any) => l.tracking_number));
    if (!existing || hasTracking) orderMap.set(o.order_number, o);
  }
  allOrders = Array.from(orderMap.values());

  const shipped = allOrders.filter((o: any) => {
    if (!o.shipments?.length) return false;
    return o.shipments.some((s: any) => s.shipping_labels?.some((l: any) => l.tracking_number));
  });

  log.push(`[TRACK] Found ${allOrders.length} total SH orders, ${shipped.length} with tracking`);

  let synced = 0, skippedTrack = 0, failedTrack = 0;
  const trackErrors: Array<{ orderId: string; error: string }> = [];

  for (const order of shipped) {
    const orderId = order.order_number;
    let trackingNumber = '';
    let rawCarrier = '';
    let labelDate = '';

    for (const shipment of (order.shipments || [])) {
      const label = (shipment.shipping_labels || []).find((l: any) => l.tracking_number);
      if (label) {
        trackingNumber = label.tracking_number;
        rawCarrier = label.carrier || order.shipping_lines?.[0]?.carrier || 'USPS';
        labelDate = label.created_date || shipment.created_date || '';
        break;
      }
    }
    if (!trackingNumber) continue;

    const carrier = CARRIER_MAP[rawCarrier] || rawCarrier.toLowerCase();

    try {
      const ffResp = await ccApiCall('fulfillment/query', { orderId });

      if (ffResp.result !== 'SUCCESS' || !ffResp.message?.data) {
        skippedTrack++;
        continue;
      }

      const fulfillments = extractOrders(ffResp.message.data);
      const ff = fulfillments.find((f: any) => f.status !== 'CANCELLED') || fulfillments[0];
      if (!ff?.fulfillmentId) { skippedTrack++; continue; }

      if (ff.trackingNumber && ff.trackingNumber === trackingNumber) {
        skippedTrack++;
        continue;
      }

      const updateResp = await ccApiCall('fulfillment/update', {
        orderId,
        fulfillmentId: ff.fulfillmentId,
        shipCarrier: carrier,
        trackingNumber,
        fulfillmentStatus: 'SHIPPED',
        dateShipped: labelDate?.split('T')[0] || isoDate(new Date()),
      });

      if (updateResp.result === 'SUCCESS') {
        synced++;
      } else {
        failedTrack++;
        trackErrors.push({ orderId, error: updateResp.message?.error || updateResp.result });
      }
    } catch (e: any) {
      failedTrack++;
      trackErrors.push({ orderId, error: e.message });
    }

    await new Promise(r => setTimeout(r, 300));
  }

  log.push(`[TRACK] Synced: ${synced}, Skipped: ${skippedTrack}, Failed: ${failedTrack}`);
  if (trackErrors.length > 0 && trackErrors.length <= 10) {
    for (const e of trackErrors) log.push(`[TRACK] FAIL ${e.orderId}: ${e.error}`);
  }

  return { synced, skipped: skippedTrack, failed: failedTrack, errors: trackErrors };
}

// ─── Main Handler ───

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log: string[] = [];
  const startTime = Date.now();
  log.push(`[SYNC] Started at ${new Date().toISOString()}`);

  let pushResult = { pushed: 0, alreadyExists: 0, skipped: 0, failed: 0, errors: [] as any[] };
  let trackResult = { synced: 0, skipped: 0, failed: 0, errors: [] as any[] };

  try {
    pushResult = await pushOrders(log);
  } catch (e: any) {
    log.push(`[PUSH] Fatal error: ${e.message}`);
  }

  try {
    trackResult = await syncTracking(log);
  } catch (e: any) {
    log.push(`[TRACK] Fatal error: ${e.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.push(`[SYNC] Completed in ${elapsed}s`);

  res.status(200).json({
    ok: true,
    elapsed: `${elapsed}s`,
    push: {
      pushed: pushResult.pushed,
      alreadyExists: pushResult.alreadyExists,
      skipped: pushResult.skipped,
      failed: pushResult.failed,
    },
    tracking: {
      synced: trackResult.synced,
      skipped: trackResult.skipped,
      failed: trackResult.failed,
    },
    log,
  });
}
