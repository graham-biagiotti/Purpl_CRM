# 05 — Inventory, Production & Projections

Read-only architecture review. Scope: the `iv` ledger and `_onHand`/`_onHandRaw`, the Inventory page (summary / locations / receive / repack / pallets / supplies / log / returns), `poolTransfer`, `receiveFinishedPacks`, the Production page (runs, recommendation, `_scheduleRecommendedRun`, shipments planner), the Projections page (`calcProjections` / `calcProjectionsWindow`), low-stock alerts, and an app-wide map of every writer/reader of the `iv` ledger. All citations are `file:line` against the current working tree.

Primary files:
- `/home/user/Purpl_CRM/public/app.js` (17,009 lines — all business logic)
- `/home/user/Purpl_CRM/public/index.html` (page/modal markup, inline `onclick` handlers)
- `/home/user/Purpl_CRM/public/db.js` (Firestore-backed cache layer)

---

## 1. Data model & core primitives

### 1.1 Units

- `CANS_PER_CASE = 12` — app.js:10. Comment at app.js:6-9 states the invariant: **orders/deliveries are tracked in CASES, the `iv` ledger is tracked in CANS**; every case→can conversion must use the constant. `PURPL_DIRECT_PER_CASE = 2.30 × 12 = $27.60` (app.js:11-13).
- SKUs: `classic`, `blueberry`, `peach`, `variety` (app.js:226-231); archived `raspberry` kept for historical rendering (app.js:233-235). Invoice SKU list `IV_SKUS` mirrors these as "12-pack" case items (app.js:2420-2425).

### 1.2 The `iv` collection is dual-purpose (ledger + legacy invoices)

`iv` is one of the per-record Firestore collections (db.js:14-21, path `workspace/main/iv`, db.js:67-72). It holds two unrelated record shapes:

1. **Inventory ledger entries**: `{id, date, sku, type:'in'|'out'|'return', qty (cans), pool:'warehouse'|'farm', note, …keying fields}`.
2. **Legacy purpl invoices** (records carrying `number`/`invoiceNumber`): merged into invoice lists by `_allPurplInvoices()` (app.js:47-50) and `_allInvoices()` (app.js:52-68); `iv` is a member of `_INV_COLS` (app.js:45). `markPaid` falls through to `DB.update('iv', …)` for these (app.js:15701-15707); the Stripe webhook col-map in functions/index.js:964-965 includes `iv: 'workspace/main/iv'`.

The two shapes coexist safely only because ledger math filters on `type` and invoice logic filters on `number||invoiceNumber`. This is the single most surprising design fact in the module.

### 1.3 On-hand computation — single source of truth

- `_onHand(skuId, pool)` = `max(0, _onHandRaw(...))` (app.js:122-124).
- `_onHandRaw` (app.js:129-135): sums `qty` of entries where `type ∈ {in, return}` minus `type === 'out'`, matched on `sku` and (optionally) `pool`, with **`pool` defaulting to `'warehouse'` when absent** (app.js:131).
- Deductions **never check availability** (design note, app.js:125-128); pools can go negative. Clamping in `_onHand` hides this, so Warehouse + Farm can stop summing to Total; the inventory summary surfaces raw negatives as an explicit warning banner (app.js:8046-8062).
- `type:'return'` counts as stock-in regardless of return reason (`_onHandRaw` app.js:132) — damaged returns re-enter sellable stock.

---

## 2. INVENTORY page (`page-inventory`, index.html:413+)

Routing: `nav('inventory')` → `renderInventory` (app.js:298). `renderInventory` wires the tab bar once (`#inv-tabs`, `data-inv-tab`, index.html:415-423; wiring app.js:7984-8001) and dispatches via `_renderInvPane` → handler map `{summary, locations, receive, repack, pallets, supplies, log, returns}` (app.js:8006-8023). Tab click only re-renders the active pane.

### 2.1 Summary tab — `_invSummary` (app.js:8026-8090)

Reads: `iv`, `loose_cans`, `pallets`, `costs`. KPI cards (app.js:8034-8045): Total Stock / Warehouse / Farm (all via `_onHand`), Stock Value at COGS (default $2.15/can). Negative-pool warning per §1.3. Per-SKU table (app.js:8067-8089): warehouse/farm/total cans, loose-can count, "Pallets" column = contents of `status==='ready'` pallets (app.js:8072 — **these are CASES**, displayed unlabeled next to can columns), status badge Critical<24 / Low<48 / OK.

Buttons:
| Button | Handler | Ledger write |
|---|---|---|
| `+ Add` / `- Use` per SKU row | `invAdjust(sku,'in'/'out')` (onclick built at app.js:8085-8086) | `DB.push('iv', {…type, qty, pool})` app.js:8501 — qty/note via `prompt()`, pool from `#inv-adj-pool` select (index.html:434). Re-renders `_invSummary` only. |

`invAdjust` validates SKU against `SKU_MAP` and positive qty (app.js:8493-8504). No keying field — manual adjustments are irreversible-by-reference.

### 2.2 Locations tab — pool transfers

`_invLocations` populates `#pool-xfer-sku` (app.js:8514-8517). Button `onclick="poolTransfer()"` (index.html:468).

`poolTransfer` (app.js:8520-8549): direction `wh-farm`/`farm-wh`, qty in **cans**; double-click guard via `_poolTransferInFlight` Set keyed `sku-qty-dir` (app.js:8519, 8526-8528); availability checked against clamped `_onHand(sku, fromPool)` (app.js:8531-8536). Writes **two paired ledger entries in one `DB.atomicUpdate`**: `out` from source pool + `in` to destination pool, both tagged `transferId` (app.js:8537-8543). Re-renders whole inventory page (app.js:8547). Note: nothing ever reverses by `transferId` — deleting one leg via the Log tab (§2.7) silently unbalances pools.

### 2.3 Receive tab — `_invReceive` (app.js:8093-8108)

Log table merges `loose_cans` receipts with **all `iv` `type==='in'` entries** labeled "Finished Packs" (app.js:8094-8097) — this includes production-run ins, repack outputs, and transfer-in legs, each deletable from here.

Buttons:
| Button | Handler | Write |
|---|---|---|
| `Log Receipt` (loose) index.html:491 | `receiveLooseCans` app.js:8110-8120 | `DB.push('loose_cans', …)` app.js:8116 — **not** the iv ledger; loose cans are a separate config-doc array (db.js:40). |
| `Log Receipt` (packs) index.html:517 | `receiveFinishedPacks` app.js:8123-8142 | `DB.push('iv', {type:'in', qty: packs×packSize, pool})` app.js:8138. Pack-type multiplier `{6pack:6, 12pack:12, 24pack:24, single:1}` (app.js:8136 — fixes a historical bug where 8 six-packs added 8 cans, per comment app.js:8134-8135). Pool from `#recv-pack-pool` (index.html:512). Guard `_recvPacksInFlight` 2s (app.js:8122-8127). |
| `✕` per receipt row | `delLooseCan(id, form)` app.js:8144-8151 | `DB.remove('loose_cans')` or `DB.remove('iv')` depending on row type (app.js:8147-8148). |

Re-render after each: `_invReceive` only — the Summary KPIs stay stale until you revisit the Summary tab.

### 2.4 Repack tab — `_invRepack` (app.js:8154-8168)

This is the **operational variety-pack mechanism** (see §7). Buttons:
| Button | Handler | Writes |
|---|---|---|
| `+ New Repack Job` index.html:534 | `openRepackModal` app.js:8170-8186 (save wired `_once(saveRepackJob)` app.js:8184) | — |
| `Save` in modal | `saveRepackJob` app.js:8189-8221 | 1) `DB.push('repack_jobs', job)` app.js:8203. 2) Best-effort FIFO consumption of `loose_cans` per input SKU (app.js:8204-8215) — **decrements/removes loose_cans records only, never writes iv `out`s; silently under-consumes if loose stock is short**. 3) `DB.push('iv', {type:'in', sku:outSku, qty:outQty, pool:'warehouse', repackId: job.id})` app.js:8217. Guard `_repackInFlight` 2s. |
| `✕` per job | `deleteRepackJob` app.js:8223-8233 | Admin-gated; atomic delete of the job + `cache.iv` filter on `repackId` (app.js:8227-8230). Consumed loose cans are *not* restored (confirm text, app.js:8225). |

### 2.5 Pallets tab — `_invPallets` (app.js:8236-8257)

| Button | Handler | Writes |
|---|---|---|
| `+ Build Pallet` index.html:552 / `Edit` row | `openPalletModal` app.js:8259-8277 → `savePallet` app.js:8279-8293 | `DB.push`/`DB.update('pallets')` only — **building a pallet does not reserve or deduct stock**. Contents entered in **cases** (placeholder "0 cases", app.js:8272). |
| `Ship` row (app.js:8251) | `shipPallet` app.js:8295-8307 | Sets pallet `status:'shipped'` then, per content SKU, `DB.push('iv', {type:'out', qty: cases×CANS_PER_CASE, pool:'warehouse', palletId})` (app.js:8301-8304). Destination/date via `prompt()`. No availability check; pool hardcoded warehouse. |
| `✕` row | `deletePallet` app.js:8309-8320 | Admin-gated; atomic removal of pallet + all `iv` entries with matching `palletId` (app.js:8314-8317) — reverses the ship deduction. |

### 2.6 Supplies tab — `_invSupplies` (app.js:8323-8376)

Packaging supplies (`pack_supply` config array). `openSupplyModal`/`saveSupply`/`deleteSupply` (app.js:8344-8376, button index.html:568). No iv interaction; low flag when `qty <= reorderPoint` (app.js:8328).

### 2.7 Log tab — `_invLog` (app.js:8379-8400)

Shows the latest 60 ledger entries (`type in/out/return`, app.js:8381) with badges and per-row `✕` → `delInvEntry` (app.js:8506-8511): `confirm2` then `DB.remove('iv', id)` — **can delete any ledger row, including invoice-linked deductions and single transfer legs**, with no reference-integrity warning.

### 2.8 Returns tab — `_invReturns` (app.js:8403-8435)

`Log Return` button (index.html:626) → `saveReturn` (app.js:8438-8486): validates account/SKU/cans first, then in-flight guard (`_saveReturnInFlight`, 2s — guard placed after validation per HIGH-6 comment app.js:8445-8449). One `DB.atomicUpdate` appends a `returns` record **and** an iv entry `{type:'return', qty:cans, pool}` (pool from `#ret-pool`, index.html:615; write app.js:8464-8475). Optional credit fields are informational only (no invoice/AR linkage). `toggleReturnCredit` (app.js:8488-8491) shows the amount row. Returns have **no keying field** back to the `returns` record — deleting a return record (none exists in UI; account deletion filters `returns` by accountId, app.js:5539) does not reverse the ledger `return` entry.

---

## 3. PRODUCTION page (`page-production`, index.html:849-890)

Routing: `production: renderProduction` (app.js:303). `renderProduction` (app.js:8853-8889) renders: upcoming shipments (`shipments` collection filtered `date>=today`), production history (`prod_hist`, latest 15), today's run inputs (`renderTodaySchedule` app.js:8958-8970), and the recommendation card.

### 3.1 Log Production Run

Button `#save-run-btn` "Save Run + Update Inventory" (index.html:865), wired at app.js:13903-13904 → `saveTodayRun` (app.js:8973-8991):
- Reads per-SKU inputs `#sched-<sku>` (labeled "units", `step=6`, app.js:8966 — treated as **cans** because they go straight into the ledger).
- `DB.push('prod_hist', entry)` (app.js:8982) then per SKU `DB.push('iv', {type:'in', qty, pool:'warehouse', note:'Production run', prodId: entry.id})` (app.js:8984-8986). Guard `_prodRunInFlight` 2s. Re-renders production + inventory.
- Delete: `delProdHist` (app.js:9000-9015) — admin-gated; removes iv entries by `prodId`, with a legacy fallback matching `note==='Production run' && date && qty` for pre-`prodId` records (app.js:9006-9009), then removes the `prod_hist` row.

Note: `prod_hist` and per-SKU `iv` ins are written as **separate `DB.push` calls, not one atomicUpdate** (unlike returns/dist-shipments), so a persistence failure can split them.

### 3.2 Production Recommendation — `renderProductionRecommendation` (app.js:8892-8942)

- Stock: per-SKU **unclamped** in+return−out over the whole ledger (app.js:8897-8903) — negative SKUs offset positive ones in `totalStock`.
- Demand: orders (non-cancelled) created in last 90 days, items `qty (cases) × CANS_PER_CASE`, scaled ×30/90 (app.js:8907-8917).
- `needed = max(0, demand − stock + 20% buffer)` (app.js:8919-8921); renders either "Stock looks good" or the deficit plus a **`Schedule This Run`** button (onclick `_scheduleRecommendedRun(neededCases)`, app.js:8941).
- `_scheduleRecommendedRun` (app.js:8944-8956): computes `baseSkus = SKUS.filter(id!=='variety')` **but never uses it** — `perSku = round(totalCasesNeeded / SKUS.length)` divides by all 4 SKUs and fills every `#ship-<sku>` input *including variety* (app.js:8946-8951), contradicting the "distribute across non-variety SKUs" comment. It then pre-fills the **Shipment** modal (`#ship-date` = +7d, customer "Production Run") and opens `modal-shipment`. Saving that modal writes a `shipments` record only — **"Schedule This Run" never adds inventory**; only §3.1 does.

### 3.3 Shipments planner

- `+ Schedule` (`#add-ship-btn`, index.html:872, wired app.js:13905-13906) opens `modal-shipment` (index.html:2529-2555; per-SKU qty inputs `#ship-<sku>`).
- `Schedule Shipment` (`#save-ship-btn`, wired app.js:13907-13908) → `saveShipment` (app.js:9017-9030): `DB.push('shipments', {customer, date, type, notes, <sku>: qty…})`. **No iv write** — purely a planning artifact — then `_showInvoiceSuggestion` banner (app.js:9032-9063) offers `openAddInv(…, 'dist', totalCases, …)`.
- `✕` on a card → `delShipment` (app.js:8993-8998): `DB.remove('shipments')`, no ledger effect.

The unit convention of `ship-*` inputs is ambiguous: `_showInvoiceSuggestion` and `_scheduleRecommendedRun` treat them as **cases**, while the modal itself gives no unit label (index.html:2543-2546).

---

## 4. PROJECTIONS page (`page-projections`, index.html:2529 region / 896+)

Routing: `projections: renderProjectionsPage` (app.js:305). Velocity window select `#proj-velocity-source` (index.html:900-905) is bound `change → renderProjectionsPage` at app.js:11198-11199. Rows in the account table navigate via `onclick="openAccount(...)"` (app.js:2961); distributor rows via `openDistributor(...)` (app.js:2998).

### 4.1 `calcProjections()` (app.js:2746-2798) and `calcProjectionsWindow(windowDays)` (app.js:3013-3061)

Near-duplicate implementations (the window variant adds the configurable window and an M8 NaN guard, app.js:3028). Both, per active account:
- Velocity `weeklyUnits[sku]` = order-item **cases**/week over the window (period clamped 7..90 days, app.js:2763-2765 / 3030-3031).
- If ≥2 orders: `avgDays` between due dates, `avgOrderValue`, then a projected-order loop stepping `avgDays` out to +90d accumulating `proj30/60/90` revenue (app.js:2769-2792 / 3034-3056).

Consumers of `calcProjections` (fixed 90d): dashboard `renderProjections` (app.js:2730-2744), `renderProdPlan` (app.js:2801-2852), `renderVelocities` (app.js:2855-2872) — each recomputes independently (3× per dashboard render). Consumer of `calcProjectionsWindow`: `renderProjectionsPage` (app.js:2877-3010).

### 4.2 `renderProjectionsPage` sections

- **Revenue scenarios**: 75%/100%/125% of proj30/60/90 (app.js:2883-2903).
- **SKU Demand Forecast** (app.js:2907-2928): weekly velocity summed across accounts; 30/60/90-day unit projections — these are **cases** (order units).
- **Production Planning** (app.js:2930-2952): `stock = _onHand(sku, null)` (cans, app.js:2911); `gap = d30u × CANS_PER_CASE − stock` (cans, app.js:2938); `daysSupply = stock / (weekly cases × 12 / 7)` (app.js:2939). Unit mismatch in the table itself: the "Stock" column is cans while "30d Need" (`d30u`) is cases (app.js:2944-2945), only the Gap column reconciles units.
- **Account velocity** (app.js:2954-2969) and **Distributor demand** from `dist_pos` PO cadence (app.js:2971-3009).

### 4.3 Dashboard production-planning card — `renderProdPlan` (app.js:2801-2852)

Inline per-SKU clamped net (`max(0, in−out)`, app.js:2806-2811 — note: clamps per SKU, unlike the recommendation card), demand = total weekly cases × 30/7 × 12 cans (app.js:2814-2819), renders surplus/deficit banner with "Schedule a production run" advice.

---

## 5. Low-stock alerts

- Settings: `lowStockThreshold` default 500 (`_lowStock()` app.js:20; settings field `#set-low-inv-threshold` app.js:10925; saved in settings object app.js:11083 exclusion list).
- Dashboard **Total Inventory KPI** turns red + border below threshold (app.js:1437-1443); **low-stock alert card** with "View Inventory" button below threshold (app.js:1446-1462).
- Dashboard **Alerts KPI** counts SKUs with total `_onHand < 48` (hardcoded, app.js:1404, 1493) — the `_lowStock()` helper is *not* used here.
- **Needs Attention** feed flags per-pool `_onHand(sku, pool) < 48` for warehouse and farm (app.js:1771-1776).
- Inventory summary row badges: Critical <24 / Low <48 cans (app.js:8074); report `repInventory` uses the same cutoffs (app.js:10252).

---

## 6. App-wide `iv` ledger writers and readers

### 6.1 WRITERS (every code path that appends ledger entries)

| # | Source flow | Location | Entry written | Keying field |
|---|---|---|---|---|
| 1 | Receive finished packs | app.js:8138 | `in`, qty = packs×packSize, pool selectable | — (note only) |
| 2 | Repack job output | app.js:8217 | `in`, warehouse | `repackId` |
| 3 | Ship pallet | app.js:8303 | `out`, cases×12, warehouse | `palletId` |
| 4 | Manual adjust (+Add/−Use) | app.js:8501 | `in`/`out`, pool selectable | — |
| 5 | Log production run | app.js:8985 | `in`, warehouse | `prodId` |
| 6 | Pool transfer | app.js:8538-8542 | paired `out`+`in` | `transferId` |
| 7 | Log return | app.js:8465-8474 | `return`, pool selectable | — |
| 8 | Distributor shipment | app.js:7320-7333 | `out` per SKU, cases×12, warehouse | `source:'dist_shipment'`, `ref: shipId` |
| 9 | Manual purpl invoice created non-draft (`_saveInvCore`) | app.js:16544-16556 | `out` per line, cases×12, pool = `fulfillmentSource` | `invoiceId` |
| 10 | Invoice marked sent (`markInvoiceSent`) | app.js:16269-16285 | `out` per line (skips `__shipping__`, app.js:16278), draft-only + `alreadyDeducted` guard (app.js:16265-16266) | `invoiceId` |
| 11 | Combined invoice created non-draft (`saveNewCombinedInvoice`) | app.js:12645-12661 | `out` per purpl line (LF lines never touch iv) | `invoiceId` (child purpl id) |
| 12 | Combined invoice emailed (send flow) | app.js:13376-13397 | `out` per purpl line, `alreadyDeducted` re-checked inside the atomic block (race fix, app.js:13383-13385); skips `__shipping__` (app.js:13389) | `invoiceId: rec.purplInvoiceId` |
| 13 | Delivery-run invoice (`createDeliveryInvoice`) | app.js:9408-9422 | `out` per line, cases×12, atomic with invoice + order flag | `invoiceId` |

Deduction policy: **stock is deducted when an invoice leaves draft** (created non-draft, marked sent, or emailed) — orders and delivery-stop completion no longer deduct ("Inventory deduction now happens at invoice creation, not status change", app.js:8844, 9266). LF-brand items are Wix-managed and never hit `iv` (app.js:13176-13178; `lf_wix_deductions` instead).

### 6.2 REVERSERS / DELETERS

| Flow | Location | Removal predicate |
|---|---|---|
| Log-tab row delete | app.js:8508 | by `id` (unrestricted) |
| Receive-tab row delete | app.js:8148 | by `id` (`in` entries) |
| Repack job delete | app.js:8229 | `repackId === id` |
| Pallet delete | app.js:8316 | `palletId === id` |
| Production record delete | app.js:9006-9009 | `prodId` (+ legacy note/date/qty match) |
| Invoice delete (`deleteInvoiceWithCleanup`) | app.js:93 | `invoiceId === id && type==='out'` |
| Dist invoice delete | app.js:7778 | same predicate |
| Combined invoice void | app.js:13435, 13450 | `invoiceId ∈ {purplInvoiceId, combinedId}` |
| Delivery stop un-toggle | app.js:9324-9331 | outs of invoices removed for that stop |
| Delivery stop remove / route clear | app.js:9499-9501, 9535-9536 | outs of that day's `delivery_run` invoices |
| Dist shipment-PO delete | app.js:7616-7627 | `source==='dist_shipment' && ref===po.shipId` (only when `isShipment && shipId`) |
| Order delete | app.js:8810 | `e.ordId === id` — **no current writer sets `ordId` on iv entries**; legacy-only cleanup |
| Account delete | app.js:5532 | `accountId === id` — removes only legacy *invoice* records in `iv`; the account's invoice-linked `out` entries (keyed by `invoiceId`) are left behind even though the invoices themselves are deleted (app.js:5533-5535) — orphaned deductions |

### 6.3 READERS

- On-hand: `_onHand`/`_onHandRaw` (app.js:122-135) → inventory summary/table (app.js:8035-8072), dashboard KPI + alerts (app.js:1404, 1437), Needs Attention (app.js:1772-1773), projections stock (app.js:2911), reports `repInventory` (app.js:10243-10257, uses clamped `_onHand` for net but inline sums for Received/Shipped columns per LOW-3 comment).
- Inline ledger sums (bypass `_onHand`): production recommendation (app.js:8897-8903, unclamped), dashboard `renderProdPlan` (app.js:2806-2811, clamped per SKU).
- Receive log (`type==='in'` listing, app.js:8096), Log tab (app.js:8380-8381).
- Deduction guards: `alreadyDeducted` checks (app.js:13384, 13435, 16265).
- Invoice-list readers of the *legacy invoice* shape: app.js:47-57, 2211, 15706; functions/index.js:964-965.

---

## 7. Variety-pack SKU handling

- `variety` is a **first-class ledger SKU** — received, produced, shipped, and counted like the flavors (app.js:230).
- A **variety recipe** (cans of each base flavor per 12-can variety case) is editable in Settings (`#variety-recipe-<sku>` inputs, app.js:10940-10947; live total validator `_updateVarietyTotal` requiring exactly `CANS_PER_CASE`, app.js:11046-11051; persisted as `settings.variety_recipe` only when the total is exactly 12, app.js:11060-11077 and duplicate save path 11124-11140).
- **The recipe is write-only**: no inventory, projection, or production code ever reads `settings.variety_recipe`. Building variety stock does not decrement base-flavor stock automatically; the operational mechanism is a **repack job** (§2.4), which consumes *loose cans* (not finished-pack iv stock) and emits variety `in` entries.
- `_scheduleRecommendedRun`'s non-variety intent is unimplemented (dead `baseSkus`, §3.2).
- SKU-name → id mapping for imports treats any name containing "var" as variety (dist imports app.js:7930-7934; Local Line parsing app.js:10852).

## 8. CANS_PER_CASE conversion inventory (where cases×12 happens)

Case→can conversions at: invoice line rows/units (app.js:2592, 2667, 12564, 15432, 15476, 16507-16508), order `canCount` (app.js:8732, 8736, 9260), delivery par pre-fill can→case with `Math.ceil` (app.js:8713, 9182, 14292), dist shipment (app.js:7284, 7326), pallet ship (app.js:8303), all invoice deductions (app.js:9413, 12654, 13393, 16281, 16551), projections/recommendation demand (app.js:2819, 2938-2939, 8913, 8921-8922), COGS totals in reports (app.js:10121-10135, 10389-10405). The constant is surfaced to users at app.js:8723 ("1 case = 12 cans") and app.js:10930.

## 9. Findings / risks (ranked)

1. **Dual-purpose `iv` collection** (ledger + legacy invoices, §1.2) — every new reader must know to filter by `type` or by `number`; `deleteAccount`'s `accountId` filter (app.js:5532) works only for the invoice shape and orphans invoice-linked deductions.
2. **`_scheduleRecommendedRun` is misleading** (app.js:8944-8956): dead `baseSkus`, evenly fills variety too, and lands in the shipment modal — the "Schedule This Run" CTA never creates inventory or a production record.
3. **Unrestricted ledger deletes**: Log tab `delInvEntry` (app.js:8506-8511) and Receive tab `delLooseCan` (app.js:8148) can remove invoice deductions, transfer legs (unbalancing `transferId` pairs), or production ins with a generic confirm.
4. **Repack consumes only `loose_cans`, best-effort** (app.js:8204-8215): shortfalls are silent; conversions from finished-pack stock aren't representable; deletion doesn't restore consumed loose cans.
5. **Unit-mixing in UI**: summary "Pallets" column is cases beside can columns (app.js:8072); projections "30d Need" is cases beside a cans Stock column (app.js:2944-2945); shipment modal quantities are unlabeled (index.html:2543-2546); production-run inputs say "units" but are cans (app.js:8966-8967).
6. **Deductions never check availability** (by design, app.js:125-128) — mitigated only by the summary negative-pool banner (app.js:8046-8062).
7. **`markInvoiceSent` SKU fallback `'classic'`** (app.js:16281, also 13393): lines with unrecognized SKUs silently deduct Classic. `_saveInvCore`'s non-draft path lacks the `__shipping__` skip its sibling paths have (app.js:16549-16553 vs 16278/13389) — latent, since shipping lines are only appended post-creation.
8. **`saveTodayRun` is not atomic** (`prod_hist` + n× iv via separate `DB.push`, app.js:8982-8986), unlike returns (app.js:8472-8475), transfers (app.js:8538), and dist shipments (app.js:7320, LOW-4 comment).
9. **Recommendation uses unclamped totals** (app.js:8897-8904): a negative SKU balance shrinks apparent stock across SKUs; `renderProdPlan` clamps per SKU (app.js:2810) — the two dashboard-adjacent numbers can disagree.
10. **`calcProjections` / `calcProjectionsWindow` duplication** (app.js:2746 vs 3013) plus triple recomputation per dashboard render (app.js:2731, 2814, 2856).
11. **Stale KPI renders**: `receiveFinishedPacks`/`saveReturn`/`invAdjust` re-render only their own pane (app.js:8140, 8484, 8502); summary cards refresh only on tab switch or full `renderInventory`.
12. **Double-submit protection is timer-based** (2s flags at app.js:8122, 8188, 8437, 8972, 7265; `_once` 400ms at app.js:151-159; Set-keyed at app.js:8519, 9376, 16258) — adequate for single-user, not multi-tab.
