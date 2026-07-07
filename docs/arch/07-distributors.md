# 07 — Distributors Tab: Architecture Review

Scope: `renderDistributors`, the distributor detail modal (`openDistributor` + tabs), `dist_profiles`, `dist_pricing`, `dist_pos` (incl. shipment POs), `dist_invoices`, PO status cycling, 30-day forecast, `lastOrderDate`, and every cross-section consumer.

All line numbers refer to `public/app.js` (17,009 lines) and `public/index.html` (3,499 lines) unless noted. This is a single-file vanilla-JS SPA over a cached Firestore wrapper (`public/db.js`): `DB.a(col)` reads the in-memory array cache, `DB.push/update/remove` write one record (db.js:670–689), `DB.atomicUpdate(fn)` mutates the whole cache snapshot and diff-saves as a batch (db.js:691+).

---

## 1. Data model (collections)

| Collection | Written by | Key fields |
|---|---|---|
| `dist_profiles` | saveDistributor (app.js:7443–7444), saveDistShipment (7334–7335, `lastOrderDate`), contact/velocity/outreach subwrites (6806, 6818, 6931, 6943, 6973, 6097) | `name, status, platformType, territory, statesCovered[], dcAddress/dcLat/dcLng, territoryRadiusMiles, radiusType, doorCount, targetDoorCount, contractStart, paymentTerms, paymentTermsDays, reorderCycleDays, lastOrderDate, brandsCarried[], contacts[], outreach[], velocityReports[], nextFollowup, lastContacted, nextSteps, notes` |
| `dist_pricing` | saveDistPricing (7524–7546) | one row per `{distId, sku}`: `pricePerCase, updatedAt` — deleted when price cleared (7535) |
| `dist_pos` | saveDistPO (7593), saveDistShipment (7321) | `poNumber, dateReceived, expectedShipDate, items[{sku,cases}], totalCases, totalValue, status, notes`; shipment POs add `isShipment:true, shipId` (7300–7313) |
| `dist_invoices` | saveDistInvoice (7751–7752), markDistInvoicePaid (7762), reminder stamp (16252) | `distId, distName, invoiceNumber, number, dateIssued, dueDate, poRef, externalRef, items[{sku,cases,pricePerCase}], total, status(draft/sent/paid/void), paidDate/paidAt, reminderSentAt` |
| `dist_reps` | saveDistRep (7508–7509), deleteDistRep (7517) | rep contact info per distributor |
| `dist_chains` | saveDistChain (7819–7820), deleteDistChain (7828) | `chainName, doorCount, authorizedSkus[]` — door counts roll into KPIs |
| `dist_imports` | confirmCSVImport (7940–7943) | CSV-imported order rows (`orderDate, buyerName, sku, qty/cases, value, rawData, source, importDate`) |
| `iv` (inventory ledger, CANS) | saveDistShipment deductions (7322–7333); reversed by deleteDistPO (7626) | `{sku, type:'out', qty(cans), date, pool:'warehouse', source:'dist_shipment', ref:shipId, note}` |

Status vocabularies: `DIST_STATUS` (6380–6389, pipeline order 6390), `DIST_PO_STATUS` (6392–6397), `DIST_INV_STATUS` (6399–6406, legacy `unpaid`/`overdue` retained; `migrateInvoiceStatuses` app.js:13792–13802 remaps them to `sent` on boot).

---

## 2. List page (`#page-distributors`, index.html:386–410)

Route: `distributors: renderDistributors` in the page-render map (app.js:296). Search/status filter inputs re-render via `setupFilters` binding (app.js:11196). `nav('distributors')` + `openDistributor(id)` is also triggered from global search hits (app.js:1229, 1252).

### renderDistributors (app.js:6556–6613)
- Reads `dist_profiles`; filters by `#dist-search` (name/territory) and `#dist-status-filter` (6557–6564); updates `#dist-count` (6566).
- Calls `_renderDistListKPIs()` (6569) then groups cards by pipeline status into `#dist-cards` (6584–6612), with a "No Status" bucket (6604–6610). Shows loading skeleton until `DB._firestoreReady` (6574–6577).

### _renderDistListKPIs (app.js:6409–6488)
Reads `dist_profiles`, `dist_chains`, `dist_pos`, `dist_invoices`. Computes: Active count; Total Doors (chain doorCounts, else profile doorCount, 6420–6423); Cases This Month from `dist_pos` where `dateReceived >= first-of-month` and status ≠ cancelled (6427–6435); **Overdue Reorders** = active dists where `lastOrderDate + reorderCycleDays < today` (6437–6444 — uses `lastOrderDate` only, see §8); Outstanding invoice value excluding paid/draft/void (6424–6425). Needs-Attention panel (`#dist-list-attention`): overdue invoices → `onclick="openDistributor(distId)"` (6460), and "No PO in 60+ days" per active dist (6470–6483).

### Distributor card `_distCardHTML` (app.js:6491–6554)
Reads per-dist `dist_pos`, open `dist_invoices`, `dist_chains`. `lastOrder = d.lastOrderDate || pos[0]?.dateReceived` (6497); next-expected/overdue flag from `reorderCycleDays` (6509–6516). Buttons:

| Button | Handler | Location |
|---|---|---|
| View | `openDistributor(d.id)` | app.js:6548 |
| Log Contact | `logDistContact(d.id)` | app.js:6549 → opens shared `modal-log-outreach` (6616–6637); save path writes `dist_profiles.outreach[] + lastContacted + nextFollowup` (6087–6113), re-renders list + open outreach tab |
| + Invoice | `addDistInvoice(d.id)` | app.js:6550 → `_openDistInvModal` (7648) |
| + Log PO | `addDistPO(d.id)` | app.js:6551 → `_openDistPOModal` (7552) |

Page header button: `+ Add Distributor` → `editDistributor('_new_')` (index.html:400).

---

## 3. Detail modal (`#modal-distributor`, index.html:2560–2598)

### openDistributor(id) (app.js:6645–6673)
Sets `_currentDistId` (declared app.js:245); fills name/status badge; wires tab buttons `[data-dtab]` → `renderDistTab(tab, id)` (6654–6663); wires footer buttons — `#mdist-edit-btn` → close + `editDistributor(id)` (6666), `#mdist-po-btn` → close + `addDistPO(id)` (6667), `#mdist-invoice-btn` → close + `addDistInvoice(id)` (6668); static footer `📞 Log Contact` → `logDistContact(_currentDistId)` (index.html:2592); clicks the first tab (default Overview, 6671) and opens the modal.

`renderDistTab` (6675–6691) dispatches to 10 pane renderers (overview, reps, pricing, orders, invoices, stores, imports, outreach, accounts, velocity). Section scope covers the four core tabs; the others are traced for completeness.

### 3a. Overview tab — renderDistOverviewHTML (app.js:6693–6755)
Reads: linked accounts `DB.a('ac').filter(a=>a.fulfilledBy===d.id)` (6695); open `dist_invoices` for outstanding value (6697–6698); most recent `dist_pos` (6699); outreach for last-contacted (6700–6701); stale linked accounts (no order 30+ days, 6702, warning banner 6740). Last Order = `d.lastOrderDate || recentPO.dateReceived` (6712); Next Expected from `reorderCycleDays` (6713–6719). Buttons/links:
- Linked Accounts count → `_switchDistTab('accounts')` (6735; note the **same "Linked Accounts" row is rendered twice** — 6735 and 6738, duplicate grid cell).
- `+ Add Contact` / per-contact `Edit` → `_openDistContactForm(distId, idx)` (6746, 6754) — injects a raw DOM overlay (6769–6795) with Save → `_saveDistContact` (writes `dist_profiles.contacts`, 6797–6814), Delete → `_deleteDistContact` (6816–6824). Both re-render the overview pane only.

### 3b. Pricing tab — renderDistPricingHTML (app.js:7008–7045)
Reads `dist_pricing` per `{distId, sku}` (7011) and COGS from `costs` config (7009, 7014) to show price/can, margin/can, margin % (thresholds 40%/20%, 7028); unpriced SKUs badge "Pending" (7018).
- **Save Pricing** → `saveDistPricing(distId)` (7043 → 7524–7546): reads every `.dist-price-input[data-dist]`; value > 0 upserts a `dist_pricing` row (update if existing else push, 7530–7533); empty/0 **deletes** the row (7534–7535). Re-renders the pricing pane if visible. Each SKU is an independent single-record write (not atomic across SKUs).

### 3c. Orders/POs tab — renderDistOrdersHTML (app.js:7047–7077)
Reads `dist_pos` for this dist sorted by `dateReceived` desc (7048). Row shows PO#, dates, items (`skuBadge ×cases`), total cases, `totalValue`, status badge. Buttons:

| Button | Handler | Behavior |
|---|---|---|
| 🚚 Log Shipment | `openDistShipmentModal(d.id)` (7068) | opens `#modal-dist-shipment` (index.html:2601–2631) with per-SKU case inputs (7253–7261) |
| + Log PO | `addDistPOInModal(d.id)` (7069) | closes dist modal, opens `#modal-add-po` (7550, index.html:2763–2793) |
| → Next | `cycleDistPOStatus(poId, distId)` (7060) | see below |
| ✕ | `deleteDistPO(poId, distId)` (7061) | see below |

**PO status cycling — cycleDistPOStatus (app.js:7600–7609).** Sequence `pending → fulfilled → partial → cancelled` (7601); `Math.min(i+1, len-1)` makes `cancelled` terminal (no wrap-around; a mis-click into `cancelled` can only be fixed by re-logging). An unknown/legacy status (`indexOf === -1`) advances to `pending`. Single `DB.update('dist_pos')`; re-renders the orders pane if this dist's modal is open. **Cycling has no inventory side effects** — cancelling a shipment PO via cycling does NOT restore the iv deductions (only delete does), and the "Cases This Month" KPI excludes cancelled POs (6431) while the iv ledger still holds the deduction: KPI and stock can disagree.

**Manual PO — saveDistPO (app.js:7570–7598).** Values items against `dist_pricing` (`pricePerCase × cases`, 7577–7582 — unpriced SKUs silently contribute $0 to `totalValue`, unlike the invoice path which warns). Pushes to `dist_pos`, re-opens the dist modal and re-renders the list. **Does NOT touch inventory and does NOT update `lastOrderDate`** (see §8).

**Shipment PO — saveDistShipment (app.js:7266–7345).** Triggered by `Save Shipment` (index.html:2628). Re-entrancy guard `_distShipInFlight` (7265–7269, 2 s window). Builds `items` from `#dship-qty-*` (7276–7279); requires ≥1 case (7281). Values the shipment from `dist_pricing` (7294–7298, comment notes this fixed shipment POs showing $0 in PO-value reports). Then ONE `DB.atomicUpdate` (7320–7336) writes three things:
1. `dist_pos` += PO record with `isShipment:true, shipId` (7321);
2. `iv` += one `type:'out'` entry per SKU, `qty = cases × CANS_PER_CASE (12)`, `pool:'warehouse'`, `source:'dist_shipment'`, `ref:shipId` (7322–7333) — this is the cross-section inventory deduction;
3. `dist_profiles[dist].lastOrderDate = date` (7334–7335).
Refreshes the orders pane if open (7340–7343). Note: the modal's `status` select allows saving a shipment as `pending`/`partial`, but inventory is deducted immediately regardless of status.

**Delete PO with reversal — deleteDistPO (app.js:7611–7633).** `canReverse = po.isShipment && po.shipId` (7616). Confirm text warns for legacy shipment POs that predate `shipId` linking (7619–7620). One `DB.atomicUpdate`: removes the PO and, if reversible, filters out `iv` entries where `source==='dist_shipment' && ref===po.shipId` (7623–7628) — deletion of ledger rows rather than a compensating `in` entry. Does NOT recompute `dist_profiles.lastOrderDate` (stays at the deleted shipment's date). Not admin-gated (unlike deleteDistributor/deleteDistInvoice).

### 3d. Invoices tab — renderDistInvoicesHTML (app.js:7079–7108)
Reads `dist_invoices` for this dist sorted by `dateIssued` desc; outstanding total excludes paid/draft/void (7081). Buttons:
- Invoice # link and `Edit` → `editDistInvoice(invId)` (7085, 7093 → 7699–7703 → `_openDistInvModal(distId, invId)`).
- `✓ Paid` (non-paid rows) → `markDistInvoicePaid(invId, d.id)` (7092).
- `+ Add Invoice` → `addDistInvoiceInModal(d.id)` (7100 → 7646: closes dist modal, opens `#modal-add-dist-invoice`, index.html:2886–2926).

**Invoice modal — _openDistInvModal (app.js:7648–7690).** Populates dist dropdown from all `dist_profiles` (7657–7658; dropdown `onchange` recomputes due date). Invoice # defaults to `peekNextInvoiceNumber()` (7674 → 12345–12349, max across all four invoice collections including `dist_invoices` 12337). Due date = issue + `paymentTermsDays` (default 30) via `_mdinvUpdateDueDate` (7692–7697). Save button wrapped in `_once` (7683); Delete shown only for existing + admin (7684–7688).

**saveDistInvoice (app.js:7705–7759).** Invoice number: user-entered or `await getNextInvoiceNumber('dist')` (7712 — Firestore transaction, 12353+, shared counter with all invoice types). Line pricing: for each SKU with cases > 0, price = the EXISTING line's stored `pricePerCase` if editing (guards against silent repricing of old invoices at today's rates — comment 7715–7717), else current `dist_pricing.pricePerCase`, else 0 (7718–7727). Unpriced lines trigger an explicit confirm ("will bill at $0", 7729–7730). `total = Σ cases × pricePerCase` (7732). Upsert preserves prior fields via spread (7735–7749). Renders: closes modal, re-opens dist modal if one was open, `renderInvoicesPage()` if on invoices page, `renderDistributors()` (7754–7757). **Dist invoices never touch the `iv` ledger** — only shipments deduct stock (purpl retail invoices deduct on send, `markInvoiceSent` 16259+; dist invoices are billing-only).

**markDistInvoicePaid (app.js:7761–7769).** Sets `status:'paid', paidDate, paidAt` via single update; refreshes invoices page, the modal invoices pane, and the invoices-hub dist column (`renderInvColDist`, 7767). Also invoked from the Invoices hub (15806, 16227).

**deleteDistInvoice (app.js:7771–7784).** Admin-gated (`_requireAdmin`), audit-logged (7775), atomic: removes the invoice and defensively filters `iv` entries with `invoiceId === invId && type==='out'` (7778 — dist invoices never create such entries, so this is a no-op safety mirror of the shared invoice-delete path).

### 3e. Other tabs (brief)
- **Reps** (6983–7005): `+ Add Rep`/`Edit` → `addDistRep`/`editDistRep` → `#modal-add-rep`; save/delete at 7494–7521; both re-run `openDistributor` (resets to Overview tab — mild UX wart shared by several save paths: 7511, 7519, 7595, 7822, 7830, 7948).
- **Stores** (7110–7128): `dist_chains` CRUD via `#modal-add-chain` (7787–7832).
- **Imports** (7131–7172): `openCSVImport` → `#modal-csv-import`; `confirmCSVImport` (7915–7950) dedupes on date+buyer+sku+qty and pushes `dist_imports` rows one-by-one. Imported rows feed nothing else (display-only).
- **Outreach** (7174–7199): reads embedded `d.outreach`; `logDistContact` button.
- **Accounts** (7201–7239): lists `ac` where `fulfilledBy === d.id` with unpaid-delivered-order counts from `orders`; `View` → `openAccount`, `Follow-Up` → `logOutreach`.
- **Velocity** (6826–6981): embedded `d.velocityReports[]`; save/delete/CSV-import entries (6921–6981). Bug: `doorsTM` accumulator `reduce((s,r)=>s+Math.max(s,r.doors||0),0)` (6840) is mathematically wrong (adds s to max) but the variable is never rendered — dead code.

### 3f. Edit/Delete distributor
- **editDistributor** (7348–7388) fills `#modal-edit-distributor` (index.html:2634–2732), incl. `#edist-last-order` → `lastOrderDate` (7371) and reorder cycle; delete button admin-only (7383); Places autocomplete on DC address (7387).
- **saveDistributor** (7390–7448): geocodes changed DC address (7404–7407); spread-preserves all existing fields plus explicit preservation of outreach/contacts/pricing/velocityReports etc. (7409–7442); push or full-replace update (7443–7444); `renderDistributors()`.
- **deleteDistributor** (7450–7468): admin-gated + audit-logged; ONE atomicUpdate removes the profile and cascades deletion across `dist_reps, dist_pricing, dist_pos, dist_invoices, dist_chains, dist_imports` (7457–7458) and **resets `ac.fulfilledBy` → `'direct'`** on linked accounts (7460–7463). Note: deleting a distributor deletes its shipment POs WITHOUT reversing their iv deductions (correct — goods really left) but also deletes unpaid `dist_invoices` (revenue records vanish from tax export 10478).

---

## 4. Cross-section: dist_pricing as the price authority

Three consumers of `dist_pricing.pricePerCase`:
1. **Shipment PO valuation** — saveDistShipment 7294–7298.
2. **Manual PO valuation** — saveDistPO 7577–7582.
3. **Dist invoice line pricing** — saveDistInvoice 7714–7727 (with stored-price precedence on edit).

Separately, **account-level dist-tier pricing** does NOT read `dist_pricing`. `_calcPricePerCase(account)` (app.js:23–28) picks `ac.pricePerCaseDist` when `ac.fulfilledBy` is a distributor, else `pricePerCaseDirect||pricePerCaseCustom`, falling back to `PURPL_DIRECT_PER_CASE` ($27.60, app.js:13). `ac.pricePerCaseDist` is a per-account field edited in the account modal (`#ac-price-dist`, index.html:2227; load 5413, save 5510). The purpl invoice modal's tier selector (`#iv-tier` 'direct'/'dist'/'custom', index.html:2829–2833) maps through `_ivGetPrice` (2563–2569) to the same account fields (2648–2658), and the combined-invoice modal repeats the logic inline (12430–12443). So there are **two disconnected "distributor price" systems**: per-distributor `dist_pricing` (what you charge the distributor) vs per-account `pricePerCaseDist` (what an account is worth when a distributor fulfills it). Consumers of `_calcPricePerCase`: order valuation `calcOrderValue` (1744–1747, feeding dashboard revenue 1400–1401), delivery-run invoicing (9389), portal-order conversion (15357), and report revenue paths (10110, 10159, 10377).

## 5. Cross-section: accounts with `fulfilledBy = distId`

- Account edit modal populates `#eac-fulfilled-by` from active dists, injecting the current inactive dist to avoid a silent revert to direct (5378–5394); saved at 5507.
- Accounts page: fulfillment filter (3267–3269), grouping direct vs per-distributor (3315–3322), and dist-serve dropdown options (3244).
- Account detail modal shows a "via {dist}" badge that closes the account modal and opens the distributor (3505–3511).
- Orders page marks dist-fulfilled orders (`_isDist`, 8641; badge 8664–8668) and filters by fulfillment (8646–8647); delivery route builder excludes/labels them (9127–9128, 9159–9161).
- Dashboard splits Direct vs Via Distributor account counts (1412–1413) and the attention feed annotates stale dist-fulfilled accounts (1761–1764).
- Deleting an ACCOUNT cascades `dist_invoices`/`dist_pos` rows carrying that `accountId` (5539–5540) — defensive; distributor-side records normally have no accountId.

## 6. Cross-section: dashboards, invoices hub, reports, map, search

- **Dashboard dist KPI row** `renderDistDashKPIs` (7953–7976, container index.html:292, called from renderDash 1528): active count, total doors (chains-else-profile), dist-fulfilled account count, outstanding `dist_invoices` value, last PO date from `dist_pos`.
- **Dashboard attention feed** (1790–1808): overdue dist invoices, dists uncontacted 30+ days, overdue dist follow-ups — all deep-link `openDistributor`.
- **Recent payments widget** includes paid `dist_invoices` (1333–1336). Global search indexes `dist_profiles` (1252) and `dist_invoices` (1260); result click → `nav('distributors'); openDistributor(id)` (1229).
- **Invoices hub**: `_allInvoices` merges `dist_invoices` with `_col/_brand` tags (45–68); shared helpers `findInvoice/updateInvoice/deleteInvoiceWithCleanup` treat `dist_invoices` as a first-class column (70–118); list rows with Edit/Paid actions (15800–15808); KPI totals include dist invoices with legacy-status handling (15860–15879); dist column card `renderInvColDist` (16174–16237) with `+ New Invoice`, per-row Paid/Edit/✉ reminder; `_sendDistInvoiceReminder` emails a dist contact or rep and stamps `reminderSentAt` (16239–16256).
- **Orders page "Distributor Orders" tab** `renderDistOrders` (8601–8623) lists ALL `dist_pos`. Bug: item summary uses `i.qty` (8613) but `dist_pos.items` store `{sku, cases}` — renders `undefinedcs classic` for every UI-created PO.
- **Reports → Distributor** `repDistributor` (10272–10360): per-dist PO count/value and invoiced/paid/outstanding within date range (outstanding correctly excludes draft/void, 10284–10286); PO-value bar chart (10295–10299); velocity sub-table from `d.velocityReports` (10304–10359). Year-end tax export includes paid `dist_invoices` (10477–10483). Invoice-status migration covers `dist_invoices` (13795).
- **Map**: DC pins + radius coverage circles per active/submitted/under_review dist (14139–14188), legend layer toggles (14227+), info-window link → `openDistributor` (14166).

## 7. 30-day forecast (Projections page)

`Distributor Demand` table (index.html:951–958) rendered inside `calcProjections` (app.js:2971–3009): for each ACTIVE dist, sorts its `dist_pos` ascending, computes avg PO value, avg interval between `dateReceived` dates (2984–2995), `nextEst = lastPO + avgInterval`, and **30-day projection = round(30/avgFreq) × avgValue** (2996; falls back to a single avg PO value when frequency is unknown). Rows deep-link `openDistributor` (2980, 2998). Caveats: cancelled POs are NOT excluded here (unlike the KPIs), and `round(30/avgFreq)` quantizes (a 45-day cycle projects ×1, a 61-day cycle projects ×0... actually round(30/61)=0 → $0 projected for slow distributors). `totalValue` feeds avg value, so unpriced SKUs (no `dist_pricing`) depress the forecast.

## 8. `lastOrderDate` — writers vs readers (consistency gap)

Writers: saveDistShipment (7334–7335) and the manual edit field (7371/7427). **saveDistPO does NOT set it** (7570–7598), and deleteDistPO does not roll it back. Readers: overdue-reorder KPI uses `lastOrderDate` alone (6440), while the card/overview use `lastOrderDate || latest dist_pos.dateReceived` (6497, 6712). Consequence: a distributor whose POs are only hand-logged (never shipments) shows a Last Order date on cards but is invisible to the "Overdue Reorders" KPI count; conversely deleting the latest shipment leaves a stale `lastOrderDate`.

## 9. Findings summary

1. **Two unlinked pricing systems** — `dist_pricing` (per-dist charge list) vs `ac.pricePerCaseDist` (per-account dist-tier) never reconcile; §4.
2. **PO cancel ≠ inventory reversal** — cycling a shipment PO to `cancelled` leaves the iv deduction in place; only delete reverses (7600–7633); KPIs exclude cancelled POs so stock and KPIs diverge.
3. **`lastOrderDate` drift** — manual POs don't update it; KPI (6440) and card (6497) read different sources; §8.
4. **renderDistOrders `i.qty` bug** — app.js:8613 shows `undefined` for case counts on UI-created POs.
5. **Duplicate "Linked Accounts" cell** in overview grid (6735 + 6738); dead/buggy `doorsTM` (6840).
6. **Cancelled-terminal cycle** — no path back from `cancelled` except delete (7602).
7. **deleteDistributor destroys unpaid invoice history** (7455–7464) — paid ones vanish from the year-end export (10478).
8. **Forecast quantization** — `round(30/avgFreq)` zeroes projections for cycles > ~60 days and includes cancelled POs (2996).
9. **Non-atomic pricing save** — saveDistPricing issues one write per SKU (7526–7537); partial failure leaves a mixed price list feeding PO/invoice valuation.
10. Good patterns worth noting: shipment save, PO delete + reversal, distributor cascade delete, and invoice delete are all single `DB.atomicUpdate` batches; invoice edit preserves original line prices; inactive-dist option injection prevents silent `fulfilledBy` reverts (5382–5391).
