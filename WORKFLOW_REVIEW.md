# WORKFLOW_REVIEW.md — Full-Picture Workflow Audit (evidence-based)

**Date:** 2026-07-11 · Companion: `docs/arch/13-external-deps.md` (full dependency table)

## Why "verified" workflows kept failing on first real use

Every prior review verified **code**: given an input, the functions do the right thing.
But a workflow crosses boundaries code review cannot see:

1. **Inbound callbacks** — ShipStation/Stripe/Resend must be TOLD to call us, in *their*
   dashboards. Nothing in this repo can register or verify that.
2. **First-use paths** — dist invoices, LF portal orders: correct code, never exercised.
3. **Silent failure by design** — a webhook that never arrives produces *nothing*: no
   error, no log, no symptom except "the thing I expected didn't happen."

**The pattern in one sentence: every lane where WE call THEM is proven and works;
every lane where THEY call US has never worked, and at least one (ShipStation) is
confirmed misconfigured.**

---

## The Workflow Ledger

Status legend: ✅ **PROVEN** (worked in your real use) · 📄 **CODE-ONLY** (verified in
code, never real-world) · ❌ **BROKEN** (confirmed failing) · 🔧 **STUB** (by design,
in TODO)

### A. Customer acquisition → order → invoice draft — ✅ PROVEN END TO END
Blast w/ tokens → link opens portal (pricing live) → orders submitted (purpl/LF/dual/
sample, correct pairing) → unmatched matching → confirm → draft invoice(s) + inventory
deduction + Wix pull record. Every step exercised by you with real customers.
Residual papercuts (Tier-2/3 backlog): match-twice friction, pay-link race banner.

### B. Invoice → send → customer PAYS → auto-marked paid — ⚠️ half proven
| Step | Status |
|---|---|
| Preview/send (all 4 types incl. dist) | ✅ PROVEN (dist sent to a real customer) |
| Pay Online button = real invoice-bound link | ✅ PROVEN (button renders only on success) |
| Customer completes payment → Stripe webhook → paid | ✅ PROVEN — owner tested with a $1 invoice (INV-0019, auto-marked paid). |

### C. Ship lane — ✅ PROVEN END TO END (7/17: webhook secret fixed; 4 real sample shipments processed — tracking, farm deductions, customer emails all confirmed via audit log)
| Step | Status |
|---|---|
| Push invoice → ShipStation order (idempotent orderKey) | ✅ PROVEN |
| Packing slip quantities | ✅ fixed (units for LF) — re-verify on next push |
| Label purchase → webhook → tracking + shipping + badge | ✅ PROVEN 7/17 (secret added to webhook URL; 4 sample_shipped audit rows by shipstation) |
| Manual fallback (shipping charge + tracking fields on the invoice) | ✅ built this week (LF modal; purpl modal lacks the shipping field — parity item) |

### D. Distributor lane — ✅ mostly proven
Shipment→PO+pool deduction ✅ · special-price invoice ✅ · branded doc + send ✅ ·
pay link generated ✅ · payment completion ✅ (real Stripe payments INV-0046/47 auto-marked paid) ·
terms-from-delivery autofill 📄 (built+verified, not yet used).

### E. Email lane — ⚠️ sends proven, feedback loop unproven
All sends ✅ (blast, invoices, confirmations, reminders exist). But:
**Resend webhook: ✅ registered** (click tracking works per TODO). Open-pixel tracking stays OFF — owner decision, settled. (Open tracking additionally
OFF by design until the custom tracking subdomain — in TODO.)

### F. Inventory & ops — ✅ core proven, edges code-only
Confirm/send deductions ✅ · pools + shipment pool choice ✅ (select-reset bug in
Tier-2) · production/repack/pallets 📄 (light use) · delivery runs 📄 (not yet used
for real) · Warehouse push → see lane G.

### G. Warehouse-partner lane — ✅ PROVEN IN PRODUCTION 7/23 (full launch batch pushed to the real partner; audit log confirms delivery address)
Partner (Millennial Moving) is 3PL + closes accounts; owner still invoices retailers
directly. Push = email the invoice doc to settings.warehouseEmail with a printable
HTML attachment (subject: PRINT & LEAVE WITH CUSTOMER — store — deliver {date} — INV).
The printed copy doubles as pick sheet + customer leave-behind.

| Step | Status |
|---|---|
| Settings → warehouseEmail (save/populate, live save fn) | 📄 verified |
| Fulfilled-by=Warehouse flag on purpl/LF/combined; dist correctly excluded | 📄 verified |
| Push from list row + both preview modals; legacy `iv` invoices resolve | 📄 verified (iv fix 7/22) |
| Attachment: UTF-8-safe base64 HTML, prints clean full page; >5MB refuses loudly | 📄 verified |
| No Pay button possible on warehouse copy (param-only + _payLink stripped) | 📄 verified adversarially |
| Subject uses REAL deliveryDate (combined: children), not issue date | 📄 verified (fix 7/22) |
| Re-send after edits: "↻ Re-send" + confirm; UPDATED subject/banner | 📄 verified |
| Failure honesty: failed send marks nothing, sticky error | 📄 verified |
| Terms label derived from invoice's own dates on ALL doc types | 📄 verified (fix 7/22) |
| Inventory: warehouse-fulfilled sends deduct the 'warehouse' pool | 📄 code-verified — stock must be transferred into that pool |

Known residuals (accepted): doc's address block is the account's single address
(billing=delivery assumed) · bounce after Resend accepts is only visible in the
Resend dashboard · cross-tab simultaneous push can skip the re-send confirm (still
sends a correctly-marked UPDATED copy) · .html attachments could be stripped by
strict corporate filters (Gmail delivers them; PDF fallback on request).
**To turn ✅ PROVEN:** dry-run to your own email, then the first real push to Tim.

---

## External dependencies (full table: docs/arch/13-external-deps.md)

**Confirmed working by evidence:** Resend API key · Stripe secret key · ShipStation
API key (pushes work) · hosting targets · portal config docs · Places key (maps work).
**The three that must be verified/registered — all "they call us":**

| # | What | Where | How |
|---|---|---|---|
| 1 | **ShipStation webhook** ✅ FIXED 7/17 (secret added; proven with 4 shipments) | — | nothing to do |
| 2 | **Stripe webhook** ✅ CONFIRMED working (owner $1 test) | — | nothing to do |
| 3 | **Resend webhook** ✅ registered; open-pixel OFF by owner decision | — | nothing to do |

Also found: `callAnthropic` function has **no secret binding** (its own setup
instruction can't work — AI drafting is dead until bound) · `.env.local` in git holds
only a fake test key (verified — no exposure) · shipstation `fromAddress` setting is
saved but never sent (dead field).

---

## The fix plan (in order — say go per block)

**Block 1 — YOU, in dashboards (~15 min, no code):**
1. ShipStation webhook URL + secret (above) — revives tracking/shipping/sample emails.
2. Stripe Dashboard → verify/create the webhook endpoint + set STRIPE_WEBHOOK_SECRET —
   **do this before any customer pays.**
3. Optional now / later: Resend webhook for click badges.

**Block 2 — ME, code hardening so silent callbacks can never hide again (on your go):**
1. Webhook rejections (bad/missing secret, bad signature) write audit_log rows — the
   ShipStation misconfig would have been visible in 30 seconds instead of invisible for weeks.
2. An **Integrations health panel**: one screen showing last-received timestamp per
   webhook (Stripe/ShipStation/Resend) + "never received" warnings.
3. Parity: shipping-charge field on the purpl invoice modal (LF has it).
4. Bind ANTHROPIC_API_KEY properly or remove the dead AI button.
5. Pay-link race auto-retry (filed) + Tier-2 sweep items when ready.

**Block 3 — PROOF, not assumption (after 1+2):** one $0.50→refund live Stripe payment
against a test invoice · one test label on a $0 test order · one click on a test email.
Each proves an inbound lane end-to-end. Then — and only then — the ledger above turns
fully green and "it's verified" means verified.
