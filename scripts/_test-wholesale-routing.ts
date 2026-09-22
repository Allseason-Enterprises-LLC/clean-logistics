/**
 * FBA transfers must route to wholesale_order_create (Wholesale flag set).
 * 2026-09-22: all 14 recovery orders landed as NORMAL orders and the warehouse
 * manager toggled Wholesale by hand on every one.
 * Run: npx tsx scripts/_test-wholesale-routing.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const orders = fs.readFileSync(path.join(__dirname, '../lib/shiphero-orders.ts'), 'utf8');
const types = fs.readFileSync(path.join(__dirname, '../lib/cin7-transfer-types.ts'), 'utf8');
const sync = fs.readFileSync(path.join(__dirname, '../lib/cin7-transfer-sync.ts'), 'utf8');

ok('input type carries cin7Destination', /cin7Destination\?: string \| null;/.test(types));
ok('the builder populates it', /cin7Destination: transfer\.destinationName/.test(sync));
ok('detection reads the destination', orders.includes("const destination = (input.cin7Destination || '')"));
ok('logs the routing decision (so a miss is visible in prod logs)',
   orders.includes('isFbaTransfer=') && orders.includes('wholesale_order_create'));
ok('documents the 2026-09-22 incident', orders.includes('2026-09-22') && orders.includes('Wholesale flag'));
ok('wholesale path tags the order Wholesale', /tags: \[\.\.\.\(input\.tags \|\| \[\]\), 'FBA', 'Wholesale'\]/.test(orders));

// Behavioural replica of the shipped predicate
const isFba = (o: { dest?: string | null; company?: string | null; orderNo?: string | null; tags?: string[] }) => {
  const destination = (o.dest || '').toLowerCase();
  const company = (o.company || '').toLowerCase();
  const orderNo = (o.orderNo || '').toLowerCase();
  return destination.includes('fba') || destination.includes('amazon') ||
    orderNo.startsWith('amz_') || orderNo.startsWith('ref_') || orderNo.includes('fba') ||
    company.includes('amazon') || company.includes('fba') ||
    !!o.tags?.some((t) => /^(fba|wholesale|amazon)$/i.test(t));
};

// The EXACT production values that defeated the old logic
const REAL = { dest: 'Amazon FBA Warehouse', company: 'Allseason Enterprises LLC', tags: ['cin7-transfer', 'amazon-kit', 'las-vegas'] };
ok('REAL TR-00477 shape -> wholesale', isFba({ ...REAL, orderNo: 'AMZ_CN-DRP-VAGINALPRO-2OZ_00477' }));
ok('REAL legacy CIN7- naming -> wholesale', isFba({ ...REAL, orderNo: 'CIN7-TR-00477' }));
ok('REAL remapped REF_ naming (TR-00448) -> wholesale', isFba({ ...REAL, orderNo: 'REF_B0F7JWVX6N_00448' }));
ok('per-lot child order -> wholesale', isFba({ ...REAL, orderNo: 'AMZ_CN-CAP-SAFFRON-60CT_TR-00459-2510014A' }));

// the old predicate must be demonstrably broken on the same input (proves the fix matters)
const oldIsFba = (o: any) => o.tags?.includes('FBA') ||
  o.company?.toLowerCase().includes('amazon') || o.company?.toLowerCase().includes('fba') ||
  o.orderNo?.toLowerCase().includes('fba');
ok('OLD logic FAILED on the real shape (regression proof)',
   !oldIsFba({ ...REAL, orderNo: 'AMZ_CN-DRP-VAGINALPRO-2OZ_00477' }));

// non-FBA transfers must NOT be flagged wholesale
ok('TikTok destination -> NOT wholesale', !isFba({ dest: 'TikTok Shop US', company: 'Allseason Enterprises LLC', orderNo: 'TT_CN-CAP-X_00500', tags: ['cin7-transfer'] }));
ok('Intermountain destination -> NOT wholesale', !isFba({ dest: 'Intermountain Warehouse', company: 'Allseason Enterprises LLC', orderNo: 'IM_CN-CAP-X_00501', tags: ['cin7-transfer'] }));
// (was a tautology `... === false || true` on first write — always green, proved
// nothing. Asserting the real property: a non-FBA customer whose NAME merely
// contains "Wholesale" must not be routed down the FBA wholesale path.)
ok('customer named "Wholesale" -> NOT routed as FBA',
   !isFba({ dest: 'Costco DC 7', company: 'Costco Wholesale Corp', orderNo: 'CW_00502', tags: ['cin7-transfer'] }));
ok('empty/unknown destination -> NOT wholesale (fails safe to normal)', !isFba({ dest: '', company: '', orderNo: 'X_00503', tags: [] }));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
