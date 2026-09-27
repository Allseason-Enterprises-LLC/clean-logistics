/**
 * Formal "New Work Order Needed" notice + product identity/barcode resolution.
 * Run: npx tsx scripts/_test-kit-notice-and-identity.ts
 */
import { buildWorkOrderCreatedNotice, type WorkOrderState } from '../lib/kit-work-order-gate';
import { resolveKitProductIdentity, extractAsin, renderBarcodePng, findFnsku } from '../lib/kit-product-identity';
let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const base: WorkOrderState = { type: 'CUSTOM', ids: ['171102'], status: 'IN_PROGRESS', created_at: '2026-09-27T06:32:42Z',
  kit_sku: 'CN-BDL-CAP-NMNSUPP-60CT-2PK', kit_qty: 100, pack_count: 2, order_number: 'AMZ_NMNSUPP_00484', amazon_msku: null, reason: 'cin7_sku:prefix' };

async function main() {
  // ── notice: UPC case (TR-00484 reality) ──
  const upc = buildWorkOrderCreatedNotice({ ...base, asin: 'B0HJN6KKVK', product_name: 'Clean Nutra NMN Supplement 500mg', upc: '810197342278', barcode_kind: 'UPC', barcode_url: 'https://x/barcode.png' }, 'TR-00484');
  ok('title: New Work Order Needed — 2-Pack for Amazon FBA', /🔧 <b>New Work Order Needed — 2-Pack for Amazon FBA<\/b>/.test(upc));
  ok('product block: name, CIN7 SKU, ASIN, UPC', /<b>Product:<\/b> Clean Nutra NMN/.test(upc) && /<code>CN-BDL-CAP-NMNSUPP-60CT-2PK<\/code>/.test(upc) && /<b>ASIN:<\/b> <code>B0HJN6KKVK<\/code>/.test(upc) && /<b>UPC:<\/b> <code>810197342278<\/code>/.test(upc));
  ok('work order block: id, order number, TR, build qty, units total', /<b>Work Order:<\/b> <code>171102<\/code>/.test(upc) && /AMZ_NMNSUPP_00484/.test(upc) && /\(TR-00484\)/.test(upc) && /<b>100 × 2-Pack<\/b> \(200 units total\)/.test(upc));
  ok('priority HIGH / 1 business day', /HIGH/.test(upc) && /1 business day/.test(upc));
  ok('step 2 names the UPC barcode + links the PNG', /Label each finished pack with the <b>UPC<\/b> barcode <code>810197342278<\/code>/.test(upc) && /href="https:\/\/x\/barcode.png"/.test(upc));
  ok('Transparency sticker instruction present', /Transparency/.test(upc));
  ok('non-pickable bulk bin + mark Complete steps', /non-pickable bulk bin/.test(upc) && /Mark work order <code>171102<\/code> <b>Complete<\/b>/.test(upc));
  ok('closing warning: labels not created until Complete', /<b>not<\/b> created until the work order is marked Complete/.test(upc));
  ok('no engineering words', !/reconciler|jsonb|request_payload|bridge|gate/i.test(upc));

  // ── notice: FNSKU case ──
  const fn = buildWorkOrderCreatedNotice({ ...base, asin: 'B0G6LJDW9W', fnsku: 'X00585YT9V', upc: '810197342278', barcode_kind: 'FNSKU' }, 'TR-1');
  ok('FNSKU wins over UPC when present (shows FNSKU, hides UPC)', /<b>FNSKU:<\/b> <code>X00585YT9V<\/code>/.test(fn) && !/<b>UPC:<\/b>/.test(fn) && /<b>FNSKU<\/b> barcode <code>X00585YT9V<\/code>/.test(fn));

  // ── notice: NO barcode known → Seller Central instruction ──
  const none = buildWorkOrderCreatedNotice({ ...base }, 'TR-1');
  ok('🔴 no FNSKU/UPC -> "download it from Seller Central"', /download it from Seller Central/.test(none) && !/barcode <code>/.test(none));
  ok('no product_name -> falls back to SKU', /<b>Product:<\/b> CN-BDL-CAP-NMNSUPP-60CT-2PK/.test(none));

  // ── identity resolver with a fake SP-API ──
  const fakeApi = (async (req: any) => {
    if (req.path.includes('/fba/inventory')) {
      if (req.query?.sellerSkus === 'CN-CAP-NMNSUPP-60CT-FBA') return { body: { payload: { inventorySummaries: [{ sellerSku: 'CN-CAP-NMNSUPP-60CT-FBA', asin: 'B0G6LJDW9W', fnSku: 'X00585YT9V' }] } } };
      return { body: { payload: { inventorySummaries: [{ sellerSku: 'OTHER', asin: 'B0OTHER', fnSku: 'X0OTHER' }] }, pagination: {} } };
    }
    if (req.path.includes('/catalog/')) return { body: { identifiers: [{ identifiers: [{ identifierType: 'EAN', identifier: '0810197342278' }, { identifierType: 'UPC', identifier: '810197342278' }] }], summaries: [{ itemName: 'Clean Nutra NMN Supplement 500mg' }] } };
    throw new Error('unexpected ' + req.path);
  }) as any;

  const idA = await resolveKitProductIdentity({ cin7Sku: 'CN-BDL-CAP-NMNSUPP-60CT-2PK', asin: 'B0HJN6KKVK', api: fakeApi });
  ok('never-FBA ASIN -> no FNSKU, UPC from catalog, barcode=UPC', idA.fnsku === null && idA.upc === '810197342278' && idA.barcode?.kind === 'UPC' && idA.barcode.bcid === 'upca');
  ok('product name from catalog', idA.productName === 'Clean Nutra NMN Supplement 500mg');
  ok('notes explain the missing FNSKU', idA.notes.some((n) => /not been sent to FBA/.test(n)));
  const idB = await resolveKitProductIdentity({ cin7Sku: 'X', amazonMsku: 'CN-CAP-NMNSUPP-60CT-FBA', api: fakeApi });
  ok('MSKU with FNSKU -> barcode=FNSKU code128, asin filled from inventory', idB.fnsku === 'X00585YT9V' && idB.barcode?.kind === 'FNSKU' && idB.barcode.bcid === 'code128' && idB.asin === 'B0G6LJDW9W');
  const idC = await resolveKitProductIdentity({ cin7Sku: 'X', asin: 'B0HJN6KKVK', api: (async () => { throw new Error('token expired'); }) as any });
  ok('API failure -> no barcode, notes carry the error, NO throw (fail-open)', idC.barcode === null && idC.notes.some((n) => /token expired/.test(n)));
  ok('findFnsku with nothing to look up -> null without calling the API', (await findFnsku({}, (async () => { throw new Error('should not call'); }) as any)) === null);

  // ── ASIN extraction from CIN7 Reference ──
  ok('extractAsin from the real 00484 Reference', extractAsin('FBA B0HJN6KKVK - Cellnova 2PK bundle') === 'B0HJN6KKVK');
  ok('extractAsin: none in prose', extractAsin('rush please') === null && extractAsin(null) === null);

  // ── barcode renders ──
  const png = await renderBarcodePng({ kind: 'UPC', value: '810197342278', bcid: 'upca' }, 'UPC · AMZ_NMNSUPP_00484');
  ok('UPC-A renders to a PNG', png.length > 1000 && png.slice(1, 4).toString() === 'PNG');
  const png2 = await renderBarcodePng({ kind: 'FNSKU', value: 'X00585YT9V', bcid: 'code128' });
  ok('Code128 (FNSKU) renders to a PNG', png2.length > 1000);

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
