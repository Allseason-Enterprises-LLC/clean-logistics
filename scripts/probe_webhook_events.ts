import { supabase } from '../lib/supabase';
async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  // Inspect CreateWebhookInput to find available event names
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query { __type(name: "CreateWebhookInput") { inputFields { name description type { name kind ofType { name kind enumValues { name } } enumValues { name } } } } }` }),
  });
  const j: any = await r.json();
  console.log(JSON.stringify(j.data?.__type?.inputFields, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
