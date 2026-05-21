import { supabase } from '../lib/supabase';
import * as fs from 'fs';

async function getToken(): Promise<string> {
  const { data } = await supabase
    .from('warehouses').select('api_credentials')
    .eq('id', process.env.SHIPHERO_WAREHOUSE_ID!)
    .eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function gql(token: string, q: string, vars: any = {}): Promise<any> {
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: vars }),
  });
  return r.json();
}

async function main() {
  const token = await getToken();
  const usOrders: string[] = JSON.parse(fs.readFileSync('/tmp/us_orders.json', 'utf-8'));
  console.log(`CSV us-shipped orders: ${usOrders.length}`);

  // Paginate ShipHero orders since April 25
  const allOrderNumbers = new Set<string>();
  let after: string | null = null;
  let page = 0;
  while (true) {
    page++;
    const query = `
      query($after: String) {
        orders(order_date_from: "2026-04-25") {
          data(first: 100, after: $after) {
            edges { node { order_number } cursor }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    const j: any = await gql(token, query, { after });
    if (j.errors) { console.error(JSON.stringify(j.errors)); return; }
    const data = j.data?.orders?.data;
    const edges = data?.edges || [];
    edges.forEach((e: any) => allOrderNumbers.add(e.node.order_number));
    console.log(`  page ${page}: +${edges.length} (total ${allOrderNumbers.size})`);
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 600)); // rate limit
  }
  console.log(`\nShipHero orders since 2026-04-25: ${allOrderNumbers.size}`);

  let alreadyImported = 0;
  let missing = 0;
  const missingIds: string[] = [];
  for (const oid of usOrders) {
    if (allOrderNumbers.has(oid) || allOrderNumbers.has(`TT-${oid}`)) {
      alreadyImported++;
    } else {
      missing++;
      missingIds.push(oid);
    }
  }
  console.log(`\nAlready in ShipHero: ${alreadyImported}`);
  console.log(`MISSING (need backfill): ${missing}`);
  console.log(`Sample missing: ${missingIds.slice(0, 10).join(', ')}`);
  fs.writeFileSync('/tmp/missing_orders.json', JSON.stringify(missingIds));
  console.log('Wrote /tmp/missing_orders.json');
}
main().catch(e => { console.error(e); process.exit(1); });
