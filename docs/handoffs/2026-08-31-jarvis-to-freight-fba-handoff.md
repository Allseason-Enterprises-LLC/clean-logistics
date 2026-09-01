# Jarvis → Freight: FBA Pipeline Handoff (Final)

**Date:** 2026-08-31
**From:** Jarvis
**To:** Freight
**Status:** FBA shipments are YOUR lane now. This doc covers everything that changed in the last 48h, what you own, and what you must verify.

---

## 1. Telegram notifications now go through YOUR bot — verify this keeps working

The pipeline's automated label posts to **"Clean Nutra FBA Shipments 🚚"** (chat id `-5244576221`) were repointed from Jarvis's bot to yours (`8617148871`, `@freightaiagentbm_bot`) on 2026-08-31:

- `clean-logistics/.env` → `TELEGRAM_BOT_TOKEN` swapped locally (for scripts that read .env)
- Vercel production env `TELEGRAM_BOT_TOKEN` overridden + redeployed (prod deployment `anazqqoxu`)
- **Verified working**: 3 relabel posts for TR-00368 (lots 2507092A, 2505065A, 2507092B) landed with `telegramSent: true` after the swap

**Your ongoing responsibility:**
- Your bot MUST stay a member of that group. If it's ever removed, posts silently fail — the relabel/auto-submit responses will show `telegramSent: false` but nothing alerts. Check `telegramSent` in any manual run's response.
- The gateway config (`~/.hermes/profiles/freight/config.yaml`) uses the same token for your chat sessions. One token, two jobs: don't rotate it without updating BOTH the Vercel env (`npx vercel env add TELEGRAM_BOT_TOKEN production --force` + redeploy) and your gateway config.
- `TELEGRAM_FBA_CHAT_ID=-5244576221` is unchanged.
- Channel rules: **shipment notifications only**. No engineering chatter, no recovery/status alerts, no dev back-and-forth. (Jarvis got removed from the group for exactly this. Learn from his mistakes.)

**Vercel CLI gotcha on this box:** plain `vercel` on PATH is a broken Python shim that prompts for sudo. Use `npx vercel ...` from the repo root. `env rm` can't confirm non-interactively — use `env add ... --force` to override instead.

## 2. New this week: auto-recovery for frozen drafts (commits `3856de2`, `6b67038`)

TR-00370 (2026-08-31) exposed a recoverable crash mode: auto-submit dies **after confirmPlacementOption but before confirmTransportationOptions**. Plan is ACTIVE, shipments exist with real FBA ids, but v0 getLabels 400s with *"Carrier estimate is not yet confirmed"* — and the row freezes as a draft.

The reconciler (`lib/fba-reconciler.ts`) now tries `lib/fba-transport-recovery.ts` on every frozen draft **before** flagging `needs_review`:

1. Verifies plan ACTIVE + placement ACCEPTED + all shipments have confirmation ids (any mismatch → falls through to needs_review, untouched behavior)
2. Probes v0 getLabels. If blocked on carrier estimate: lists transport options per shipment, **regenerates them if any shipment's partnered quote expired** (quotes DO expire — TR-00370's GYR2 split lost its option), picks cheapest partnered SPD, confirms delivery windows where preconditioned, confirms transportation
3. Binds `amazon_shipment_ids` + `amazon_internal_shipment_ids` to the row (`status='plan_created'`, defends the dedup slot)
4. Fires `/api/fba/relabel` (uploads PDFs → Storage, attaches to ShipHero, posts to Telegram), then marks `labels_ready`

**Safety properties (do not weaken these):** never creates plans, never cancels anything, never frees the (transfer,sku,lot) dedup slot. Every Amazon call is a read or an idempotent confirmation on the EXISTING plan. Anything not provably this failure mode falls through to `needs_review` exactly as before.

**Proven in production already:** auto-recovered all 3 TR-00368 lots (11 shipments total) on its first cron tick.

### Known sharp edges in/around this code
- **`readyToShipWindow` must be full ISO timestamps** (`2026-09-01T17:00:00Z`). Date-only values 400 with a MISLEADING error about "pallet and freight info not provided".
- **SpApiError puts the real Amazon error in `.details`, not `.message`** — `.message` is always the generic "Amazon SP-API error (HTTP 400)". Match error text against `JSON.stringify(err.details)`.
- **Self-calls must use the canonical prod URL** (`https://shiphero-shipstation-bridge.vercel.app`), never `VERCEL_URL` — deployment-specific hosts are behind deployment protection and 401.
- **Recovery posts NOTHING to Telegram itself** — the relabel step's normal label post is the only channel message. Keep it that way.
- **Relabel does not set `labels_ready`/`labels_url`** on the row — recovery does it, but if you ever run relabel manually, PATCH the row yourself afterward.
- The reconciler cron (`api/cron/reconcile-fba-handoffs.ts`, every 15 min) is at `maxDuration: 300` now for the operation polling.

## 3. TR-00370 state (fully resolved, for the record)

- Lot 6E0224 (2,400 units): labels were already good; row bound `labels_ready`, ids FBA19NG53FVZ/6HYWZ/70PNM/7HDPD/7PYSJ
- Lot 6E0225 (16,680 units, 556 boxes): manually recovered (this incident birthed the auto-recovery). 5 splits, partnered UPS Ground confirmed, labels in Storage under `TR-00370/6E0225/`, attached to ShipHero, posted to channel. Row `labels_ready`, ids FBA19NG6J04P/71MZ0/4JSHL/5LWD5/415ZK
- Runbook for the manual version of this recovery: skill reference `2026-08-15-duplicate-fba-shipments-incident.md`, section "Crashed after confirmPlacement, before confirmTransportation"

## 4. TR-00368 state (fully resolved)

All 3 lots auto-recovered + relabeled + posted (posts re-fired after the token swap so the channel has them from your bot). Rows `labels_ready` with `labels_url` set. No action needed.

## 5. What you must verify going forward (your checklist)

- [ ] Next organic FBA transfer: confirm the label post appears in the channel from your bot, unprompted
- [ ] Any manual relabel/auto-submit: check `telegramSent: true` in the response — false means your bot lost group membership or the token drifted
- [ ] If a frozen-draft `needs_review` alert still appears (Telegram alert only fires for NON-recoverable frozen drafts now): follow the needs_review runbook in the skill — recovery already ruled out the easy case, so it's a real crashed-before-create or bind-required situation
- [ ] Watch the first few auto-recoveries in Vercel logs (`[reconciler] auto-recovered frozen draft ...`) to build confidence in the path

## 6. Standing context you inherit

- Everything in the `clean-nutra-inventory-pipeline` skill (you already have it) — the incident references are the real knowledge base; load them before acting
- Manual-fire → manual-bind is STANDARD (persist gap on all manual auto-submit runs): bind ids from the HTTP response or storage filenames after every manual fire
- Never blind cancel+re-fire a frozen draft — Amazon-side reality must be checked first (v0 shipments, ALL statuses)
- Warehouse ground truth beats every API/DB check — before regenerating labels during recovery, ask the channel what's physically on boxes
- Test on 1 before any bulk operation
- Supabase: label URL base is `$SUPABASE_URL/storage/v1/object/public/shipment-labels/TR-XXXXX[/LOT]/` — read SUPABASE_URL from .env, verify links with curl before posting

Godspeed. — Jarvis
