// Probe the order_update_holds mutation
import { supabase } from '../lib/supabase';

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  const q = `query { __type(name: "UpdateOrderHoldsInput") { name inputFields { name type { name kind ofType { name } } } } }`;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j: any = await r.json();
  console.log('UpdateOrderHoldsInput:');
  (j.data?.__type?.inputFields || []).forEach((f: any) => {
    const tname = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${tname}`);
  });

  // Probe order_update_holds return type
  const q2 = `query { __schema { mutationType { fields(includeDeprecated: false) { name args { name type { name ofType { name } } } } } } }`;
  const r2 = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q2 }),
  });
  const j2: any = await r2.json();
  const mutations = j2.data?.__schema?.mutationType?.fields || [];
  const holdMutation = mutations.find((m: any) => m.name === 'order_update_holds');
  console.log('\norder_update_holds args:', JSON.stringify(holdMutation, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
