/**
 * The ShipHero packing note must account for EVERY lot/run of a transfer, not just the
 * last one written (TR-00533/00567/00591/00596: 2-lot transfers showed one lot's boxes;
 * floor read "labels missing"). Run: npx tsx scripts/_test-packing-note-consolidated.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildConsolidatedPackingNote, type LabelSet } from '../lib/fba-post-process';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const sets: LabelSet[] = [
  { lot: '2605070A', expiration: '2028-05-31', units: 3024, cases: 24, unitsPerBox: 126, shipments: [
    { fbaId: 'FBA19T4G9BLC', destination: 'LAS VEGAS, NV', boxes: 3 }, { fbaId: 'FBA19T4DVRCZ', destination: 'Stockton, CA', boxes: 4 },
    { fbaId: 'FBA19T4D46M1', destination: 'PERRYSBURG, OH', boxes: 4 }, { fbaId: 'FBA19T4FB9G6', destination: 'KANSAS CITY, KS', boxes: 4 }, { fbaId: 'FBA19T4D5KH3', destination: 'GOODYEAR, AZ', boxes: 9 } ] },
  { lot: '2511098A', expiration: '2027-12-01', units: 630, cases: 5, unitsPerBox: 126, shipments: [
    { fbaId: 'FBA19T4G4N68', destination: 'KANSAS CITY, KS', boxes: 1 }, { fbaId: 'FBA19T4FJWYK', destination: 'PERRYSBURG, OH', boxes: 1 },
    { fbaId: 'FBA19T4DQCWZ', destination: 'GOODYEAR, AZ', boxes: 1 }, { fbaId: 'FBA19T4FLTJN', destination: 'LAS VEGAS, NV', boxes: 1 }, { fbaId: 'FBA19T4D5DSY', destination: 'Stockton, CA', boxes: 1 } ] },
];
const note = buildConsolidatedPackingNote({ transferNumber: 'CIN7-TR-00591', productName: 'Shroomzoom', box: { length: 15, width: 13, height: 12, weightLbs: 20 }, labelOwner: 'NONE — ship with the UPC, no FNSKU stickers', sets });

ok('header totals are the SUM across lots (3,654 units, 29 boxes, 2 lots)', /3,654 units · 29 boxes · 2 lots/.test(note));
ok('both lots appear with their own expiration', note.includes('LOT 2605070A · Exp 2028-05-31') && note.includes('LOT 2511098A · Exp 2027-12-01'));
ok('every one of the 10 shipment ids is listed', sets.flatMap((s) => s.shipments).every((sh) => note.includes(sh.fbaId)));
ok('lot sections tell the floor to pack only that lot with those labels', (note.match(/pack ONLY this lot/g) || []).length === 2);
ok('Total line matches the sum of boxes and forbids mixing', /Total: 29 boxes/.test(note) && /Do not mix lots in a box/.test(note));
ok('label owner wording comes through', /FNSKU labeling: NONE — ship with the UPC/.test(note));

const one = buildConsolidatedPackingNote({ transferNumber: 'CIN7-TR-00544', productName: 'Magmelan', box: { length: 15, width: 13, height: 12, weightLbs: 12 }, labelOwner: 'SELLER', sets: [sets[1]] });
ok('single-lot note still reads correctly (1 lot)', /630 units · 5 boxes · 1 lot ·/.test(one));

const src = fs.readFileSync(path.join(__dirname, '../lib/fba-post-process.ts'), 'utf8');
const writeSite = src.slice(src.indexOf('// Update packing note'), src.indexOf('await updatePackingNote(shToken, shOrder.orderId, note)'));
ok('🔴 the live write persists this run then rebuilds from ALL rows of the transfer', /persistLabelSet\(planId[\s\S]*loadLabelSetsForTransfer\(input\.cin7TransferNumber\)[\s\S]*buildConsolidatedPackingNote/.test(writeSite));
ok('🔴 the per-lot-only note builder is gone', !/\$\{input\.quantity\.boxes\} cases \(\$\{input\.quantity\.totalUnits/.test(src));
ok('loader includes -S1 top-up rows (LIKE on the TR token) and excludes cancelled', /\.like\('cin7_transfer_number', `%\$\{tr\}%`\)[\s\S]{0,120}\.neq\('status', 'cancelled'\)/.test(src));

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
if (fails) process.exitCode = 1;
