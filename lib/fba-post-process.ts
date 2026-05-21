import { createClient } from '@supabase/supabase-js';
import { callAmazonSpApi } from './amazon-sp-api-client';

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';
const SUPABASE_BUCKET = 'shipment-labels';

export interface PostProcessInput {
  /** CIN7-TR-XXXXX — used for folder naming + ShipHero order lookup */
  cin7TransferNumber: string;
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

  // Box count (paginated)
  let nBoxes = 0;
  let token: string | undefined;
  do {
    const path = `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments/${internalShipmentId}/boxes${
      token ? `?paginationToken=${token}` : ''
    }`;
    const boxRes = await callAmazonSpApi<any>({ method: 'GET', path });
    nBoxes += (boxRes.data?.boxes ?? []).length;
    token = boxRes.data?.pagination?.nextToken;
  } while (token);

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
    shippingCost,
    shippingCurrency,
  };
}

async function fetchLabelPdf(fbaId: string, nBoxes: number): Promise<Buffer> {
  // LabelType=UNIQUE + PackageLabel_Thermal_No_Carrier_Rotation gives the correct combined
  // label PDF: page 1 = FBA box label (portrait 4×6), page 2 = carrier shipping label (portrait 4×6).
  // Do NOT use BARCODE_2D (omits carrier label) or PackageLabel_Thermal (carrier label rotated 90°).
  // Box IDs are formatted as {shipmentId}U{number} e.g. FBA19DNLZ885U000001.
  const boxIds = Array.from({ length: nBoxes }, (_, i) => `${fbaId}U${String(i + 1).padStart(6, '0')}`);
  const path = `/fba/inbound/v0/shipments/${fbaId}/labels?PageType=PackageLabel_Thermal_No_Carrier_Rotation&LabelType=UNIQUE&${boxIds.map(id => `PackageLabelsToPrint=${id}`).join('&')}`;
  const r = await callAmazonSpApi<any>({ method: 'GET', path });
  const url = r.data?.payload?.DownloadURL;
  if (!url) throw new Error(`No DownloadURL in getLabels response for ${fbaId}`);
  const pdfRes = await fetch(url);
  if (!pdfRes.ok) throw new Error(`S3 label download failed: HTTP ${pdfRes.status}`);
  const arr = new Uint8Array(await pdfRes.arrayBuffer());
  return Buffer.from(arr);
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

async function findShipheroOrder(
  token: string,
  cin7TransferNumber: string
): Promise<{ orderId: string; accountId: string } | null> {
  const query = `
    query {
      orders(order_number: "${cin7TransferNumber}") {
        data(first: 3) {
          edges { node { id order_number account_id } }
        }
      }
    }
  `;
  const data = await shGql(token, query);
  const edges = data?.orders?.data?.edges ?? [];
  const node = edges[0]?.node;
  if (!node) return null;
  return { orderId: node.id, accountId: node.account_id };
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

async function sendTelegram(text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FBA_CHAT_ID;
  if (!botToken || !chatId) {
    console.warn('[fba-post-process] Telegram env vars not set — skipping notification');
    return false;
  }
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error('[fba-post-process] Telegram send failed:', resp.status, body);
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

  // Process each shipment: fetch label → upload → attach
  const shToken = await getShipHeroToken();
  const shOrder = await findShipheroOrder(shToken, input.cin7TransferNumber);
  if (!shOrder) {
    throw new Error(`ShipHero order not found for ${input.cin7TransferNumber}`);
  }
  result.shipheroOrderId = shOrder.orderId;

  let totalShippingCost = 0;
  let hasShippingCost = false;

  for (const internalId of internalIds) {
    try {
      const det = await getShipmentDetails(planId, internalId);
      const slug = destinationSlug(det.destinationCity, det.destinationState);
      const filename = `${det.fbaId}-${slug}-${det.nBoxes}boxes.pdf`;
      const objectPath = `${input.cin7TransferNumber.replace(/^CIN7-/, '')}/${filename}`;

      // Fetch + upload
      const pdfBytes = await fetchLabelPdf(det.fbaId, det.nBoxes);
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

function buildTelegramMessage(input: PostProcessInput, result: PostProcessResult): string {
  const lines: string[] = [];
  const name = input.product.productName || input.product.amazonSku;
  lines.push(`📦 *FBA Shipment — ${name}*`);
  lines.push('');
  lines.push(`*Product:* ${name}`);
  lines.push(`*CIN7 SKU:* \`${input.product.cin7Sku}\``);
  lines.push(`*Amazon MSKU:* \`${input.product.amazonSku}\``);
  if (input.product.fnsku || input.product.asin) {
    const bits: string[] = [];
    if (input.product.fnsku) bits.push(`*FNSKU:* \`${input.product.fnsku}\``);
    if (input.product.asin) bits.push(`*ASIN:* \`${input.product.asin}\``);
    lines.push(bits.join(' · '));
  }
  lines.push('');
  lines.push('*Shipment Details:*');
  lines.push(`• Units: *${input.quantity.totalUnits.toLocaleString()}* (${input.quantity.boxes} cases × ${input.quantity.unitsPerBox}/case)`);
  lines.push(`• Case Pack: ${input.quantity.unitsPerBox} per case`);
  if (input.expiration) {
    const lotSuffix = input.lot ? ` (Lot ${input.lot})` : '';
    lines.push(`• Expiration: *${input.expiration}*${lotSuffix} — FEFO`);
  }
  lines.push(`• Box Dims: ${input.box.length} × ${input.box.width} × ${input.box.height} inches, ${input.box.weightLbs} lbs/case`);
  lines.push(`• Ship From: Clean Nutra, 6425 S Jones Blvd, Las Vegas NV 89118`);
  lines.push('');
  lines.push(`*ShipHero Order:* ${input.cin7TransferNumber}`);
  lines.push(`*Inbound Plan:* \`${input.fbaResult.planId}\``);
  lines.push('');
  lines.push(`*Amazon Optimized Splits — ${result.labels.length} destination(s) (Partnered UPS Ground):*`);
  for (const l of result.labels) {
    lines.push(`• \`${l.fbaId}\` → ${l.destination} — ${l.boxes} boxes`);
  }
  lines.push('');
  if (typeof result.totalShippingCost === 'number') {
    lines.push(`*Total shipping:* $${result.totalShippingCost.toFixed(2)} (UPS Partnered Carrier)`);
  }
  lines.push(`*Placement fee:* $${result.placementFee} ${result.placementFee === 0 ? '(Amazon-optimized splits)' : ''}`);
  lines.push('');
  lines.push(`📋 *Shipping Labels (4×6 Thermal — one PDF per destination):*`);
  for (const l of result.labels) {
    lines.push(`• [${l.destination} (${l.boxes})](${l.supabaseUrl})`);
  }
  lines.push('');
  lines.push(`(Labels also attached to ShipHero order \`${input.cin7TransferNumber}\` + in packing note)`);
  lines.push('');
  lines.push(`*Prep:* FNSKU labeling — apply one unique label per box · SELLER`);
  lines.push('');
  lines.push(`✅ Ready for warehouse processing`);
  return lines.join('\n');
}
