# Architecture Review — Orders & Delivery Tab

Scope: Orders list, order create/edit/delete, delivery runs (`today_run`), route builder, stops,
`toggleStop`, `createDeliveryInvoice`, `offerDeliveryInvoice`, delivery cost modal, batch invoicing,
map/route integration, and cross-section flows (Reports/Projections demand, Invoices lifecycle,
warehouse coords).

All paths relative to repo root `/home/user/Purpl_CRM`. Primary files:
- `public/app.js` (17,009 lines — entire SPA logic)
- `public/index.html` (page markup, lines 731–821 for this tab)
- `public/db.js` (Firebase data layer)

---

## 1. Data model & persistence

| Key | Storage | Notes |
|---|---|---|
| `orders` | Firestore collection `workspace/main/orders/{id}` (`db.js:14-21` COLLECTION_KEYS) | One doc per order. `{id, accountId, created, dueDate, status, source, items:[{sku,qty(cases)}], canCount, notes, invoiceStatus?, invoiceNumber?}` |
| `retail_invoices` | Firestore collection (`db.js:16`) | purpl invoices; delivery invoices carry `source:'delivery_run'`, `orderId` |
| `iv` | Firestore collection (`db.js:15`) | Doubles as inventory ledger (`type:'in'/'out'/'return'`) AND legacy purpl invoices (rows with `number`) — see `_allPurplInvoices` `app.js:47-50` |
| `today_run` | Config doc object key (`db.js:51` OBJ_KEYS → `workspace/main/config/main`) | `{date, stops:[], milesDriven?, fuelCost?, costPerCase?}`. Stops: `{name, accountId, address, notes, done, <skuId>:cases, lfItems?, ordId?, wixDeductionId?, lat?, lng?}` |
| `runs` | Firestore collection (`db.js:20`) | Archived delivery runs (from `clearRoute`) |
| `lf_wix_deductions` | Config array key (`db.js:42`) | Pending Wix stock pulls for LF items delivered on runs |
| `dist_pos` | Firestore collection (`db.js:17`) | Distributor Orders sub-tab (read-only here) |

Writes go through `DB.push/update/setObj/atomicUpdate` (`db.js:663-752`). `atomicUpdate` diffs
before/after id-sets to propagate explicit deletes (`db.js:697-722`) and flushes all keys ~50ms
later. Remote snapshots debounce into `window.refreshCurrentPage` (`db.js:274-278`), which re-runs
`renders[currentPage]` (`app.js:13879-13885`) — so any remote change re-renders the whole active
page, including this tab.

---

## 2. Page structure & render entry

- Sidebar nav `data-page="orders-delivery"` (`index.html:84`) → `nav()` (`app.js:258-291`) →
  `renders['orders-delivery'] = renderOrdersDelivery` (`app.js:299`). Legacy routes `orders` and
  `delivery` redirect here (`app.js:301-302`).
- Page markup: `#page-orders-delivery` (`index.html:731-821`) with three sub-tabs
  `#od-main-tabs` (`index.html:733-737`): **All Orders**, **Route Builder**, **Distributor Orders**.
- `renderOrdersDelivery()` (`app.js:8557-8585`): wires tab buttons once (`_wired` flag), then
  `switchODTab(_odCurrentTab)` (`app.js:8587-8602`) which shows one pane and dispatches to
  `renderOrders()` / `renderDelivery()` / `renderDistOrders()`.
- `renderDistOrders()` (`app.js:8604-8623`): reads `dist_pos` + `dist_profiles`; only button is
  **View** → `openDistributor(po.distId)` (`app.js:8619`). No writes.

### Duplicate wiring wart
The orders status-filter tabs and `#new-order-btn` are wired **twice**: once at startup in
`onAppReady` without a guard (`app.js:13911-13912`, `13927-13934`) and again in
`renderOrdersDelivery` with a `_wired` guard (`app.js:8568-8584`) — the guard doesn't know about
the first wiring, so each click fires two listeners. Both handlers are idempotent
(set `ordFilter` + `renderOrders()`; `openNewOrder(null)`), so the effect is a double render, not
data corruption. Same for `#nord-account` change → `populateOrderSkus` (`app.js:13913-13914`).

---

## 3. Orders list (All Orders sub-tab)

### Buttons / handlers

| UI element (index.html) | Handler (app.js) | Reads | Writes | Re-renders |
|---|---|---|---|---|
| Status tabs `#orders-filter` (`index.html:745-751`) | inline listeners `app.js:8571-8578` & `13927-13934` | — | `ordFilter` (module var `app.js:8628`) | `renderOrders()` |
| Fulfillment tabs `onclick="setOrdFulfillFilter(...)"` (`index.html:753-755`) | `setOrdFulfillFilter` `app.js:8630-8635` | — | `_ordFulfillFilter` | `renderOrders()` |
| `+ New Order` `#new-order-btn` (`index.html:743`) | `openNewOrder(null)` `app.js:8686-8702` | `ac` (active) | — (opens `#modal-new-order`, binds `_once(saveNewOrder)` at `app.js:8700`) | — |
| Row **View** (`app.js:8677`) | `openOrderDetail(id)` `app.js:8776-8836` | `orders`, `ac` | — | modal only |
| Row **→ Next** (`app.js:8678`) | `cycleOrderStatus(id)` `app.js:8838-8848` | `orders` | `orders` (status advance pending→confirmed→in_transit→delivered) | `renderOrders()`, `renderDash()` |

`renderOrders()` (`app.js:8637-8684`) reads `orders`, `ac`, `dist_profiles`; sorts by `created`
desc, filters by status + fulfillment (`ac.fulfilledBy`), and paints `#orders-tbody`. Source
badges map at `app.js:8651-8657` covers `run/manual/import/local_line/distributor` — **`source:
'portal'` orders (created by `confirmPortalOrder`, `app.js:15397-15414`) get no badge** (minor gap).

### Order create — `createOrder` (canonical path)
`createOrder({accountId, dueDate, notes, items, source, status})` (`app.js:8730-8746`):
- Computes `canCount = Σ qty×CANS_PER_CASE`.
- Single `DB.atomicUpdate`: appends to `orders` **and** stamps `ac.lastOrder = today()`
  (`app.js:8739-8742`).
- `auditLog('create','order',…)` (`app.js:8744`).

Callers: `saveNewOrder` (`app.js:8763`, source `manual`). Other order-creation paths bypass it:
`toggleStop` (`app.js:9261-9291`, source `run`), `importLLOrders` (`app.js:10861-10864`, source
`local_line`, raw `DB.push`, **does not update `ac.lastOrder`**), and portal confirm
(`app.js:15394-15421`, source `portal`, does set `lastOrder`).

`saveNewOrder` (`app.js:8748-8774`): validates account/date/items, creates the order, closes the
modal, `renderOrders()`. Then `confirm2('Create an invoice for this order now?')` →
`setInvStatus(ord.id,'invoiced')` (`app.js:8770-8773`). **Note:** `setInvStatus`
(`app.js:2368-2376`) only flags `orders.invoiceStatus`/`invoiceDate` — it does *not* create a
`retail_invoices` record. The prompt reads like it will create an invoice but only marks the order.

### Order detail modal (`#modal-order-detail`, `index.html:2506-2524`)
`openOrderDetail` (`app.js:8776-8836`):
- **Delete Order** `#mod-delete-btn` (`app.js:8807-8823`): removes linked `iv` rows where
  `e.ordId===id` (`app.js:8810` — note delivery-invoice ledger rows use `invoiceId`, not `ordId`,
  so those are NOT cleaned here; the associated retail invoice also survives an order delete),
  removes the order, **recomputes `ac.lastOrder`** from the newest surviving non-cancelled order
  (`app.js:8812-8816`), audit-logs, re-renders `renderOrders()`, `renderInventory()`, `renderDash()`.
- **Advance Status** `#mod-status-btn` (`app.js:8824-8825`) → `cycleOrderStatus` + reopen modal.
- **Reschedule** `#mod-reschedule-btn` (`app.js:8826-8834`): `prompt()` for date → `DB.update('orders',…)`.
- Invoice-status block (`app.js:8792-8805`): after delivery, shows **Mark Invoiced** / **Mark Paid**
  buttons → `setInvStatus(id,'invoiced'|'paid')` (`app.js:2368-2376`), which writes
  `orders.invoiceStatus` (+`invoiceDate`/`paidDate`) and refreshes `renderInvoiceStatus()`
  (dashboard card, `app.js:2076`).

There is **no order-edit UI for line items** — only status/date; item edits require delete+recreate.

---

## 4. Route Builder (delivery run)

Markup `#od-tab-route-builder` (`index.html:765-815`). State object: `today_run`
(config-doc object; single shared run per workspace, keyed by nothing — one run at a time).

### Buttons / handlers

| UI element | Handler | Collections read | Collections written | Re-render |
|---|---|---|---|---|
| Fulfill filter `#del-ff-*` (`index.html:768-770`) | `setDeliveryFulfillFilter` `app.js:9107-9114` | — | `_deliveryFulfillFilter` | `renderDelivery()` |
| `Clear Route` `#clear-route-btn` (`index.html:776`; wired `app.js:13919-13920`) | `clearRoute` `app.js:9512-9558` | `today_run`, `orders`, `retail_invoices`, `iv` | deletes run-orders/invoices/iv for done stops; archives run into `runs` (`app.js:9543-9551`); resets `today_run` | `renderDelivery()` |
| Stop checkbox `onchange="toggleStop(i)"` (`app.js:9132`) | `toggleStop` `app.js:9234-9344` | see §4.2 | see §4.2 | `renderDelivery()` |
| Stop ✕ `onclick="removeStop(i)"` (`app.js:9145`) | `removeStop` `app.js:9483-9510` | `today_run`, `orders`, `retail_invoices` | reverses done-stop side effects (account+date match), splices stop | `renderDelivery()` |
| Account select `#del-account-sel` change (`app.js:9165`) | `prefillStop` `app.js:9171-9195` | `ac` | — (fills form; par cans→cases `app.js:9182`; auto-shows LF section for `isPbf` accounts `app.js:9186-9194`) | — |
| `🪻 Add LF Items` (`index.html:806`) | `toggleDelLfSection` `app.js:9070-9076` → `_renderDelLfInputs` `app.js:9078-9092` | `lf_skus` | — | — |
| `Add to Route` `#add-stop-btn` (`index.html:812`; wired `app.js:13917-13918`) | `addStop` `app.js:9197-9231` | `today_run`, `lf_skus` | `today_run` (`DB.setObj` `app.js:9216`) | `renderDelivery()` |
| Delivery-cost modal fields (`index.html:3138-3151`) | `_calcDeliveryFuel` `app.js:9574-9583` (oninput), Save → `saveDeliveryCost` `app.js:9584-9594`, Skip → `_skipDeliveryCost` `app.js:9595-9598` | `settings` (mpg/gasPrice `app.js:9564-9566`) | `today_run` (miles/fuel/costPerCase `app.js:9590`) | then `offerBatchInvoice()` |
| Offer banner **Create Invoice** (`app.js:9368`) | `createDeliveryInvoice(acId, ordId)` | see §4.3 | see §4.3 | banner removed, toast |
| Batch banner **Create All Invoices** (`app.js:9454`) | `createBatchDeliveryInvoices` `app.js:9462-9481` | `today_run`, `ac`, `orders` | via `createDeliveryInvoice` per stop | toast |

`renderDelivery()` (`app.js:9116-9169`) reads `today_run`, `ac`, `dist_profiles`; paints stop
cards into `#del-stops` (drop-off rules box `app.js:9136-9139`, dist-fulfilled warning
`app.js:9135`, LF items line `app.js:9142`), progress counter `#del-progress` (`app.js:9151-9152`),
and repopulates the account `<select>` filtered by fulfillment mode (`app.js:9155-9166`).
SKU qty inputs `#del-qty-*` are generated by an inline script in `index.html:3236-3249`.

### 4.1 Stop identity is positional
Stops are addressed by **array index** everywhere: `toggleStop(${i})` (`app.js:9132`),
`removeStop(${i})` (`app.js:9145`), and the debounce set `_stopToggleBusy` keys on index
(`app.js:9233-9239`). `mapAddToRun` gives stops an `id` (`app.js:14280`) but `addStop` does not
(`app.js:9201`). If a remote snapshot reorders/removes stops between render and click, the index
can point at a different stop. Low risk single-user; real risk with two devices on the same run.

### 4.2 `toggleStop` — the stop-done side-effect chain (`app.js:9234-9344`)

**Mark done (not-done → done):**
1. Double-click guard via `_stopToggleBusy` (600ms, `app.js:9237-9239`).
2. Account resolution: stored `stop.accountId`, else case-insensitive name match
   `_findAccount(null, stop.name)` (`app.js:9247-9248`, helper `app.js:31-35`). No account →
   toggle is refused and reverted with a toast (`app.js:9250-9256`).
3. Builds `newOrd` `{status:'delivered', source:'run', created/dueDate: today(), items from stop
   case quantities, canCount}` (`app.js:9259-9265`). *Inventory is intentionally NOT deducted here*
   — deduction happens at invoice creation (`app.js:9266` comment).
4. If the stop has `lfItems`, builds an unconfirmed `lf_wix_deductions` record
   `{runName: run.date+' run', note:'Delivery: '+name, items, confirmed:false}` (`app.js:9268-9276`).
5. Links `stop.ordId` / `stop.wixDeductionId` for exact reversal (`app.js:9278-9282`).
6. One `DB.atomicUpdate` writes **four keys**: `today_run` (done flag + links), `ac`
   (`lastOrder = today()`), `orders` (+newOrd), `lf_wix_deductions` (+deduction)
   (`app.js:9284-9291`).
7. Follow-ups (timers): `showWixPullModal(null, deductionId)` at +300ms (`app.js:9294-9296`;
   modal `app.js:13700-13736`, confirm → `confirmWixPull` `app.js:13738-13751` flips
   `d.confirmed` and drives the dashboard "Pending LF Deductions" KPI `app.js:13765`);
   `offerDeliveryInvoice(stop, ac2, newOrd.id)` at +200ms (`app.js:9299`); if **all** stops done,
   `openDeliveryCostModal(stops)` at +800ms (`app.js:9301-9304`).

**Un-mark (done → not-done)** (`app.js:9306-9338`): one `atomicUpdate` reverses exactly this
stop's records — deletes the order by `stop.ordId` (fallback: `source==='run' && accountId &&
created===today()` for legacy stops, `app.js:9316-9318`), deletes `retail_invoices` where
`source==='delivery_run'` and `orderId` matches (fallback account+date, `app.js:9325-9330`),
deletes the `iv` `type:'out'` rows for those invoice ids (`app.js:9331`), and drops the
unconfirmed wix deduction by `stopWixId` (`app.js:9334-9336`). Note it does **not** roll back
`ac.lastOrder`.

**Consistency gap:** `removeStop` (`app.js:9490-9502`) and `clearRoute` (`app.js:9524-9536`)
still use the *legacy* account+date match instead of the stored `stop.ordId`/invoice `orderId`,
even though `toggleStop`'s reversal was fixed to use links (comment at `app.js:9278-9280`
describes exactly this collision). With two done stops for the same account on one day, removing
one stop deletes an arbitrary one of the two run-orders and **all** of that account's
`delivery_run` invoices dated today (`app.js:9493-9498`). Also `clearRoute` matches orders on
`created===run.date` (`app.js:9524`) while orders are always created with `created: today()`
(`app.js:9262`) — if a run object carries yesterday's `date` (see §4.5) the cleanup silently
misses.

### 4.3 `offerDeliveryInvoice` / `createDeliveryInvoice`

`offerDeliveryInvoice(stop, ac, ordId)` (`app.js:9347-9374`): injects banner
`#del-invoice-offer` as first child of `#page-orders-delivery` with **Create Invoice** →
`createDeliveryInvoice('${ac.id}','${ordId}')` and **Skip** (removes banner). Reads
`settings.default_payment_terms` for the due-date preview (`app.js:9356-9357`); the local `costs`
read at `app.js:9355` is dead. The banner lives outside the re-rendered `#del-stops` container,
so page re-renders don't clear it; only Skip/create/a new offer replacing it do.

`createDeliveryInvoice(accountId, ordId)` (`app.js:9376-9427`), async, per-order in-flight guard
(`app.js:9376-9379`):
- Reads `ac`, `orders`; prices every line with `_calcPricePerCase(ac)` (`app.js:9388-9391`;
  pricer at `app.js:23-28`: dist accounts → `pricePerCaseDist`, else
  `pricePerCaseDirect||pricePerCaseCustom`, fallback `PURPL_DIRECT_PER_CASE`).
- Claims `invoiceNumber` via Firestore **transaction** `getNextInvoiceNumber('purpl')`
  (`app.js:9386`, allocator `app.js:12353-12404` with two retries then non-atomic cache fallback
  + warning toast).
- One `atomicUpdate` (`app.js:9408-9422`) writes: `retail_invoices` (+invoice `{status:'draft',
  source:'delivery_run', orderId, lineItems:[{sku, cases, pricePerCase, amount}], cases, cans,
  total, deliveryDate}`), `iv` (+`type:'out'` ledger rows per line, `qty = cases×12`,
  `pool:'warehouse'`, `invoiceId`), and `orders` (sets `invoiceStatus:'invoiced'`, `invoiceDate`,
  `invoiceNumber` on the order).
- `invoice.fulfillmentSource` is referenced at `app.js:9414` but never set on the object — the
  pool is always `'warehouse'` (dead branch).

### 4.4 Delivery cost modal + batch invoicing
`openDeliveryCostModal(stops)` (`app.js:9562-9573`; markup `index.html:3138-3151`) caches stops in
module var `_deliveryCostStops` (`app.js:9561`), prefills MPG/gas from `settings`.
`saveDeliveryCost` (`app.js:9584-9594`) stamps `milesDriven/fuelCost/costPerCase` onto `today_run`;
both Save and Skip funnel into `offerBatchInvoice(stops)` (`app.js:9430-9460`), which lists done
stops whose run-order (account+date lookup, `app.js:9439`) isn't yet invoiced and shows the
"Run complete 🎉" banner. **Create All Invoices** → `createBatchDeliveryInvoices`
(`app.js:9462-9481`): per done stop, finds the run-order by account+`created===today()` sorted by
`b.id>a.id` (`app.js:9471-9472` — uid ordering, not chronological), skips invoiced ones, and calls
async `createDeliveryInvoice` **without awaiting** inside `forEach`. Consequences: (a) the
`Created N invoices` toast counts optimistically before any invoice exists; (b) it ignores the
per-stop `stop.ordId` link, so two same-account stops in one run produce an invoice for only one
order (the other is skipped after the first flips `invoiceStatus` — or double-invoices the same
order if the flip hasn't landed, though the `_deliveryInvInFlight` guard covers the same-ordId
case only); (c) N concurrent invoice-number transactions are safe server-side but each failure
falls back to the collision-prone cache path.

### 4.5 `today_run.date` staleness
`addStop` (`app.js:9214`) and `toggleStop` (`app.js:9240`) fetch `DB.obj('today_run',
{date:today(), stops:[]})` — the default only applies when `today_run` is null. A run left over
from yesterday keeps its old `date`; only `clearRoute` resets it (`app.js:9553`). Downstream
users of `run.date`: wix `runName` (`app.js:9272`), `clearRoute` order matching (`app.js:9519,
9524`), archived `runs.date` (`app.js:9545`). Orders themselves always use `today()`, so a
multi-day run desynchronizes date-matched cleanup (see §4.2).

### 4.6 Entry points into the route builder
- Dashboard "View Route →" and legacy `nav('delivery')` (`app.js:302`).
- Account card / detail: `addAccountToRun(accountId)` (`app.js:9094-9105`) navigates, switches tab,
  and prefills the add-stop form (does not add the stop).
- Territory map run mode (see §7).
- Account deletion scrubs the account's stops out of `today_run` and archived `runs`
  (`app.js:5543-5548`).

---

## 5. Cross-section flow: how delivery invoices enter the Invoices tab

1. Created as `retail_invoices` docs with `status:'draft'`, `source:'delivery_run'`,
   `invoiceNumber` (note: **no `number` field**) — `app.js:9397-9405`.
2. Invoices page unified list `renderInvUnifiedList` (`app.js:15745-15843`) pulls them via
   `_allPurplInvoices()` (`app.js:47-50`, merges `retail_invoices` + legacy `iv` invoices);
   row number falls back `x.number || x.invoiceNumber` (`app.js:15762`).
3. Row actions: **Preview** `openInvoicePreview('purpl',id)` (`app.js:13066`), **Edit**
   `openInvModal(id)` (`app.js:2429-2561`), **✓ Paid** `markRetailInvPaid` (`app.js:2693-2702`,
   routes by `_invoiceCol` `app.js:78`), plus `markPaid` (`app.js:15701-15710`) from other
   surfaces.
4. Draft → sent: `markInvoiceSent(id)` (`app.js:16259-16289`) flips status and deducts inventory
   **guarded by `alreadyDeducted`** (`app.js:16265-16266`) — delivery invoices already wrote their
   `iv` 'out' rows at creation, so this correctly avoids double-deduction. Its line reader accepts
   both key shapes (`li.skuId || li.sku`, `app.js:16281`).
5. Delete: `deleteInvoice` (`app.js:16291-16299`) → `deleteInvoiceWithCleanup` (`app.js:87-118`)
   removes the doc, its `iv` 'out' rows by `invoiceId`, `lf_wix_deductions` by `invoiceId`,
   dissolves combined-invoice parents, and scrubs `ac.cadence`. It does **not** reset the linked
   order's `invoiceStatus`, so the order stays "invoiced" with a dangling `invoiceNumber`.

**Bug — editing a delivery invoice zeroes its lines:** `openInvModal` renders line rows via
`_ivRenderLineRows(inv.lineItems)` which matches `x.skuId === sku.id` (`app.js:2580`), but
delivery-run invoices store lines as `{sku, cases, pricePerCase, amount}` (`app.js:9390`), not
`{skuId, …, lineTotal}` (the shape `_saveInvCore` writes, `app.js:16483-16490`). Opening a
`delivery_run` invoice for edit therefore shows all quantities as 0; the save-guard "Enter at
least one case quantity" (`app.js:16493`) prevents data loss but makes these invoices effectively
uneditable without retyping every line. `_invAmt` (`app.js:120`) and the unified list still show
totals correctly (`amount`/`total` fallbacks).

Order-side status tracking (`orders.invoiceStatus`) is a parallel, loosely-coupled state machine
(`setInvStatus` `app.js:2368`, dashboard `renderInvoiceStatus` `app.js:2076`, badge counts
`app.js:7207,7228`); `createDeliveryInvoice` is the only place both sides update atomically.

---

## 6. Cross-section flow: orders → Reports / Projections / Production demand

- **Reports (purpl)**: every report filters through `_repFilterOrders` (`app.js:9914-9917` —
  non-cancelled, `dueDate` within `#rep-date-from/to`, default last 90d `app.js:9908-9912`).
  Revenue `repRevenue` (`app.js:10095-10141`) reprices order items via `_calcPricePerCase`
  (comment MED-4 `app.js:10107-10110`) — i.e. reports derive revenue from **orders × current
  account price**, not from actual invoice totals; historical price changes rewrite reported
  revenue. Same pattern in `repAccounts` (`app.js:10144`), `repSkuPerf` (`app.js:10188`),
  `repProfit` (`app.js:10364`). Top-account/going-cold/MoM report tiles also read raw orders
  (`app.js:9699, 9746, 9784, 9842`).
- **Delivery report** `repDelivery` (`app.js:10034-10049`) reads the archived `runs` collection
  (miles/fuel/cost-per-case captured by the delivery cost modal → `clearRoute` archive
  `app.js:9543-9551`).
- **Projections**: `calcProjections` (`app.js:2746-2798`) and the projections page's
  `calcProjectionsWindow` (`app.js:3013`) infer per-account order cadence from order `dueDate`
  intervals and project 30/60/90-day revenue; delivery-run orders (due date = delivery day)
  therefore directly feed reorder-interval estimates. Dashboard reorder predictions
  (`app.js:1941-1945`) and pending-order value (`app.js:2732`) also read `orders`.
- **Production demand**: `renderProductionRecommendation` (`app.js:8892-8942`) computes 30-day
  projected demand as 90-day order history (by `created`) scaled ×30/90, versus on-hand from the
  `iv` ledger, +20% buffer; "Schedule This Run" pre-fills the shipment modal
  (`_scheduleRecommendedRun` `app.js:8944-8956`).
- **`ac.lastOrder`** written by: `createOrder` (`app.js:8741`), `toggleStop` (`app.js:9286`),
  portal confirm (`app.js:15416-15420`); recomputed on order delete (`app.js:8812-8816`); *not*
  set by Local Line import (`app.js:10864`). Consumed by dashboard attention list
  (`app.js:1756`), account cards (`app.js:3129-3132`, sort `app.js:3275`), account detail
  (`app.js:3458`), AI outreach prompts (`app.js:4088, 5168`), distributor stale-account lists
  (`app.js:6702, 7216`).

---

## 7. Map / route integration & warehouse coords

- Territory map page (`index.html:1893-1915`): **Route Builder Mode** button →
  `toggleMapRunMode` (`app.js:14260-14271`) shows `#map-run-bar` and enables the "+ Add to Run"
  info-window link / marker double-click (`app.js:14072, 14077-14079` — the dblclick path uses
  `eval(opts.runAction)`).
- `mapAddToRun(accountId)` (`app.js:14273-14297`): dedupes by `stop.accountId`, builds a stop
  with `id`, legacy `a.address/a.lat/a.lng` (not the newer `a.locs[]` array used for pins at
  `app.js:14089-14106`), par-derived case quantities (`app.js:14290-14293`), **no lfItems**, and
  appends via `atomicUpdate` to `today_run` (`app.js:14294`). Updates `#map-run-count`
  (`_updateRunModeBar` `app.js:14299-14304`). "View Route →" (`index.html:1904`) →
  `nav('orders-delivery'); switchODTab('route-builder')`.
- Today's stops render as green pins when they carry lat/lng (`app.js:14123-14133`) — only
  map-added stops have coords; `addStop` form stops never do.
- **Warehouse coords from Settings**: inputs `#set-warehouse-radius/lat/lng` loaded in
  `renderSettings` (`app.js:10911-10913`), saved by `saveBusinessSettings` into
  `settings.warehouseRadiusMiles/warehouseLat/warehouseLng` (`app.js:11102-11117`). Sole consumer
  is the map: warehouse pin + delivery-radius circle (`app.js:14190-14215`). The route builder
  does **not** use warehouse coords — there is no Google Directions/route-optimization
  integration anywhere (no waypoint/directions code in `app.js`); "route" is an ordered checklist
  only, and stop order is fixed to insertion order (no drag-reorder).

---

## 8. Findings summary (ranked)

1. **Delivery invoices are uneditable in the invoice modal** — line-item key mismatch
   `sku` vs `skuId` (`app.js:9390` vs `app.js:2580`/`16483`). Edit shows zeros; save is blocked
   by validation. Normalize the line shape at creation or in `_ivRenderLineRows`.
2. **`removeStop`/`clearRoute` reversal still matches by account+date** (`app.js:9490-9498,
   9524-9532`) despite per-stop `ordId` links existing (`app.js:9281`); multi-stop-per-account
   days can delete the wrong order/invoices. `createBatchDeliveryInvoices` has the same
   account+date ambiguity (`app.js:9471`).
3. **`clearRoute` date mismatch**: cleanup matches `created===run.date` (`app.js:9524`) but
   run-orders are stamped `created: today()` (`app.js:9262`); a run rolled past midnight leaves
   orphan orders/invoices. Related: `today_run.date` is never refreshed on a new day (§4.5).
4. **Batch invoicing is fire-and-forget** (`app.js:9466-9478`): unawaited async loop, optimistic
   toast, N parallel number transactions with a collision-prone offline fallback.
5. **`saveNewOrder`'s "Create an invoice now?" doesn't create an invoice** — only flips
   `orders.invoiceStatus` (`app.js:8770-8773`); misleading vs the delivery flow which creates a
   real `retail_invoices` doc.
6. **Deleting an invoice leaves the order marked invoiced** (`deleteInvoiceWithCleanup`
   `app.js:87-118` never touches `orders`); deleting an order leaves its delivery invoice + `iv`
   deductions behind (`app.js:8810` cleans `iv.ordId` rows, but delivery rows use `invoiceId`).
7. **Stops addressed by array index** across toggle/remove/debounce (`app.js:9132, 9145, 9233`);
   unsafe under concurrent multi-device edits of the shared `today_run` config object.
8. Minor: duplicate event wiring for orders filter tabs and `#new-order-btn` (§2); `source:
   'portal'` missing from the orders source-badge map (`app.js:8651-8657`); dead `costs` read
   (`app.js:9355`) and dead `invoice.fulfillmentSource` branch (`app.js:9414`); `eval()` used for
   map pin run-action (`app.js:14078`); un-toggling a stop doesn't restore the previous
   `ac.lastOrder`.
