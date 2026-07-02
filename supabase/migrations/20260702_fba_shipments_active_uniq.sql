-- Prevent duplicate Amazon FBA inbound plans for the same (transfer, sku).
--
-- Historical race: api/fba/auto-submit.ts did a SELECT-then-INSERT idempotency
-- check with Amazon's createInboundPlan call sitting inside the window. Two
-- concurrent invocations (client double-tap, reconciler re-fire, Vercel
-- timeout retry) could both pass the SELECT and both create Amazon plans.
-- Concrete incident: TR-00203 CN-POW-WMNSCREATIORA-30SV, 2026-07-02, two
-- plans (wf961ae669… + wfb003f188…) created 7s apart.
--
-- Fix: partial unique index over active statuses. Combined with a code change
-- that INSERTs the draft row BEFORE calling Amazon, this makes the guard
-- atomic (Postgres enforces "at most one active row per transfer+sku").

CREATE UNIQUE INDEX IF NOT EXISTS fba_shipments_active_transfer_sku_uniq
  ON fba_shipments (cin7_transfer_number, cin7_sku)
  WHERE status NOT IN ('cancelled', 'failed', 'voided');
