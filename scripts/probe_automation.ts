// Probe: does ShipHero API expose automation rules?
import { supabase } from '../lib/supabase';

async function main() {
  const { data: wh } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  const token = (wh?.api_credentials as any)?.accessToken;

  // Search all mutations + queries for "rule" or "automation"
  const q = `
    query {
      __schema {
        mutationType { fields { name args { name type { name ofType { name } } } } }
        queryType { fields { name args { name type { name ofType { name } } } } }
      }
    }`;
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j: any = await r.json();
  const muts = j.data?.__schema?.mutationType?.fields || [];
  const qs = j.data?.__schema?.queryType?.fields || [];

  console.log('=== MUTATIONS matching rule|automation|hold|tag ===');
  muts.filter((m: any) => /rule|automation|hold|tag/i.test(m.name))
      .forEach((m: any) => console.log(`  ${m.name}`));

  console.log('\n=== QUERIES matching rule|automation ===');
  qs.filter((q: any) => /rule|automation/i.test(q.name))
    .forEach((q: any) => console.log(`  ${q.name}`));

  // Also probe webhook subscriptions — we can build our own rule via webhooks
  console.log('\n=== WEBHOOK-related mutations ===');
  muts.filter((m: any) => /webhook/i.test(m.name))
      .forEach((m: any) => console.log(`  ${m.name}`));
}
main().catch(e => { console.error(e); process.exit(1); });
