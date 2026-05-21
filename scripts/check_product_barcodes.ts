import { supabase } from '../lib/supabase';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

async function getToken() {
  const { data } = await supabase.from('warehouses').select('api_credentials').eq('id', '22e17170-af72-4bf8-b77c-d73c86b06765').single();
  return (data?.api_credentials as any)?.accessToken;
}

async function lookupProduct(sku: string) {
  const tok = await getToken();
  const resp = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({
      query: `query($sku:String!){ product(sku:$sku){ data { sku name barcode warehouse_products { warehouse_id on_hand allocated available } } } }`,
      variables: { sku }
    }),
  });
  const json: any = await resp.json();
  return json.data?.product?.data;
}

async function main() {
  const skus = [
    'CN-CAP-PARASWEEP-90CT',
    'CN-BDL-CAP-PARASWEEP-90CT-B1G1',
    'CN-BDL-CAP-THYROID-60CT-B1G1',  // the one on the failing order TT-577383277829919446
  ];

  for (const sku of skus) {
    const p = await lookupProduct(sku);
    if (!p) { console.log(`${sku}: NOT FOUND IN CATALOG`); continue; }
    const inv = p.warehouse_products?.find((w:any) => w.warehouse_id === 'V2FyZWhvdXNlOjEzNTg3Mg==');
    console.log(`${sku}:`);
    console.log(`  name:      ${p.name}`);
    console.log(`  barcode:   ${p.barcode || '(none)'}`);
    console.log(`  on_hand:   ${inv?.on_hand ?? 'n/a'}`);
    console.log(`  allocated: ${inv?.allocated ?? 'n/a'}`);
    console.log(`  available: ${inv?.available ?? 'n/a'}`);
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
