// Probe: figure out the correct cancel mutation
import { supabase } from '../lib/supabase';

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  // 1. Introspect UpdateOrderInput
  const q = `
    query { __type(name: "UpdateOrderInput") { name inputFields { name type { name kind ofType { name } } } } }
  `;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j: any = await r.json();
  console.log('UpdateOrderInput fields:');
  (j.data?.__type?.inputFields || []).forEach((f: any) => {
    const tname = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${tname}`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });
