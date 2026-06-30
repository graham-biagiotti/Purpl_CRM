# Purpl CRM — Full Section-by-Section Scan

_Read-only audit of every CRM section (Dashboard, Accounts, Prospects, Orders &
Delivery, Distributors, Invoices & Payments, Production, Projections, Reports,
Settings, Integrations, Map, Emails, Pre-Orders/Portal). Inventory's 8 tabs are
covered separately in `INVENTORY_SCAN.md`. Nothing was changed — findings only.
File:line references are in `public/app.js` unless noted._

Verdict: **no data-destroying bugs and no launch blockers** beyond what was
already fixed. The recurring themes are (1) inventory deductions that some
invoice actions skip, (2) reports that read only `orders` so direct invoices go
uncounted, (3) a confirmed `$0` distributor field bug, (4) dead/hidden UI, and
(5) the same metric computed two different ways in different places.

---

## ★ The handful actually worth fixing (ranked)

1. **Inventory deduction gaps → overselling risk.** Stock is only deducted when
   an invoice is *emailed* (`markInvoiceSent`) or *created already-non-draft*.
   These common paths deduct **nothing**:
   - Marking a Draft "✓ Paid" from the list — `markRetailInvPaid` (2653),
     `markLfInvPaid` (11547), `markCombinedPaid` (12017). _Verified: 2653 just
     flips status._
   - Editing a Draft's status to Sent/Paid in the modal — `_saveInvCore` edit
     path (16046) never deducts (only the new-invoice branch does, 16037).
   - Voiding a standalone purpl/LF invoice (modal Status→Void, 16046) does **not
     reverse** its earlier deduction (only the *combined* void does, 13010).
   Root cause: the old "✉ Sent" button that used to deduct lives in a now-dead
   four-column UI block (see #8), so there's no non-email "send + deduct" path.

2. **Reports undercount revenue — manual invoices never create `orders`.**
   Standalone purpl (16029) and combined (12436) invoices write to the invoice
   collections but never push to `orders`. Every revenue/profit report reads only
   `DB.a('orders')` (`repRevenue`/`repProfit`/`repAccounts`/`repSkuPerf`
   9929-10073, MoM 9614, Top Accounts 9529). So an invoice you bill directly
   shows full value on the Invoices page + KPIs but **$0 in Reports**.

3. **Distributor PO value renders $0 everywhere _(confirmed)_.** POs store the
   amount in `totalValue` (writes 7213, 7493) but the KPI (10124), chart (10128),
   dashboard "Avg PO Value"/"projected" (2938, 2952) and dist 30-day forecast all
   read `p.total`, which doesn't exist. The per-row table (10115) reads the right
   field, so the report visibly contradicts itself.

4. **Stored XSS in map info windows _(confirmed)_.** `addPin` interpolates
   `opts.name`/`opts.sub` into InfoWindow HTML **without `escHtml`** (13644-13645),
   while distributor pins right below do escape (13739). An account named
   `<img src=x onerror=...>` runs script in the CRM origin when its pin is opened.
   Low real-world risk on a solo CRM, but a real hole; one-line fix.

5. **`createDeliveryInvoice` leaks its in-flight lock** on the empty-items early
   return (9228 returns without `_deliveryInvInFlight.delete`), so a 0-case
   delivery stop can never be invoiced again that session (same bug class as the
   portal-confirm one already fixed).

6. **Portal/Emails cluster (user-visible, cheap):**
   - Live auto-refresh of the Pre-Orders list is dead — checks `currentPage ===
     'preorders'` but the id is `'pre-orders'` (16272); new orders don't appear
     until you re-navigate.
   - Declined orders never clear the nav badge — badge excludes `'rejected'` but
     `declinePortalOrder` writes `'declined'` (16265 vs 14649).
   - Confirmed-tab "Confirmed" column shows `[object Object]` — `confirmedAt` is a
     Firestore Timestamp that `PortalDB.load` never converts (14316).
   - Pre-Order Announcement sends don't show in the per-account cadence tracker
     (stage mismatch, 4396 vs CADENCE_STAGES).

7. **Distributor shipment can't reverse cleanly / hardcoded pool.** Un-toggling a
   delivery stop deletes iv rows by a fragile "orphaned invoice" filter rather
   than by id (9167), risking deletion of unrelated orphan rows; and dist
   shipments always deduct `warehouse` (7232) with no pool choice.

8. **Dead UI worth deleting (maintenance traps):** the entire old four-column
   invoice UI (`renderInvColPurpl/Lf/Combined/Dist`, `toggleInvCol`, `markPaid`,
   `editInv` — 15414-15700) is unreachable; `saveSettings()` (10883) is wired to a
   non-existent `#save-settings-btn`; dashboard brand-count KPIs
   (`#dash-kpi-accounts` etc.) are populated but sit in a `display:none` block
   (index.html:220); the `?optout` client handler (13555) is superseded by the
   `/unsubscribe` function.

---

## Section-by-section

### Dashboard
- Brand/fulfillment breakdown KPIs are computed every render but hidden in a
  `display:none` block — all the drill-downs (`dashFilterBrand`,
  `dashFilterFulfill('dist')`) are invisible/unclickable (1459, index.html:220).
- `dashFilterFulfill('dist')` can't work — sets `#ac-fulfill-filter` to a
  distributor id but the select only has static `""`/`"direct"` options (1718 /
  index.html:331), so it silently shows all accounts.
- "carry both" count (`isPbf`, 1395) wired to `dashFilterBrand('lf')` which filters
  to **LF-only** (3208) — count and resulting list disagree.
- Follow-Ups list iterates all accounts incl. paused/inactive (1852), while "Needs
  Attention" only counts active (1769) — inconsistent.
- Outstanding amount resolved `total||amount` here (1407) vs `amount||total` on the
  Invoices KPIs (15380) vs `iv.amount` only in the account-modal invoices tab
  (13189) — a legacy invoice with only `total` shows `$0` in the modal.
- Two different "overdue" rules: dashboard `renderInvoiceStatus` uses
  terms-window (2066) vs `_isOverdue` (`due < today`) everywhere else.

### Accounts / Prospects
- `convertProspect` creates `status:'active'` (5772), bypassing the "pending (no
  first order)" concept — a converted prospect immediately reads "Needs
  Attention" and never shows under the Pending filter.
- "Velocity" computed two ways: account card uses `dueDate` intervals (3104),
  dashboard reorder predictions use `created` intervals (1940) — same account,
  different cadence.
- `_acBrandFilter` is module-level and never reset by `nav()` (1700) — can stay
  applied while the brand buttons show "All," making counts look wrong.
- Account-modal recent-orders includes cancelled orders (3424), unlike the card
  velocity/index which filter them out.
- _Verified correct:_ Active/Pending KPI reconciles with the accounts filter;
  `acLastContacted` merges notes/outreach/cadence consistently; the O(n²) fix
  rebuilds indexes fresh; `_calcPricePerCase` is the single pricing source;
  `deleteAccount` purges across collections atomically.

### Orders & Delivery / Distributors
- `createDeliveryInvoice` in-flight lock leak on empty items (9228).
- Un-toggle delivery stop removes iv by orphan-filter not id (9167).
- Dist shipment hardcoded `warehouse` pool (7232); no pool selector.
- `cycleDistPOStatus` order is one-way and illogical (7505); `markDistInvoicePaid`
  doesn't refresh the Overview tab (7640); dist invoice can save `total:0` with no
  `dist_pricing` (7607); CSV import assumes "Quantity" = cases (7804).
- _Verified correct:_ orders never touch `iv` directly; the "via {Distributor}"
  badge and `_isDist` filter use the same predicate everywhere; dist invoices
  correctly never deduct; `saveDistShipment` writes atomically.

### Invoices & Payments
- The deduction gaps and dead four-column block (see ★1, ★8).
- `markLfInvPaid` toggles paid↔sent (11547) while `markRetailInvPaid` is one-way
  (2651) — same button, different behavior.
- KPI counts combined **children** (15358) while every other money view counts the
  **parent** `grandTotal` (10283, 1314, 9466) — equal today, but any edit to one
  child/subtotal without the other makes them silently drift.
- `openCombinedInvoicePreview` calls `.toFixed` on subtotals with no null guard
  (12851) — a legacy combined doc missing them would throw.
- _Verified correct:_ the new self-advancing invoice counter is collision-safe;
  `createPayLink` never trusts client amounts (rebuilds from `grandTotal`
  server-side); Stripe webhook is idempotent and handles combined→children;
  `deleteInvoiceWithCleanup` and combined void/delete reverse inventory + dissolve
  the parent correctly.

### Production / Projections / Reports
- Manual invoices invisible to reports (★2).
- Distributor PO `$0` (★3).
- **Variety-pack recipe is never consumed** — `variety_recipe` is read only in
  Settings (10769); no production/sale/inventory code decomposes a variety pack
  into its component cans, so base-flavor on-hand is overstated and variety COGS
  is a flat guess.
- Reports bucket orders by `dueDate` (payment date), not order date (9750) — a
  NET-30 order placed June 28 lands in July's report.
- `repProfit` subtracts a flat **monthly** overhead regardless of the selected
  range (10228) — overstates profit on a 90-day report, understates on a 1-day.
- `renderProductionRecommendation` stock is unclamped + pool-agnostic (8754),
  disagreeing with the clamped Inventory page; Warehouse+Farm columns can fail to
  sum to Total if any iv row has a non-standard pool (7914).
- LF reports filter by issue date with no upper bound and report **no COGS**
  (10389) — cross-brand comparisons are apples-to-oranges.
- _Verified correct:_ combined double-count avoided in "Total Invoiced";
  revenue/COGS unit math is dimensionally correct with div-by-zero guards; the
  $2.15 COGS placeholder is applied uniformly; CSV export escapes correctly.

### Settings / Integrations / Map
- Map stored XSS (★4).
- `saveSettings()` dead — bound to non-existent `#save-settings-btn` (10883 /
  13499); per-tab savers do the real work.
- Warehouse Lat/Lng "auto-filled from address" is a lie — no geocoding wired
  (index.html:1294; `saveBusinessSettings` 10931 only reads `.value`), so the
  warehouse pin/radius never appears unless coords are hand-entered.
- `0` is unsavable for `target_margin` / `warehouseRadiusMiles` (falsy coercion).
- No Resend connection-test button (ShipStation + Stripe have them).
- _Verified correct:_ no client-side secret exposure (all server-side Firebase
  secrets); integration status callables make real upstream calls; `nextInvoiceNum`
  and payment-instructions round-trip on one key; map pins guard null lat/lng.

### Emails / Pre-Orders (staff side)
- Live-refresh dead, declined badge, `[object Object]` date, preorder cadence not
  tracked (★6).
- Opt-out not surfaced on the compose page (only a confirm at send, 4388).
- KPI counts raw docs while the list groups dual-brand halves into one row
  (13999 vs 14198) — visually confusing, not wrong.
- Engagement badge priority differs across the 3 render sites (clicked-first vs
  opened-first) — same email can show 🔗 in one place, 👁 in another.
- _Verified correct:_ `filterAccountSelect` no longer auto-selects while typing;
  unsubscribe link routing is correct; webhook engagement write/read shapes match;
  all 14 template stages exist with safe merge-field fallbacks;
  `_samePortalSubmission` requires positive shared identity; confirm-flow
  double-invoice guards are sound.

---

## Cross-cutting patterns
- **Deduction is action-specific, not state-based.** Tying inventory to "emailed"
  vs "paid" vs "created non-draft" is the root of the gaps in ★1. A single rule —
  deduct once when status becomes Sent/Paid, reverse on Void/Delete — would close
  all of them. (This is the workflow change discussed separately.)
- **`amount` vs `total` vs `grandTotal` vs `totalValue`.** The same "how much"
  question is answered with different field-precedence in different views; the
  `totalValue` distributor case is the one that actually shows wrong numbers.
- **Metric defined twice.** Velocity (dueDate vs created), overdue (terms vs
  due<today), report date axis (dueDate vs created) — pick one definition each.
- **Dead/hidden UI.** Several fully-built features are unreachable (four-column
  invoices, dashboard brand KPIs, `saveSettings`), which both confuses and, in the
  invoice case, removed the only non-email deduction path.
