/**
 * Bulk-cancel the 94 native dupes where bridge already shipped.
 * Skips the first one (already cancelled in the test).
 */
import { supabase } from '../lib/supabase';
import * as fs from 'fs';

async function getToken(): Promise<string> {
  const { data } = await supabase.from('warehouses').select('api_credentials')
    .eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').eq('provider', 'shiphero').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function gql(token: string, query: string, variables: any = {}): Promise<any> {
  const r = await fetch('https://public-api.shiphero.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

async function main() {
  const token = await getToken();
  const data = JSON.parse(fs.readFileSync('/tmp/dupe_analysis.json', 'utf-8'));
  console.log(`Total native dupes to cancel: ${data.length}`);

  const m = `
    mutation($data: UpdateOrderInput!) {
      order_update(data: $data) {
        request_id
        order { id order_number fulfillment_status }
      }
    }`;

  const results: any[] = [];
  let cancelled = 0;
  let alreadyCancelled = 0;
  let errors = 0;

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    try {
      const j = await gql(token, m, {
        data: { order_id: r.native_id, fulfillment_status: 'canceled' },
      });
      if (j.errors) {
        const msg = JSON.stringify(j.errors);
        if (msg.includes('already canceled') || msg.includes('already cancelled')) {
          alreadyCancelled++;
          results.push({ partner_order_id: r.partner_order_id, native_id: r.native_id, ok: true, note: 'already cancelled' });
        } else {
          throw new Error(msg);
        }
      } else {
        cancelled++;
        results.push({ partner_order_id: r.partner_order_id, native_id: r.native_id, ok: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors++;
      console.error(`  ERROR ${r.native_order_number}: ${msg}`);
      results.push({ partner_order_id: r.partner_order_id, native_id: r.native_id, ok: false, error: msg });
    }
    if ((i + 1) % 20 === 0 || i === data.length - 1) {
      console.log(`  Progress: ${i + 1}/${data.length}  cancelled=${cancelled}  already=${alreadyCancelled}  errors=${errors}`);
    }
    fs.writeFileSync('/tmp/native_cancel_results.json', JSON.stringify(results, null, 2));
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`\n=== DONE ===`);
  console.log(`Cancelled now:       ${cancelled}`);
  console.log(`Already cancelled:   ${alreadyCancelled}`);
  console.log(`Errors:              ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
