/**
 * audit_tiktok_status.ts
 *
 * For every order in /tmp/order_numbers.txt:
 *  - Strip the TT- prefix to get the TikTok order ID
 *  - Fetch the TikTok order status via /order/202309/orders
 *  - Build a CSV: order_number, tiktok_status, cancel_reason
 *
 * Used to detect orders canceled on TikTok side that ShipHero still has open.
 */
import * as fs from 'fs';
import { getTikTokCredentials, getOrderDetail } from '../lib/tiktok-api';

const ORDERS_FILE = '/tmp/order_numbers.txt';
const OUT = '/tmp/tiktok_status.csv';

async function main() {
  const orderNumbers = fs.readFileSync(ORDERS_FILE, 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);

  // Strip TT- prefix to get raw TikTok order IDs
  const tiktokIds = orderNumbers.map(n => n.replace(/^TT-/, ''));
  console.log(`Checking ${tiktokIds.length} TikTok orders...`);

  const creds = await getTikTokCredentials();

  // TikTok allows up to 50 ids per call
  const results: any[] = [];
  for (let i = 0; i < tiktokIds.length; i += 50) {
    const chunk = tiktokIds.slice(i, i + 50);
    try {
      const batch = await getOrderDetail(creds, chunk);
      results.push(...batch);
      process.stdout.write(`\r  fetched ${results.length}/${tiktokIds.length}...   `);
    } catch (e) {
      console.error(`\n  chunk ${i}-${i+50} failed:`, e);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\nGot details for ${results.length}/${tiktokIds.length} orders\n`);

  // Build status map
  const statusCounts: Record<string, number> = {};
  const cancelReasonCounts: Record<string, number> = {};
  const rows: string[] = ['order_number,tiktok_status,cancellation_role,cancel_reason'];

  for (const detail of results) {
    const status = detail.status || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    const cancelReason = detail.cancellation_initiator || '';
    if (status === 'CANCELLED' || status === 'CANCELED') {
      cancelReasonCounts[cancelReason || '(none)'] = (cancelReasonCounts[cancelReason || '(none)'] || 0) + 1;
    }

    rows.push(`TT-${detail.id},${status},"${cancelReason}","${(detail.cancellation_reason || '').replace(/"/g,'""')}"`);
  }

  console.log('=== Status breakdown ===');
  for (const [s, c] of Object.entries(statusCounts).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${s}: ${c}`);
  }

  if (Object.keys(cancelReasonCounts).length > 0) {
    console.log('\n=== Cancellation initiators ===');
    for (const [r, c] of Object.entries(cancelReasonCounts).sort((a,b) => b[1]-a[1])) {
      console.log(`  ${r}: ${c}`);
    }
  }

  fs.writeFileSync(OUT, rows.join('\n'));
  console.log(`\nFull report written to ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
