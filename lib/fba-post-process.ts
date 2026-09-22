import { createClient } from '@supabase/supabase-js';
import { callAmazonSpApi } from './amazon-sp-api-client';
import { extractTransferNumber } from './order-naming';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const SUPABASE_BUCKET = 'shipment-labels';

export interface PostProcessInput {
  /** CIN7-TR-XXXXX — used for folder naming + ShipHero order lookup */
  cin7TransferNumber: string;
  /**
   * Lot-split child order number (e.g. CIN7-TR-00123-CN61522602). When set,
   * the ShipHero order lookup tries this first so labels/notes attach to the
   * per-lot child order instead of a legacy parent. Falls back to
   * cin7TransferNumber if not found.
   */
  shipheroOrderNumberOverride?: string;
  /** Output of runFbaInboundWorkflow */
  fbaResult: {
    planId?: string;
    shipmentIds?: string[]; // internal sh... IDs
    shipmentConfirmationIds?: string[]; // public FBA... IDs
    [key: string]: any;
  };
  /** Product / shipment metadata used in packing note + Telegram */
  product: {
    cin7Sku: string;
    amazonSku: string;
    productName?: string;
    fnsku?: string;
    asin?: string;
  };
  quantity: {
    totalUnits: number;
    boxes: number;
    unitsPerBox: number;
  };
  box: {
    length: number;
    width: number;
    height: number;
    weightLbs: number;
  };
  expiration?: string;
  lot?: string;
}

export interface PostProcessResult {
  labels: Array<{
    fbaId: string;
    internalShipmentId: string;
    boxes: number;
    destination: string;
    warehouseCode: string;
    supabaseUrl: string;
  }>;
  totalShippingCost?: number;
  placementFee: number;
  shipheroOrderId?: string;
  attachmentsCreated: number;
  telegramSent: boolean;
  errors: string[];
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

async function getShipHeroToken(): Promise<string> {
  const sb = getSupabase();
  const warehouseId = process.env.SHIPHERO_WAREHOUSE_ID || '22e17170-af72-4bf8-b77c-d73c86b06765';
  const { data, error } = await sb
    .from('warehouses')
    .select('api_credentials')
    .eq('id', warehouseId)
    .eq('provider', 'shiphero')
    .single();
  if (error || !data) throw new Error(`ShipHero token fetch failed: ${error?.message}`);
  const creds = data.api_credentials as any;
  if (!creds?.accessToken) throw new Error('No ShipHero accessToken in api_credentials');
  return creds.accessToken;
}

async function shGql(token: string, query: string, variables?: any): Promise<any> {
  const resp = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await resp.json();
  if (json.errors) throw new Error(`ShipHero GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/**
 * Normalize a city/state into a safe filename prefix.
 * "Goodyear, AZ" -> "GOODYEAR_AZ"
 */
function destinationSlug(city: string, state: string): string {
  const c = (city || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const s = (state || 'XX').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${c}_${s}`;
}

async function getShipmentDetails(
  planId: string,
  internalShipmentId: string
): Promise<{
  fbaId: string;
  destinationCity: string;
  destinationState: string;
  warehouseCode: string;
  nBoxes: number;
  boxIds: string[];
  shippingCost?: number;
  shippingCurrency?: string;
}> {
  // Shipment overview
  const shipRes = await callAmazonSpApi<any>({
    method: 'GET',
    path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments/${internalShipmentId}`,
  });
  const d = shipRes.data ?? {};
  const fbaId = d.shipmentConfirmationId;
  const addr = d.destination?.address ?? {};
  const wh = d.destination?.warehouse ?? {};

  // Box count + REAL box IDs (paginated).
  // CRITICAL: we must use Amazon's actual boxId values (e.g. "bxi-...") when calling getLabels.
  // The previous implementation faked them as `${fbaId}U000001` and Amazon silently returned
  // only the carrier label + one FBA box label per PDF, causing destinations with >1 boxes to
  // be under-labeled. See 2026-05-22 incident (TR-00079..00084).
  let nBoxes = 0;
  const boxIds: string[] = [];
  let token: string | undefined;
  do {
    const path = `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments/${internalShipmentId}/boxes${
      token ? `?paginationToken=${token}` : ''
    }`;
    const boxRes = await callAmazonSpApi<any>({ method: 'GET', path });
    const boxes = boxRes.data?.boxes ?? [];
    nBoxes += boxes.length;
    for (const box of boxes) {
      const id = box.boxId || box.packageId || box.cartonId || box.contentId || box.id;
      if (id) {
        boxIds.push(id);
      } else {
        console.warn(`[fba-post-process] Box has no recognizable ID field:`, Object.keys(box));
      }
    }
    token = boxRes.data?.pagination?.nextToken;
  } while (token);

  if (boxIds.length !== nBoxes) {
    console.warn(
      `[fba-post-process] Box ID count mismatch for ${fbaId}: ${boxIds.length} ids vs ${nBoxes} boxes. ` +
        `Labels may be incomplete — check listShipmentBoxes response.`
    );
  }

  // Get the selected transportation option cost (for Telegram summary)
  let shippingCost: number | undefined;
  let shippingCurrency: string | undefined;
  try {
    const topRes = await callAmazonSpApi<any>({
      method: 'GET',
      path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/transportationOptions`,
      query: { shipmentId: internalShipmentId },
    });
    const opts = topRes.data?.transportationOptions ?? [];
    // We can't determine the "selected" option from this endpoint reliably, but
    // in most cases only one option exists after placement confirm. Use the
    // partnered carrier quote if present.
    const partnered = opts.find(
      (o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER' && o.quote?.cost?.amount
    );
    const chosen = partnered ?? opts.find((o: any) => o.quote?.cost?.amount);
    if (chosen?.quote?.cost) {
      shippingCost = chosen.quote.cost.amount;
      shippingCurrency = chosen.quote.cost.code;
    }
  } catch (e) {
    console.warn(`[fba-post-process] Could not fetch transportation cost for ${fbaId}:`, e);
  }

  return {
    fbaId,
    destinationCity: addr.city ?? 'Unknown',
    destinationState: addr.stateOrProvinceCode ?? 'XX',
    warehouseCode: wh.warehouseId ?? (d.name?.match(/-([A-Z0-9]{3,4})$/)?.[1] ?? '?'),
    nBoxes,
    boxIds,
    shippingCost,
    shippingCurrency,
  };
}

async function fetchLabelPdf(fbaId: string, nBoxes: number, boxIds: string[]): Promise<Buffer> {
  // Use LabelType=BARCODE_2D (NOT UNIQUE) — this returns 2 pages PER BOX:
  //   page 1 = FBA box label (portrait 4×6, unique boxId barcode)
  //   page 2 = carrier shipping label (portrait 4×6)
  // Verified 2026-05-22: 2 boxes → 4 pages, 23 boxes → 46 pages, 24 boxes → 48 pages.
  //
  // Do NOT use LabelType=UNIQUE — despite the name, it returns ONLY ONE combined sheet
  // (2 pages total) regardless of box count, even when PackageLabelsToPrint lists every
  // real box ID. This caused the 2026-05-22 incident (TR-00079..00084): multi-box
  // shipments shipped with a single box label and a single carrier label.
  //
  // PackageLabelsToPrint is NOT used with BARCODE_2D — Amazon generates labels for all
  // boxes registered against the shipment via the packing-info workflow. boxIds is kept
  // as a sanity input only (used by callers for filename + verification).
  if (nBoxes <= 0) {
    throw new Error(`fetchLabelPdf: nBoxes=${nBoxes} for ${fbaId} — cannot fetch zero labels.`);
  }
  if (!boxIds || boxIds.length === 0) {
    console.warn(
      `[fba-post-process] fetchLabelPdf: ${fbaId} has nBoxes=${nBoxes} but listShipmentBoxes returned empty boxIds — ` +
        `proceeding with BARCODE_2D (which doesn't require IDs), but verify page count after upload.`
    );
  }
  const path =
    `/fba/inbound/v0/shipments/${fbaId}/labels?PageType=PackageLabel_Thermal&LabelType=BARCODE_2D`;
  const r = await callAmazonSpApi<any>({ method: 'GET', path });
  const url = r.data?.payload?.DownloadURL;
  if (!url) throw new Error(`No DownloadURL in getLabels response for ${fbaId}`);
  const pdfRes = await fetch(url);
  if (!pdfRes.ok) throw new Error(`S3 label download failed: HTTP ${pdfRes.status}`);
  const arr = new Uint8Array(await pdfRes.arrayBuffer());
  const buf = Buffer.from(arr);

  // Verify page count: PDF page count should be ~2 * nBoxes (1 box label + 1 carrier label each).
  // Use a lightweight regex on the raw bytes — no PDF parser needed.
  const pageMatches = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  const pageCount = pageMatches ? pageMatches.length : 0;
  const expected = nBoxes * 2;
  if (pageCount < expected) {
    throw new Error(
      `fetchLabelPdf: ${fbaId} expected ~${expected} pages (${nBoxes} boxes × 2) but PDF has ${pageCount}. ` +
        `Aborting — would ship under-labeled.`
    );
  }
  console.log(
    `[fba-post-process] ${fbaId}: ${nBoxes} boxes → ${pageCount} pages (size=${buf.length})`
  );
  return buf;
}

async function uploadToSupabase(
  objectPath: string,
  pdfBytes: Buffer
): Promise<string> {
  const sb = getSupabase();
  const { error } = await sb.storage.from(SUPABASE_BUCKET).upload(objectPath, pdfBytes, {
    contentType: 'application/pdf',
    upsert: true,
    cacheControl: 'no-cache',
  });
  if (error) throw new Error(`Supabase upload failed for ${objectPath}: ${error.message}`);
  const { data } = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

/**
 * Resolve the ShipHero order for a transfer.
 *
 * ⚠️ Must tolerate BOTH naming schemes (2026-09-21):
 *   legacy: `CIN7-TR-00477`
 *   new:    `AMZ_CN-CAP-SAFFRON-60CT_TR-00477`  (or a custom CIN7 Reference)
 *
 * `orders(order_number:)` is an EXACT match, so the old single-query approach
 * silently returned null for renamed orders — which would mean labels never
 * attach. Strategy:
 *   1. exact match on whatever we were handed (fast path, both schemes)
 *   2. fall back to scanning recent orders for one whose number contains the
 *      same `TR-XXXXX` token
 */
/**
 * ShipHero spells it "canceled" (one L) in `fulfillment_status`, but be liberal
 * about both spellings and casing so a schema tweak can't silently re-open the
 * TR-00474 bug (labels attached to a dead order).
 */
function isCancelledStatus(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase();
  return s.includes('cancel') || s.includes('void');
}

async function findShipheroOrder(
  token: string,
  cin7TransferNumber: string
): Promise<{ orderId: string; accountId: string } | null> {
  const exact = async (orderNumber: string) => {
    const query = `
      query {
        orders(order_number: "${orderNumber}") {
          data(first: 5) {
            edges { node { id order_number account_id fulfillment_status } }
          }
        }
      }
    `;
    const data = await shGql(token, query);
    const nodes = (data?.orders?.data?.edges ?? []).map((e: any) => e.node);
    // ⚠️ NEVER attach to a cancelled order. Ops cancels a broken order and the
    // pipeline then builds a REPLACEMENT; if we match the cancelled one the
    // labels land where the warehouse will never look. Observed on TR-00474
    // (2026-09-21): 5 label PDFs attached to canceled `CIN7-TR-00474` while the
    // live replacement `AMZ_CN-CAP-VBIOTIC-90CT_TR-00474` had none.
    const live = nodes.find((n: any) => !isCancelledStatus(n?.fulfillment_status));
    if (!live) return null;
    return { orderId: live.id, accountId: live.account_id };
  };

  // 1) exact, as given
  const direct = await exact(cin7TransferNumber);
  if (direct) return direct;

  const tr = extractTransferNumber(cin7TransferNumber);
  if (!tr) return null;

  // 2) scan recent orders for a LIVE order carrying this TR token. Runs BEFORE
  // the legacy `CIN7-<TR>` guess, because after a cancel+replace the legacy
  // name is precisely the dead order we must avoid.
  //
  // ⚠️ `Query.orders` has NO `sort` argument — passing one makes the whole
  // query fail with "Unknown argument 'sort'" (found 2026-09-22 while
  // recovering TR-00459). Use `created_from` to bound the window instead, and
  // `fulfillment_status_not_in` to exclude dead orders server-side.
  const createdFrom = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19);
  const scan = `
    query {
      orders(created_from: "${createdFrom}", fulfillment_status_not_in: ["canceled", "cancelled"]) {
        data(first: 100) {
          edges { node { id order_number account_id fulfillment_status } }
        }
      }
    }
  `;
  try {
    const data = await shGql(token, scan);
    const edges = data?.orders?.data?.edges ?? [];
    const hit = edges.find(
      (e: any) =>
        extractTransferNumber(e?.node?.order_number) === tr &&
        !isCancelledStatus(e?.node?.fulfillment_status)
    );
    if (hit) {
      console.log(
        `[fba-post-process] resolved ${tr} to LIVE ShipHero order ${hit.node.order_number} by TR scan`
      );
      return { orderId: hit.node.id, accountId: hit.node.account_id };
    }
  } catch (err: any) {
    console.warn(`[fba-post-process] TR scan failed for ${tr}: ${err?.message || err}`);
  }

  // 3) last resort: the legacy name (only reached if no live order was found)
  return await exact(`CIN7-${tr}`);
}

async function attachToShipHero(
  token: string,
  orderId: string,
  accountId: string,
  url: string,
  description: string,
  filename: string
): Promise<string> {
  const mutation = `
    mutation($d: OrderAddAttachmentInput!) {
      order_add_attachment(data: $d) {
        request_id
        attachment { id url description }
      }
    }
  `;
  const data = await shGql(token, mutation, {
    d: {
      order_id: orderId,
      customer_account_id: accountId,
      url,
      description,
      filename,
      file_type: 'application/pdf',
    },
  });
  return data?.order_add_attachment?.attachment?.id ?? '';
}

async function updatePackingNote(token: string, orderId: string, note: string): Promise<void> {
  const mutation = `
    mutation($d: UpdateOrderInput!) {
      order_update(data: $d) { request_id }
    }
  `;
  await shGql(token, mutation, { d: { order_id: orderId, packing_note: note } });
}

/**
 * Send the FBA shipment notification to the warehouse group.
 *
 * ⚠️ 2026-09-21: notifications had been silently dead since ~2026-09-18.
 * TWO env-level faults, both of which this function used to swallow as a
 * generic "send failed" line in the logs:
 *   1. TELEGRAM_BOT_TOKEN was the old Jarvis bot, which has been REMOVED from
 *      the group — every call returned 404 Not Found.
 *   2. TELEGRAM_FBA_CHAT_ID was the pre-supergroup id (-5244576221). The group
 *      was upgraded, so the live id is -1003528234475.
 * Both values also carried a trailing newline, hence the .trim() on each.
 *
 * `parse_mode` is HTML, NOT Markdown: destination names and label filenames
 * contain underscores (HAGERSTOWN_MD, FBA19QN44TW9-...-2boxes.pdf) which
 * legacy Markdown reads as italic markers and rejects with a 400.
 *
 * Failures are logged LOUDLY with Amazon-visible context, because a silent
 * notification failure means the warehouse never learns a shipment is ready.
 */
async function sendTelegram(text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    console.error(
      '[fba-post-process] ⚠️ TELEGRAM NOTIFICATION SKIPPED — env vars missing ' +
        `(token=${botToken ? 'set' : 'MISSING'}, chat_id=${chatId ? 'set' : 'MISSING'}). ` +
        'The warehouse will NOT be notified for this shipment.'
    );
    return false;
  }
  let resp: Response;
  try {
    resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err: any) {
    console.error(
      `[fba-post-process] ⚠️ TELEGRAM NOTIFICATION FAILED (network): ${err?.message || err} — ` +
        'the warehouse will NOT be notified for this shipment.'
    );
    return false;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(
      `[fba-post-process] ⚠️ TELEGRAM NOTIFICATION FAILED: HTTP ${resp.status} ${body.slice(0, 300)} — ` +
        'the warehouse will NOT be notified for this shipment. ' +
        '404 = bot not in the group or wrong token; 400 = chat_id stale or markup error.'
    );
    return false;
  }
  return true;
}

/**
 * Post-process an FBA result:
 *   1. For each shipment: fetch 4x6 thermal label PDF → upload to Supabase → attach to ShipHero
 *   2. Update ShipHero packing note with full summary
 *   3. Send one consolidated Telegram notification to the Clean Nutra FBA Shipments group
 */
export async function postProcessFbaShipment(
  input: PostProcessInput
): Promise<PostProcessResult> {
  const errors: string[] = [];
  const result: PostProcessResult = {
    labels: [],
    placementFee: 0,
    attachmentsCreated: 0,
    telegramSent: false,
    errors,
  };

  const planId = input.fbaResult.planId;
  const internalIds = input.fbaResult.shipmentIds ?? [];
  if (!planId || internalIds.length === 0) {
    throw new Error('postProcessFbaShipment: planId and shipmentIds are required');
  }

  // Fetch placement fee once (for Telegram summary only — not fatal if missing)
  try {
    const pl = await callAmazonSpApi<any>({
      method: 'GET',
      path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/placementOptions`,
    });
    const accepted = (pl.data?.placementOptions ?? []).find((p: any) => p.status === 'ACCEPTED');
    result.placementFee = (accepted?.fees ?? []).reduce(
      (sum: number, f: any) => sum + (f?.value?.amount ?? 0),
      0
    );
  } catch (e) {
    console.warn('[fba-post-process] Could not fetch placement fee:', e);
  }

  // Process each shipment: fetch label → upload → attach.
  // Lot-split: try the per-lot child order first (e.g. CIN7-TR-00123-CN61522602),
  // fall back to the legacy transfer-level order number.
  const shToken = await getShipHeroToken();
  let shOrder = input.shipheroOrderNumberOverride
    ? await findShipheroOrder(shToken, input.shipheroOrderNumberOverride)
    : null;
  let shOrderNumber = input.shipheroOrderNumberOverride || input.cin7TransferNumber;
  if (!shOrder) {
    if (input.shipheroOrderNumberOverride) {
      console.warn(
        `[fba-post-process] Child order ${input.shipheroOrderNumberOverride} not found — falling back to ${input.cin7TransferNumber}`
      );
    }
    shOrder = await findShipheroOrder(shToken, input.cin7TransferNumber);
    shOrderNumber = input.cin7TransferNumber;
  }
  if (!shOrder) {
    // ⚠️ AUTHORITATIVE FALLBACK (2026-09-22, found recovering TR-00459).
    //
    // Two things break the name-based lookups above once an order has been
    // cancelled and replaced:
    //   - the per-lot child name (`CIN7-TR-00459-2510014A`) never exists under
    //     the descriptive naming scheme, and
    //   - the legacy `CIN7-<TR>` name resolves ONLY to the cancelled order,
    //     which we now correctly refuse to attach to.
    // Result: `relabel` threw "ShipHero order not found" even though a healthy
    // replacement order was sitting right there.
    //
    // The bridge table records the real order for this transfer, so consult it
    // rather than guessing at names.
    const tr = extractTransferNumber(input.cin7TransferNumber);
    if (tr) {
      try {
        const db = getSupabase();
        const { data: bridge } = await db
          .from('cin7_transfer_shiphero_orders')
          .select('shiphero_order_number')
          .eq('cin7_transfer_number', tr)
          .not('shiphero_order_number', 'is', null)
          .maybeSingle();
        const bridgeName = (bridge as any)?.shiphero_order_number;
        if (bridgeName) {
          shOrder = await findShipheroOrder(shToken, bridgeName);
          if (shOrder) {
            shOrderNumber = bridgeName;
            console.log(
              `[fba-post-process] resolved ${tr} via the bridge table to ${bridgeName}`
            );
          }
        }
      } catch (err: any) {
        console.warn(
          `[fba-post-process] bridge-table order lookup failed for ${tr}: ${err?.message || err}`
        );
      }
    }
  }
  if (!shOrder) {
    throw new Error(`ShipHero order not found for ${input.shipheroOrderNumberOverride || input.cin7TransferNumber}`);
  }
  result.shipheroOrderId = shOrder.orderId;

  let totalShippingCost = 0;
  let hasShippingCost = false;

  for (const internalId of internalIds) {
    try {
      const det = await getShipmentDetails(planId, internalId);
      const slug = destinationSlug(det.destinationCity, det.destinationState);
      const filename = `${det.fbaId}-${slug}-${det.nBoxes}boxes.pdf`;
      // Per-lot subfolder keeps label PDFs from colliding across sibling lot shipments.
      const lotFolder = input.lot ? `/${input.lot.replace(/[^A-Za-z0-9_-]/g, '')}` : '';
      const objectPath = `${input.cin7TransferNumber.replace(/^CIN7-/, '')}${lotFolder}/${filename}`;

      // Fetch + upload
      const pdfBytes = await fetchLabelPdf(det.fbaId, det.nBoxes, det.boxIds);
      const publicUrl = await uploadToSupabase(objectPath, pdfBytes);

      // Attach to ShipHero
      const desc = `FBA Shipping Labels - ${det.fbaId} - ${det.destinationCity}, ${det.destinationState} - ${det.nBoxes} boxes (4x6 thermal)`;
      const attId = await attachToShipHero(shToken, shOrder.orderId, shOrder.accountId, publicUrl, desc, filename);
      if (attId) result.attachmentsCreated++;

      result.labels.push({
        fbaId: det.fbaId,
        internalShipmentId: internalId,
        boxes: det.nBoxes,
        destination: `${det.destinationCity}, ${det.destinationState}`,
        warehouseCode: det.warehouseCode,
        supabaseUrl: publicUrl,
      });

      if (typeof det.shippingCost === 'number') {
        totalShippingCost += det.shippingCost;
        hasShippingCost = true;
      }
    } catch (err: any) {
      console.error(`[fba-post-process] Failed processing ${internalId}:`, err?.message);
      errors.push(`${internalId}: ${err?.message}`);
    }
  }

  if (hasShippingCost) result.totalShippingCost = totalShippingCost;

  // Update packing note
  try {
    const lines = [
      `FBA Shipment for ${input.cin7TransferNumber} - ${input.product.productName || input.product.amazonSku}`,
      `${input.quantity.boxes} cases (${input.quantity.totalUnits.toLocaleString()} units) - Exp: ${input.expiration || 'N/A'} ${input.lot ? `(Lot ${input.lot})` : ''} FEFO`,
      `Box: ${input.box.length}x${input.box.width}x${input.box.height} in, ${input.box.weightLbs} lbs each. Units per case: ${input.quantity.unitsPerBox}.`,
      '',
      `Amazon Partnered Carrier - ${result.labels.length} destination(s):`,
      ...result.labels.map(
        (l) => `  • ${l.fbaId} -> ${l.destination}: ${l.boxes} boxes`
      ),
      '',
      `Total: ${result.labels.reduce((s, l) => s + l.boxes, 0)} boxes = ${input.quantity.boxes} cases. Apply one UNIQUE label per box.`,
      'FNSKU labeling: SELLER.',
      '',
      'Labels are attached to this order (one PDF per destination).',
    ];
    await updatePackingNote(shToken, shOrder.orderId, lines.join('\n'));
  } catch (err: any) {
    errors.push(`packing_note update: ${err?.message}`);
  }

  // Send single consolidated Telegram message
  try {
    const tg = buildTelegramMessage(input, result);
    result.telegramSent = await sendTelegram(tg);
  } catch (err: any) {
    errors.push(`telegram: ${err?.message}`);
  }

  return result;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the warehouse notification.
 *
 * ⚠️ HTML, not Markdown (changed 2026-09-21 alongside sendTelegram). Every
 * interpolated value goes through esc() because destination names, SKUs and
 * label filenames contain characters Telegram's HTML parser would otherwise
 * choke on. Underscores are the specific reason Markdown was abandoned:
 * HAGERSTOWN_MD and FBA19QN44TW9-...-2boxes.pdf became unclosed italics → 400.
 */
function buildTelegramMessage(input: PostProcessInput, result: PostProcessResult): string {
  const lines: string[] = [];
  const name = input.product.productName || input.product.amazonSku;
  const orderNo = input.shipheroOrderNumberOverride || input.cin7TransferNumber;
  lines.push(`📦 <b>FBA Shipment — ${esc(name)}</b>`);
  lines.push('');
  lines.push(`<b>Product:</b> ${esc(name)}`);
  lines.push(`<b>CIN7 SKU:</b> <code>${esc(input.product.cin7Sku)}</code>`);
  lines.push(`<b>Amazon MSKU:</b> <code>${esc(input.product.amazonSku)}</code>`);
  if (input.product.fnsku || input.product.asin) {
    const bits: string[] = [];
    if (input.product.fnsku) bits.push(`<b>FNSKU:</b> <code>${esc(input.product.fnsku)}</code>`);
    if (input.product.asin) bits.push(`<b>ASIN:</b> <code>${esc(input.product.asin)}</code>`);
    lines.push(bits.join(' · '));
  }
  lines.push('');
  lines.push('<b>Shipment Details:</b>');
  lines.push(`• Units: <b>${input.quantity.totalUnits.toLocaleString()}</b> (${input.quantity.boxes} cases × ${input.quantity.unitsPerBox}/case)`);
  lines.push(`• Case Pack: ${input.quantity.unitsPerBox} per case`);
  if (input.expiration) {
    const lotSuffix = input.lot ? ` (Lot ${esc(input.lot)})` : '';
    lines.push(`• Expiration: <b>${esc(input.expiration)}</b>${lotSuffix} — FEFO`);
  }
  lines.push(`• Box Dims: ${input.box.length} × ${input.box.width} × ${input.box.height} inches, ${input.box.weightLbs} lbs/case`);
  lines.push('• Ship From: Clean Nutra, 6425 S Jones Blvd, Las Vegas NV 89118');
  lines.push('');
  lines.push(`<b>ShipHero Order:</b> ${esc(orderNo)}`);
  lines.push(`<b>Inbound Plan:</b> <code>${esc(input.fbaResult.planId)}</code>`);
  lines.push('');
  lines.push(`<b>Amazon Optimized Splits — ${result.labels.length} destination(s) (Partnered UPS Ground):</b>`);
  for (const l of result.labels) {
    lines.push(`• <code>${esc(l.fbaId)}</code> → ${esc(l.destination)} — ${l.boxes} boxes`);
  }
  lines.push('');
  if (typeof result.totalShippingCost === 'number') {
    lines.push(`<b>Total shipping:</b> $${result.totalShippingCost.toFixed(2)} (UPS Partnered Carrier)`);
  }
  lines.push(`<b>Placement fee:</b> $${result.placementFee} ${result.placementFee === 0 ? '(Amazon-optimized splits)' : ''}`);
  lines.push('');
  lines.push('📋 <b>Shipping Labels (4×6 Thermal — one PDF per destination):</b>');
  for (const l of result.labels) {
    lines.push(`• <a href="${esc(l.supabaseUrl)}">${esc(l.destination)} (${l.boxes})</a>`);
  }
  lines.push('');
  lines.push(`(Labels also attached to ShipHero order <code>${esc(orderNo)}</code> + in packing note)`);
  lines.push('');
  lines.push('<b>Prep:</b> FNSKU labeling — apply one unique label per box · SELLER');
  lines.push('');
  lines.push('✅ Ready for warehouse processing');
  return lines.join('\n');
}
