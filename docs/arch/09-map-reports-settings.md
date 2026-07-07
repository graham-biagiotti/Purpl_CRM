# 09 — Territory Map, Reports, Settings, Integrations

Read-only architecture review. All paths relative to repo root. Primary files:
`public/app.js` (17,009 lines), `public/index.html`, `public/places.js`, `public/db.js`, `functions/index.js`.

Storage model (context for everything below): db.js persists all config objects
(`settings`, `costs`, `today_run`, `invoice_settings`, `api_settings`, `shipstation_settings` —
`OBJ_KEYS`, db.js:51) inside the single Firestore doc `workspace/main` (db.js:67).
Entity "collections" (`ac`, `pr`, `orders`, `iv`, `retail_invoices`, `lf_invoices`,
`combined_invoices`, `dist_*`, `runs`, `saved_reports`, …) are subcollections under it.

---

## 1. TERRITORY MAP (`#page-map`, index.html:1893–1917)

### 1.1 Init

- Nav entry: `renders.map = renderMap` (app.js:304).
- `renderMap()` app.js:14009 — gates on `window.GOOGLE_PLACES_KEY` (set in
  `firebase-config.js`; missing key shows `#map-no-key` placeholder, index.html:1910).
  Loads Maps JS via `PlacesAC.load()` (places.js:32–59, script tag with
  `libraries=places`), then creates `google.maps.Map` on `#map-canvas` centered on
  Boston (42.3601,-71.0589), zoom 9 (app.js:14020–14026). Instance cached in module
  globals `_mapInstance/_mapMarkers/_mapRunMode/_mapDistLayers/_mapCoverageOverlays`
  (app.js:14002–14007); re-entry only re-renders pins (app.js:14018).

### 1.2 Buttons / handlers (index.html:1895–1907)

| Control | Handler | file:line |
|---|---|---|
| "Route Builder Mode" `#map-run-mode-btn` | `toggleMapRunMode()` | app.js:14260 |
| "↺ Refresh" | `renderMap()` | app.js:14009 |
| "View Route →" (run bar) | `nav('orders-delivery');switchODTab('route-builder')` | app.js:258 |
| Distributor legend checkboxes | `toggleDistMapLayer(distId, checked)` | app.js:14255 |
| Pin info-window "View Account" | `openAccount(id)` | via `opts.action`, app.js:14100 |
| Pin info-window "View Prospect" | `editProspect(id)` | app.js:14117 |
| Pin info-window "View <Dist>" | `openDistributor(id)` | app.js:14103, 14166 |
| Pin "+ Add to Run" (run mode) | `mapAddToRun(id)` | app.js:14273 |

### 1.3 Pin sources (`_renderMapPins()` app.js:14039–14220)

| Pin | Source collection | Filter | Color |
|---|---|---|---|
| Accounts (per-location) | `ac` — `a.locs[]` with legacy fallback `a.lat/a.lng` (app.js:14088–14090) | `status==='active'`, loc has lat/lng | purple `#8b5cf6` direct; amber `#d97706` if `fulfilledBy !== 'direct'` (app.js:14091–14093, colors 14032–14037) |
| Prospects | `pr` | not won/lost, has lat/lng (app.js:14112) | blue `#3b82f6` |
| Today's run stops | `today_run.stops` (app.js:14125) | has lat/lng | green `#10b981` |
| Distributor DCs | `dist_profiles` `dcLat/dcLng` (app.js:14139–14160) | status active/submitted/under_review; per-dist visibility `_mapDistLayers` | 6-color palette, arrow icon, zIndex 999 |
| Dist coverage circle | `d.territoryRadiusMiles` → `google.maps.Circle` (app.js:14173–14185) | radius > 0 | dist color, 7% fill |
| Warehouse | **settings** `warehouseLat/warehouseLng/warehouseRadiusMiles` (app.js:14191–14215) | valid floats | brand purple `#4B2082`, radius circle if set; popup shows `settings.address` (app.js:14202) |

Legend rendered by `_renderDistMapLegend()` app.js:14227.

### 1.4 Route planning (map run mode)

- `toggleMapRunMode()` app.js:14260 flips `_mapRunMode`, shows `#map-run-bar`, re-renders pins.
- `mapAddToRun(accountId)` app.js:14273 — appends a stop to `today_run.stops` via
  `DB.atomicUpdate` (app.js:14294), pre-filling per-SKU case qty from `a.par` (cans → cases,
  app.js:14290–14293); dedupes by `accountId` (app.js:14277).
- The stop then flows into the Delivery/Route-Builder pipeline: `renderDelivery()`
  app.js:9116, `addStop()` app.js:9197, `toggleStop()` app.js:9234 (marks delivered → creates
  `orders` record source `'run'` + optional `lf_wix_deductions`), `createDeliveryInvoice()`
  app.js:9377 (writes `retail_invoices` + `iv` out-entries), `clearRoute()` app.js:9512
  (archives to `runs` — the data source for the Delivery report §2.4).
- Delivery cost modal (`openDeliveryCostModal` app.js:9562) reads **settings** `mpg`
  (app.js:9565) and `gasPrice` (app.js:9566); `saveDeliveryCost` app.js:9584 writes
  `milesDriven/fuelCost/costPerCase` onto `today_run`.

**Findings**

- `eval(opts.runAction)` on marker dblclick (app.js:14078) — eval of a built string; works
  because ids are internal, but it's an injection-shaped pattern (same for inline
  `onclick="${opts.action}"` in info-window HTML, app.js:14070–14072).
- `mapAddToRun` reads legacy top-level `a.address/a.lat/a.lng` (app.js:14283–14285), not
  `a.locs[]` — accounts migrated to multi-location get a run stop **without coordinates**,
  so it renders in the route builder but never as a green map pin (filter app.js:14126).
- No geocoding happens on the map page itself; coords are captured at save time:
  account locations app.js:5463, prospects app.js:5957, distributor DC app.js:7405 — all via
  `PlacesAC.getCoords` (places.js:130) which prefers autocomplete `dataset.lat/lng`
  (places.js:84–85) and falls back to `geocode()` (places.js:105). Autocomplete is attached
  to the fixed id list `ADDRESS_FIELD_IDS` (places.js:144–150, includes `del-stop-addr`).

---

## 2. REPORTS (`#page-reports`, index.html:964–1135)

### 2.1 Entry + brand/date handling

- `renders.reports = renderReports` (app.js:306). `renderReports()` app.js:9618:
  - Injects combined KPI "Total Invoiced (All Brands)" from `_allInvoices({excludeChildren:true})`
    minus void (app.js:9632–9637) — `_allInvoices` app.js:52 merges `retail_invoices` +
    legacy `iv` invoices + `lf_invoices` + `combined_invoices` + `dist_invoices`.
  - Defaults date range to last 90 days (app.js:9641–9644); builds `#rep-year-filter`
    (cur year, prev year, all — app.js:9647–9653).
  - Wires report-type tabs once via `dataset.wired` (app.js:9656–9669); date inputs
    re-render on change (app.js:9667–9668).
- Brand toggle buttons `setRepBrand('purpl'|'lf')` (index.html handlers, app.js:9608) swap
  `#rep-purpl-section` / `#rep-lf-section`; LF branch calls `renderLfReports()`.
- Date filter core: `_repDateRange()` app.js:9908; `_repFilterOrders()` app.js:9914 filters
  `orders` by `status!=='cancelled' && o.dueDate>=from && o.dueDate<=to` — **orders with no
  `dueDate` are silently excluded**, and the range is on dueDate not created date.

### 2.2 Buttons

| Button (index.html §reports) | Handler | file:line |
|---|---|---|
| Brand: 💜 purpl / 🪻 LF | `setRepBrand()` | app.js:9608 |
| 9 type tabs (`data-rep`) | tab listener → `renderReportContent()` | app.js:9659, 9980 |
| ⬇ CSV | `exportReportCSV()` | app.js:10433 |
| 🖨 Print | `window.print()` | inline |
| 💾 Save | `saveReport()` | app.js:10498 |
| 📊 Year-End Export | `exportYearEnd()` | app.js:10446 |
| Saved-report chip / ✕ | `loadSavedReport(id)` / `deleteSavedReport(id)` | app.js:10523 / 10535 |
| LF period 30/60/90/all | `setLfRepPeriod(days)` | app.js:10543 |
| LF ⬇ CSV ×4 | `exportLfReportCSV('sku'\|'accounts'\|'outstanding'\|'wix')` | app.js:10662 |

### 2.3 Data source per report (orders vs invoices)

Dispatcher `renderReportContent()` app.js:9980 → handler map (app.js:9982–9992).

| Report | Function | Collections read | Basis |
|---|---|---|---|
| Revenue & Sales | `repRevenue` app.js:10095 | `orders` (date-filtered), `ac`, `costs` | **orders**, priced by `_calcPricePerCase(account)` fallback `PURPL_DIRECT_PER_CASE` (app.js:10110–10114); COGS per can × `CANS_PER_CASE` |
| Account Performance | `repAccounts` app.js:10144 | `orders`, `ac`, `costs` | **orders** (active accounts only, app.js:10151) |
| SKU Performance (tab) | `repSkuPerf` app.js:10187 | `orders`, `ac` | **orders**, cases only |
| Inventory | `repInventory` app.js:10242 | `iv` ledger, `costs`; on-hand via `_onHand` (app.js:10251) | inventory ledger |
| Distributor | `repDistributor` app.js:10272 | `dist_profiles`, `dist_pos` (by `dateReceived`), `dist_invoices` (by `dateIssued`), `d.velocityReports` (app.js:10312–10335) | **dist POs + dist invoices** |
| Gross Profit | `repProfit` app.js:10363 | `orders`, `ac`, `costs` (incl. `overhead_monthly` app.js:10397) | **orders** |
| Win/Loss | `repWinLoss` app.js:10052 | `pr` (won/lost, `lostReason`) | prospects |
| Returns | `repReturns` app.js:9997 | `returns` (own date filter, app.js:10000) | returns |
| Delivery | `repDelivery` app.js:10034 | `runs` (archived by `clearRoute` app.js:9543) | run history — **ignores the date range entirely** |
| Top 10 Accounts | `renderTopAccountsReport` app.js:9695 | `orders` (all-time, non-cancelled), `ac`; revenue via `calcOrderValue` app.js:1744 | orders |
| Going Cold | `renderGoingColdReport` app.js:9736 | `orders` (last order by `dueDate`, app.js:9754), outstanding from `_allInvoices` excl. paid/void/draft (app.js:9759) | orders + invoices |
| Month over Month | `renderMomReport` app.js:9780 | `orders`, bucketed by `o.dueDate \|\| o.created` (app.js:9797), 24 months | orders |
| SKU Perf (bottom card) | `renderSkuPerformanceReport` app.js:9838 | `orders` all-time | orders |
| LF Reports | `renderLfReports` app.js:10556 | `lf_invoices` (paid for revenue/SKU/account; non-paid/void/draft for outstanding, app.js:10558–10567), `lf_wix_deductions` (app.js:10645) | **LF invoices** (not orders) |

Key asymmetry: all purpl revenue reports price from **orders × current account pricing**
(retroactive — a price change rewrites history), while the page-top combined KPI, LF
reports, and the year-end export come from **invoice** records. These can legitimately
disagree.

### 2.4 CSV exports

- `exportReportCSV()` app.js:10433 exports the cached `_reportData` (headers+rows) set by
  the last handler. **Bug-shaped gap:** `repReturns`, `repWinLoss`, `repDelivery` never set
  `_reportData` (no assignment in app.js:9997–10092), so clicking ⬇ CSV on those tabs
  downloads the *previous* report's rows under a filename claiming the current type
  (`purpl-report-${_reportType}-…`, app.js:10440).
- `exportYearEnd()` app.js:10446 — cash-basis tax export, filtered by paid date
  (`paidDate || paidAt`, year dropdown `#rep-year-filter`):
  - purpl: `_allPurplInvoices()` (app.js:47 — `retail_invoices` + legacy invoices living in
    `iv`) where `status==='paid' && !combinedInvoiceId` (app.js:10453);
  - LF: `lf_invoices` same filter (app.js:10461);
  - combined: `combined_invoices` → two rows (purpl/LF subtotals, app.js:10469–10475);
  - distributor: `dist_invoices` (app.js:10478, the "DM-1 FIX").
- `exportLfReportCSV(section)` app.js:10662 recomputes from `lf_invoices` /
  `lf_wix_deductions` (independent of `_reportData`).
- Saved reports: `saveReport` app.js:10498 pushes `{name,type,from,to}` to `saved_reports`;
  the Local Line importer **also logs into `saved_reports`** with `type:'ll_import'`
  (app.js:10869) — mixed-purpose collection; `renderSavedReports` doesn't filter that type
  out (app.js:10511), so LL import logs appear as clickable "saved reports".

---

## 3. SETTINGS (`#page-settings`, index.html:1256–1660)

### 3.1 Entry + admin gating

- `renders.settings = () => { renderSettings(); loadShipStationSettings(); }` (app.js:308).
- `renderSettings` is monkey-patched (IIFE app.js:15681–15689) to also run
  `renderPortalSettings()`, `loadInvoiceSettings()`, `loadApiSettings()`.
- `renderSettings()` app.js:10897 hides all `button.primary/button.green` on the page for
  non-admins (app.js:10899–10904). Role model: `_isAdmin()` app.js:180 =
  `window._userRole === 'admin'`; `_requireAdmin(action)` app.js:329 toasts and blocks.
- **Enforcement gap:** only `saveSettings` (app.js:11055, itself dead — no caller anywhere
  in index.html/app.js), `saveInvoiceSettings` (app.js:16302), `toggleUserRole`
  (app.js:11010) and `inviteEmployee` (app.js:11020) call `_requireAdmin`.
  `saveBusinessSettings` (11102), `saveInventorySettings` (11121), `saveEmailSettings`
  (11155), `savePortalSettings` (15608), `saveShipStationSettings` (464) rely purely on the
  hidden buttons — trivially invokable from console by an employee.

Tab switching: `[data-stab]` buttons wired in `renderSettings` (app.js:10975–10985);
`audit` tab → `renderAuditLog()` app.js:9920 (reads `audit_log`, last 100, filters
`#al-filter-action`/`#al-filter-type`); `team` tab → `renderTeamTab()` app.js:10988.

### 3.2 Buttons per tab

| Tab | Button | Handler | Writes |
|---|---|---|---|
| Business Info | Save Business Info | `saveBusinessSettings()` app.js:11102 | `settings`: company, address, phone, website, ein, default_state, default_account_type, default_payment_terms, warehouseRadiusMiles, warehouseLat, warehouseLng |
| Invoicing | ⚡ Test Stripe Connection | `testStripeConnection()` app.js:16344 | none (calls CF `stripeStatus`, functions/index.js:913) |
| Invoicing | Save Invoicing Settings | `saveInvoiceSettings()` app.js:16301 | `invoice_settings`: fromName, fromEmail, fromAddress, terms, nextInvoiceNum, footerNotes, legalTerms, stripeLink, achRouting, achAccount, checkInstructions |
| Invoicing (portal card) | Save Portal Settings | `savePortalSettings()` app.js:15608 | Firestore `portal_config/main` **and mirrors to** `portal_settings/config` (app.js:15624–15626): mode, pricePerCase, portalPassword, deadlineEnabled, deadline, launchDate |
| Invoicing (portal card) | deadline checkbox | `togglePortalDeadline()` app.js:15564 | UI only |
| Invoicing (portal card) | View Order Forms / Preview Form | `nav('pre-orders')` / `window.open('/order')` | none |
| Email | Save Email Settings | `saveEmailSettings()` app.js:11155 | `settings.emailSignature` |
| Inventory & Production | Save Inventory & Production | `saveInventorySettings()` app.js:11121 | `settings`: lowStockThreshold, defaultProdRunSize, production_lead_time, mpg, gasPrice, variety_recipe; `costs`: cogs (only entered values — MED-5 comment app.js:11142), overhead_monthly, target_margin |
| Inventory (LF SKUs) | + Add SKU / Save / Archive / variants | `addLfSku`, `saveLfSkuRow`, `toggleLfSkuArchive`, `addLfVariant`, `saveLfVariantRow`, `toggleLfVariantArchive`, `deleteLfVariant` (app.js:11497ff) | `lf_skus` |
| Inventory | Import NEM Show / Trade Show | `importNEMShowAccounts()` app.js:11422 / `importTradeShowProspects()` app.js:11333 | `ac`/`pr` + `settings.nem_show_2026_imported` / `tradeshow_2026_imported` flags (cards hidden once set, app.js:10953–10956) |
| Integrations (tab) | Save ShipStation Settings | `saveShipStationSettings()` app.js:464 | `shipstation_settings`: storeId, fromAddress |
| Integrations (tab) | ⚡ Test Connection | `testShipStationConnection()` app.js:477 | none (CF `shipStationStatus`, functions/index.js:1338) |
| Integrations (tab) | Save Integrations | `saveApiSettings()` app.js:16375 | **no-op** — toasts "AI key is now managed via Firebase secrets"; `#set-anthropic-key` field is decorative (app.js:16385–16386); admin/locked card swap in `loadApiSettings()` app.js:16379 |
| Team | Send Invite | `inviteEmployee()` app.js:11019 | CF `inviteEmployee` (functions/index.js:815) → `users` collection; audit log |
| Team | Make Admin/Employee | `toggleUserRole()` app.js:11009 | Firestore `users/{uid}.role` |
| Audit Log | filters | `renderAuditLog()` app.js:9920 | reads `audit_log` |

Note `renderTeamTab` (app.js:10993) reads the top-level `users` collection directly
(outside db.js), as do role toggles — the only settings surface not under `workspace/main`.

### 3.3 Settings-key → consumer map (app-wide)

`settings` object (workspace/main):

| Key | Written | Consumers outside Settings UI | Status |
|---|---|---|---|
| `company` | 11071, 11106 | none (invoices use `invoice_settings.fromName`, app.js:12939) | **DEAD** (known) |
| `phone` / `website` / `ein` | 11108–11110 | none (grep: only render 10914–10916) | **DEAD** (known) |
| `address` | 11107 | warehouse map popup app.js:14202 | live (single cosmetic use) |
| `default_state` | 11074, 11111 | none | **DEAD (newly confirmed)** |
| `default_account_type` | 11075, 11112 | none | **DEAD (newly confirmed)** |
| `default_payment_terms` (+legacy `payment_terms`) | 11076/11072, 11113 | `_payTerms()` app.js:18 → invoice due dates 2078, 9356, 9384, and fallback after `invoice_settings.terms` at 2438, 11740, 12414, 15362 | live |
| `warehouseLat/Lng/RadiusMiles` | 11114–11116 | Territory Map warehouse pin/circle app.js:14192–14214 | live (map only) |
| `emailSignature` | 11157 | none — emails use hardcoded `_aiSignature()` app.js:3898 | **DEAD** (known) |
| `lowStockThreshold` | 11078, 11135 | dashboard low-stock KPI/alert app.js:1438–1452 (helper `_lowStock()` app.js:20 itself has zero callers) | live |
| `defaultProdRunSize` | 11136 | none | **DEAD** (known) |
| `production_lead_time` | 11073, 11137 | none | **DEAD** (known) |
| `mpg` | 11079, 11138 | delivery-cost modal prefill app.js:9565 | live |
| `gasPrice` | 11080, 11139 | delivery-cost modal prefill app.js:9566 (helper `_gasPrice()` app.js:19 has zero callers) | live |
| `variety_recipe` | 11077, 11140 | only round-tripped back into the Settings form (10940–10949); production/inventory never read it | **DEAD outside UI (newly confirmed)** |
| `zapierWebhookUrl` | `saveWebhookUrl()` app.js:10715 | display-only in Integrations page (10705–10707); nothing ever POSTs to it and `functions/webhook.js` referenced by the UI does not exist (only functions/index.js) | **DEAD** |
| `known_users` | auth bootstrap | read-only user table app.js:10960–10968 | live |
| `tradeshow_2026_imported` / `nem_show_2026_imported` | importers 11333/11422, restore 11325 | hide import cards 10953–10956 | live (one-shot flags) |
| `data_restored` / `seeded` | `restoreMyData` app.js:11322–11326 | guard app.js:11249 | live (migration flags) |

`costs` object: `cogs` → reports (10122, 10135, 10252, 10389) plus pricing/margin surfaces
(7009, 7576, 8030, 12435) with hardcoded 2.15 fallback everywhere (`_cogs()` helper
app.js:16 has zero callers); `target_margin` → `_margin()`/`_calcPricePerCase`
(app.js:17, 23, 10098, 12436); `overhead_monthly` → repProfit net line app.js:10397 only.

`invoice_settings`: every key has a real consumer — fromName/fromAddress (invoice HTML
12939), fromEmail (send path 16536), terms (2438, 11740, 12414, 15362), nextInvoiceNum
(`getNextInvoiceNumber` transaction 12347–12395, note server copy lives at
`workspace/main.invoice_settings.nextInvoiceNum`), footerNotes (12936), legalTerms
(12703), stripeLink (pay-link fallback 704/711, invoice footer 12674), achRouting/
achAccount (12676), checkInstructions (12677).

`shipstation_settings`: `storeId` live (push 573, sample push 6293);
`fromAddress` **DEAD** — saved/loaded (467/474) but never sent to the CF.

`api_settings`: still in `OBJ_KEYS` (db.js:51) but zero readers/writers in app.js —
legacy of the client-side Anthropic key, now dead.

### 3.4 Portal settings config mirroring

`savePortalSettings` (app.js:15608) double-writes: CRM reads `portal_config/main` via
`PortalDB.getConfig()` (app.js:14344–14353) while the public order form reads
`portal_settings/config` through CF `getPortalConfig` (functions/index.js:444–457) and
`verifyPortalPassword` (functions/index.js:458+). The mirror at app.js:15624–15626 was
widened from password-only to the full public config (comment documents the prior bug
where the order form never saw price/mode). Two-doc design remains a divergence risk —
any other writer to `portal_config/main` won't be mirrored.

---

## 4. INTEGRATIONS (`#page-integrations`, index.html:1136–1255)

Entry: `renders.integrations = renderIntegrations` (app.js:307) — app.js:10701 loads
`settings.zapierWebhookUrl` into the UI and renders LL import history.

### 4.1 Local Line CSV import

- File input `#ll-csv-input` `onchange="handleLLCSV(this)"` (index.html:1159; handler
  app.js:10740) → `_parseLLCSV()` app.js:10748: quote-aware row parser, header auto-detect
  via `LL_COLUMN_MAP` (app.js:10726–10736), groups rows into orders by
  `orderId || buyer+date` (app.js:10796), renders preview and binds `#ll-import-btn`
  onclick → `importLLOrders(orders)` (app.js:10823).
- `importLLOrders()` app.js:10828: gated on `DB._firestoreReady`; find-or-create account in
  `ac` by fuzzy name (`_findAccount`), dedupe on `source==='local_line' &&
  externalId===orderId` (app.js:10843), fuzzy product→SKU map defaulting to `'classic'`
  (app.js:10847–10854), **qty treated as cases** (app.js:10857), writes `orders` with
  `source:'local_line'`, logs into `saved_reports` `type:'ll_import'` (app.js:10869 —
  see §2.4 collision). History list + delete: `_renderLLImportHistory` 10877 /
  `deleteLLImportLog` 10889.
- Zapier card: `saveWebhookUrl()` app.js:10711 → `settings.zapierWebhookUrl`; purely
  aspirational — no sender, and the "already scaffolded" `functions/webhook.js`
  (index.html:1213) doesn't exist.

### 4.2 ShipStation

- Settings: §3.2 (storeId live, fromAddress dead). Secret `SHIPSTATION_API_KEY`
  (functions/index.js:11).
- Push: `pushInvoiceToShipStation(invoiceId, collection)` app.js:520 — resolves the
  invoice from `retail_invoices`/`iv` (`findInvoice` app.js:70), `lf_invoices` or
  `combined_invoices` (a combined parent gathers line items from both children,
  app.js:538–543); ship-to parsed from account address by `_parseAddress` app.js:498;
  calls CF `pushToShipStation` (functions/index.js:1259, V1 Basic auth); on success writes
  `deliveryMethod:'ship'`, `shipStationOrderId`, `shipStationPushedAt` back onto the
  invoice + audit log (app.js:580–586).
- Samples: `pushSampleToShipStation(accountId)` app.js:6277 (SAMPLE-order, no invoice).
- Status loop: CF `shipStationWebhook` (functions/index.js:1369) marks invoices
  `readyToSend`; client `_checkShippedInvoices()` app.js:605 runs on every snapshot and
  shows the green shipped banner (`_showShippedBanner` app.js:618); flag cleared on send
  by `_clearReadyToSend` app.js:651.

### 4.3 Stripe

- No client-side key. Secrets `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`
  (functions/index.js:9–10).
- `testStripeConnection()` app.js:16344 → CF `stripeStatus` (functions/index.js:913),
  renders step-by-step diagnostics into `#stripe-test-result`.
- Pay links: `_getStripePayLink(invoice, type)` app.js:684 → CF `createPayLink`
  (functions/index.js:955); on any failure falls back to the static
  `invoice_settings.stripeLink` (app.js:704, 711) with a sticky error banner. Webhook
  `stripeWebhook` (functions/index.js:1085) marks invoices paid server-side.

### 4.4 Anthropic

- Client: `_callAnthropicApi(userPrompt)` app.js:4017 → CF `callAnthropic` with system
  prompt `_aiSystemPrompt()` (app.js:3896); strips ```json fences and `JSON.parse`s —
  a malformed model reply throws (callers catch and toast).
- Callers: `generateOutreachDraft()` app.js:4100 (per-account Draft Outreach modal, can
  auto-log outreach app.js:4106–4115), `meBroadcastGenerate()` app.js:4867 and
  `meBatchGenerate()` app.js:5171 (mass-email page).
- CF `callAnthropic` (functions/index.js:393–431): requires auth, prompt ≤ 5000 chars,
  key from `process.env.ANTHROPIC_API_KEY` (Firebase secret; note it is **not** declared
  via `defineSecret`/`secrets:[…]` like the others — functions/index.js:7–11 — so it
  relies on env availability), model `claude-sonnet-4-20250514`, max_tokens 1000.
- Settings UI for it is vestigial: `saveApiSettings` no-op toast (app.js:16375),
  placeholder-only key field (app.js:16386).

---

## 5. Consolidated findings (this section's scope)

1. **CSV export of stale data** — Returns/Win-Loss/Delivery report tabs never set
   `_reportData`; ⬇ CSV exports the previous tab's rows under the new report's filename
   (app.js:10433 vs handlers 9997/10052/10034).
2. **Orders-priced vs invoice-priced reports diverge by design** — purpl revenue/profit/
   account reports recompute from `orders` × *current* `_calcPricePerCase` (app.js:10110),
   while the combined KPI, LF reports, and year-end export use invoice records; price
   changes retroactively rewrite report history but not the tax export.
3. **Date-range quirks** — `_repFilterOrders` keys on `dueDate` only (app.js:9916, orders
   without dueDate invisible); Delivery report ignores the range (app.js:10034); MoM
   buckets by `dueDate||created` (app.js:9797) vs Top-Accounts `created||date`
   (app.js:9709).
4. **Admin gating is cosmetic for most save paths** — only 2 of ~8 settings savers call
   `_requireAdmin` (§3.1); the rest depend on hidden buttons.
5. **Dead settings confirmed** — beyond the known set (company/phone/website/ein,
   defaultProdRunSize, production_lead_time, emailSignature): `default_state`,
   `default_account_type`, `variety_recipe` (round-trip only), `zapierWebhookUrl`
   (+ missing `functions/webhook.js`), `shipstation_settings.fromAddress`, the whole
   `api_settings` OBJ_KEY, and dead helpers `_cogs()`/`_gasPrice()`/`_lowStock()`
   (app.js:16–20) plus uncallable legacy `saveSettings()` (app.js:11054).
6. **Portal config double-write** (`portal_config/main` + `portal_settings/config`,
   app.js:15608–15626) is a standing consistency risk despite the current mirror fix.
7. **Map**: `eval()` on marker dblclick + string-built inline onclick handlers
   (app.js:14070–14078); `mapAddToRun` ignores `locs[]` coords (app.js:14283–14285);
   `saved_reports` doubles as the LL-import log (app.js:10869) and those entries render
   as loadable saved reports (app.js:10511).
