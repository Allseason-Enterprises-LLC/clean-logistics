/**
 * Reset specified TikTok bridge rows from status='error' back to 'imported'
 * so the reconcile cron will retry them.
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

async function main() {
  const ids: string[] = JSON.parse(fs.readFileSync('/tmp/error_ids_to_reset.json', 'utf8'));
  console.log(`Resetting ${ids.length} rows...`);

  const { data, error } = await supabase
    .from('tiktok_shiphero_orders')
    .update({ status: 'imported', error_message: null, retry_count: 0 })
    .in('tiktok_order_id', ids)
    .eq('status', 'error')
    .select('tiktok_order_id');

  if (error) throw error;
  console.log(`Reset ${data?.length || 0} rows back to 'imported'`);
}

main().catch(e => { console.error(e); process.exit(1); });
