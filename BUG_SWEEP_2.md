# BUG_SWEEP_2.md — Deep Sweep Findings (verified, no fixes applied)

**Date:** 2026-07-09 · Five adversarial lenses (fresh-diff, clock/money, state machines,
data-shape, portal/functions). All headline claims re-verified against source (13 spot-checks:
12 confirmed, 1 corrected). Excludes everything already in CAPABILITY_SCAN.md / docs/arch/*.
Full traces: scratchpad sweep-A..E files (session) — line refs below are authoritative.

## 🔴 SEVERE — money or data actively wrong

1. **`today()` is UTC — after 8pm Eastern the whole app lives in tomorrow** (app.js:165).
   Cascades: invoices dated +1; payments after 8pm land in next month's Collected — and
   **next tax year** in the Dec-31 Year-End export (10465); invoices show OVERDUE a day
   early (portal + KPIs); "Not contacted today" resurfaces same-day contacts at 9pm;
   follow-ups say "Tomorrow" until noon (separate noon-pin at 1868). One-line class fix
   (local-date formatter) heals the family.
2. **Shipped delivery-run invoices get their total clobbered to shipping-only**
   (functions:1576-1578 + 1602 vs app.js:9407 — lines store `amount`, webhook sums
   `lineTotal||total`). Interaction of two recent fixes. $494.20 → $14.20 in list/KPIs;
   doc preview masks it.
3. **LF portal orders inflate purpl revenue reports** — `orders` rows with brand:'lf'
   are priced by the purpl pricer in repRevenue/repAccounts/repSkuPerf (10122-10184);
   KPI disagrees with its own by-SKU table.
4. **`migrateLfSkuPrices()` reverts LF price edits on every boot** (app.js:1194, run at
   13978) — hardcoded catalog overwrites staff edits by name; the live portal catalog
   (getLfCatalog) then serves reverted prices. Defeats the feature.
5. **Voided combined invoice → one click "Mark Both Paid" resurrects it** (13344 +
   markCombinedPaid no status guard) — books say paid, inventory already restored by void.

## 🟠 HIGH — workflow lands wrong data

6. **Dist Issue-date handler leaks into combined preview** (13188-95; combined never
   clears it) — editing a combined invoice's Issue Date rewrites Due with the wrong
   distributor's terms; Save persists to parent + both children.
7. **Mass template send never clears selections** (only meBatchReset 5222 does) — next
   blast targets every previously-checked, now-hidden account; confirm count is sole tell.
8. **Dist modal: switching distributor keeps the other distributor's line prices**
   (7659 refreshes due date only; typed values always win 7741) → dist B billed at A's
   prices, $0-warning can't fire. Also stored price can't be cleared back to list.
9. **Combined send double-fire** — `callSendCombinedInvoice` not awaited (13474), finally
   re-enables mid-flight → double-click = duplicate customer emails; catch opens mailto
   silently with no failure toast.
10. **Shipment modal never resets the pool select** (7241-61 resets all but #dship-pool)
    — after one Farm shipment every later one silently deducts Farm.
11. **Watchdog swallows portal validation errors** (order.html:1152 armed pre-validation,
    showError never clears) — "missing address" becomes "connection offline, don't close!"
    after 15s. (Own-goal from this week.)
12. **Portal Order History prints "Invalid Date" on every row** (order.html:999 —
    toDate wrapper reads the field after overwriting it).

## 🟡 MEDIUM

13. Portal Outstanding: LF rows render $0.00 (reads `amount` only, 1746), combined charge
    appears twice (children unfiltered 1726), total matches neither (1764).
14. Legacy `iv` invoices: Ship/Warehouse buttons save to wrong collection (15945-53) —
    ShipStation push never remembered (orderKey prevents dupes but button never ✓);
    warehouse toast lies. Pay links: type 'retail' lookup misses iv (functions:971) —
    reminder/preview emails for legacy invoices always lack the Pay button + sticky error.
15. Legacy 'unpaid'/'overdue' statuses never migrated for `iv` + combined (13899-909),
    and the migration is skipped entirely if Firestore beats the 10s boot timeout
    (retry hook omits it, 13986-89) — invoices invisible under status filters.
16. Combined `_updateFulfillBtns` lacks else-reset (13391-401) — after previewing a pushed
    invoice, an unpushed combined shows stale "✓ Pushed" disabled button.
17. Preview-open race: two quick Preview clicks interleave awaits; modal can act on
    invoice A while showing B's id (both openers, no epoch token).
18. Confirmed Wix pull absorbs later quantity edits silently (12139-53 preserves
    confirmed:true) — extra cases never flagged for re-pull.
19. Preview quick-edit stamps `fulfillmentSource:'warehouse'` on records that never had
    it (13199/13247) — delivery-run/pre-feature invoices gain the 🏭 badge and pin
    later deductions to warehouse; contradicts LF farm default.
20. Email-open badge pinned to oldest cadence entry (find() at 143) — after any re-send,
    opens land on newer entries; badge shows "not opened" forever.
21. ShipStation webhook stamps issued/due from webhook-arrival UTC, ignoring the payload
    shipDate (functions:1621-26) — late/replayed webhooks skew invoice aging.
22. Combined children inherit parent `paidAmount` (functions:1216-37) — latent
    double-count for anything summing paidAmount.
23. Dist doc prints "Net {global terms}" while Due autofill uses the distributor's own
    days (13036 vs 13192) — contradictory for non-Net-30 dists.
24. Reorder-due date math DST-unsafe (6440-42) — flags a day early across spring-forward.

## 🟢 LOW
25. offerDeliveryInvoice interpolates account name unescaped (9381) — HTML injection
    via portal-originated names in the CRM.
26. Double loadLfSkus on token entry re-renders and wipes typed LF quantities
    (order.html:944/592).
27. New LF SKU defaults to published $0.00 item on the live portal (11593);
    SKU/variant names render unescaped on the portal (625/645/669).
28. Portal commit-failure resets button to "Place Order" even in pre-order mode (1397).

## Corrected during verification
- "Duplicate ShipStation orders on double-push" — wrong: orderKey (recent fix) makes
  re-pushes update the same order. The mis-persistence half (14) stands.

## Recommended fix batch (on approval)
Tier 1 (same-day): #1 today() local-time, #2 webhook amount-field, #4 kill/one-shot the
LF price migration, #5 paid-guard, #6 handler reset, #7 clear selections, #11 watchdog
clear-on-error, #12 Invalid Date. Tier 2: #3, #8, #9, #10, #13-16. Tier 3: the rest.
