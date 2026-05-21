import { supabase } from '../lib/supabase';
async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;
  const q = `query { __type(name: "Order") { fields { name } } }`;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j: any = await r.json();
  const fields = (j.data?.__type?.fields || []).map((f: any) => f.name);
  console.log('Hold-related fields on Order:');
  fields.filter((n: string) => /hold/i.test(n)).forEach((n: string) => console.log(`  ${n}`));
}
main().catch(e => { console.error(e); process.exit(1); });
