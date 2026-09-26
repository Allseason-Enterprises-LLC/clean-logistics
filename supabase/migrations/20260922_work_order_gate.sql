-- Kit/bundle work-order gate (2026-09-22).
-- FBA-bound transfers whose lines are kits/bundles park at status='awaiting_work_order'
-- until the ShipHero assembly work order is COMPLETED; then they flip to 'synced' and the
-- existing reconciler fires the shipment through the existing duplicate gates.
-- New status values (free-text column): 'awaiting_work_order', 'work_order_failed'.
ALTER TABLE cin7_transfer_shiphero_orders
  ADD COLUMN IF NOT EXISTS work_order_ids            text[]      NULL,
  ADD COLUMN IF NOT EXISTS work_order_status         text        NULL,
  ADD COLUMN IF NOT EXISTS work_order_created_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS work_order_completed_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS work_order_auto_completed boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_order_last_nudge_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS kit_sku                   text        NULL,
  ADD COLUMN IF NOT EXISTS kit_qty                   integer     NULL;

CREATE INDEX IF NOT EXISTS idx_bridge_awaiting_wo
  ON cin7_transfer_shiphero_orders (status)
  WHERE status = 'awaiting_work_order';
