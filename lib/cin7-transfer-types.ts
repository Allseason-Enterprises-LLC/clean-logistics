/**
 * Types for the CIN7 → ShipHero transfer sync pipeline.
 * Isolated here so clean-logistics' other modules don't take a dep on them.
 */

export interface ShipHeroCredentials {
  accessToken: string;
  refreshToken?: string;
  warehouseId?: string;
}

export interface CIN7TransferOrderLine {
  lineId: string;
  productId?: string | null;
  sku: string;
  name: string;
  quantity: number;
  receivedQuantity?: number;
  unitCost?: number;
  notes?: string | null;
  raw?: any;
}

export interface CIN7TransferOrder {
  id: string;
  taskId?: string | null;
  transferNumber: string;
  status: string;
  sourceName?: string | null;
  sourceId?: string | null;
  destinationName?: string | null;
  destinationId?: string | null;
  transferDate?: string | null;
  lastModified?: string | null;
  notes?: string | null;
  reference?: string | null;
  lines: CIN7TransferOrderLine[];
  raw?: any;
}

export interface ShipHeroOrderAddressInput {
  first_name: string;
  last_name: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  email?: string;
  phone?: string;
}

export interface ShipHeroOrderLineItemInput {
  sku: string;
  quantity: number;
  name?: string;
  note?: string;
}

export interface ShipHeroTransferOrderInput {
  externalOrderId: string;
  orderNumber: string;
  customerAccountId?: string | null;
  profile?: 'normal' | 'internal';
  partnerLineItems: ShipHeroOrderLineItemInput[];
  shippingAddress: ShipHeroOrderAddressInput;
  tags?: string[];
  notes?: string;
  source?: string;
  reference?: string | null;
  rawTransfer?: any;
}

export interface ShipHeroOrderCreateResult {
  created: boolean;
  existingOrderId: string | null;
  orderId: string;
  orderNumber: string;
}

export interface CIN7TransferSyncOptions {
  modifiedSince?: string;
  status?: string;
  limit?: number;
  maxPages?: number;
  allowedStatuses?: string[];
  lasVegasAliases?: string[];
  shipHeroWarehouseId?: string;
}

export interface CIN7TransferSyncResult {
  success: boolean;
  fetched: number;
  filteredLasVegas: number;
  eligible: number;
  created: number;
  skipped: number;
  errors: string[];
  shipHeroWarehouse: {
    id: string;
    name: string;
  } | null;
  duration_ms: number;
  modifiedSince: string | null;
}

export interface ShipHeroTransferSyncSummary {
  shipHeroWarehouse: {
    id: string;
    name: string;
    credentials: ShipHeroCredentials;
  } | null;
}
