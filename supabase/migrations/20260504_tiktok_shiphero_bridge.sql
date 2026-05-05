-- TikTok → ShipHero Order Bridge
--
-- Tracks TikTok Shop orders that have been imported into Clean Nutra's ShipHero account.
-- One row per TikTok order we pull. Idempotency is enforced via unique constraint on
-- (tiktok_order_id).
--
-- Lifecycle:
--   1. Cron job polls TikTok for AWAITING_SHIPMENT orders
--   2. For each matching Clean Nutra SKU order we don't already have, INSERT with
--      status='imported' and shiphero_order_id filled
--   3. ShipHero ships. shipment_update webhook fires → we UPDATE to status='shipped'
--      and POST tracking back to TikTok
--   4. On successful tracking post-back → status='tracking_confirmed'
--
-- Status values:
--   - 'skipped'             → TikTok order had no Clean Nutra SKUs (we still log for audit)
--   - 'imported'            → order created in ShipHero, awaiting ship
--   - 'shipped'             → ShipHero webhook received, tracking posted to TikTok
--   - 'tracking_confirmed'  → TikTok accepted tracking post-back
--   - 'error'               → something broke, see error_message

CREATE TABLE IF NOT EXISTS tiktok_shiphero_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- TikTok side
  tiktok_order_id TEXT NOT NULL UNIQUE,
  tiktok_order_number TEXT,
  tiktok_shop_id  TEXT,

  -- ShipHero side (nullable for 'skipped' rows)
  shiphero_order_id      TEXT,
  shiphero_order_number  TEXT,

  -- Order content snapshot
  skus              JSONB,           -- [{sku, qty, matched_pattern}]
  matched_patterns  TEXT[],          -- which patterns matched (for audit)

  -- Fulfillment
  carrier           TEXT,            -- mapped to TikTok enum on post-back
  tracking_number   TEXT,
  shipped_at        TIMESTAMPTZ,
  tracking_posted_at TIMESTAMPTZ,

  -- State machine
  status            TEXT NOT NULL DEFAULT 'imported'
                    CHECK (status IN ('skipped','imported','shipped','tracking_confirmed','error')),
  error_message     TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tiktok_shiphero_status
  ON tiktok_shiphero_orders(status);

CREATE INDEX IF NOT EXISTS idx_tiktok_shiphero_shiphero_id
  ON tiktok_shiphero_orders(shiphero_order_id)
  WHERE shiphero_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tiktok_shiphero_created
  ON tiktok_shiphero_orders(created_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_tiktok_shiphero_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tiktok_shiphero_orders_updated_at ON tiktok_shiphero_orders;
CREATE TRIGGER trg_tiktok_shiphero_orders_updated_at
  BEFORE UPDATE ON tiktok_shiphero_orders
  FOR EACH ROW EXECUTE FUNCTION update_tiktok_shiphero_orders_updated_at();
