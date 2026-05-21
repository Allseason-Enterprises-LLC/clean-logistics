/**
 * Scan all Clean Nutra LV orders since Apr 25 to find:
 *   - Duplicates (same partner_order_id appearing under multiple shop_names)
 *   - Native TikTok orders missing TT- prefix (shop=Clean Nutra + tiktok_* tag)
 *   - Manual Order rows that look like TikTok orders (numeric order_number = TikTok ID)
 */
import { supabase } from '../lib/supabase';

interface OrderRow { id: string; order_number: string; partner_order_id: string; shop_name: string; tags: string[]; }

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  const allOrders: OrderRow[] = [];
  let after: string | null = null;
  while (true) {
    const q = `
      query($after: String) {
        orders(order_date_from: "2026-04-25") {
          data(first: 100, after: $after) {
            edges { node { id order_number partner_order_id shop_name tags } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const r = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { after } }),
    });
    const j: any = await r.json();
    const data = j.data?.orders?.data;
    (data?.edges || []).forEach((e: any) => allOrders.push(e.node));
    if (!data?.pageInfo?.hasNextPage) break;
    after = data.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Total orders since 2026-04-25: ${allOrders.length}\n`);

  // Group by partner_order_id
  const byPartnerId = new Map<string, OrderRow[]>();
  for (const o of allOrders) {
    const key = o.partner_order_id || o.order_number;
    if (!byPartnerId.has(key)) byPartnerId.set(key, []);
    byPartnerId.get(key)!.push(o);
  }

  // 1. Duplicates
  const dupes = Array.from(byPartnerId.entries()).filter(([, rows]) => rows.length > 1);
  console.log(`=== DUPLICATES (${dupes.length} partner_order_ids appear more than once) ===`);
  let manualOrderDupes: { partnerId: string; manual: OrderRow; bridge?: OrderRow; native?: OrderRow }[] = [];
  for (const [pid, rows] of dupes.slice(0, 30)) {
    const summary = rows.map(r => `[${r.shop_name}|${r.order_number}|tags=${(r.tags || []).slice(0, 2).join(',')}]`).join(' + ');
    console.log(`  ${pid}: ${summary}`);
    const manual = rows.find(r => r.shop_name === 'Manual Order');
    if (manual) {
      manualOrderDupes.push({
        partnerId: pid,
        manual,
        bridge: rows.find(r => r.shop_name === 'TikTok Shop'),
        native: rows.find(r => r.shop_name === 'Clean Nutra'),
      });
    }
  }
  if (dupes.length > 30) console.log(`  ... and ${dupes.length - 30} more`);

  // 2. Native TikTok orders missing prefix
  const nativeTikTok = allOrders.filter(o =>
    o.shop_name === 'Clean Nutra' &&
    (o.tags || []).some(t => t.startsWith('tiktok_') || t === 'fulfilled_by_tiktok')
  );
  const missingPrefix = nativeTikTok.filter(o => !o.order_number.startsWith('TT-'));
  console.log(`\n=== NATIVE TIKTOK ORDERS ===`);
  console.log(`  Total native TikTok: ${nativeTikTok.length}`);
  console.log(`  Missing TT- prefix:  ${missingPrefix.length}`);
  console.log(`  FBT (skip these):    ${nativeTikTok.filter(o => (o.tags || []).includes('fulfilled_by_tiktok')).length}`);

  // 3. Manual Order rows that look like TikTok IDs (>15 digits, all numeric)
  const manualTikTokLooking = allOrders.filter(o =>
    o.shop_name === 'Manual Order' &&
    /^\d{15,}$/.test(o.order_number)
  );
  console.log(`\n=== MANUAL ORDERS WITH TIKTOK-LOOKING IDs ===`);
  console.log(`  Count: ${manualTikTokLooking.length}`);
  if (manualTikTokLooking.length) {
    console.log('  Samples:');
    manualTikTokLooking.slice(0, 5).forEach(o => console.log(`    ${o.order_number}`));
  }

  console.log(`\n=== SHOP_NAME DISTRIBUTION ===`);
  const counts: Record<string, number> = {};
  for (const o of allOrders) counts[o.shop_name] = (counts[o.shop_name] || 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
