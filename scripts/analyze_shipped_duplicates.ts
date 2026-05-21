/**
 * Analyze the 94 duplicate pairs where one side has already shipped.
 *
 * For each pair, fetch:
 *   - Shipment details (tracking #, carrier, date)
 *   - Fulfillment status of each side
 *   - Whether the native order has any shipping label / picked status
 *
 * Output a CSV with recommended action per pair.
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

interface OrderNode {
  id: string;
  order_number: string;
  partner_order_id: string;
  shop_name: string;
  tags: string[];
  fulfillment_status: string | null;
  total_price: string;
  ready_to_ship: boolean;
  shipments?: Array<{
    id: string;
    created_date: string;
    shipped_off_shiphero: boolean;
    shipping_labels: Array<{
      tracking_number: string;
      carrier: string;
      cost: string;
    }>;
  }>;
}

async function getToken(): Promise<string> {
  const { data } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function gql(token: string, query: string, variables: any = {}): Promise<any> {
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

async function fetchAllOrders(token: string): Promise<OrderNode[]> {
  const all: OrderNode[] = [];
  let after: string | null = null;
  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "2026-04-25") {
          data(first: 100, after: $after) {
            edges { node {
              id order_number partner_order_id shop_name tags fulfillment_status total_price ready_to_ship
              shipments {
                id created_date shipped_off_shiphero
                shipping_labels { tracking_number carrier cost }
              }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const j = await gql(token, q, { after });
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    const data = j.data?.orders?.data;
    (data?.edges || []).forEach((e: any) => all.push(e.node));
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 500));
  }
  return all;
}

function summarize(o: OrderNode | undefined): string {
  if (!o) return '-';
  const ships = (o.shipments || []).length;
  const tracking = (o.shipments || []).flatMap(s => s.shipping_labels.map(l => l.tracking_number)).join(';');
  return `status=${o.fulfillment_status} | ships=${ships} | tracking=${tracking || 'none'} | ready=${o.ready_to_ship}`;
}

async function main() {
  const token = await getToken();
  const all = await fetchAllOrders(token);
  console.log(`Fetched ${all.length} orders`);

  const byPid = new Map<string, OrderNode[]>();
  for (const o of all) {
    const k = o.partner_order_id || o.order_number;
    if (!byPid.has(k)) byPid.set(k, []);
    byPid.get(k)!.push(o);
  }

  const rows: any[] = [];
  let needsCancel = 0; // native unshipped, bridge shipped → cancel native
  let bothShipped = 0;
  let unclear = 0;

  for (const [pid, orders] of byPid.entries()) {
    if (orders.length < 2) continue;
    const native = orders.find(o => o.shop_name === 'Clean Nutra');
    const bridge = orders.find(o => o.shop_name === 'TikTok Shop');
    if (!native || !bridge) continue;

    const nativeShipped = (native.shipments || []).length > 0;
    const bridgeShipped = (bridge.shipments || []).length > 0;
    const nativeFulfilled = native.fulfillment_status === 'fulfilled';
    const bridgeFulfilled = bridge.fulfillment_status === 'fulfilled';

    // Only interested in cases where at least one side shipped/fulfilled
    if (!nativeShipped && !bridgeShipped && !nativeFulfilled && !bridgeFulfilled) continue;

    let action = 'REVIEW';
    let actionDetail = '';

    if (bridgeShipped && !nativeShipped && !nativeFulfilled) {
      action = 'CANCEL_NATIVE';
      actionDetail = 'Bridge shipped, native still unshipped — prevent double-ship';
      needsCancel++;
    } else if (bridgeShipped && nativeShipped) {
      action = 'DOUBLE_SHIPPED';
      actionDetail = 'BOTH already shipped — customer got 2 boxes';
      bothShipped++;
    } else if (bridgeShipped && nativeFulfilled && !nativeShipped) {
      action = 'CANCEL_NATIVE';
      actionDetail = 'Bridge shipped, native auto-fulfilled (no shipment) — safe to cancel native';
      needsCancel++;
    } else if (!bridgeShipped && bridgeFulfilled) {
      action = 'REVIEW';
      actionDetail = `Bridge fulfilled but no shipment record. Native: ${summarize(native)}`;
      unclear++;
    } else {
      action = 'REVIEW';
      actionDetail = `Mixed state. Bridge: ${summarize(bridge)}; Native: ${summarize(native)}`;
      unclear++;
    }

    const bridgeTracking = (bridge.shipments || []).flatMap(s => s.shipping_labels.map(l => l.tracking_number)).join(';');
    const bridgeCarrier = (bridge.shipments || []).flatMap(s => s.shipping_labels.map(l => l.carrier)).join(';');
    const bridgeShippedDate = (bridge.shipments || [])[0]?.created_date || '';

    rows.push({
      partner_order_id: pid,
      action,
      action_detail: actionDetail,
      native_id: native.id,
      native_order_number: native.order_number,
      native_status: native.fulfillment_status,
      native_ready_to_ship: native.ready_to_ship,
      native_shipments: (native.shipments || []).length,
      bridge_id: bridge.id,
      bridge_order_number: bridge.order_number,
      bridge_status: bridge.fulfillment_status,
      bridge_shipments: (bridge.shipments || []).length,
      bridge_tracking: bridgeTracking,
      bridge_carrier: bridgeCarrier,
      bridge_shipped_date: bridgeShippedDate,
    });
  }

  console.log(`\n=== ANALYSIS ===`);
  console.log(`Total dupe pairs with shipments: ${rows.length}`);
  console.log(`  CANCEL_NATIVE (bridge shipped, native still pending): ${needsCancel}`);
  console.log(`  DOUBLE_SHIPPED (both shipped — customer got 2): ${bothShipped}`);
  console.log(`  REVIEW (unclear state): ${unclear}`);

  // Write CSV
  const csvHeader = Object.keys(rows[0] || {}).join(',');
  const csvRows = rows.map(r => Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  const csv = [csvHeader, ...csvRows].join('\n');
  fs.writeFileSync('/tmp/dupe_analysis.csv', csv);
  fs.writeFileSync('/tmp/dupe_analysis.json', JSON.stringify(rows, null, 2));
  console.log(`\nCSV: /tmp/dupe_analysis.csv`);
  console.log(`JSON: /tmp/dupe_analysis.json`);

  console.log(`\n=== Sample of each action category ===`);
  for (const action of ['CANCEL_NATIVE', 'DOUBLE_SHIPPED', 'REVIEW']) {
    const sample = rows.filter(r => r.action === action).slice(0, 3);
    if (sample.length === 0) continue;
    console.log(`\n--- ${action} ---`);
    sample.forEach(s => {
      console.log(`  ${s.partner_order_id}`);
      console.log(`    Native: ${s.native_order_number} | status=${s.native_status} | ready=${s.native_ready_to_ship} | ships=${s.native_shipments}`);
      console.log(`    Bridge: ${s.bridge_order_number} | status=${s.bridge_status} | ships=${s.bridge_shipments} | tracking=${s.bridge_tracking}`);
      console.log(`    Action: ${s.action_detail}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
