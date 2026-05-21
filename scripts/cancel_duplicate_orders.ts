/**
 * Cancel duplicate bridge-backfill and Manual Order entries that have a native
 * Clean Nutra equivalent.
 *
 * Strategy:
 *   - Native (shop_name="Clean Nutra") is canonical. Always KEEP.
 *   - Bridge (shop_name="TikTok Shop", order_number=TT-XXX) → CANCEL if native exists.
 *   - Manual Order with TikTok-looking ID → CANCEL if native exists.
 *
 * Safety:
 *   - SKIP any duplicate where the candidate-for-cancel has already shipped
 *     (fulfillment_status='fulfilled' or has any shipment). Log for manual review.
 *   - DRY_RUN=1 mode prints the plan without executing.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/cancel_duplicate_orders.ts   # plan only
 *   npx tsx scripts/cancel_duplicate_orders.ts             # execute
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

const DRY_RUN = process.env.DRY_RUN === '1';
const RESULTS_PATH = '/tmp/cancel_results.json';

interface OrderNode {
  id: string;
  order_number: string;
  partner_order_id: string;
  shop_name: string;
  tags: string[];
  fulfillment_status: string | null;
  shipments?: { id: string; created_date: string }[];
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
              id order_number partner_order_id shop_name tags fulfillment_status
              shipments { id created_date }
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

async function cancelOrder(token: string, orderId: string): Promise<void> {
  // ShipHero cancel = order_update with fulfillment_status="canceled"
  const m = `
    mutation($data: UpdateOrderInput!) {
      order_update(data: $data) {
        request_id
        order { id order_number fulfillment_status }
      }
    }`;
  const j = await gql(token, m, {
    data: { order_id: orderId, fulfillment_status: 'canceled' },
  });
  if (j.errors) throw new Error(JSON.stringify(j.errors));
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN MODE ===' : '=== LIVE EXECUTION ===');
  const token = await getToken();
  const all = await fetchAllOrders(token);
  console.log(`Fetched ${all.length} orders`);

  const byPartnerId = new Map<string, OrderNode[]>();
  for (const o of all) {
    const key = o.partner_order_id || o.order_number;
    if (!byPartnerId.has(key)) byPartnerId.set(key, []);
    byPartnerId.get(key)!.push(o);
  }

  type Plan = {
    partnerId: string;
    keep: OrderNode;
    cancel: OrderNode;
    reason: string;
  };
  const plan: Plan[] = [];
  const skipped: { partnerId: string; reason: string; orders: { shop: string; on: string; status: string | null; shipments: number }[] }[] = [];

  for (const [pid, rows] of byPartnerId.entries()) {
    if (rows.length < 2) continue;

    const native = rows.find(r => r.shop_name === 'Clean Nutra');
    const bridge = rows.find(r => r.shop_name === 'TikTok Shop');
    const manual = rows.find(r => r.shop_name === 'Manual Order');

    // Only deal with Native↔Bridge or Native↔Manual dupes
    if (!native) continue;

    for (const dupe of [bridge, manual].filter(Boolean) as OrderNode[]) {
      // Safety: don't cancel anything already shipped/fulfilled
      const shippedCount = (dupe.shipments || []).length;
      const isFulfilled = dupe.fulfillment_status === 'fulfilled';
      if (isFulfilled || shippedCount > 0) {
        skipped.push({
          partnerId: pid,
          reason: `Already shipped/fulfilled — manual review needed`,
          orders: rows.map(o => ({
            shop: o.shop_name,
            on: o.order_number,
            status: o.fulfillment_status,
            shipments: (o.shipments || []).length,
          })),
        });
        continue;
      }

      // Also skip if native side has already shipped — keep both, requires manual handling
      const nativeShipped = (native.shipments || []).length > 0 || native.fulfillment_status === 'fulfilled';
      if (nativeShipped) {
        skipped.push({
          partnerId: pid,
          reason: `Native side already shipped — duplicate may have been correctly fulfilled, manual check`,
          orders: rows.map(o => ({
            shop: o.shop_name,
            on: o.order_number,
            status: o.fulfillment_status,
            shipments: (o.shipments || []).length,
          })),
        });
        continue;
      }

      plan.push({
        partnerId: pid,
        keep: native,
        cancel: dupe,
        reason: dupe.shop_name === 'TikTok Shop' ? 'bridge-dupe' : 'manual-order-dupe',
      });
    }
  }

  console.log(`\n=== PLAN ===`);
  console.log(`To cancel: ${plan.length}`);
  console.log(`Skipped (manual review): ${skipped.length}`);
  const reasonCounts: Record<string, number> = {};
  plan.forEach(p => { reasonCounts[p.reason] = (reasonCounts[p.reason] || 0) + 1; });
  console.log(`Cancel reasons: ${JSON.stringify(reasonCounts)}`);

  if (skipped.length) {
    console.log(`\nSKIPPED (need manual review):`);
    skipped.slice(0, 10).forEach(s => {
      console.log(`  ${s.partnerId}: ${s.reason}`);
      s.orders.forEach(o => console.log(`    - ${o.shop} | ${o.on} | status=${o.status} | shipments=${o.shipments}`));
    });
    if (skipped.length > 10) console.log(`  ... and ${skipped.length - 10} more`);
  }

  console.log(`\nFirst 5 to cancel:`);
  plan.slice(0, 5).forEach(p => {
    console.log(`  KEEP   ${p.keep.shop_name}|${p.keep.order_number}`);
    console.log(`  CANCEL ${p.cancel.shop_name}|${p.cancel.order_number}  (${p.reason})`);
    console.log('');
  });

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes made. Set DRY_RUN=0 to execute.');
    fs.writeFileSync('/tmp/cancel_plan.json', JSON.stringify({ plan, skipped }, null, 2));
    console.log('Plan saved to /tmp/cancel_plan.json');
    return;
  }

  console.log(`\n=== EXECUTING ${plan.length} CANCELLATIONS ===`);
  const results: any[] = [];
  let cancelled = 0;
  let errors = 0;

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    try {
      await cancelOrder(token, p.cancel.id);
      // Update bridge row in Supabase if applicable
      if (p.cancel.shop_name === 'TikTok Shop') {
        await supabase.from('tiktok_shiphero_orders')
          .update({ status: 'cancelled', error_message: 'Duplicate of native integration order — cancelled in favor of native' })
          .eq('shiphero_order_id', p.cancel.id);
      }
      cancelled++;
      results.push({ partnerId: p.partnerId, cancelledOrderId: p.cancel.id, cancelledOrderNumber: p.cancel.order_number, ok: true });
      if ((i + 1) % 25 === 0 || i === plan.length - 1) {
        console.log(`  Progress: ${i + 1}/${plan.length}  cancelled=${cancelled}  errors=${errors}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR cancelling ${p.cancel.order_number}: ${msg}`);
      errors++;
      results.push({ partnerId: p.partnerId, cancelledOrderId: p.cancel.id, cancelledOrderNumber: p.cancel.order_number, ok: false, error: msg });
    }
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n=== DONE ===`);
  console.log(`Cancelled: ${cancelled}`);
  console.log(`Errors:    ${errors}`);
  console.log(`Skipped:   ${skipped.length} (in /tmp/cancel_plan.json)`);
}

main().catch(e => { console.error(e); process.exit(1); });
