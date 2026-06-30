# Purpl CRM — Open To-Do

_Updated for go-live. The account + portal-order systems have been fully
reviewed and the must-fix items are committed (see "Done this session")._

## 🔴 Open — needs your DECISION
- [ ] **Opt-out on transactional/invoice emails** (email-R1). Policy choice: should
      invoices skip opted-out accounts, or send regardless (usual default)? Not a
      bug — current behavior (send regardless) is the standard default; leave unless
      you want it changed.
- [x] ~~Unsubscribe link doesn't work for real customers~~ — BUILT (public Cloud
      Function + /unsubscribe rewrite). Needs `firebase deploy --only functions,hosting`.

## 🟡 Open — needs your ACTION / assets
- [ ] **"Push to Warehouse" intake method** — the 🏭 Warehouse button is currently a
      stub: it only sets `fulfillmentSource:'warehouse'` + a timestamp, it does NOT
      send the order anywhere (unlike 📦 Ship → ShipStation Cloud Function). Decide how
      the 3PL/warehouse receives orders (API/portal, email, or file export), then wire
      `pushToWarehouse` (app.js:15328) to actually do it.
- [ ] **Email Open Tracking (Resend)** — currently OFF (Resend flags it "Not
      Recommended": the open pixel is inaccurate + can hurt deliverability).
      Click tracking IS on, so 🔗 Clicked works; 👁 Opened never fires (incl.
      "opened-but-didn't-click" and order confirmations, which have no link).
      To enable safely LATER: (1) Resend → Domains → pbfwholesale.com →
      Configuration → "Enable tracking metrics → Configure" = set up a CUSTOM
      tracking subdomain (adds a CNAME at GoDaddy; also clears the shared-click-
      tracking deliverability banner), THEN (2) flip Open Tracking on. Order
      matters — custom subdomain first keeps it from tanking deliverability.
      CRM side already supports displaying opens; nothing to code. Gmail still
      caches the pixel, so opens stay imperfect even then.
- [ ] Set real **COGS** in Settings (reports still fall back to $2.15 placeholder
      for SKUs with no cost set).
- [ ] Set variety pack recipe to 4+4+4.
- [ ] NEW Aromatherapy Roll-On product photo — current public/images/lf-rollon.PNG
      is the OLD image. Drop in the new one (same filename), redeploy.
- [ ] WS_Edits page 10 "Receipt?" item — unclear; describe what the note meant.
- [ ] Confirm Resend plan/daily limit before the 87-blast (free tier = 100/day).

## ⚪ Deferred — after launch / bigger effort
- [ ] **H3: audit_log query-on-demand** — it's loaded in full + permanently listened;
      should be `orderBy('timestamp').limit(N)`. Architectural; touches db.js core.
- [ ] **Portal "Outstanding Invoices" section is dead** (portal-R1) — fails closed,
      no leak, but customers can't see their balance. Needs a token-validated callable.
- [ ] Portal re-order prefill ("remember last order") — denied by rules from the
      unauthenticated portal; would need a Cloud Function to persist prefs.
- [ ] "Both brands" account filter is an alias of "LF only" — needs a `brands[]` field.
- [ ] M12 atomicUpdate cache rollback; M10 config recovery — low value, see SCAN.md.

## Resolved / dropped
- "Without pesticides" claim — CONFIRMED accurate, kept.
- Email sender profile picture (BIMI/VMC) — DROPPED (not worth ~$1k/yr).
- portal_tokens cleanup on delete — MOOT (nothing reads that collection).

## Done this session (go-live hardening)
- [x] **Pre-order email blast** hardened: auto-generates personalized tokens for
      token-less accounts, pre-flight summary, abort-on-failure, 500ms send delay.
- [x] **#1 Copy Link** reuses existing token (no longer breaks already-sent links).
- [x] **#2 Last Contacted** reflects email/invoice sends (no false "Needs Attention").
- [x] **#3 Dual-brand pairing** strict — can't merge two different customers' orders.
- [x] **#4 Dual-brand double-convert** guarded (transactional paired-claim + in-flight lock).
- [x] **#5 Dual-brand submit** atomic (batch); sample-only orders now recorded.
- [x] fulfilledBy silent-revert fixed; `created` field on new accounts; dashboard
      brand counts reconcile; opted-out accounts skipped in token pre-pass.
- [x] **"Pending (no order yet)" account status** + status filter + dashboard pending count.
- [x] Accounts page O(n²) render fixed (indexes orders/invoices once); Delete button on cards.
- [x] **C1 (critical):** save layer no longer deletes other users' records from a stale cache.
- [x] H1/H2 recovery layer (no resurrection/clobber); H4 render debounce; M-series fixes (see SCAN.md).
- [x] HIGH-7 audit_log append-only; double DMARC record removed.

## Done earlier
- [x] Sample double-entry dedup; sample tile; can mockups; green→purple; 🌿→🪻;
      email password + two ordering methods; em dashes removed; wholesale auto-sync hook.
