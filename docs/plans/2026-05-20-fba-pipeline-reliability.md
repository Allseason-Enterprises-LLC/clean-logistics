# FBA Pipeline Reliability — Implementation Plan

**Date:** 2026-05-20
**Trigger:** Three CIN7 Transfer Orders (TR-00051, TR-00052, TR-00053) created after 9pm 2026-05-19 reached ShipHero successfully but never produced Amazon FBA shipments, labels, ShipHero attachments, or Telegram notifications. The original TR-00050 the night before had similar problems plus accidental duplicate plan creation.

---

## Audit Findings (Phase 1 — Evidence Gathered)

### Confirmed state of the 4 affected transfers

| Transfer | ShipHero Order | Bridge Status | Amazon Plan | fba_shipments | Labels | Telegram |
|---|---|---|---|---|---|---|
| TR-00050 | CIN7-TR-00050 | synced 01:00 | 2 plans @ 02:22, 02:24 (after Jarvis redeploy) | none written | only via manual runs | only manual |
| TR-00051 | CIN7-TR-00051 | synced 04:20 | **none** | **none** | **none** | **none** |
| TR-00052 | CIN7-TR-00052 | synced 04:40 | **none** | **none** | **none** | **none** |
| TR-00053 | CIN7-TR-00053 | synced 04:40 | **none** | **none** | **none** | **none** |

### Root cause (proved with deployed `/api/fba/debug-env` endpoint)

**The Supabase edge function `amazon-sp-api` was returning HTTP 404 NOT_FOUND when called from Vercel (us-east-1 IAD edge), while returning HTTP 200 OK when called from other regions.**

Response headers from the failing call:
```
sb-error-code: NOT_FOUND
sb-gateway-version: 1
sb-project-ref: gvrwkjmmgohtovtcyjiu
x-sb-edge-region: us-east-1
x-served-by: supabase-edge-runtime
```

This means the edge function deployment **did not propagate to the us-east-1 edge region** where Vercel functions run. After a forced redeploy via `npx supabase functions deploy amazon-sp-api --project-ref gvrwkjmmgohtovtcyjiu --no-verify-jwt`, the function became reachable again from Vercel — verified with HTTP 200 response.

This is the THIRD time this has happened (May 13, May 19 morning, May 19 night). The edge function is not durable across regions.

### Secondary issues found during audit

1. **No idempotency check in `auto-submit.ts`** — every call creates a fresh Amazon inbound plan even if one already exists for the same transfer+SKU. This is how I created the duplicate plans for TR-00050 (Gluco Tone Drops × 2, Gluco Defend × 2).

2. **No monitoring/alerting** — the only way we discovered the broken FBA pipeline was the user noticing missing Telegram notifications hours later. No alert fired.

3. **Fire-and-forget handoff with no retry** — `fireFbaAutoSubmit` aborts after 8 seconds (`controller.abort(), 8_000`) and the work continues on Vercel, but if Vercel returns an error there's no retry path. `result.created` returns `false` on every subsequent cron run because the bridge record exists, so the FBA handoff never re-fires.

4. **Edge function regional propagation is unreliable** — known to disappear from `us-east-1` periodically. No alert exists for this.

5. **`fba_shipments` table is missing `cin7_transfer_number` and `cin7_sku` columns** — would be needed for clean idempotency lookups.

---

## Implementation Plan

### Goal

Build a self-healing FBA pipeline that:
- Catches edge function regional failures within 5 minutes (not hours)
- Retries failed FBA handoffs automatically without manual intervention
- Refuses to create duplicate Amazon plans for the same transfer+SKU
- Surfaces failures in Telegram instead of silently failing

### Tech Stack
- TypeScript on Vercel (clean-logistics repo)
- Supabase Postgres + Edge Functions
- Existing Telegram bot (`8350576274:...` to chat `-5244576221`)

---

### Task 1: Health check probe for `amazon-sp-api` edge function

**Objective:** Detect within 5 min when the edge function becomes unreachable from Vercel, and auto-redeploy or alert.

**Files:**
- Create: `api/cron/check-amazon-proxy-health.ts`
- Modify: `vercel.json` — add cron schedule

**Code:**
```ts
// api/cron/check-amazon-proxy-health.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callAmazonSpApi } from '../../lib/amazon-sp-api-client';

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Lightweight probe — list 1 inbound plan
    const r = await callAmazonSpApi<any>({
      method: 'GET',
      path: '/inbound/fba/2024-03-20/inboundPlans',
      query: { pageSize: 1 },
    });
    if (r.status === 200) {
      return res.status(200).json({ healthy: true });
    }
    throw new Error(`Unexpected status ${r.status}`);
  } catch (err: any) {
    // Send Telegram alert
    const msg = `🚨 amazon-sp-api edge function unreachable from Vercel\n\n` +
                `Error: ${err?.message || String(err)}\n` +
                `Status: ${err?.status || '?'}\n` +
                `Action: Run \`npx supabase functions deploy amazon-sp-api --project-ref gvrwkjmmgohtovtcyjiu --no-verify-jwt\``;

    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_FBA_CHAT_ID;
      if (token && chatId) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: msg }),
        });
      }
    } catch {}

    return res.status(503).json({ healthy: false, error: err?.message });
  }
}
```

**vercel.json addition:**
```json
{
  "path": "/api/cron/check-amazon-proxy-health",
  "schedule": "*/5 * * * *"
}
```

**Verification:**
1. Deploy and call manually: `curl ... /api/cron/check-amazon-proxy-health` → `{healthy:true}`
2. Manually break edge function (rename in Supabase dashboard temporarily) → next cron fires Telegram alert within 5 min

---

### Task 2: Reconciler cron for stuck CIN7 transfers

**Objective:** Find ShipHero orders that should have created Amazon plans but didn't, and re-fire FBA handoff for them.

**Files:**
- Create: `lib/fba-reconciler.ts`
- Create: `api/cron/reconcile-fba-handoffs.ts`
- Modify: `vercel.json` — add schedule

**Logic:**
1. Query `cin7_transfer_shiphero_orders` where:
   - `status='synced'`
   - `cin7_destination ILIKE '%amazon%'` OR `ILIKE '%fba%'`
   - `synced_at > now() - interval '24 hours'`
2. For each, check `fba_shipments` for any record matching the transfer number
3. If none exists, re-fire `fireFbaAutoSubmit` with the original transfer line items
4. Mark the bridge row with a `last_fba_handoff_at` timestamp to throttle retries (max 1/hour per transfer)
5. Cap at 3 retries per transfer; after that, send Telegram alert with manual recovery instructions

**Schedule:** `*/15 * * * *` (every 15 min)

**Schema change:**
```sql
ALTER TABLE cin7_transfer_shiphero_orders
  ADD COLUMN IF NOT EXISTS last_fba_handoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS fba_handoff_attempts int DEFAULT 0;
```

**Verification:** Manually mark the bridge row for an existing successful transfer as `last_fba_handoff_at=null`, then trigger cron — confirm it re-fires.

---

### Task 3: Idempotency check in `auto-submit.ts`

**Objective:** Prevent duplicate Amazon plans by checking for existing plans before calling `createInboundPlan`.

**Files:**
- Modify: `api/fba/auto-submit.ts`
- Modify: `lib/fba-post-process.ts` — write `cin7_transfer_number` + `cin7_sku` columns

**Schema change:**
```sql
ALTER TABLE fba_shipments
  ADD COLUMN IF NOT EXISTS cin7_transfer_number text,
  ADD COLUMN IF NOT EXISTS cin7_sku text;

CREATE INDEX IF NOT EXISTS idx_fba_shipments_transfer_sku
  ON fba_shipments(cin7_transfer_number, cin7_sku)
  WHERE status NOT IN ('failed','voided','cancelled');
```

**Code change in `auto-submit.ts`:**
Before each SKU loop iteration, query Supabase:
```ts
const { data: existing } = await supabase
  .from('fba_shipments')
  .select('id, status, plan_id, amazon_shipment_ids')
  .eq('cin7_transfer_number', cin7_transfer_number)
  .eq('cin7_sku', item.sku)
  .not('status', 'in', '("failed","voided","cancelled")')
  .maybeSingle();

if (existing) {
  results.push({
    sku: item.sku,
    status: 'skipped',
    reason: `Already processed — plan ${existing.plan_id}, ${existing.amazon_shipment_ids?.length || 0} shipments`,
  });
  continue;
}
```

**Code change in `fba-post-process.ts`:**
When updating `fba_shipments`, include `cin7_transfer_number` and `cin7_sku` in the upsert payload.

**Verification:** Call `auto-submit` twice for the same transfer+SKU — second call should return `status: 'skipped'` and not create a new Amazon plan.

---

### Task 4: Manual recovery endpoint for the 3 stuck transfers

**Objective:** Re-fire FBA for TR-00051, TR-00052, TR-00053 right now (before the new code is deployed).

**Action (immediate, not code):**
```bash
# After confirming edge function is healthy via Task 1
for tr in TR-00051 TR-00052 TR-00053; do
  curl -X POST "https://shiphero-shipstation-bridge.vercel.app/api/fba/auto-submit" \
    -H "Authorization: Bearer $CRON_SECRET" \
    -H "Content-Type: application/json" \
    -d "$(get_payload_for $tr)"  # SKU + quantity from bridge row
  sleep 60
done
```

I'll execute this manually once Task 1 is deployed and confirms healthy state.

---

### Task 5: Remove temporary debug endpoint

**Files:**
- Delete: `api/fba/debug-env.ts`

After all above tasks are verified working.

---

## Sequencing

1. **Task 1** (health check) — DEPLOY FIRST so we know if edge function dies again during the rest of the work
2. **Task 3** (idempotency in auto-submit) — second, to prevent duplicates when we manually re-fire
3. **Task 4** (manual recovery for TR-00051/52/53) — third, once 1 and 3 are deployed
4. **Task 2** (reconciler cron) — fourth, longer-term self-healing
5. **Task 5** (cleanup) — last

## Acceptance Criteria

- [ ] Health check fires Telegram alert within 5 min when edge function 404s
- [ ] Reconciler picks up missing FBA records and re-fires within 15 min
- [ ] Re-running `auto-submit` for the same transfer+SKU returns `skipped`, doesn't hit Amazon
- [ ] TR-00051, TR-00052, TR-00053 successfully complete (Amazon plans created, labels attached to ShipHero, Telegram notification sent)
- [ ] Manual test: rename edge function in Supabase → health alert fires; rename back → next reconciler run picks up unfinished transfer
