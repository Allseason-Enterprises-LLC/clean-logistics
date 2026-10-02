/**
 * FBA PREFLIGHT — "the pipeline never fails on something the floor can fix."
 *
 * Before a transfer is handed to auto-submit we check every input the Amazon
 * workflow needs. Each missing input becomes a BLOCKER with:
 *   • who can fix it  — 'floor' (ShipHero data entry → CUSTOM work order with a
 *                        checklist) or 'marketing' (Amazon listing → channel
 *                        notice tagging marketing, NO floor work order)
 *   • a checklist      — the exact steps, in the words the person doing them
 *                        needs. The WO instructions are built from these.
 *
 * Weston 2026-10-01 (design decisions, do not relitigate here):
 *   • ShipHero is the ONLY source of truth for case pack, dims, weight, lot and
 *     expiration. If CIN7 has it and ShipHero doesn't, the WO is to COPY it into
 *     ShipHero. We never read CIN7 for these.
 *   • Amazon-side blockers (no MSKU mapping, offer not inbound-ready) get NO
 *     floor WO — the floor can't fix a listing. They get a channel notice to
 *     marketing ("fix on our side first") and the transfer parks until Amazon
 *     says ready.
 *   • When Amazon flips ready and the label type is FNSKU, a SECOND WO follows:
 *     print FNSKU labels, apply FNSKU + Transparency to every unit (Wild Yam,
 *     TR-00481, was exactly this and the system just failed silently).
 *
 * This module is PURE: it takes already-fetched facts and returns a decision.
 * No I/O. The gate (kit-work-order-gate / sync) does the fetching and acting.
 */

export type BlockerOwner = 'floor' | 'marketing';

export type BlockerCode =
  | 'MISSING_CASE_PACK'      // product_note lacks "Quantity per Case"
  | 'MISSING_BOX_DIMS'       // product_note lacks "Box Size: L x W x H"
  | 'MISSING_BOX_WEIGHT'     // product_note lacks "Box Weight"
  | 'MISSING_LOT'            // no lot on the SKU in ShipHero
  | 'MISSING_EXPIRATION'     // lot exists but no expiration / no dated lot
  | 'NO_AMAZON_MAPPING'      // sku_master has no MSKU for the CIN7 SKU
  | 'OFFER_NOT_INBOUND_READY'// Amazon: "MSKUs are not available for inbound"
  | 'VERIFY_BARCODE_FIRST_SHIPMENT' // first FBA shipment: floor checks the unit's barcode vs what Amazon requires, then branches
  | 'UPC_MISMATCH';          // ShipHero barcode ≠ Amazon listing UPC on a UPC-type listing → units would scan as the wrong product

export interface Blocker {
  code: BlockerCode;
  owner: BlockerOwner;
  /** One line for the ledger / digest. */
  summary: string;
  /** Numbered steps for the WO instructions or the marketing notice. */
  checklist: string[];
}

/** Facts the gate has already fetched. Every field optional: unknown ≠ missing
 *  for the Amazon side (fail OPEN there — see below), but missing ShipHero data
 *  IS a blocker (fail CLOSED — the shipment cannot be built without it). */
export interface PreflightFacts {
  cin7Sku: string;
  quantity: number;
  /** Parsed from ShipHero product_note. null = note absent or unparseable. */
  casePack?: { caseQuantity: number; boxLength: number; boxWidth: number; boxHeight: number; boxWeightLbs: number } | null;
  /** Raw note so the checklist can quote what IS there. */
  productNote?: string | null;
  /** From ShipHero lots / product expiry. */
  lotNumber?: string | null;
  expirationDate?: string | null;
  /** From sku_master. null = no row. */
  amazonMsku?: string | null;
  /** Result of Amazon prepDetails for the MSKU. undefined = not checked (don't block). */
  inboundReady?: boolean;
  /** From prepDetails.labelOwnerConstraint. SELLER_ONLY → we sticker FNSKUs. */
  labelOwnerConstraint?: 'SELLER_ONLY' | 'AMAZON_ONLY' | 'NONE_ONLY' | string | null;
  fnsku?: string | null;
  /**
   * Has this MSKU EVER been shipped to FBA before (Amazon FBA inventory has a
   * record, or our fba_shipments has a non-cancelled row)? Weston 2026-10-01:
   * "it's only usually for first orders that we have to flag this — if we've
   * sent in inventory before, they should already have barcodes on them."
   * undefined = could not determine → treat as shipped-before (no WO): a
   * needless labelling WO on an established product is the worse error.
   */
  shippedBefore?: boolean;
  /** Barcode on the ShipHero product record (what the warehouse scans). */
  shipheroBarcode?: string | null;
  /** UPC/EAN on the Amazon listing (listings report product-id / Listings API). */
  amazonUpc?: string | null;
  /** Kit SKUs are handled by the kit gate; preflight still checks their data. */
  isKit?: boolean;
}

/** Digits-only compare; EAN-13 with a leading 0 equals the 12-digit UPC-A. */
export function barcodesMatch(a: string | null | undefined, b: string | null | undefined): boolean | undefined {
  const na = String(a ?? '').replace(/\D/g, ''); const nb = String(b ?? '').replace(/\D/g, '');
  if (!na || !nb) return undefined;
  return na.replace(/^0+/, '') === nb.replace(/^0+/, '');
}

export interface PreflightResult {
  ok: boolean;
  blockers: Blocker[];
  /** Blockers the FLOOR fixes → become ONE custom work order. */
  floor: Blocker[];
  /** Blockers MARKETING fixes → become ONE channel notice. */
  marketing: Blocker[];
}

const SH_NOTE_FORMAT = [
  'Box Weight: <number> Lbs',
  'Box Size: <L> x <W> x <H> inches',
  'Quantity per Case: <number> <units>',
];

/** Pure. Order of blockers is the order the floor should work them. */
export function runPreflight(f: PreflightFacts): PreflightResult {
  const blockers: Blocker[] = [];
  const sku = f.cin7Sku;

  // ── ShipHero data (floor) — fail CLOSED ────────────────────────────────
  const cp = f.casePack ?? null;
  const noteHint = f.productNote
    ? `Current note reads: "${String(f.productNote).replace(/\s+/g, ' ').trim().slice(0, 120)}".`
    : 'The product note is empty.';
  if (!cp || !(cp.caseQuantity > 0)) {
    blockers.push({
      code: 'MISSING_CASE_PACK', owner: 'floor',
      summary: `ShipHero has no case quantity for ${sku}`,
      checklist: [
        `Count how many sellable units are in ONE shipping case of ${sku}.`,
        `ShipHero → Products → ${sku} → Notes. Add a line exactly: "Quantity per Case: <number> units".`,
        noteHint,
      ],
    });
  }
  if (!cp || !(cp.boxLength > 0 && cp.boxWidth > 0 && cp.boxHeight > 0)) {
    blockers.push({
      code: 'MISSING_BOX_DIMS', owner: 'floor',
      summary: `ShipHero has no case dimensions for ${sku}`,
      checklist: [
        `Measure the outside of one packed shipping case of ${sku} in inches (length x width x height).`,
        `ShipHero → Products → ${sku} → Notes. Add a line exactly: "Box Size: <L> x <W> x <H> inches".`,
        'Amazon limits: no side over 25 in, so if a case is bigger tell the office before entering it.',
        noteHint,
      ],
    });
  }
  if (!cp || !(cp.boxWeightLbs > 0)) {
    blockers.push({
      code: 'MISSING_BOX_WEIGHT', owner: 'floor',
      summary: `ShipHero has no case weight for ${sku}`,
      checklist: [
        `Weigh one packed shipping case of ${sku} on the floor scale, in pounds.`,
        `ShipHero → Products → ${sku} → Notes. Add a line exactly: "Box Weight: <number> Lbs".`,
        'Amazon limit: 50 lb per case. If heavier, tell the office before entering it.',
        noteHint,
      ],
    });
  }
  if (!f.lotNumber) {
    blockers.push({
      code: 'MISSING_LOT', owner: 'floor',
      summary: `ShipHero has no lot for ${sku}`,
      checklist: [
        `Read the lot number printed on the ${sku} product (bottle / bag / case label).`,
        `ShipHero → Products → ${sku} → Lots → Add lot: enter the lot number AND its best-by / expiration date.`,
        'Move the on-hand units into that lot so the quantity shows against it.',
      ],
    });
  } else if (!f.expirationDate) {
    blockers.push({
      code: 'MISSING_EXPIRATION', owner: 'floor',
      summary: `ShipHero lot ${f.lotNumber} for ${sku} has no expiration date`,
      checklist: [
        `Read the best-by / expiration date printed on the ${sku} product for lot ${f.lotNumber}.`,
        `ShipHero → Products → ${sku} → Lots → ${f.lotNumber} → set the expiration date.`,
      ],
    });
  }

  // ── Amazon side (marketing) ────────────────────────────────────────────
  if (f.amazonMsku === null) {
    blockers.push({
      code: 'NO_AMAZON_MAPPING', owner: 'marketing',
      summary: `No Amazon MSKU mapped for ${sku}`,
      checklist: [
        `Find the seller SKU for ${sku} in Seller Central → Inventory → Manage All Inventory (or the listings report). Match by ASIN + UPC, not by name.`,
        `If there is no listing yet, create the FBA offer on the correct ASIN.`,
        `Send Freight the MSKU + ASIN; the mapping is added and the shipment fires automatically.`,
      ],
    });
  } else if (f.inboundReady === false) {
    blockers.push({
      code: 'OFFER_NOT_INBOUND_READY', owner: 'marketing',
      summary: `Amazon will not accept ${f.amazonMsku} for inbound yet`,
      checklist: [
        `Seller Central → Manage Inventory → ${f.amazonMsku} → Edit → Offer tab.`,
        `Set "Fulfilled by Amazon" and choose the barcode type (UPC = no stickers; Amazon barcode = FNSKU stickers on every unit). Save.`,
        `Amazon takes 10–60 minutes to accept the offer for inbound. The shipment then fires on its own — no further action.`,
      ],
    });
  }

  // ── Barcode checks once Amazon is ready ────────────────────────────────
  //    The system knows what Amazon REQUIRES (UPC vs FNSKU) but can never see
  //    what is PRINTED on the unit. Weston 2026-10-01: "sometimes the products
  //    are already preconfigured with the correct UPC or FNSKU barcode, but
  //    sometimes not." So the floor VERIFIES one unit and branches — the WO is
  //    a verification, not a blind "apply labels".
  if (f.amazonMsku && f.inboundReady === true) {
    const wantsFnsku = f.labelOwnerConstraint === 'SELLER_ONLY';
    const upcMatch = barcodesMatch(f.shipheroBarcode, f.amazonUpc);
    const required = wantsFnsku
      ? `FNSKU${f.fnsku ? ` ${f.fnsku}` : ' (see Seller Central → Print item labels)'}`
      : `UPC${f.amazonUpc ? ` ${f.amazonUpc}` : ''}`;
    const printSteps = [
      `Print ${f.quantity} FNSKU labels${f.fnsku ? ` for ${f.fnsku}` : ''}: Seller Central → Manage Inventory → ${f.amazonMsku} → Print item labels.`,
      `Apply ONE FNSKU label to EVERY unit, covering the existing barcode completely so only the FNSKU scans.`,
      `If this product is enrolled in Amazon Transparency, also apply ONE Transparency code sticker to every unit (do not cover it).`,
    ];

    // (a) UPC-type listing whose ShipHero barcode does not match Amazon's UPC:
    //     units would be received as a different product. Fires on EVERY
    //     shipment (not just the first) — it is a data conflict, not a habit.
    if (!wantsFnsku && upcMatch === false) {
      blockers.push({
        code: 'UPC_MISMATCH', owner: 'floor',
        summary: `Barcode conflict on ${sku}: ShipHero has UPC ${f.shipheroBarcode}, the Amazon listing has UPC ${f.amazonUpc}`,
        checklist: [
          `Pull ONE unit of ${sku} and read the barcode printed on it.`,
          `If the unit shows ${f.amazonUpc} (Amazon's UPC): the ShipHero record is wrong. Tell the office to correct the ShipHero barcode to ${f.amazonUpc}, then mark this work order Complete.`,
          `If the unit shows ${f.shipheroBarcode} or anything else: Amazon would receive it as the WRONG product. Do NOT ship on the UPC. Tell the office — the listing must be switched to FNSKU labels, then:`,
          ...printSteps,
          `Mark this work order Complete only after the office confirms which path was taken.`,
        ],
      });
    }

    // (b) FIRST FBA shipment of the MSKU: verify one unit, then branch.
    //     Established products are not flagged (unknown history = established).
    else if (f.shippedBefore === false) {
      blockers.push({
        code: 'VERIFY_BARCODE_FIRST_SHIPMENT', owner: 'floor',
        summary: `FIRST FBA shipment of ${sku}: confirm the barcode on the unit is the one Amazon requires (${required})`,
        checklist: wantsFnsku
          ? [
              `Amazon requires every unit to carry ${required}.`,
              `Pull ONE unit of ${sku} and read the barcode printed on it.`,
              `If it already shows exactly that FNSKU: nothing to apply. Mark this work order Complete.`,
              `If it shows a different code or only a UPC:`,
              ...printSteps,
              `Then mark this work order Complete. The FBA box labels will post here within ~15 minutes.`,
            ]
          : [
              `Amazon requires every unit to scan as ${required} (the product's own UPC — no FNSKU stickers).`,
              `Pull ONE unit of ${sku} and read the barcode printed on it.`,
              `If it shows exactly that UPC: nothing to apply. Mark this work order Complete.`,
              `If it shows a different code, or a code that does not scan: do NOT ship. Tell the office — the listing must be switched to FNSKU labels, then:`,
              ...printSteps,
              `Then mark this work order Complete. The FBA box labels will post here within ~15 minutes.`,
            ],
      });
    }
  }

  const floor = blockers.filter((b) => b.owner === 'floor');
  const marketing = blockers.filter((b) => b.owner === 'marketing');
  return { ok: blockers.length === 0, blockers, floor, marketing };
}

/** The ShipHero note format, for messages that teach it. */
export const SHIPHERO_NOTE_FORMAT = SH_NOTE_FORMAT;

/** Deterministic reason key stored on the work order state. */
export function preflightReason(r: PreflightResult): string {
  return 'preflight:' + r.floor.map((b) => b.code).join('+');
}

/**
 * Work-order NAME (≤ what ShipHero shows in its list) + INSTRUCTIONS for the
 * floor blockers. One WO for all of them: one row to complete.
 */
export function buildPreflightWorkOrderText(args: {
  transferNumber: string;
  orderNumber: string | null | undefined;
  sku: string;
  quantity: number;
  blockers: Blocker[];
}): { name: string; instructions: string } {
  const floor = args.blockers.filter((b) => b.owner === 'floor');
  const label = (c: string) => c === 'VERIFY_BARCODE_FIRST_SHIPMENT' ? 'verify barcode (first FBA shipment)' : c === 'UPC_MISMATCH' ? 'barcode conflict' : c.replace(/^MISSING_/, '').replace(/_/g, ' ').toLowerCase();
  const what = floor.map((b) => label(b.code)).join(', ');
  const barcodeOnly = floor.length > 0 && floor.every((b) => b.code === 'VERIFY_BARCODE_FIRST_SHIPMENT' || b.code === 'UPC_MISMATCH');
  const name = `${barcodeOnly ? 'VERIFY BARCODE' : 'DATA FIX'} ${args.orderNumber || args.transferNumber} — ${what}`.slice(0, 120);
  const L: string[] = [];
  L.push(barcodeOnly
    ? `FBA shipment ${args.orderNumber || args.transferNumber} (${args.transferNumber}) is waiting on a barcode check. One unit, one minute.`
    : `FBA shipment ${args.orderNumber || args.transferNumber} (${args.transferNumber}) cannot be created until the following is entered in ShipHero.`);
  L.push(`Product: ${args.sku} · ${args.quantity} units`);
  L.push('');
  let n = 1;
  for (const b of floor) {
    L.push(`${b.summary.toUpperCase()}`);
    for (const step of b.checklist) L.push(`  ${n++}. ${step}`);
    L.push('');
  }
  L.push('When every step is done, mark this work order COMPLETE. The system re-checks ShipHero and creates the FBA shipment; box labels post to the FBA channel. If something is still missing, a new work order will say exactly what.');
  return { name, instructions: L.join('\n') };
}
