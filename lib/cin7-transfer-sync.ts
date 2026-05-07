import { SupabaseClient } from '@supabase/supabase-js';
import {
  CIN7TransferOrder,
  CIN7TransferOrderLine,
  CIN7TransferSyncOptions,
  CIN7TransferSyncResult,
  ShipHeroTransferOrderInput,
  ShipHeroTransferSyncSummary,
} from './cin7-transfer-types';
import { createShipHeroOrderFromCIN7Transfer } from './shiphero-orders';
import { fireFbaAutoSubmit, isFbaDestination } from './cin7-fba-handoff';
import { createShipHeroPurchaseOrder } from './shiphero-inbound';

const CIN7_BASE_URL = 'https://inventory.dearsystems.com/ExternalApi/v2';
const CIN7_ACCOUNT_ID = process.env.CIN7_ACCOUNT_ID!;
const CIN7_API_KEY = process.env.CIN7_API_KEY!;

/**
 * Assumptions centralized here because CIN7 Core / DEAR transfer-order docs
 * are inconsistent across tenants and older docs.
 *
 * Current implementation assumptions:
 * - Transfer list endpoint is GET /stockTransferList with standard DEAR v2 auth headers.
 * - Response may be wrapped in one of several list keys depending on tenant/version.
 * - Incremental sync can use ModifiedSince when available.
 * - Destination/source warehouse names may arrive under multiple field names.
 * - Line items may arrive under Lines / OrderLines / TransferOrderLines.
 *
 * If CIN7 returns a shape outside these assumptions, we fail loudly with a payload
 * snippet so Atlas/TARS can adjust mapping quickly.
 */
export const CIN7_TRANSFER_ASSUMPTIONS = {
  endpoint: '/stockTransferList',
  defaultPageSize: 100,
  lasVegasAliases: [
    'las vegas',
    'las vegas warehouse',
    'ase warehouse - vegas',
    'ase warehouse vegas',
    'vegas',
    'lv',
    'lv warehouse',
  ],
  defaultEligibleStatuses: [
    'AUTHORISED',
    'AUTHORIZED',
    'ORDERED',
    'PICKING',
    'PACKED',
    'IN TRANSIT',
    'NOT RECEIVED',
  ],
  listKeys: [
    'StockTransferList',
    'StockTransfers',
    'SaleTransferList',
    'TransferList',
    'Transfers',
    'TransferOrderList',
    'TransferOrders',
  ],
  lineKeys: ['Lines', 'OrderLines', 'TransferOrderLines', 'Products', 'Items'],
} as const;

type CIN7TransferListResponse = Record<string, any> & {
  Total?: number;
  Page?: number;
};

function assertCin7Credentials() {
  if (!CIN7_ACCOUNT_ID || !CIN7_API_KEY) {
    throw new Error('CIN7_ACCOUNT_ID and CIN7_API_KEY must be set in environment');
  }
}

async function executeCIN7Request<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  assertCin7Credentials();

  const url = new URL(`${CIN7_BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.append(key, String(value));
    }
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'api-auth-accountid': CIN7_ACCOUNT_ID,
      'api-auth-applicationkey': CIN7_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CIN7 transfer API error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Fetch a single stock transfer's full detail (including line items / products)
 * via GET /StockTransfer?TaskID=xxx
 */
export async function fetchCIN7TransferDetail(taskId: string): Promise<Record<string, any>> {
  console.log(`[CIN7 Transfer] Fetching detail for TaskID ${taskId}`);
  
  // Try multiple endpoint paths — CIN7 v2 API is inconsistent with casing
  const endpointsToTry = [
    '/stockTransfer',
    '/StockTransfer', 
    '/stockTransferOrder',
    '/StockTransferOrder',
  ];
  
  let lastError: Error | null = null;
  for (const endpoint of endpointsToTry) {
    try {
      const response = await executeCIN7Request<Record<string, any>>(endpoint, { TaskID: taskId });
      // If we got a valid object back (not HTML), return it
      if (response && typeof response === 'object') {
        console.log(`[CIN7 Transfer] Detail fetch succeeded via ${endpoint}`);
        return response;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`[CIN7 Transfer] Detail fetch failed via ${endpoint}: ${lastError.message}`);
      // Try next endpoint
    }
  }
  
  throw lastError || new Error(`All detail endpoints failed for TaskID ${taskId}`);
}

/**
 * Extract line items from a transfer detail response.
 * The detail endpoint returns product/line data under various possible keys.
 */
function extractDetailLines(detail: Record<string, any>, transferRef: string): CIN7TransferOrderLine[] {
  // Try multiple possible keys for the line items array
  const lineKeys = ['Lines', 'OrderLines', 'TransferOrderLines', 'Products', 'Items', 'Line'];
  let rawLines: any[] | null = null;
  for (const key of lineKeys) {
    if (Array.isArray(detail[key]) && detail[key].length > 0) {
      rawLines = detail[key];
      break;
    }
  }

  // Also check inside nested Order/Transfer objects
  if (!rawLines || rawLines.length === 0) {
    for (const outerKey of ['Order', 'Transfer', 'StockTransfer']) {
      if (detail[outerKey] && typeof detail[outerKey] === 'object') {
        for (const key of lineKeys) {
          if (Array.isArray(detail[outerKey][key]) && detail[outerKey][key].length > 0) {
            rawLines = detail[outerKey][key];
            break;
          }
        }
        if (rawLines) break;
      }
    }
  }

  if (!rawLines || rawLines.length === 0) {
    console.warn(`[CIN7 Transfer] No line items found in detail for ${transferRef}. Keys: ${Object.keys(detail).join(', ')}`);
    return [];
  }

  console.log(`[CIN7 Transfer] Found ${rawLines.length} line items in detail for ${transferRef}`);

  return rawLines.map((line: Record<string, any>, index: number) => {
    const sku = pickFirstString(line, ['SKU', 'Sku', 'ProductSKU', 'ProductCode', 'ItemCode']);
    const name = pickFirstString(line, ['Name', 'ProductName', 'Description']);
    const quantity = coerceNumber(line.Quantity ?? line.TransferQuantity ?? line.Qty ?? line.OrderQty ?? line.TransferQty);

    if (!sku) {
      console.warn(`[CIN7 Transfer] Detail line ${index + 1} for ${transferRef} missing SKU, skipping`);
      return null;
    }
    if (!quantity || quantity <= 0) {
      console.warn(`[CIN7 Transfer] Detail line ${index + 1} for ${transferRef} invalid qty for ${sku}, skipping`);
      return null;
    }

    return {
      lineId: pickFirstString(line, ['ID', 'LineID']) || `${transferRef}:${index + 1}`,
      productId: pickFirstString(line, ['ProductID', 'ItemID', 'ProductCode']),
      sku,
      name: name || sku,
      quantity,
      receivedQuantity: coerceNumber(line.ReceivedQuantity ?? line.ReceivedQty ?? line.QuantityReceived),
      unitCost: coerceNumber(line.Price ?? line.UnitCost ?? line.Cost ?? line.AverageCost, 0),
      notes: pickFirstString(line, ['Comment', 'Notes', 'Note']),
      raw: line,
    };
  }).filter(Boolean) as CIN7TransferOrderLine[];
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStatus(value: unknown): string {
  return normalizeString(value)?.toUpperCase() || 'UNKNOWN';
}

function normalizeLocationName(value: unknown): string {
  return normalizeString(value)?.toLowerCase() || '';
}

function coerceNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function pickFirstString(source: Record<string, any>, keys: string[]): string | null {
  for (const key of keys) {
    const value = normalizeString(source[key]);
    if (value) return value;
  }
  return null;
}

function extractTransferList(payload: CIN7TransferListResponse): any[] {
  for (const key of CIN7_TRANSFER_ASSUMPTIONS.listKeys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  if (Array.isArray((payload as any).data)) return (payload as any).data;
  if (Array.isArray(payload)) return payload as any[];

  throw new Error(
    `[CIN7 Transfer] Unsupported transfer list response shape. Expected one of ${CIN7_TRANSFER_ASSUMPTIONS.listKeys.join(', ')}. Payload keys: ${Object.keys(payload).join(', ')}`
  );
}

function extractTransferLines(raw: Record<string, any>, transferRef: string): CIN7TransferOrderLine[] {
  let rawLines: any[] | null = null;
  for (const key of CIN7_TRANSFER_ASSUMPTIONS.lineKeys) {
    if (Array.isArray(raw[key])) {
      rawLines = raw[key];
      break;
    }
  }

  if (!rawLines || rawLines.length === 0) {
    // StockTransferList endpoint does not include line items — return empty array
    // Line items can be fetched separately via /StockTransfer?TaskID=xxx if needed
    console.log(`[CIN7 Transfer] Transfer ${transferRef} has no line items in list response (expected for StockTransferList endpoint)`);
    return [];
  }

  return rawLines.map((line: Record<string, any>, index: number) => {
    const sku = pickFirstString(line, ['SKU', 'Sku', 'ProductSKU', 'ProductCode', 'ItemCode']);
    const name = pickFirstString(line, ['Name', 'ProductName', 'Description']);
    const quantity = coerceNumber(line.Quantity ?? line.TransferQuantity ?? line.Qty ?? line.OrderQty ?? line.TransferQty);

    if (!sku) {
      console.warn(`[CIN7 Transfer] Transfer ${transferRef} line ${index + 1} missing SKU, skipping`);
      return null;
    }

    if (!quantity || quantity <= 0) {
      console.warn(`[CIN7 Transfer] Transfer ${transferRef} line ${index + 1} has invalid quantity for SKU ${sku}, skipping`);
      return null;
    }

    return {
      lineId: pickFirstString(line, ['ID', 'LineID']) || `${transferRef}:${index + 1}`,
      productId: pickFirstString(line, ['ProductID', 'ItemID']),
      sku,
      name: name || sku,
      quantity,
      receivedQuantity: coerceNumber(line.ReceivedQuantity ?? line.ReceivedQty ?? line.QuantityReceived),
      unitCost: coerceNumber(line.Price ?? line.UnitCost ?? line.Cost, 0),
      notes: pickFirstString(line, ['Comment', 'Notes', 'Note']),
      raw: line,
    };
  }).filter(Boolean) as CIN7TransferOrderLine[];
}

function mapRawTransfer(raw: Record<string, any>): CIN7TransferOrder {
  const id = pickFirstString(raw, ['TaskID', 'ID', 'TransferID']);
  const transferNumber = pickFirstString(raw, ['Number', 'TransferNumber', 'StockTransferNumber', 'OrderNumber', 'DocumentNumber']);

  if (!id && !transferNumber) {
    throw new Error(`[CIN7 Transfer] Transfer record missing both ID and transfer number. Raw keys: ${Object.keys(raw).join(', ')}`);
  }

  const ref = transferNumber || id!;
  const destinationName = pickFirstString(raw, [
    'ToLocation',
    'Destination',
    'DestinationLocation',
    'DestinationLocationName',
    'ToWarehouse',
    'LocationTo',
    'WarehouseTo',
  ]);

  const sourceName = pickFirstString(raw, [
    'FromLocation',
    'Source',
    'SourceLocation',
    'SourceLocationName',
    'FromWarehouse',
    'LocationFrom',
    'WarehouseFrom',
  ]);

  if (!destinationName) {
    console.warn(`[CIN7 Transfer] Transfer ${ref} missing destination warehouse/location. Raw keys: ${Object.keys(raw).join(', ')}`);
  }

  return {
    id: id || ref,
    taskId: pickFirstString(raw, ['TaskID', 'ID']),
    transferNumber: ref,
    status: normalizeStatus(raw.Status),
    sourceName,
    sourceId: pickFirstString(raw, ['SourceID', 'SourceLocationID', 'FromLocationID', 'FromWarehouseID']),
    destinationName,
    destinationId: pickFirstString(raw, ['DestinationID', 'DestinationLocationID', 'ToLocationID', 'ToWarehouseID']),
    transferDate: pickFirstString(raw, ['DepartureDate', 'TransferDate', 'Date', 'Created', 'CreatedDate']),
    lastModified: pickFirstString(raw, ['LastModifiedOn', 'Modified', 'ModifiedOn', 'Updated']),
    notes: pickFirstString(raw, ['Note', 'Notes', 'Comment']),
    reference: pickFirstString(raw, ['Reference', 'CustomerReference', 'ExternalReference']),
    lines: extractTransferLines(raw, ref),
    raw,
  };
}

export async function fetchCIN7TransferOrdersPage(
  page = 1,
  options: Pick<CIN7TransferSyncOptions, 'modifiedSince' | 'limit' | 'status'> = {}
): Promise<CIN7TransferOrder[]> {
  const params: Record<string, string> = {
    Page: String(page),
    Limit: String(options.limit || CIN7_TRANSFER_ASSUMPTIONS.defaultPageSize),
  };

  if (options.modifiedSince) params.ModifiedSince = options.modifiedSince;
  if (options.status) params.Status = options.status;

  console.log('[CIN7 Transfer] Fetching page', page, params);

  const response = await executeCIN7Request<CIN7TransferListResponse>(
    CIN7_TRANSFER_ASSUMPTIONS.endpoint,
    params
  );

  const rawTransfers = extractTransferList(response);
  return rawTransfers.map((raw) => mapRawTransfer(raw));
}

export async function fetchCIN7TransferOrders(
  options: Pick<CIN7TransferSyncOptions, 'modifiedSince' | 'limit' | 'status' | 'maxPages'> = {}
): Promise<CIN7TransferOrder[]> {
  const pageSize = options.limit || CIN7_TRANSFER_ASSUMPTIONS.defaultPageSize;
  const maxPages = options.maxPages || 20;
  const transfers: CIN7TransferOrder[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const pageResults = await fetchCIN7TransferOrdersPage(page, {
      modifiedSince: options.modifiedSince,
      limit: pageSize,
      status: options.status,
    });

    transfers.push(...pageResults);

    if (pageResults.length < pageSize) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return transfers;
}

export function isLasVegasTransfer(
  transfer: Pick<CIN7TransferOrder, 'destinationName' | 'sourceName'>,
  aliases: string[] = [...CIN7_TRANSFER_ASSUMPTIONS.lasVegasAliases]
): boolean {
  // Match on either source OR destination containing Vegas
  // Real data shows transfers go FROM ASE Warehouse - Vegas TO Amazon FBA Warehouse
  const destination = normalizeLocationName(transfer.destinationName);
  const source = normalizeLocationName(transfer.sourceName);
  return aliases.some((alias) => {
    const lower = alias.toLowerCase();
    return destination.includes(lower) || source.includes(lower);
  });
}

// Keep backward compat alias
export const isLasVegasTransferDestination = isLasVegasTransfer;

/**
 * Returns true when a CIN7 transfer is an INBOUND to the Las Vegas warehouse
 * (i.e. manufacturer/3PL → LV). These should become ShipHero Purchase Orders,
 * not outbound Orders.
 *
 * Inbound = destination is Vegas AND source is NOT Amazon/FBA.
 * Outbound = destination is Amazon/FBA (handled by FBA pipeline).
 */
export function isInboundToLasVegas(
  transfer: Pick<CIN7TransferOrder, 'destinationName' | 'sourceName'>,
  lasVegasAliases: readonly string[] = CIN7_TRANSFER_ASSUMPTIONS.lasVegasAliases,
): boolean {
  const destination = normalizeLocationName(transfer.destinationName);
  const isDestinationLV = lasVegasAliases.some((alias) => destination.includes(alias.toLowerCase()));
  const isFBA = isFbaDestination(transfer.destinationName);
  return isDestinationLV && !isFBA;
}

function isEligibleTransferStatus(status: string, allowedStatuses: string[]): boolean {
  return allowedStatuses.includes(normalizeStatus(status));
}

function buildShipHeroTransferOrderInput(transfer: CIN7TransferOrder): ShipHeroTransferOrderInput {
  const externalOrderId = `cin7-transfer:${transfer.id}`;
  const orderNumber = `CIN7-${transfer.transferNumber}`;
  const notes = [
    'CIN7 transfer order for Amazon kitting.',
    `Transfer #: ${transfer.transferNumber}`,
    transfer.sourceName ? `Source: ${transfer.sourceName}` : null,
    transfer.destinationName ? `Destination: ${transfer.destinationName}` : null,
    transfer.reference ? `Reference: ${transfer.reference}` : null,
    transfer.notes || null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    externalOrderId,
    orderNumber,
    customerAccountId: null,
    profile: 'normal',
    partnerLineItems: transfer.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      name: line.name,
      note: line.notes || undefined,
    })),
    shippingAddress: {
      first_name: 'ASE',
      last_name: 'Warehouse',
      company: 'Allseason Enterprises LLC',
      address1: '6425 S Jones Blvd',
      address2: 'Suite 101',
      city: 'Las Vegas',
      state: 'NV',
      country: 'US',
      zip: '89118',
    },
    tags: ['cin7-transfer', 'amazon-kit', 'las-vegas'],
    notes,
    source: 'cin7-transfer-sync',
    reference: transfer.transferNumber,
    rawTransfer: transfer.raw,
  };
}

async function resolveShipHeroLasVegasWarehouse(
  supabase: SupabaseClient,
  explicitWarehouseId?: string
): Promise<ShipHeroTransferSyncSummary['shipHeroWarehouse']> {
  if (explicitWarehouseId) {
    const { data, error } = await supabase
      .from('warehouses')
      .select('id, name, provider, api_credentials')
      .eq('id', explicitWarehouseId)
      .eq('provider', 'shiphero')
      .single();

    if (error || !data) {
      throw new Error(`ShipHero warehouse ${explicitWarehouseId} not found: ${error?.message || 'missing row'}`);
    }

    return {
      id: data.id,
      name: data.name,
      credentials: data.api_credentials,
    };
  }

  const { data: warehouses, error } = await supabase
    .from('warehouses')
    .select('id, name, provider, api_credentials, sync_enabled, is_active')
    .eq('provider', 'shiphero');

  if (error) {
    throw new Error(`Failed to fetch ShipHero warehouses: ${error.message}`);
  }

  // Prefer the Clean Nutra (Las Vegas) warehouse by exact ID to avoid picking ClearShip
  const CLEAN_NUTRA_LV_WAREHOUSE_ID = '22e17170-af72-4bf8-b77c-d73c86b06765';
  const match = (warehouses || []).find((w: any) => w.id === CLEAN_NUTRA_LV_WAREHOUSE_ID)
    || (warehouses || []).find((warehouse: any) => {
      const haystack = `${warehouse.name || ''} ${JSON.stringify(warehouse.api_credentials || {})}`.toLowerCase();
      return haystack.includes('las vegas') || haystack.includes('vegas') || haystack.includes('lv');
    });

  if (!match) {
    throw new Error('Could not resolve Las Vegas ShipHero warehouse from warehouses table. Pass shipHeroWarehouseId explicitly or configure a Las Vegas ShipHero warehouse record.');
  }

  return {
    id: match.id,
    name: match.name,
    credentials: match.api_credentials,
  };
}

export async function syncCIN7LasVegasTransferOrders(
  supabase: SupabaseClient,
  options: CIN7TransferSyncOptions = {}
): Promise<CIN7TransferSyncResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let fetched = 0;
  let filteredLasVegas = 0;
  let eligible = 0;
  let created = 0;
  let skipped = 0;

  try {
    const allowedStatuses = (options.allowedStatuses || [...CIN7_TRANSFER_ASSUMPTIONS.defaultEligibleStatuses]).map((s) => normalizeStatus(s));
    const shipHeroWarehouse = await resolveShipHeroLasVegasWarehouse(supabase, options.shipHeroWarehouseId);
    if (!shipHeroWarehouse) {
      throw new Error('Failed to resolve ShipHero Las Vegas warehouse');
    }

    const transfers = await fetchCIN7TransferOrders({
      modifiedSince: options.modifiedSince,
      limit: options.limit,
      maxPages: options.maxPages,
      status: options.status,
    });

    fetched = transfers.length;

    const lasVegasTransfers = transfers.filter((transfer) =>
      isLasVegasTransferDestination(transfer, options.lasVegasAliases || [...CIN7_TRANSFER_ASSUMPTIONS.lasVegasAliases])
    );
    filteredLasVegas = lasVegasTransfers.length;

    for (const transfer of lasVegasTransfers) {
      if (!isEligibleTransferStatus(transfer.status, allowedStatuses)) {
        skipped++;
        console.log(`[CIN7 Transfer] Skipping ${transfer.transferNumber} due to status ${transfer.status}`);
        continue;
      }

      eligible++;

      try {
        // Fetch transfer detail to get line items (SKUs + quantities)
        if (transfer.id && transfer.lines.length === 0) {
          console.log(`[CIN7 Transfer] Fetching detail for ${transfer.transferNumber} (TaskID: ${transfer.id})`);
          try {
            const detail = await fetchCIN7TransferDetail(transfer.id);
            const detailLines = extractDetailLines(detail, transfer.transferNumber);
            if (detailLines.length > 0) {
              transfer.lines = detailLines;
              console.log(`[CIN7 Transfer] Got ${detailLines.length} line items for ${transfer.transferNumber}`);
            } else {
              console.warn(`[CIN7 Transfer] No line items from detail for ${transfer.transferNumber}`);
            }
            // Small delay to avoid rate limiting
            await new Promise((resolve) => setTimeout(resolve, 200));
          } catch (detailError) {
            const msg = detailError instanceof Error ? detailError.message : 'Unknown';
            console.error(`[CIN7 Transfer] DETAIL FETCH FAILED for ${transfer.transferNumber}: ${msg}`);
            // DO NOT create order without line items — skip and retry next cycle
            errors.push(`Transfer ${transfer.transferNumber}: Detail fetch failed (no line items) - ${msg}`);
            skipped++;
            continue;
          }
        }

        // Skip if still no line items after detail fetch
        if (transfer.lines.length === 0) {
          console.warn(`[CIN7 Transfer] Skipping ${transfer.transferNumber} — no line items available`);
          errors.push(`Transfer ${transfer.transferNumber}: Skipped — no line items available after detail fetch`);
          skipped++;
          continue;
        }

        // Route based on transfer direction:
        //   - Destination = LV warehouse (inbound from manufacturer/3PL) → ShipHero Purchase Order
        //   - Destination = Amazon FBA (outbound from LV)                → ShipHero Order + FBA handoff
        const lasVegasAliases = options.lasVegasAliases || [...CIN7_TRANSFER_ASSUMPTIONS.lasVegasAliases];
        if (isInboundToLasVegas(transfer, lasVegasAliases)) {
          // INBOUND: create a ShipHero Purchase Order so warehouse can receive against it
          const poNumber = `CIN7-${transfer.transferNumber}`;
          console.log(`[CIN7 Transfer] Creating ShipHero PO ${poNumber} (inbound to LV from ${transfer.sourceName || 'unknown'})`);

          const poResult = await createShipHeroPurchaseOrder(
            shipHeroWarehouse.credentials.accessToken,
            {
              poNumber,
              warehouseId: 'V2FyZWhvdXNlOjEzNTg3Mg==', // Clean Nutra LV warehouse (legacy 135872)
              customerAccountId: '95145',
              vendorName: transfer.sourceName || undefined,
              items: transfer.lines.map((line) => ({
                sku: line.sku,
                quantity: line.quantity,
                productName: line.name,
                pricePerUnit: line.unitCost ?? 0,
              })),
              note: [
                `CIN7 inbound transfer ${transfer.transferNumber}`,
                transfer.sourceName ? `From: ${transfer.sourceName}` : null,
                transfer.destinationName ? `To: ${transfer.destinationName}` : null,
                transfer.reference ? `Ref: ${transfer.reference}` : null,
              ].filter(Boolean).join('\n'),
            },
          );

          console.log(`[CIN7 Transfer] PO created: ${poResult.po_number} (${poResult.purchase_order_id})`);

          // Persist to bridge table so the sync is idempotent on re-runs
          const now = new Date().toISOString();
          await supabase.from('cin7_transfer_shiphero_orders').upsert(
            {
              cin7_transfer_id: transfer.id,
              cin7_transfer_number: transfer.transferNumber,
              cin7_destination: transfer.destinationName || '',
              cin7_source: transfer.sourceName || null,
              warehouse_provider: 'shiphero',
              shiphero_order_id: poResult.purchase_order_id,
              shiphero_order_number: poResult.po_number,
              status: 'synced',
              sync_attempts: 1,
              last_attempt_at: now,
              synced_at: now,
              request_payload: { type: 'purchase_order', poNumber, items: transfer.lines.map(l => ({ sku: l.sku, quantity: l.quantity })), rawTransfer: transfer.raw },
              response_payload: poResult,
              payload_snapshot: transfer.raw || {},
              error_message: null,
              last_error_at: null,
            },
            { onConflict: 'cin7_transfer_id,cin7_destination', ignoreDuplicates: false }
          );

          created++;
        } else {
          // OUTBOUND (→ FBA or unknown destination): create a ShipHero Order
          const result = await createShipHeroOrderFromCIN7Transfer({
            credentials: shipHeroWarehouse.credentials,
            warehouseName: shipHeroWarehouse.name,
            input: buildShipHeroTransferOrderInput(transfer),
          });

          if (result.created || result.existingOrderId) {
            created++;
          } else {
            skipped++;
          }

          // If FBA-bound and freshly created, fire the clean-logistics FBA pipeline
          // immediately — eliminates the ~20-min delay to Amazon shipment creation.
          if (result.created && isFbaDestination(transfer.destinationName)) {
            void fireFbaAutoSubmit({
              cin7TransferNumber: transfer.transferNumber,
              items: transfer.lines.map((line) => ({
                sku: line.sku,
                quantity: line.quantity,
              })),
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Transfer ${transfer.transferNumber}: ${message}`);
      }
    }

    return {
      success: errors.length === 0,
      fetched,
      filteredLasVegas,
      eligible,
      created,
      skipped,
      errors,
      shipHeroWarehouse: {
        id: shipHeroWarehouse.id,
        name: shipHeroWarehouse.name,
      },
      duration_ms: Date.now() - startedAt,
      modifiedSince: options.modifiedSince || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    errors.unshift(message);

    return {
      success: false,
      fetched,
      filteredLasVegas,
      eligible,
      created,
      skipped,
      errors,
      shipHeroWarehouse: null,
      duration_ms: Date.now() - startedAt,
      modifiedSince: options.modifiedSince || null,
    };
  }
}
