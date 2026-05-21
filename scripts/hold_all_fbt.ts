/**
 * Bulk operator-hold all FBT (fulfilled_by_tiktok) orders that aren't already shipped.
 *
 * FBT = TikTok ships these from their warehouse. We should not pick/ship them.
 * Operator hold removes them from picking queue without cancelling.
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

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

async function main() {
  const token = await getToken();

  // Pull all FBT orders since Apr 25
  console.log('Fetching all orders since 2026-04-25...');
  const fbt: any[] = [];
  let after: string | null = null;
  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "2026-04-25") {
          data(first: 100, after: $after) {
            edges { node { id order_number shop_name tags fulfillment_status order_history { information } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const j = await gql(token, q, { after });
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    const data = j.data?.orders?.data;
    for (const e of data?.edges || []) {
      const n = e.node;
      const tags = n.tags || [];
      if (tags.includes('fulfilled_by_tiktok')) fbt.push(n);
    }
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`Found ${fbt.length} FBT orders`);

  // Filter out already-shipped/cancelled
  const toHold = fbt.filter(o =>
    o.fulfillment_status !== 'fulfilled' &&
    o.fulfillment_status !== 'canceled' &&
    o.fulfillment_status !== 'cancelled'
  );
  console.log(`To hold (not shipped/cancelled): ${toHold.length}`);
  console.log(`Skipping (already shipped/cancelled): ${fbt.length - toHold.length}`);

  if (toHold.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const m = `
    mutation($data: UpdateOrderHoldsInput!) {
      order_update_holds(data: $data) {
        request_id
        order { id order_number holds { operator_hold } }
      }
    }`;

  const results: any[] = [];
  let held = 0;
  let errors = 0;

  for (let i = 0; i < toHold.length; i++) {
    const o = toHold[i];
    try {
      const j = await gql(token, m, {
        data: { order_id: o.id, operator_hold: true },
      });
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      held++;
      results.push({ order_id: o.id, order_number: o.order_number, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors++;
      console.error(`  ERROR ${o.order_number}: ${msg.slice(0, 200)}`);
      results.push({ order_id: o.id, order_number: o.order_number, ok: false, error: msg });
    }
    if ((i + 1) % 50 === 0 || i === toHold.length - 1) {
      console.log(`  Progress: ${i + 1}/${toHold.length}  held=${held}  errors=${errors}`);
    }
    fs.writeFileSync('/tmp/fbt_hold_results.json', JSON.stringify(results, null, 2));
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== DONE ===`);
  console.log(`Held:    ${held}`);
  console.log(`Errors:  ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
