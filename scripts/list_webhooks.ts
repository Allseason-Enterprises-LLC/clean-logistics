import { supabase } from '../lib/supabase';
async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `
      query { webhooks {
        request_id
        data(first: 50) {
          edges { node { id account_id name url source shop_name } }
        }
      }}` }),
  });
  const j: any = await r.json();
  console.log('Registered webhooks:');
  const edges = j.data?.webhooks?.data?.edges || [];
  edges.forEach((e: any) => {
    console.log(`  id=${e.node.id}`);
    console.log(`  name=${e.node.name}`);
    console.log(`  url=${e.node.url}`);
    console.log(`  source=${e.node.source}`);
    console.log(`  shop=${e.node.shop_name}`);
    console.log('');
  });
}
main().catch(e => { console.error(e); process.exit(1); });
