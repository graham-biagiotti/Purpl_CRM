# 12 — Customer-Facing Invoices & ShipStation Setup (read-only review)

Scope: the shared invoice document `buildInvoiceDocHTML` and its wrappers as the customer receives them (email + "Pay Online"), reminder emails, statement print, and the full ShipStation pipeline (settings → push → webhook). Verified against `public/app.js`, `public/index.html`, `functions/index.js` as of this review; cross-checked against `docs/arch/04-invoices.md` and `docs/arch/00-foundation.md`. Findings ranked by customer impact.

---

## Ranked findings

### HIGH-1 — The generic Stripe-link fallback is actively misleading and can swallow payments
- `_buildPaymentHTML(payLink)` (`public/app.js:12672-12689`) renders the "Pay Online" button from `payLink || invoice_settings.stripeLink`. So whenever the per-invoice link is missing, the customer still gets a full-size Pay Online button pointing at the **generic** settings link.
- Consequences, in order of severity:
  1. **Payments can vanish from the CRM.** A generic Stripe link carries no `invoiceId` metadata; `stripeWebhook` ACKs and drops sessions without one (`functions/index.js:1116-1119`). The customer pays, the invoice stays `sent`, and the reminder card (`app.js:2197-2274`) keeps dunning a customer who already paid. Nothing ties the money to the invoice; there isn't even a `paid_orphan` audit row (that path requires metadata too).
  2. **The staff warning lies.** On `createPayLink` failure `_getStripePayLink` shows "the invoice will go out WITHOUT a pay button" but then returns `invoice_settings.stripeLink` (`app.js:703-711`), which `_buildPaymentHTML` renders as a pay button anyway. Staff believe no button went out; the customer got a button to the wrong charge.
  3. **$0 / amount-pending invoices get a pay button.** `_getStripePayLink` returns `null` for zero totals (`app.js:685`; server also rejects `< $0.50`, `functions/index.js:972`) — but the null flows into the same generic-link fallback, so an invoice whose Amount Due prints "$0.00" (`app.js:12828,12917`) can still carry a live Pay Online button. There is no "TBD/Amount Pending" rendering state anywhere — a not-yet-priced invoice simply says `$0.00`.
- Fix direction (not applied): only render the button for a per-invoice link; render `stripeLink` (if at all) as a plain "other payment options" line, and make the failure toast truthful.

### HIGH-2 — Combined-invoice reminder email tells the customer they owe **$0.00**
- `buildInvoiceReminderHTML` computes `amount = collection === 'lf_invoices' ? (inv.total || 0) : (inv.amount || inv.total || 0)` (`public/app.js:2312`). A `combined_invoices` **parent** has neither `amount` nor `total` — only `grandTotal` (`app.js:12635-2643`, `15453-15462`) — so the big "Amount Due" box renders `$0.00` (`app.js:2352-2355`).
- The dashboard queue row shows the correct `inv.grandTotal` (`app.js:2239`), so staff previewing the card will never notice; and the "Pay Now" button next to the $0.00 charges the real grand total (server-side lookup uses `grandTotal||total||amount`, `functions/index.js:971`). Customer sees "Amount Due $0.00 … Pay Now" — confusing at best, a dispute magnet at worst.
- One-line fix direction: `collection === 'combined_invoices' ? (inv.grandTotal || 0) : …`.

### HIGH-3 — "Save & Push to ShipStation" emails a total that will change once the label is bought
- All three one-click send paths push to ShipStation and then **immediately** email the invoice: purpl (`public/app.js:2512-2529`), LF (`app.js:11812-11830`), combined (`app.js:13363-13367`). At that moment no label exists, so there is no shipping cost; the shipping line and new total only arrive later via `shipStationWebhook` (`functions/index.js:1569-1615`).
- Result: the emailed document and its frozen Stripe link are the **pre-shipping** amount. Either the shipping charge is never collected (customer pays the emailed link → `paidAmountMismatch` flag + note, `functions/index.js:1157-1174`, which staff must notice and chase) or staff must re-send the invoice, which nothing prompts them to do — the `readyToSend` banner flow (`app.js:600-647`) assumes the invoice hasn't been sent yet.
- The two flows contradict each other: the banner says "review and send when ready", but the button labelled "Save & Push to ShipStation" (`app.js:2498`) both pushes *and* sends. Consider suppressing the email (or warning) when `deliveryMethod==='ship'` and no `shipStationOrderId`/`shippedAt` yet.

### HIGH-4 — ShipStation webhook failure paths silently no-op (lost tracking + unbilled shipping)
- Every failure in `shipStationWebhook` returns **HTTP 200**, so ShipStation never retries:
  - resource fetch failure → `res.status(200).send('fetch failed')` (`functions/index.js:1401`);
  - any thrown error → `res.status(200).send('error logged')` (`functions/index.js:1637-1640`);
  - **invoice not found by number** → the collection loop just falls through with no log, no audit row, and 200 (`functions/index.js:1556-1634`). Samples get an explicit `sample_orphaned` audit entry (`functions/index.js:1541-1550`); invoices get nothing.
- Customer-visible consequences: no tracking on the invoice/email, no shipping line ever added (shipping revenue silently lost), no `readyToSend` banner — and no operator signal that anything failed. At minimum the invoice-not-found case should write an audit row like the sample path does.

### HIGH-5 — Webhook matches on the `number` field only; delivery-run invoices can never match
- `shipStationWebhook` looks up invoices with `where('number','==',orderNumber)` across `retail_invoices`/`lf_invoices`/`combined_invoices` (`functions/index.js:1556-1559`).
- `createDeliveryInvoice` writes `invoiceNumber` but **no `number` field** (`public/app.js:9397-9405`). The client push uses `inv.number || inv.invoiceNumber` as the order number (`app.js:533`), so a delivery-run invoice pushed to ShipStation ships fine but the webhook finds nothing → HIGH-4's silent no-op (no tracking, no shipping charge). Legacy `iv`-collection invoices and dist invoices are likewise unsearchable (already noted in `docs/arch/04-invoices.md` §13.6; the delivery-run `number` gap is new).
- Related: invoice numbers are only best-effort unique (user-entered numbers bypass the counter, `app.js:12353-12404`), and the webhook takes `limit(1)` — a duplicated number can pin tracking and the shipping charge to the wrong customer's invoice.

### MED-1 — A second shipment **replaces** the first shipment's shipping charge
- The webhook is idempotent per event by stripping any existing `__shipping__` line and inserting one for the current event's cost (`functions/index.js:1567-1581`). But a genuinely new shipment on a later day (backordered second box) arrives as a separate event whose `resource_url` contains only the new shipments — so the first box's cost is discarded, not accumulated. Same for combined parents: `grandTotal = purplSubtotal + lfSubtotal + shipCost(this event)` (`functions/index.js:1609-1611`). Multi-box shipments **in the same batch** are summed correctly (`functions/index.js:1408-1417`). Net effect: undercharged shipping, silently.

### MED-2 — Pay-link generation races the local Firestore write
- `_saveInvCore`/`_saveLfInvoiceCore` write via the optimistic cache (immediate but un-awaited `_writeDoc`, `public/db.js:670-685`), and Save-&-Send calls `_getStripePayLink` right afterwards (`public/app.js:2510-2524`, `11809-11825`). `createPayLink` does a fresh server-side read (`functions/index.js:962-972`); if the doc hasn't committed yet it returns "Invoice not found" → HIGH-1's generic-link fallback. Intermittent, worst on brand-new invoices with fast networks to Functions and slow Firestore commits. (Server-side lookup itself is correct — client amount is ignored, TB-2.)

### MED-3 — Legacy `iv`-collection purpl invoices always fall back to the generic link
- Every client call passes `invoiceType:'retail'` for purpl (`public/app.js:2524`, `13081`, `2282-2283`, `16415`), and `createPayLink` then reads only `workspace/main/retail_invoices` (`functions/index.js:964-969`). The `iv` entry in the server's `colMap` is unreachable because no caller ever sends `invoiceType:'iv'`. Previewing/reminding a legacy invoice yields "Invoice not found" → sticky error + generic-link button (HIGH-1). The Stripe **webhook** does have an `iv` fallback (`functions/index.js:1180-1185`) — but it can never trigger for links that were never created.

### MED-4 — `shipstation_settings.fromAddress` is persisted but used by nothing
- Settings UI (`public/index.html:1602-1605`) and `saveShipStationSettings`/`loadShipStationSettings` (`public/app.js:464-475`) round-trip `fromAddress`, but neither `pushInvoiceToShipStation` (`app.js:568-577`) nor `pushSampleToShipStation` (`app.js:6288-6297`) nor the server payload (`functions/index.js:1275-1314`) ever reads it. Labels ship from the ShipStation account default regardless of what staff type here — a silently decorative setting. Either wire it into the order payload (`advancedOptions`/warehouse) or remove the field. (`storeId` *is* wired: `app.js:573`, `functions/index.js:1312-1314`; blank = default store, which the UI hint correctly states, `index.html:1600`; a non-numeric storeId is silently dropped.)

### MED-5 — No ShipStation `orderKey` → duplicate orders on double-push
- `pushToShipStation` builds the create-order payload with `orderNumber` but no `orderKey` (`functions/index.js:1275-1311`). In ShipStation V1, create/update is only idempotent when `orderKey` is supplied; without it each call creates a new order even with a repeated `orderNumber`. The only guard is client-side `inv.shipStationOrderId` (`public/app.js:527`) — two tabs, a retry after the callable succeeded but `DB.update` didn't land, or the same combined order pushed once via the parent and once via a child (children are hidden in the unified list, `app.js:15774`, but reachable through the account tab and edit modals) can produce two live orders → **double shipment to the customer**. Setting `orderKey` to the invoice id would close this.

### MED-6 — Webhook wiring is entirely manual and unverifiable in-app
- The webhook expects `?secret=<last 8 chars of SHIPSTATION_API_KEY>` (`functions/index.js:1375-1381`) and must be registered in ShipStation by hand; there is no in-app setup, doc, or check. "Test Connection" only verifies the API key by listing stores (`public/app.js:477-496`, `functions/index.js:1338-1362`). If the webhook was never registered (or registered store-scoped while pushes go to the default store), the whole tracking/shipping sync is silently absent — indistinguishable from HIGH-4. A blank secret can't be bypassed (empty query → 403), and `resource_url` origin is pinned (`functions/index.js:1388-1392`) — both correct.

### LOW — Document rendering edge cases (mostly graceful)
Verified in `buildInvoiceDocHTML` (`public/app.js:12792-12944`) and normalizers (`app.js:12740-12790`):
- **Missing due date**: the Due row and footnote are simply omitted (`app.js:12895`, `12920`) — clean. But invoices with no due date also never enter the reminder queue (`app.js:2205,2219,2233`) — silent no-reminder.
- **Missing issue date**: falls back to **today at render time** (`app.js:12794`) — a late re-print/re-send of an undated invoice shows the wrong issue date.
- **$0/null totals**: render as a flat `$0.00` Amount Due (`app.js:12828,12917`); no pending state (see HIGH-1.3).
- **Long item names / notes**: names wrap (only qty/price/total cells are `nowrap`), `notes` is escaped with `white-space:pre-wrap` (`app.js:12927-12930`), `footerNotes` and legal terms escaped (`app.js:12936`, `12709-12724`). Good.
- **Variant lines**: LF variants render one row per variant with `(Refillable)` tag, totals from `vl.lineTotal || units*unitPrice` (`app.js:12771-12779`); portal-created LF lines carry `lineTotal` (`app.js:15327-15340`) — consistent.
- **Shipping lines**: `_normShippingLines` reads the parent's `__shipping__` items (`app.js:12740-12747`), matching where the webhook writes them for all three collections (parent for combined, `functions/index.js:1565-1581`). ✓
- **Escaping gaps**: `achRouting`/`achAccount` are interpolated **unescaped** (`app.js:12676`) and the pay-link `href` is unescaped (`app.js:12682`) — staff-controlled values, so low risk, but inconsistent with everything else.
- **Paid banner**: correct — green "This invoice has been paid — <date>" replaces the whole payment section, plus a PAID pill in the header (`app.js:12830-12833`, `12879`). Stripe webhook cascades paid to combined children with parent-note stripping (`functions/index.js:1206-1232`). ✓
- **ACH/check instructions**: from `invoice_settings.achRouting/achAccount/checkInstructions` with a sensible default "checks payable to…" line (`app.js:12675-12678`); fields exist in Settings (`app.js:16316-16318`). ✓

### LOW — Dead/diverging combined print builder
- `buildCombinedInvoiceEmailHTML` (`public/app.js:13032-13059`) collects shipping lines from the **children** while the webhook writes them to the **parent** — it would show a grand total including shipping with no shipping row, and it never fetches a pay link. Its only caller `generateCombinedInvoicePrint` (`app.js:16430-16437`) has **zero callers** itself, so this is dead code today — but a booby trap if ever wired up. The live path (`buildCombinedInvoiceHTML`, `app.js:12948-12977`) is correct.

### LOW — Statement of account
- `printAccountStatement` (`public/app.js:13482-13587`): combined parents + non-child purpl/LF, drafts/voids/paid contribute $0 balance (`app.js:13505`), dist invoices excluded (matches `04-invoices.md` §11). Escaping is thorough. Nits: void invoices still list their full Amount (balance "—") which can confuse customers; draft rows appear at all ("money never billed" is excluded from the total but the row shows); no payments/credits section — it's an open-item list, not a true statement.

### LOW — Reminder wording/behavior nits
- Reminders are strictly one-shot (`reminderSentAt` guard, `public/app.js:2206,2220,2234`) — a still-unpaid invoice never gets a second nudge.
- `dueLabel` falls back to the string `'Net 30'` when there's no due date (`app.js:2315`), producing "was due on **Net 30**" — unreachable from the queue (which requires a due date) but wrong if ever called directly.
- Legacy `iv` reminders (`collection:'iv'`, `app.js:2211`) work for send/update but hit MED-3 for the pay link.
- Dist reminders (`_sendDistInvoiceReminder`, `app.js:16239-16256`) use `inv.total` — correct for dist — and send with no pay link at all (fine; dist has none).

### Answer to "do emailed totals always match what will be charged?"
Mostly yes, with three carve-outs. `createPayLink` ignores the client amount and reads `grandTotal||total||amount` server-side (`functions/index.js:962-972`); `_saveInvCore` keeps `total` and `amount` identical (`public/app.js:16523-16524`); the webhook keeps `total`/`amount`/`lineItems` consistent (`functions/index.js:1582,1613-1614` — and the recompute is safe for every live line shape: manual/portal purpl and all LF lines carry `lineTotal`, `app.js:16489`, `15434`, `12071-12088`, `15336`; only delivery-run lines lack it, and those can't match anyway per HIGH-5). Post-edit divergence is caught (not prevented) by `paidAmountMismatch` (`functions/index.js:1157-1174`). The carve-outs: **HIGH-3** (ship-flow emails the pre-shipping total), **MED-1** (second shipment drops the first shipping charge), and **HIGH-1** (generic-link payments match nothing at all).

---

## Corrections/additions to `docs/arch/04-invoices.md`
1. §13.6 (webhook matches only `number`): extend — delivery-run invoices lack the `number` field entirely (`app.js:9397-9405`), so even their own collection can't match.
2. §9 (Stripe): the client fallback to `invoice_settings.stripeLink` is not a benign degradation — it renders a live Pay Online button whose payments are invisible to `stripeWebhook` (HIGH-1).
3. §10: `shipstation_settings.fromAddress` is persisted but consumed by nothing (MED-4); `00-foundation.md` §3.3 lists the key as "Store ID, from-address" — only the store ID is functional.
