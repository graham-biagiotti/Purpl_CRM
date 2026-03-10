# purpl CRM — QA Report

Generated: 2026-03-10
Tested by: Claude Code static analysis (full codebase trace)
Files reviewed: `app.js` (4517 lines), `auth.js`, `db.js`, `places.js`, `index.html`, `style.css`

---

## Summary

| Result | Count |
|--------|-------|
| ✅ PASS | 47 |
| ⚠️ PARTIAL | 18 |
| ❌ FAIL | 18 |
| 🔍 UNTESTABLE from code | 6 |
| **Total tests** | **89** |

---

## Critical Issues (fix immediately)

These are ❌ FAIL items that cause crashes, data loss, or silently break core workflows.

### 1. ❌ `repProfit()` crashes with ReferenceError — app.js:3800
The Gross Profit report's chart dataset references the variable `bySkuQty` which is never defined in `repProfit()`. The function defines `bySkuCases` (correct name) and `bySkuRev`, but the chart uses `bySkuQty[s.id]`. Clicking the "Gross Profit" report tab throws `ReferenceError: bySkuQty is not defined` and the entire Reports page crashes.

### 2. ❌ `openDistPO()` function not defined — app.js:2958
`renderDistOrders()` generates a "View" button for each PO with `onclick="openDistPO('${po.id}')"`. This function does not exist anywhere in the codebase. Clicking "View" on any PO in the Orders & Delivery → Distributor Orders tab throws `ReferenceError: openDistPO is not defined`.

### 3. ❌ `saveDistributor()` wipes outreach history and nextFollowup on every save — app.js:1957–1978
The `rec` object built in `saveDistributor()` does not include `outreach`, `nextFollowup`, or `lastContact` fields. It then calls `DB.update('dist_profiles', id, ()=>rec)` which replaces the entire record with `rec`. Every time a distributor is edited, all contact history and the next follow-up date are permanently deleted.

### 4. ❌ Delivery invoice offer banners never appear — app.js:3438, 3508
Both `offerDeliveryInvoice()` and `offerBatchInvoice()` do:
```js
const page = document.getElementById('page-delivery');
```
The actual element ID in the HTML is `page-orders-delivery`. `getElementById('page-delivery')` returns `null`, so the banner is never inserted. The invoice offer after confirming a delivery stop is completely broken.

### 5. ❌ `saveLogOutreach()` for accounts never updates `lastContacted` — app.js:1461–1463
When `kind === 'ac'`, the function appends the outreach entry to `a.outreach` but never writes any date field back:
```js
DB.update('ac', id, a=>({...a, outreach:[...(a.outreach||[]),entry]}));
```
Logging outreach on an account has no effect on the "Last Contacted" display, dashboard Needs Attention panel, or any date-based sort. The same bug applies to `addAccountNote()` (app.js:980) — saving a note does not update any date on the account.

### 6. ❌ `renderDistOrders()` uses `po.created` — field does not exist — app.js:2946
```js
const pos = DB.a('dist_pos').slice().sort((a,b)=>b.created>a.created?1:-1);
```
PO records are stored with `dateReceived`, not `created`. This sort produces arbitrary order. The table column also displays `fmtD(po.created)` which returns `—` for every row. The entire Distributor Orders tab shows blank dates.

### 7. ❌ `repDistributor()` invoice date filter uses wrong field — app.js:3742
```js
const inv = allInv.filter(i=>i.distId===d.id&&i.date>=from&&i.date<=to);
```
Distributor invoices are saved with `dateIssued`, not `date`. The field `i.date` is always `undefined`. The comparison `undefined >= from` is `false`, so **all distributor invoices are always filtered out** in the Distributor report. Invoiced, Paid, and Outstanding columns always show $0 regardless of date range.

### 8. ❌ `mapAddToRun()` creates stops incompatible with delivery renderer — app.js:4497–4506
Stops added via the map run-builder use:
```js
items: (a.skus||[]).map(s=>({sku:s, qty:0}))
```
But `renderDelivery()` reads per-SKU quantities as top-level keys (`s[sk.id]`), not from an `items` array. And `toggleStop()` reads `stop[s.id]` for inventory deduction. Stops added from the map show no quantities, deliver nothing, and deduct zero inventory.

### 9. ❌ Account modal missing Invoices and Outreach tabs
The account view modal (`modal-account`) only has three tabs: **Overview**, **Orders**, **Notes**. There are no Invoices or Outreach tabs, even though outreach is logged via the card buttons. There is no way to view outreach history inside the account modal.

### 10. ❌ `renderAttention()` displays `$$X.XX` for overdue distributor invoices — app.js:302
```js
reason: `$${fmtC(i.total||0)} due ${fmtD(i.dueDate)}`
```
`fmtC()` already returns `$X.XX`. This produces output like `$$150.00 due Jan 15, 2026`. Minor but visible on the dashboard Needs Attention panel for every overdue distributor invoice.

### 11. ❌ `saveAccount()` `par` field: label says "units" but treated as cans — app.js:1098–1107
The par input field label says "units par" with `step="6"` (suggesting 6-packs). But `populateOrderSkus()` (app.js:3028–3030) treats par as cans and divides by `CANS_PER_CASE` to show cases. If a user enters `2` meaning "2 cases", the system interprets it as 2 cans and shows `1 case` par. The input UX does not clarify the unit.

### 12. ❌ Production schedule fields have no save function
`renderTodaySchedule()` (app.js:3204–3216) renders input fields that read from `today_run.items`. But `today_run` is the delivery run object; it has `stops`, not `items`. The save button `#save-run-btn` calls `saveTodayRun()` which writes to `prod_hist` and `iv`, **not** back to `today_run.items`. The production schedule section displays data it cannot write to — fields appear but inputs are never persisted.

---

## High Priority Issues

### 13. ⚠️ `saveDistributor()` also drops `reps`, `pricing`, `pos`, `invoices` — app.js:1973–1975
In addition to outreach (Critical #3), the save also replaces `dist_profiles` with an object that has no back-references to reps or pricing stored in separate arrays. Those are keyed on `distId` and survive — **but** if the distributor `id` ever changes, they would be orphaned. Current code preserves id, so this is partial risk only.

### 14. ⚠️ `renderParInputs({})` called on SKU checkbox change — app.js:4291
```js
qs('#eac-skus').addEventListener('change', ()=>renderParInputs({}));
```
When a user toggles a SKU checkbox while editing an account, `renderParInputs({})` is called with an empty object. Any currently-entered par values are wiped and reset to `24` for all checked SKUs. A user who checks multiple SKUs before setting par levels will keep losing their values.

### 15. ⚠️ Account delete does not clean up orders — app.js:1165–1171
`deleteAccount()` only calls `DB.remove('ac', id)`. Associated orders in `orders`, invoice records in `inv_log_v2`, and inventory deductions tagged `ordId` remain orphaned. Deleted accounts show as "Unknown" throughout orders tables and reports.

### 16. ⚠️ Log Outreach for accounts hides Next Steps fields — app.js:1446–1448
```js
const showExtra = kind === 'pr';
qs('#mlo-nextsteps-row').style.display = showExtra ? '' : 'none';
qs('#mlo-nextdate-row').style.display  = showExtra ? '' : 'none';
```
For accounts, the Next Steps and Next Date fields are hidden. Users cannot schedule a follow-up date when logging outreach for an account. This is inconsistent with the Account Notes tab which does have next-action fields.

### 17. ⚠️ `setInvStatus()` always calls `openOrderDetail()` — app.js:452
```js
function setInvStatus(id, status) {
  ...
  DB.update('orders', id, ...);
  openOrderDetail(id);  // ← always called
  ...
}
```
When "Mark Paid" is clicked from the dashboard Invoice Status panel, the order detail modal opens unexpectedly on top of the dashboard. This happens every time invoice status is changed from anywhere other than the order detail modal itself.

### 18. ⚠️ `renderDelivery()` account selector never refreshes after initial load — app.js:3310–3315
Once the Route Builder tab is visited, `acSel.dataset.loaded = '1'` prevents re-population. If new accounts are added during the same session, they never appear in the delivery stop selector without a full page reload.

### 19. ⚠️ Delivery stop pre-fill overwrites `del-stop-notes` with `dropOffRules` — app.js:3323
```js
if (qs('#del-stop-notes') && ac2.dropOffRules) qs('#del-stop-notes').value = ac2.dropOffRules;
```
This silently replaces any custom note the user may have typed with the account's drop-off rules. The "Notes" field and "Drop-Off Rules" are semantically different but mapped to the same input.

### 20. ⚠️ `renderOrders()` sort uses `b.created>a.created?1:-1` — string comparison — app.js:2969
`created` is a `YYYY-MM-DD` string. String comparison works correctly for ISO dates but breaks if any `created` value is `null` or `undefined` (which can happen for imported orders). Imported Local Line orders that fail `created` date mapping would sort to the bottom silently.

### 21. ⚠️ Account velocity calculation uses first order date as period start — app.js:491
```js
const periodDays = Math.max(7, Math.min(90, acOrds.length>0 ? Math.max(1, daysAgo(acOrds[0].dueDate)) : 90));
```
`acOrds[0]` is the earliest order (sorted ascending). If the first order is old, `periodDays` is capped at 90 anyway. But `totalUnits` counts all recent 90-day orders while `weeklyUnits` divides by `periodDays` (which may be as short as the age of the oldest order). This can produce inflated weekly velocity for accounts that had a gap and recently resumed ordering.

### 22. ⚠️ `repDistributor()` — PO `total` field vs `totalValue` inconsistency — app.js:3741, 2110
`saveDistPO()` stores the total as `totalValue` (app.js:2110). But the distributor report reads:
```js
const poTotal = pos.reduce((s,p)=>s+(p.total||0),0);
```
Field is `totalValue`, not `total`. The Distributor report always shows $0 for PO totals.

### 23. ⚠️ Inventory Log tab only shows finished-pack entries — app.js:2751–2765
`_invLog()` reads only from the `iv` collection. Loose can receipts (in `loose_cans`) and repack jobs are not shown here. The inventory log is incomplete — a user cannot see all inventory movements in one place.

### 24. ⚠️ `repDistributor()` accesses `inv.date` but field is `dateIssued` — also affects total
Same root cause as Critical #7. The `paid` total calculation is also broken:
```js
const paid = inv.filter(i=>i.status==='paid').reduce((s,i)=>s+(i.total||0),0);
```
The `inv` array is always empty due to the broken filter, so `paid` is always $0.

### 25. ⚠️ Stock Locations: transfers use cases, warehouse stock uses cans÷12 — app.js:2816
Warehouse stock seeded via `Math.floor((ins-outs)/CANS_PER_CASE)`. Transfers are in cases. This is consistent within the Locations tab. However, inventory deductions from delivery runs are in CANS (stored in `iv` as cans), so the warehouse display correctly shows cases. But if `ins-outs` is not evenly divisible by 12, fractional cans are silently dropped from the location display.

### 26. ⚠️ `saveSettings()` drops `seeded`, `zapierWebhookUrl`, `known_users` fields — app.js:4163–4168
The settings save reconstructs the object with a spread of "other" fields:
```js
...Object.fromEntries(
  Object.entries(DB.obj('settings',{}))
    .filter(([k])=>!['company','payment_terms',...].includes(k))
)
```
This preserves unknown fields correctly. However, `seeded` is a preserved key not in the exclusion list, so it should be preserved. The logic appears correct but is fragile — adding a new setting key requires updating the exclusion list or it gets duplicated.

### 27. ⚠️ `quickNote()` uses `prompt()` dialogs — three chained prompts — app.js:1414–1422
The "Note" quick action on account cards triggers three sequential browser `prompt()` dialogs (Note text, Next action, Next date). On mobile, browser prompts are difficult to use and non-standard. The similar Log Outreach has a proper modal but `quickNote()` was never upgraded.

### 28. ⚠️ `invAdjust()` uses `prompt()` for manual inventory entry — app.js:2767–2776
The `+ Manual Entry` button in the Inventory Log triggers three `prompt()` dialogs. Same UX issue as above. On mobile this is particularly poor.

### 29. ⚠️ CSV import stores import log in `saved_reports` collection — app.js:4053
Local Line import history is stored in `saved_reports` with `type: 'll_import'`. This pollutes the saved reports list and could interfere with report retrieval if the `saved_reports` list is iterated without type filtering. The import history view correctly filters by type, but `renderSavedReports()` does not filter and would show import logs alongside user-saved reports.

### 30. ⚠️ `parseCSV()` does not handle quoted fields with embedded commas — app.js:2296–2303
```js
const headers = lines[0].split(',').map(...)
return lines.slice(1).map(line=>{
  const vals = line.split(',').map(...)
```
The simple CSV parser in the distributor import modal splits on every comma, breaking values that contain commas (e.g., `"Smith, John"` → two columns). The `_parseLLCSV()` function in the integrations page has a proper quoted-field parser, but the distributor modal's `parseCSV()` does not.

---

## Low Priority Issues

### 31. ⚠️ Hardcoded `/12` in distributor pricing display — app.js:1758
```js
const pricePerCan = pricePerCase ? pricePerCase/12 : null;
```
Should be `pricePerCase / CANS_PER_CASE`. If `CANS_PER_CASE` is ever changed to support a different pack size, this calculation would be wrong.

### 32. ⚠️ `populateOrderSkus()` checks `ac2?.skus?.length` for SKU display — app.js:3024
New accounts created by Local Line import have `skus: undefined` (not set in `importLLOrders`). For such accounts, `populateOrderSkus()` falls back to showing all 5 SKUs — which is fine but inconsistent (newly imported accounts show all SKUs by default).

### 33. ⚠️ `renderFollowUps()` reads last note only for follow-up dates — app.js:334–341
```js
const ln = a.notes[a.notes.length-1];
if (ln?.nextDate && ln.nextDate >= now && ln.nextDate <= in14) {...}
```
Only the **most recent** note is checked for upcoming follow-up dates. If a user has multiple notes with future dates, only the newest is shown. Earlier scheduled follow-ups are invisible.

### 34. ⚠️ Distributor overview tab doesn't show contact email/phone — app.js:1715–1726
`renderDistOverviewHTML()` shows platform type, payment terms, contract start, door count, territory, and notes — but not the distributor's primary contact name, phone, or email. There are no such fields in `editDistributor()` or `saveDistributor()`. Distributor contact info (as opposed to sales rep info) cannot be stored.

### 35. ⚠️ `renderDistDashKPIs()` and `_renderDistListKPIs()` are nearly identical — app.js:2369–2390, 1518–1578
Dashboard distributor KPIs and the distributor page KPIs run the same computation twice on every dashboard render. Minor performance concern; more importantly, if one is updated the other may not be, causing KPI drift.

### 36. ⚠️ `checkMigration()` banner inserts into `page-dashboard` before first render — auth.js:133
`showMigrationBanner()` inserts a `div` as the first child of `#page-dashboard` before `renderDash()` runs. After `renderDash()` runs, it inserts its `#dash-welcome-hdr` as innerHTML of another element, so the banner survives. But if `renderDash()` ever replaces `page-dashboard` innerHTML, the banner would be lost.

### 37. ⚠️ `shipPallet()` reads pallet after `DB.update()` — app.js:2674–2685
```js
DB.update('pallets', palletId, p=>({...p, status:'shipped', ...}));
const p = DB.a('pallets').find(x=>x.id===palletId);
Object.entries(p?.contents||{}).forEach(...)
```
This reads the updated record back from cache to get `contents`. Since `DB.update()` mutates `_cache` synchronously, this works correctly. However, if `p` is `null` after the update (edge case), `p?.contents||{}` silently logs no inventory deductions. No guard or toast warns the user.

### 38. ⚠️ Mobile: `modal-close` buttons are `<button class="btn sm">✕</button>` — some as small as 28px
In the Account modal header: `<button class="modal-close btn sm">✕</button>`. The `btn sm` class applies smaller padding. On mobile @media, `.btn` gets `min-height: 44px` but `btn sm` may override this. The `modal-close` buttons in the header area lack explicit height enforcement and may fall below 44px on some modals. The account card action buttons are correctly enforced at 44px.

---

## Passing Features

### AUTH
- ✅ Google Sign-In flow — `signInWithPopup` called correctly; error message shown on failure
- ✅ Email/password sign-in — validates non-empty fields, disables button during attempt, shows error code on failure
- ✅ Enter key submits sign-in — `keydown` listener on password field calls `signInBtn.click()`
- ✅ Sign-out — confirm dialog, then `signOut(auth)`; `onAuthStateChanged` returns to auth screen
- ✅ Auth state persistence — Firebase IndexedDB persistence enabled; `onAuthStateChanged` handles reload
- ✅ Redirect to sign-in when unauthenticated — app shell hidden; auth screen shown
- ✅ All data reads/writes happen after `onAuthStateChanged` fires — `DB.init()` called inside auth callback
- ✅ All users share same data path — Firestore path is `workspace/main/data/store` (not scoped by UID)
- ✅ Legacy per-UID data migration — `_migrateFromLegacyPath()` handles old `users/{uid}/data/store` path

### DASHBOARD
- ✅ KPI cards load from Firebase — Revenue (30d), Active Accounts, Open Prospects, Alerts all calculate correctly
- ✅ Needs Attention — correctly identifies accounts with no order in 30+ days, low-stock SKUs, overdue prospect follow-ups, overdue distributor invoices (display bug noted above), distributors with no contact in 60+ days
- ✅ Upcoming Follow-ups — pulls from account notes AND prospect `nextDate`, filters to next 14 days, shows correct countdown
- ✅ Revenue Projections — calculates 30/60/90d projections from order cadence per account; notes how many accounts have data
- ✅ Store by Store Velocity — weekly units calculated correctly per SKU per account from last 90 days
- ✅ Quick Notes — saves with author (email) and timestamp, shows on reload, delete works, shows 8 most recent
- ✅ Pending Orders panel — shows pending orders sorted by due date, reschedule works
- ✅ Empty states — all panels show empty state messages when no data exists

### ACCOUNTS
- ✅ Add Account — all fields save correctly; new `uid()` assigned
- ✅ Edit Account — existing notes, outreach, lastOrder preserved via `existing?.notes||[]` etc.
- ✅ Delete Account — removed from `ac` collection; modal closes
- ✅ Address autocomplete — `PlacesAC.attach()` called on address inputs; lat/lng captured via `PlacesAC.getCoords()`
- ✅ Multiple locations — add/remove works; location rows rendered correctly; first location's address/lat/lng promoted to top-level for map compatibility
- ✅ Expandable locations on card — `toggleAcLocs()` shows/hides drawer, button text toggles ▼/▲
- ✅ Delivery rules visible on account cards — shown when `locs[0].dropOffRules` exists
- ✅ Account view modal — Overview, Orders, Notes tabs load correct data
- ✅ Account card action buttons — View, Note, Outreach, + Run, Edit all visible without hover
- ✅ Account sort and filter — name, lastOrder, lastContacted, territory sorts; type filter all work
- ✅ Par level display in order form — converts par cans to cases correctly

### PROSPECTS
- ✅ Add/Edit Prospect — all fields save; notes/outreach/lastContact preserved on edit
- ✅ Delete Prospect — removes cleanly from `pr`
- ✅ Stage badges — correct colors per stage
- ✅ Priority badges — correct colors (high=red, medium=amber, low=gray)
- ✅ 30+ day warning — `nextDate < today()` colors next follow-up date red
- ✅ Convert to Account — carries over ALL fields including outreach history, notes, contact info, address, lat/lng; uses `DB.atomicUpdate()` (single Firestore write); marks prospect as `won`
- ✅ Quick Log Follow-Up — saves outreach entry, updates `lastContact`, updates `nextAction`/`nextDate` if provided
- ✅ Next Steps box — always visible on card, shows next action and date, tapping opens outreach modal

### ORDERS & DELIVERY
- ✅ Route Builder — add stop with account pre-fill works; par values convert to cases; stop persisted to `today_run`
- ✅ Today's Run — shows stops with delivery rules in orange box; checkbox toggles done state
- ✅ Confirming a stop — atomic write covering: today_run updated, account `lastOrder` updated, inventory deducted in cans (`qty × CANS_PER_CASE`), delivery order created in cases; all four in single `DB.atomicUpdate()`
- ✅ Manual order entry — `createOrder()` called with source='manual'; atomically creates order AND updates `lastOrder` on account
- ✅ Invoice creation prompt after manual order — `confirm2()` offered; calls `setInvStatus()`
- ✅ Order source badges — run/manual/import/local_line/distributor all defined and displayed
- ✅ `CANS_PER_CASE` constant used for all conversions — inventory deductions use `× CANS_PER_CASE`; one hardcoded `/12` found (see Low Priority #31)
- ✅ Order status cycle — pending → confirmed → in_transit → delivered; inventory deducted on non-run orders reaching delivered
- ✅ Reschedule order — prompt for new date, updates `dueDate`
- ✅ Delete order — removes linked `iv` entries by `ordId`; renders orders and inventory

### INVENTORY
- ✅ Stock summary — correct on-hand from `iv` in/out; loose cans from `loose_cans`; pallets counted
- ✅ Receive loose cans — saved to `loose_cans` collection with sku, qty, source, date
- ✅ Receive finished packs — saved to `iv` with type='in'; correct collection
- ✅ Repack jobs — deducts from `loose_cans` FIFO; adds to `iv` as type='in'; job record saved
- ✅ Pallet tracker — create/edit/ship works; ship deducts from `iv`; edit preserves status
- ✅ Packaging supplies — add/edit/delete works; reorder point flag shown when qty ≤ reorderPoint
- ✅ Manual inventory adjustment — `invAdjust()` pushes to `iv`; updates summary
- ✅ Stock locations table — warehouse auto-created; transfers applied to location balances; shows cases
- ✅ Delete inventory entry — removes from `iv`

### DISTRIBUTORS
- ✅ Add Distributor — all form fields save correctly
- ✅ Sales reps tab — add/edit/delete reps; all fields (name, title, phone, email, territory, lastContacted, notes) save
- ✅ Pricing tab — per-SKU price/case saves to `dist_pricing`; margin calculated correctly; "Pending" badge when not set
- ✅ Invoices tab — add invoice saves to `dist_invoices`; mark paid updates status and `paidDate`; delete works
- ✅ Store Coverage tab — add/edit/delete chains; SKU authorization checkboxes save; total doors calculated
- ✅ Outreach/Contact Log tab — shows history sorted newest-first; Log Contact button works
- ✅ Log Contact (Quick button on card) — saves to `d.outreach` array; updates `nextFollowup` if provided
- ✅ Distributor delete — removes profile AND all related reps, pricing, POs, invoices, chains, imports
- ✅ KPI cards on distributor list and dashboard — active count, total doors, outstanding invoices, last PO all calculated

### PROJECTIONS
- ✅ Revenue scenarios (75/100/125%) — multiplied correctly from base projection
- ✅ SKU demand forecast — weekly velocity × 30/60/90 days
- ✅ Production planning table — shows stock vs 30d demand, gap flagged in red
- ✅ Account velocity table — sorted by avg order value
- ✅ Distributor demand forecast — calculates from PO history; next PO estimate shown
- ✅ Velocity window selector — `calcProjectionsWindow(windowDays)` re-runs on dropdown change

### REPORTS
- ✅ Revenue by SKU report — correct revenue, COGS, GP, margin per SKU
- ✅ Account Performance report — revenue per account, % of total
- ✅ Inventory report — on-hand, received, shipped, COGS value per SKU
- ✅ Date range filter — both from/to inputs trigger re-render via event listeners
- ✅ Export CSV — correct format, filename includes report type and date range
- ✅ Save/load report configuration — saves to `saved_reports`; loads back date range and type
- ✅ Chart rendering — Chart.js used correctly; old chart destroyed before new one created

### SETTINGS
- ✅ Company name and payment terms — saves and loads correctly
- ✅ COGS per SKU — saves to `costs.cogs`; used in margin calculations throughout
- ✅ Variety pack recipe — saves to `settings.variety_recipe`; validates total = `CANS_PER_CASE`; validation message shown real-time
- ✅ Production lead time — saves to `settings.production_lead_time`
- ✅ Territory defaults — saves; fields load on `renderSettings()`
- ✅ Units display panel — shows `CANS_PER_CASE` value (12)
- ✅ Overhead and target margin — saves to `costs.overhead_monthly` and `costs.target_margin`

### MAP
- ✅ Map hidden with message when no Google Places key configured
- ✅ Account pins at lat/lng from each location (multi-location accounts get multiple pins)
- ✅ Prospect pins appear for non-won/non-lost prospects with lat/lng
- ✅ Today's run stop pins appear if stops have lat/lng
- ✅ Layer filter tabs switch between all/accounts/prospects/run correctly
- ✅ Info window on pin click — shows name, sub text, View link
- ✅ Run mode — toggle adds "Add to Run" link in info windows; dblclick adds to run
- ✅ `mapAddToRun()` checks for duplicates before adding
- 🔍 UNTESTABLE: Cannot verify Google Maps actually loads or renders pins without live API key

### INTEGRATIONS / LOCAL LINE
- ✅ Local Line CSV import — proper quoted-field parser; auto-detects column names; fuzzy SKU mapping
- ✅ Duplicate detection — skips rows with same date+buyer+sku+qty already imported
- ✅ Import history shows past imports with record counts
- ✅ New accounts auto-created for unknown buyers
- 🔍 UNTESTABLE: Zapier webhook endpoint — only stores URL; no actual webhook handler exists server-side (correct for a static app)

### MOBILE
- ✅ Bottom nav — 5 correct items: Home (dashboard), Accounts, Prospects, Today (delivery), Inventory
- ✅ Hamburger menu opens sidebar overlay
- ✅ Sidebar closes after navigation on mobile (`window.innerWidth < 768` check)
- ✅ Account card action buttons — enforced at `min-height: 44px` via `.ac-card-actions .btn`
- ✅ General `.btn` — `min-height: 44px` in mobile media query
- ⚠️ Modal close buttons in headers use `btn sm` which may not reach 44px on all modals (see Low Priority #38)
- 🔍 UNTESTABLE: Cannot verify modal scroll behavior, one-handed usability, or actual touch target sizes without device testing

### DATA INTEGRITY
- ✅ `CANS_PER_CASE = 12` defined as single constant at app.js:10
- ✅ All delivery inventory deductions use `× CANS_PER_CASE` (no hardcoded `* 12` found except one display-only `/12` at line 1758)
- ✅ No Firebase calls before auth — `DB.init()` only called inside `onAuthStateChanged` callback
- ✅ No data scoped under UIDs — all data at `workspace/main/data/store`
- ✅ Edit Account preserves notes/outreach/lastOrder — explicitly carried over in `saveAccount()`
- ✅ Edit Prospect preserves notes/outreach/lastContact — read from DB at save time
- ✅ Convert Prospect → Account is atomic (`DB.atomicUpdate()`)
- ✅ Finish delivery stop is atomic (4 collections in one write)
- ❌ Edit Distributor does NOT preserve outreach/nextFollowup (Critical #3)
- ❌ Delete Account does NOT clean up related orders (High Priority #15)

---

## Recommended Fix Order

Based on impact on daily operations:

### Immediate (blocks core workflows)
1. **Fix `repProfit()` — rename `bySkuQty` → `bySkuCases`** (1-line fix; crashes entire Reports page)
2. **Fix `offerDeliveryInvoice()` / `offerBatchInvoice()` — change `page-delivery` → `page-orders-delivery`** (2-line fix; post-delivery invoicing is completely broken)
3. **Fix `saveLogOutreach()` for accounts — add `lastContacted: date` to the update** (1-line fix; every outreach log fails to update contact date)
4. **Fix `addAccountNote()` — update account `lastContacted` when note saved** (similar 1-line fix)
5. **Fix `saveDistributor()` — preserve `outreach`, `nextFollowup` fields** (prevents data loss on every distributor edit)
6. **Define `openDistPO()` function or fix the button** (crashes on click; simple fix — either define function or change to `openDistributor(distId)`)

### High Priority (affects data accuracy)
7. **Fix `repDistributor()` — change `i.date` → `i.dateIssued` in invoice filter**
8. **Fix `repDistributor()` — change `p.total` → `p.totalValue` in PO total**
9. **Fix `renderDistOrders()` — change `po.created` → `po.dateReceived`**
10. **Fix `mapAddToRun()` — use top-level sku keys (`stop[s.id]`) instead of `items` array**
11. **Fix `renderAttention()` — remove leading `$` from before `fmtC()` call**

### Medium Priority (data completeness)
12. **Add Invoices and Outreach tabs to Account modal**
13. **Fix `renderParInputs` call — pass `a` object not `{}` in SKU checkbox event listener**
14. **Fix `setInvStatus()` — only call `openOrderDetail()` when modal is already open**
15. **Clarify par input unit label** — make it clear par is entered in cans

### Lower Priority (UX)
16. **Replace `quickNote()` and `invAdjust()` `prompt()` chains with modals**
17. **Fix `_invLog()` to include loose can and repack movements**
18. **Fix CSV import dedup** — the distributor-modal `parseCSV()` doesn't handle quoted commas
19. **Replace hardcoded `/12` at app.js:1758 with `/ CANS_PER_CASE`**
20. **Add `account` delete cascade** — remove orphaned orders when account is deleted

---

*Report generated by full static code analysis. All line numbers reference `public/app.js` unless otherwise noted.*
