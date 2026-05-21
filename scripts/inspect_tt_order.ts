/**
 * Inspect a single TikTok order — print full detail.
 */
import { getTikTokCredentials, getOrderDetail } from '../lib/tiktok-api';

async function main() {
  const id = process.argv[2];
  if (!id) { console.error('Usage: inspect_tt_order.ts <tiktok_order_id>'); process.exit(1); }
  const creds = await getTikTokCredentials();
  const details = await getOrderDetail(creds, [id]);
  console.log(JSON.stringify(details[0], null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
