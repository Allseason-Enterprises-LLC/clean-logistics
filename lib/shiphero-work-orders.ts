/**
 * ShipHero Work Orders — the assembly step that must COMPLETE before a kit /
 * bundle transfer is allowed to become an Amazon inbound plan.
 *
 * Introspected live 2026-09-22:
 *   mutation work_order_create(data: CreateWorkOrderInput!)   → WorkOrderMutationOutput
 *   mutation work_order_complete(data: CompleteWorkOrderInput!)
 *   query    work_order(id: Int!)                              → WorkOrderQueryResult
 *   query    work_orders(status, updated_at_from, ...)
 *   CreateWorkOrderInput: warehouse_id!, requested_date!, type! (ASSEMBLY|CUSTOM),
 *     priority (HIGH|MEDIUM|LOW), name, instructions, customer_account_id,
 *     assembly_sku { sku!, quantity!, lot_id?, receiving_location_id?, staging_location_id? }
 *   WorkOrderStatus: PENDING_APPROVAL | IN_PROGRESS | READY_TO_PICK |
 *     ASSEMBLY_IN_PROGRESS | COMPLETED | CANCELED | CLOSED
 *
 * ⚠️ `work_order(id:)` takes the INTEGER legacy_id, not the base64 `id`. We
 * store legacy_id as a string in bridge.work_order_ids and Number() it here.
 *
 * `fetchImpl` is injectable so tests assert the exact mutation shape offline.
 */

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

export type WorkOrderStatus =
  | 'PENDING_APPROVAL' | 'IN_PROGRESS' | 'READY_TO_PICK'
  | 'ASSEMBLY_IN_PROGRESS' | 'COMPLETED' | 'CANCELED' | 'CLOSED';

export const WO_TERMINAL_FAILED: ReadonlySet<string> = new Set(['CANCELED', 'CLOSED']);

export interface WorkOrderRef {
  id: string;          // base64 graph id
  legacyId: number;    // what work_order(id:) wants
  status: WorkOrderStatus | string;
}

export interface CreateAssemblyWorkOrderInput {
  warehouseId: string;
  customerAccountId: string;
  sku: string;
  quantity: number;
  lotId?: string | null;
  name: string;
  instructions: string;
  /** ISO date/time. Weston: "today". */
  requestedDate: string;
  /** Weston: HIGH for kit gates. */
  priority?: 'HIGH' | 'MEDIUM' | 'LOW';
}

type FetchLike = (url: string, init: any) => Promise<{ json(): Promise<any>; status?: number }>;

async function gql(token: string, query: string, variables: any, fetchImpl: FetchLike): Promise<any> {
  const res = await fetchImpl(SHIPHERO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (json?.errors) {
    throw new Error(`ShipHero work-order GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json?.data;
}

/** Build the exact `data` payload (exported so the test can assert it byte-for-byte). */
export function buildCreateWorkOrderData(input: CreateAssemblyWorkOrderInput) {
  if (!input.sku) throw new Error('work order: sku is required');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error(`work order: quantity must be a positive integer, got ${input.quantity}`);
  }
  return {
    warehouse_id: input.warehouseId,
    customer_account_id: input.customerAccountId,
    requested_date: input.requestedDate,
    type: 'ASSEMBLY',
    priority: input.priority ?? 'HIGH',
    name: input.name,
    instructions: input.instructions,
    assembly_sku: {
      sku: input.sku,
      quantity: input.quantity,
      ...(input.lotId ? { lot_id: input.lotId } : {}),
    },
  };
}

export async function createAssemblyWorkOrder(
  token: string,
  input: CreateAssemblyWorkOrderInput,
  fetchImpl: FetchLike = fetch as any
): Promise<WorkOrderRef> {
  const mutation = `mutation CreateWO($data: CreateWorkOrderInput!) {
    work_order_create(data: $data) {
      request_id
      work_order { id legacy_id status }
    }
  }`;
  const data = await gql(token, mutation, { data: buildCreateWorkOrderData(input) }, fetchImpl);
  const wo = data?.work_order_create?.work_order;
  if (!wo?.id) {
    throw new Error(`work_order_create returned no work order: ${JSON.stringify(data)}`);
  }
  return { id: wo.id, legacyId: Number(wo.legacy_id), status: wo.status };
}

export async function getWorkOrder(
  token: string,
  legacyId: number,
  fetchImpl: FetchLike = fetch as any
): Promise<WorkOrderRef & { completedAt: string | null }> {
  const query = `query GetWO($id: Int!) {
    work_order(id: $id) { data { id legacy_id status completed_at } }
  }`;
  const data = await gql(token, query, { id: legacyId }, fetchImpl);
  const wo = data?.work_order?.data;
  if (!wo?.id) throw new Error(`work_order ${legacyId} not found`);
  return { id: wo.id, legacyId: Number(wo.legacy_id), status: wo.status, completedAt: wo.completed_at ?? null };
}

export async function completeWorkOrder(
  token: string,
  legacyIdOrId: number | string,
  message: string,
  fetchImpl: FetchLike = fetch as any
): Promise<WorkOrderRef> {
  const mutation = `mutation CompleteWO($data: CompleteWorkOrderInput!) {
    work_order_complete(data: $data) { request_id work_order { id legacy_id status } }
  }`;
  const data = await gql(token, mutation, { data: { work_order_id: String(legacyIdOrId), message } }, fetchImpl);
  const wo = data?.work_order_complete?.work_order;
  if (!wo?.id) throw new Error(`work_order_complete returned no work order: ${JSON.stringify(data)}`);
  return { id: wo.id, legacyId: Number(wo.legacy_id), status: wo.status };
}

/**
 * Units of `sku` sitting in NON-PICKABLE bins on ACTIVE lots — the only stock
 * FBA can draw from (DTC pick bins are excluded by design; see
 * fba-eligible-lots-none-pickable-bins.md). This is the guard that makes the
 * 48-hour auto-complete safe: we only mark a forgotten work order COMPLETED
 * when the built kits are provably on the shelf.
 */
export async function getNonPickableBulkUnits(
  token: string,
  sku: string,
  fetchImpl: FetchLike = fetch as any
): Promise<{ bulk: number; pickable: number; rows: number }> {
  const query = `query Bulk($sku: String!) {
    item_locations(sku: $sku) { data(first: 50) { edges { node {
      quantity location { pickable } expiration_lot { is_active }
    } } } }
  }`;
  const data = await gql(token, query, { sku }, fetchImpl);
  const edges: any[] = data?.item_locations?.data?.edges || [];
  let bulk = 0, pickable = 0;
  for (const e of edges) {
    const n = e?.node || {};
    const qty = Number(n.quantity) || 0;
    const active = n.expiration_lot ? n.expiration_lot.is_active !== false : true;
    if (n.location?.pickable) pickable += qty;
    else if (active) bulk += qty;
  }
  return { bulk, pickable, rows: edges.length };
}

/**
 * Decide what the poller should do with an open work order. Pure — no I/O —
 * so the dangerous branch (auto-complete) is fully unit-tested.
 */
export type WorkOrderDecision =
  | { action: 'release' }
  | { action: 'failed'; status: string }
  | { action: 'auto_complete'; bulk: number }
  | { action: 'escalate'; bulk: number; ageHours: number }
  | { action: 'nudge'; ageHours: number }
  | { action: 'wait'; ageHours: number };

export function decideWorkOrder(args: {
  status: string;
  ageHours: number;
  kitQty: number;
  /** Provide ONLY when ageHours >= 48 (the poller does the stock read lazily). */
  bulkUnits?: number;
  lastNudgeAgeHours?: number | null;
}): WorkOrderDecision {
  const { status, ageHours, kitQty, bulkUnits, lastNudgeAgeHours } = args;
  if (status === 'COMPLETED') return { action: 'release' };
  if (WO_TERMINAL_FAILED.has(status)) return { action: 'failed', status };

  if (ageHours >= 48) {
    if (bulkUnits === undefined) throw new Error('decideWorkOrder: bulkUnits required at >= 48h');
    // STOCK-GATED. Never complete a work order whose kits are not on the shelf —
    // that would fire an Amazon plan against phantom inventory.
    if (bulkUnits >= kitQty) return { action: 'auto_complete', bulk: bulkUnits };
    const recentlyEscalated = lastNudgeAgeHours != null && lastNudgeAgeHours < 24;
    return recentlyEscalated ? { action: 'wait', ageHours } : { action: 'escalate', bulk: bulkUnits, ageHours };
  }
  if (ageHours >= 24) {
    const nudgedRecently = lastNudgeAgeHours != null && lastNudgeAgeHours < 24;
    return nudgedRecently ? { action: 'wait', ageHours } : { action: 'nudge', ageHours };
  }
  return { action: 'wait', ageHours };
}
