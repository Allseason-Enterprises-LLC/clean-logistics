/**
 * FBA label completeness — the single answer to "does every box Amazon expects
 * have its label on the ShipHero order?"
 *
 * Why (2026-11-23): TR-00694/726/728/729/731/889. Amazon held every shipment,
 * but one or more label PDFs never reached the ShipHero order and nothing
 * alerted. Post-process swallowed per-shipment errors, and a 300s kill
 * mid-loop left the row `plan_created` silently. The floor learned by counting
 * boxes. Status (`labels_ready`) and the floor's "ready" post must follow THIS
 * check, not "post-process returned".
 *
 * Three sources must agree, per live Amazon shipment:
 *   1. an attachment on the order whose filename starts with the FBA id
 *   2. a stored PDF whose page count == boxes × 2 (box label + carrier label;
 *      counted with /Type\s*\/Page[^s] — never /Count)
 *
 * UNKNOWN is a first-class answer: any read failure → complete=undefined.
 * Callers must not alert, relabel or flip status on unknown; re-check later.
 */
import { callAmazonSpApi } from './amazon-sp-api-client';

export interface ExpectedShipment { fbaId: string; boxes: number; destination?: string }

export interface LabelDiff {
  complete: boolean;
  expectedShipments: number;
  expectedBoxes: number;
  missingAttachment: string[];
  pageMismatch: Array<{ fbaId: string; boxes: number; pages: number | null }>;
}

/** Pure. `pages[fbaId]` = page count of that shipment's stored PDF; absent/null = no PDF. */
export function diffLabels(
  expected: ExpectedShipment[],
  attachmentFilenames: string[],
  pages: Record<string, number | null | undefined>,
): LabelDiff {
  const names = Array.from(new Set((attachmentFilenames || []).map(String)));
  const missingAttachment: string[] = [];
  const pageMismatch: LabelDiff['pageMismatch'] = [];
  for (const s of expected) {
    // Full-id prefix only: "FBA19Y0GZ79Q-HENDERSON_NV-104boxes.pdf".
    if (!names.some((n) => n === s.fbaId || n.startsWith(`${s.fbaId}-`) || n.startsWith(`${s.fbaId}.`))) missingAttachment.push(s.fbaId);
    const pg = pages[s.fbaId];
    if (pg === undefined || pg === null || pg !== s.boxes * 2) pageMismatch.push({ fbaId: s.fbaId, boxes: s.boxes, pages: pg ?? null });
  }
  return {
    complete: expected.length > 0 && missingAttachment.length === 0 && pageMismatch.length === 0,
    expectedShipments: expected.length,
    expectedBoxes: expected.reduce((n, s) => n + s.boxes, 0),
    missingAttachment,
    pageMismatch,
  };
}

export interface CompletenessDeps {
  /** Live (non-cancelled) shipments of the plan with real box counts. */
  amazonShipments: (planId: string) => Promise<ExpectedShipment[]>;
  /** Filenames attached to the ShipHero order. */
  orderAttachments: (orderId: string) => Promise<string[]>;
  /** Page count of the stored PDF for a shipment; null = no PDF stored. Throw on read error. */
  pdfPages: (fbaId: string) => Promise<number | null>;
}

export interface CompletenessResult {
  /** true = verified complete · false = verified gap · undefined = could not verify */
  complete: boolean | undefined;
  diff?: LabelDiff;
  expected?: ExpectedShipment[];
  error?: string;
}

export async function checkLabelCompleteness(planId: string, orderId: string, deps: CompletenessDeps): Promise<CompletenessResult> {
  let expected: ExpectedShipment[];
  let attachments: string[];
  try {
    expected = await deps.amazonShipments(planId);
    attachments = await deps.orderAttachments(orderId);
  } catch (e: any) {
    return { complete: undefined, error: String(e?.message || e).slice(0, 300) };
  }
  const pages: Record<string, number | null> = {};
  for (const s of expected) {
    try { pages[s.fbaId] = await deps.pdfPages(s.fbaId); }
    catch (e: any) { return { complete: undefined, expected, error: `pdf ${s.fbaId}: ${String(e?.message || e).slice(0, 200)}` }; }
  }
  const diff = diffLabels(expected, attachments, pages);
  return { complete: diff.complete, diff, expected };
}

// ── Production deps ──────────────────────────────────────────────────────────

const B = '/inbound/fba/2024-03-20/inboundPlans';
const SHIPHERO = 'https://public-api.shiphero.com/graphql';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Amazon: live shipments of a plan with paginated box counts. */
export async function liveAmazonShipments(planId: string): Promise<ExpectedShipment[]> {
  const plan: any = (await callAmazonSpApi<any>({ method: 'GET', path: `${B}/${planId}` })).data;
  const out: ExpectedShipment[] = [];
  for (const s of plan?.shipments ?? []) {
    const d: any = (await callAmazonSpApi<any>({ method: 'GET', path: `${B}/${planId}/shipments/${s.shipmentId}` })).data;
    if (/CANCELLED|DELETED/i.test(String(d?.status))) continue;
    if (!d?.shipmentConfirmationId) throw new Error(`shipment ${s.shipmentId} has no confirmation id yet`);
    let boxes = 0; let token: string | undefined;
    do {
      const query: any = { pageSize: '1000' }; if (token) query.paginationToken = token;
      const b: any = (await callAmazonSpApi<any>({ method: 'GET', path: `${B}/${planId}/shipments/${s.shipmentId}/boxes`, query })).data;
      boxes += (b?.boxes ?? []).length; token = b?.pagination?.nextToken;
    } while (token);
    const a = d?.destination?.address ?? {};
    out.push({ fbaId: d.shipmentConfirmationId, boxes, destination: [a.city, a.stateOrProvinceCode].filter(Boolean).join(', ') });
  }
  return out;
}

/** ShipHero: attachment filenames on an order. Backs off on code:30, throws after. */
export async function shipheroOrderAttachments(token: string, orderId: string): Promise<string[]> {
  const query = `{ order(id: "${orderId}") { data { attachments(first: 100) { edges { node { filename } } } } } }`;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(SHIPHERO, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    const j: any = await r.json().catch(() => null);
    if ((j?.errors ?? []).some((e: any) => e?.code === 30)) { await sleep(10_000 * (i + 1)); continue; }
    if (j?.errors?.length) throw new Error(`ShipHero attachments: ${JSON.stringify(j.errors).slice(0, 200)}`);
    const edges = j?.data?.order?.data?.attachments?.edges;
    if (!Array.isArray(edges)) throw new Error(`ShipHero attachments: order ${orderId} not readable`);
    return edges.map((e: any) => String(e?.node?.filename ?? ''));
  }
  throw new Error('ShipHero attachments: code:30 credits exhausted after retries');
}

/** Storage: page count of `<prefix>/<fbaId>-*.pdf`; null when no such file. */
export async function storedPdfPages(supabaseUrl: string, serviceKey: string, prefix: string, fbaId: string): Promise<number | null> {
  const H = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const list = await fetch(`${supabaseUrl}/storage/v1/object/list/shipment-labels`, { method: 'POST', headers: H, body: JSON.stringify({ prefix, limit: 200, search: fbaId }) });
  if (!list.ok) throw new Error(`storage list ${list.status}`);
  const files = (await list.json()) as any[];
  const f = (files || []).find((x) => String(x?.name ?? '').startsWith(`${fbaId}-`));
  if (!f) return null;
  const pdf = await fetch(`${supabaseUrl}/storage/v1/object/public/shipment-labels/${prefix}/${encodeURIComponent(f.name)}`);
  if (!pdf.ok) throw new Error(`storage get ${pdf.status}`);
  const buf = Buffer.from(await pdf.arrayBuffer());
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

/** Storage folder post-process writes to: `<TR>[/<lot>]`. */
export function labelStoragePrefix(cin7TransferNumber: string, lot?: string | null): string {
  const tr = String(cin7TransferNumber).replace(/^CIN7-/, '');
  return `${tr}${lot ? `/${String(lot).replace(/[^A-Za-z0-9_-]/g, '')}` : ''}`;
}
