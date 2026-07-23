-- FBA lot-split: one Amazon plan + one ShipHero wholesale order per lot.
-- Adds lot columns and replaces the active-dedup index with a lot-aware one.
--
-- Old index (20260702): (cin7_transfer_number, cin7_sku) WHERE status NOT IN (...)
-- New index: adds cin7_lot so the same transfer+sku can have one active row per lot.
-- Legacy rows have cin7_lot NULL; new code always writes a lot name.

ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS cin7_lot text;
ALTER TABLE fba_shipments ADD COLUMN IF NOT EXISTS lot_expiration date;

DROP INDEX IF EXISTS fba_shipments_active_transfer_sku_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS fba_shipments_active_transfer_sku_lot_uniq
  ON fba_shipments (cin7_transfer_number, cin7_sku, cin7_lot)
  WHERE status NOT IN ('cancelled', 'failed', 'voided');
