/**
 * Label completeness: Amazon shipments ⇄ files on the ShipHero order ⇄ PDF pages.
 *
 * TR-00694/726/728/729/731/889 (Oct–Nov 2026): Amazon held every shipment, but
 * 1+ label PDFs never reached the ShipHero order and nothing alerted. TR-00889:
 * 5 shipments / 667 boxes, only 3 files attached (Henderson NV + Las Vegas NV
 * missing) — recovered by /api/fba/relabel on 2026-11-23.
 *
 * Contract (diffLabels — pure):
 *   complete=true  ⇔ every live Amazon shipment has an FBA* attachment AND a PDF
 *                    whose page count == boxes × 2
 *   duplicate attachments never count twice; zero expected shipments ≠ complete
 * Contract (checkLabelCompleteness — I/O, injected):
 *   any read failure → complete=undefined (UNKNOWN), never true/false
 *
 * Run: npx tsx scripts/_test-label-completeness.ts
 */
import { diffLabels, checkLabelCompleteness } from '../lib/fba-label-completeness';

let fails = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + x}`); };

const TR889 = [
  { fbaId: 'FBA19Y0BF2KZ', boxes: 142 }, { fbaId: 'FBA19Y0CP84L', boxes: 146 }, { fbaId: 'FBA19Y09L19T', boxes: 141 },
  { fbaId: 'FBA19Y0GZ79Q', boxes: 104 }, { fbaId: 'FBA19Y0GWL9S', boxes: 134 },
];
const att3 = ['FBA19Y0BF2KZ-KANSAS_CITY_MO-142boxes.pdf', 'FBA19Y0CP84L-GOODYEAR_AZ-146boxes.pdf', 'FBA19Y09L19T-PERRYSBURG_OH-141boxes.pdf'];
const allPages = Object.fromEntries(TR889.map((s) => [s.fbaId, s.boxes * 2]));

async function main() {
  // 1. 🔴 the TR-00889 shape
  {
    const d = diffLabels(TR889, att3, allPages);
    ok('🔴 TR-00889: 3 of 5 attached → complete=false', d.complete === false);
    ok('🔴 …missing names Henderson + Las Vegas shipments', JSON.stringify(d.missingAttachment.sort()) === JSON.stringify(['FBA19Y0GWL9S', 'FBA19Y0GZ79Q']), JSON.stringify(d.missingAttachment));
    ok('…expected totals reported (5 shipments, 667 boxes)', d.expectedShipments === 5 && d.expectedBoxes === 667, `${d.expectedShipments}/${d.expectedBoxes}`);
  }
  // 2. all good
  {
    const att = TR889.map((s) => `${s.fbaId}-X-${s.boxes}boxes.pdf`);
    const d = diffLabels(TR889, att, allPages);
    ok('all 5 attached + pages = boxes×2 → complete=true', d.complete === true && d.missingAttachment.length === 0 && d.pageMismatch.length === 0);
  }
  // 3. attached but under-paged PDF (under-labelled)
  {
    const att = TR889.map((s) => `${s.fbaId}-X-${s.boxes}boxes.pdf`);
    const d = diffLabels(TR889, att, { ...allPages, FBA19Y0GZ79Q: 2 });
    ok('attached but PDF has 2 pages for 104 boxes → complete=false', d.complete === false);
    ok('…pageMismatch names it with boxes + pages', d.pageMismatch.length === 1 && d.pageMismatch[0].fbaId === 'FBA19Y0GZ79Q' && d.pageMismatch[0].pages === 2 && d.pageMismatch[0].boxes === 104, JSON.stringify(d.pageMismatch));
  }
  // 4. missing PDF in storage (no page count) = mismatch
  {
    const att = TR889.map((s) => `${s.fbaId}-X-${s.boxes}boxes.pdf`);
    const { FBA19Y0GWL9S: _drop, ...pages } = allPages;
    const d = diffLabels(TR889, att, pages);
    ok('PDF absent from storage → complete=false (pages=null)', d.complete === false && d.pageMismatch.some((m) => m.fbaId === 'FBA19Y0GWL9S' && m.pages === null));
  }
  // 5. duplicate attachments don't mask a gap
  {
    const att = [...att3, ...att3];
    const d = diffLabels(TR889, att, allPages);
    ok('duplicate attachments do not count twice', d.complete === false && d.missingAttachment.length === 2);
  }
  // 6. zero expected shipments is not "complete"
  {
    const d = diffLabels([], [], {});
    ok('no shipments → complete=false (nothing to confirm)', d.complete === false);
  }
  // 7. non-FBA attachments ignored; prefix must be the full id
  {
    const d = diffLabels([{ fbaId: 'FBA19Y0GZ79Q', boxes: 1 }], ['packing-slip.pdf', 'FBA19Y0GZ79-short.pdf'], { FBA19Y0GZ79Q: 2 });
    ok('only an attachment starting with the full FBA id counts', d.complete === false && d.missingAttachment[0] === 'FBA19Y0GZ79Q');
  }

  // 8. I/O wrapper — happy path
  {
    const r = await checkLabelCompleteness('wf-x', 'order-x', {
      amazonShipments: async () => TR889,
      orderAttachments: async () => TR889.map((s) => `${s.fbaId}-X.pdf`),
      pdfPages: async (id) => allPages[id],
    });
    ok('check: all present → complete=true', r.complete === true);
  }
  // 9. I/O wrapper — ShipHero read fails → UNKNOWN
  {
    const r = await checkLabelCompleteness('wf-x', 'order-x', {
      amazonShipments: async () => TR889,
      orderAttachments: async () => { throw new Error('ShipHero query error: [{"code":30}]'); },
      pdfPages: async (id) => allPages[id],
    });
    ok('🔴 check: ShipHero read throws → complete=undefined (never false/true)', r.complete === undefined, String(r.complete));
    ok('…and the read error is reported', /code/.test(String(r.error)));
  }
  // 10. I/O wrapper — Amazon read fails → UNKNOWN
  {
    const r = await checkLabelCompleteness('wf-x', 'order-x', {
      amazonShipments: async () => { throw new Error('429'); },
      orderAttachments: async () => [],
      pdfPages: async () => 0,
    });
    ok('check: Amazon read throws → complete=undefined', r.complete === undefined);
  }
  // 11. I/O wrapper — a single PDF download failing is UNKNOWN, not "missing"
  {
    const r = await checkLabelCompleteness('wf-x', 'order-x', {
      amazonShipments: async () => TR889,
      orderAttachments: async () => TR889.map((s) => `${s.fbaId}-X.pdf`),
      pdfPages: async (id) => { if (id === 'FBA19Y0GWL9S') throw new Error('fetch failed'); return allPages[id]; },
    });
    ok('check: a PDF fetch error → complete=undefined', r.complete === undefined);
  }
  // 12. I/O wrapper — PDF genuinely absent (null) is a real gap
  {
    const r = await checkLabelCompleteness('wf-x', 'order-x', {
      amazonShipments: async () => TR889,
      orderAttachments: async () => TR889.map((s) => `${s.fbaId}-X.pdf`),
      pdfPages: async (id) => (id === 'FBA19Y0GWL9S' ? null : allPages[id]),
    });
    ok('check: PDF not in storage (null) → complete=false', r.complete === false);
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`);
  if (fails) process.exitCode = 1;
}
main();
