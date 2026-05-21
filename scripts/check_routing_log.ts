import { supabase } from '../lib/supabase';
async function main() {
  // Was this order ever logged in routing_log?
  const { data } = await supabase
    .from('tiktok_routing_log')
    .select('*')
    .eq('order_number', '577386720333172977')
    .limit(5);
  console.log('Routing log entries for this order:', data?.length || 0);
  console.log(JSON.stringify(data, null, 2));

  // Recent routing_log entries to see if webhook is even firing
  const { data: recent } = await supabase
    .from('tiktok_routing_log')
    .select('order_number, target_warehouse, reason, routed_at')
    .order('routed_at', { ascending: false })
    .limit(10);
  console.log('\n=== Last 10 routing log entries ===');
  recent?.forEach((r: any) => console.log(`  ${r.routed_at}  ${r.order_number}  ${r.reason?.slice(0, 80)}`));
}
main().catch(e => { console.error(e); process.exit(1); });
