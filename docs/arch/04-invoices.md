# 04 — INVOICES Tab Architecture

Scope: the Invoices page, its four invoice types + legacy `iv`, all edit/preview modals, send/pay/void/delete paths, numbering, Stripe, ShipStation, warehouse push, statement printing, and every cross-section producer/consumer. All paths relative to repo root; the app is a single-file SPA (`public/app.js`, 17,009 lines) backed by `public/db.js` (Firestore under `workspace/main/*`) and `functions/index.js` (callables + webhooks).

---

## 1. Data model

### 1.1 Collections (db.js)

| Key | Storage | Notes |
|---|---|---|
| `retail_invoices` | own Firestore collection (`db.js:14-21`) | purpl (lemonade) invoices |
| `lf_invoices` | own collection | Lavender Fields invoices |
| `combined_invoices` | own collection | parent record linking one purpl + one LF child via `purplInvoiceId`/`lfInvoiceId`; carries `purplSubtotal`, `lfSubtotal`, `grandTotal` |
| `dist_invoices` | own collection | distributor invoices (`distId`, `items[{sku,cases,pricePerCase}]`, `total`) |
| `iv` | own collection | **dual-purpose**: the inventory ledger (`{sku,type:'in'/'out',qty,pool,invoiceId}`) *and* legacy purpl invoice records (rows that have a `number`/`invoiceNumber`) |
| `lf_wix_deductions` | config-doc array (`db.js:39-43`) | Wix stock-pull instructions generated per LF invoice |
| `invoice_settings` | config-doc object (`db.js:51`) | from-name/email/address, `terms`, `nextInvoiceNum`, footer, legal terms, fallback `stripeLink`, ACH/check text |

DB semantics: all reads are synchronous from an in-memory cache (`DB.a`, `db.js:664-668`); `DB.push`/`DB.update` stamp `_updatedAt` and write the single doc immediately (`db.js:670-685`); `DB.atomicUpdate(fn)` mutates the whole cache under a snapshot-suppression flag, diffs before/after ids to propagate deletes, and flushes every collection ~50ms later (`db.js:691-752`). "Atomic" is atomic only against local snapshot races — Firestore writes are still per-doc batches, not a transaction.

### 1.2 Helper layer — single source of truth (`app.js:44-120`)

- `_INV_COLS` = `['retail_invoices','lf_invoices','combined_invoices','dist_invoices','iv']` (`app.js:45`).
- `_allPurplInvoices()` (`app.js:47-50`) — `retail_invoices` ∪ legacy `iv` rows that carry an invoice number, dedup by id.
- `_allInvoices(opts)` (`app.js:52-68`) — all five sources tagged `_col`/`_brand`, with `excludeChildren` (drops `combinedInvoiceId` rows), `brand`, `status`, `accountId` filters. Used by dashboards/accounts/reports (§10).
- `findInvoice(id)` / `_invoiceCol(id)` / `updateInvoice(id,fn)` (`app.js:70-85`) — search all five collections; `_invoiceCol` defaults to `retail_invoices` on miss.
- `deleteInvoiceWithCleanup(id)` (`app.js:87-118`) — see §7.
- `_invAmt(inv)` = `grandTotal || amount || total` (`app.js:120`).
- `_invEmailBadge(inv)` (`app.js:139-148`) — open/click badge derived from the account's `cadence[]` entry matching `invoiceId`.

### 1.3 Field-name drift (load-bearing)

- purpl amount: `amount` (manual) but delivery-run/portal rows also set `total`; readers use `amount||total`.
- Dates: purpl `date`/`dueDate`, LF `issued`/`due` (portal-created LF rows use `date`/`dueDate` instead — see `app.js:2216-2221` comment), dist `dateIssued`/`dueDate`. Every consumer does `x||y` fallbacks.
- Line items: manual purpl `{skuId, skuName, cases, units, pricePerCase, lineTotal}` (`app.js:16483-16491`); delivery-run `{sku, cases, pricePerCase, amount}` (`app.js:9388-9391`) — **no `skuId`/`lineTotal`**, so the edit modal's row-prefill (`existingItems.find(x => x.skuId === sku.id)`, `app.js:2580`) shows delivery-run lines as blank, and a re-save via `_saveInvCore` rebuilds from the (blank) DOM. ShipStation webhook injects `{skuId:'__shipping__'}` lines (`functions/index.js:1569-1579`) which are explicitly carried through edits (`app.js:16503-16504`, `12100`).

---

## 2. Page render pipeline

`nav('invoices')` → `renders.invoices` = `renderInvoicesPage() + loadInvoiceSettings()` (`app.js:310`). Remote snapshots re-render via debounced `refreshCurrentPage` (`db.js:274-278`, defined `app.js:13879`).

- **`renderInvoicesPage()`** (`app.js:15726-15742`): guards on `DB._firestoreReady` (loading row into `#inv-unified-tbody`), injects the four create buttons into `#inv-page-actions`, then calls `renderInvKpis()` and `renderInvUnifiedList()`.
- **`renderInvKpis()`** (`app.js:15850-15906`) → `#inv-page-kpis`: Total Invoiced (non-void, all four types), Outstanding (not paid/draft/void; purpl uses derived-overdue `purplStatus`), Overdue (due < today), Collected This Month (paidDate ≥ first-of-month). **Invariant** (comment `app.js:15851-15856`): `combined_invoices` parents are excluded because their children carry the dollars — every combined-creation path writes children.
- **`renderInvUnifiedList()`** (`app.js:15745-15842`) → one table for all types. Reads `#inv-search`, `#inv-status-filter`, module-level `_invTypeFilter` (set by `setInvTypeFilter`, `app.js:15719-15724`, wired to `#inv-type-pills` in `index.html:1699-1705`). Effective status: `paid/draft/void` literal, else `overdue` if due < today else raw (`app.js:15752-15757`). Children of combined invoices are hidden (`!x.combinedInvoiceId` filters at `app.js:15774,15783`). Sort: issued desc.
- Legacy collapsible-column renderers still exist and are reachable only via `toggleInvCol` / dist-modal panes: `renderInvColPurpl` (`app.js:15908`), `renderInvColLf` (`app.js:16020`), `renderInvColCombined` (`app.js:16094`), `renderInvColDist` (`app.js:16174`), `toggleInvCol` (`app.js:16161`).

Static markup: `index.html:1687-1728` (`#page-invoices`, toolbar, `#inv-unified-tbody`).

### 2.1 Every button on the page

**Actions bar** (built at `app.js:15733-15739`):

| Button | Handler | Effect |
|---|---|---|
| 💜 purpl Invoice | `openInvModal()` (`app.js:2429`) | opens `#modal-add-inv` |
| 🪻 LF Invoice | `openLfInvoiceModal(null)` (`app.js:11730`) | opens `#modal-lf-invoice` |
| 🤝 Combined | `openNewCombinedModal()` (`app.js:12408`) | opens `#modal-new-combined` |
| 🚚 Distributor | `pickDistForInvoice()` (`app.js:7636`) | `prompt()`-based distributor picker → `_openDistInvModal` (`app.js:7648`) |

**Toolbar** (`index.html:1700-1716`): type pills → `setInvTypeFilter`; status select + search input → `renderInvoicesPage()` on change/input.

**Per-row buttons** (`app.js:15834-15840`):

| Button | purpl | LF | Combined | Dist |
|---|---|---|---|---|
| Preview | `openInvoicePreview('purpl',id)` (`app.js:13066`) | `openInvoicePreview('lf',id)` | `openInvoicePreview('combined',id)` → delegates to `openCombinedInvoicePreview` (`app.js:13067`) | — |
| Edit | `openInvModal(id)` | `openLfInvoiceModal(id)` | — (no edit; preview modal edits) | `editDistInvoice(id)` (`app.js:7699`) |
| ✓ Paid (hidden if paid/void) | `markRetailInvPaid(id)` (`app.js:2693`) | `markLfInvPaid(id)` (`app.js:11718`) | `markCombinedPaid(id)` (`app.js:12208`) | `markDistInvoicePaid(id,distId)` (`app.js:7761`) |
| 📦 Ship (if `deliveryMethod==='ship'` && no `shipStationOrderId`) | `pushInvoiceToShipStation(id, col)` (`app.js:520`) | same | same | — |
| 🏭 Warehouse (if `fulfillmentSource==='warehouse'` && not pushed/paid/void) | `pushToWarehouse(id, col)` (`app.js:15844-15848`) — stamps `warehousePushedAt`, re-renders | same | same | — |

Row badges (`app.js:15828`): 📦 Ready-to-send (`readyToSend`, set by ShipStation webhook), Ship, 🏭 Warehouse (+✓ once pushed), 🚚 tracking, ⚠ `paidAmountMismatch` (Stripe webhook flag), email open/click badge.

---

## 3. purpl invoice modal — `#modal-add-inv` (`index.html:2796-2883`)

`openInvModal(id, prefillAccountId, prefillTier, prefillNotes)` (`app.js:2429-2561`). New: number = `peekNextInvoiceNumber()` (`app.js:12345`), date=today, terms from `invoice_settings.terms`, status=draft. Edit: fills all fields incl. delivery method/fulfillment/tracking; shows Delete. Account select is the searchable `_populateAccountSelect` pattern (`app.js:2386-2414`). Line rows = fixed 4 purpl SKUs (`IV_SKUS`, `app.js:2417-2422`) with per-row cases/$-per-case (`_ivRenderLineRows` `app.js:2571`, calc chain `_ivRowCalc`/`_ivCalcTotal` `app.js:2660-2687`; tier pricing from account fields via `_ivGetPrice` `app.js:2563`; `ivTermsChange` recomputes due date `app.js:2615-2632`).

Buttons:

| Button | Handler | Writes | Renders |
|---|---|---|---|
| Save Invoice (`#iv-save-btn`) | `_once(saveInv)` (`app.js:2484` → `saveInv` `app.js:16441-16448`) | `_saveInvCore` (below) | closes modal; `renderInvoicesPage` (if on page) + `renderInvoiceStatus` |
| Save & Send (`#iv-send-btn`) | inline async (`app.js:2505-2557`); label switches to "Save & Push to ShipStation" when method=ship | `_saveInvCore` → optional `pushInvoiceToShipStation(rec.id,'retail_invoices')` → `_getStripePayLink(rec,'retail')` → `callSendEmail` → `markInvoiceSent` if draft → cadence entry on `ac` → `_clearReadyToSend` (`app.js:651`) | `renderInvoicesPage`, `renderInvoiceStatus`, `renderAccounts` |
| Download PDF (`#iv-pdf-btn`) | `generateInvoicePrint(id)` (`app.js:16410-16418`) | none (opens window synchronously via `_openInvoiceWindow` `app.js:16396`, fetches pay link, writes `buildPurplInvoiceEmailHTML(...,{printButton:true})`) | — |
| Delete (`#iv-delete-btn`) | `deleteInvRecord(id)` (`app.js:16564-16574`) | `deleteInvoiceWithCleanup` + audit | modal close, page + dash re-render. **Note: uses `confirm2` only — not `_requireAdmin`, unlike `deleteInvoice`/`deleteRetailInv`** |

**`_saveInvCore(id, isNew)`** (`app.js:16454-16562`): 2s re-entrancy latch; validates account + ≥1 line; collects rows from DOM; carries forward `__shipping__` lines (`app.js:16503-16504`); number = user value ∥ existing ∥ `await getNextInvoiceNumber('purpl')`. **New invoice:** one `DB.atomicUpdate` writes the `retail_invoices` doc *and*, if `status !== 'draft'`, per-line `iv` `out` entries (`qty = cases*CANS_PER_CASE`, `pool = fulfillmentSource`, `invoiceId = saveId`) (`app.js:16544-16555`). **Edit:** `updateInvoice(id, () => rec)` then `_syncCombinedParentForChild(saveId)` (`app.js:16560`). Audit-logged (`app.js:16559`).

---

## 4. LF invoice modal — `#modal-lf-invoice` (`index.html:2262`)

`openLfInvoiceModal(id)` (`app.js:11730-11865`). Dynamic line blocks from `lf_skus` (non-archived) with per-variant unit inputs allowing split cases (`_lfInvRenderLineRow` `app.js:11867`, `_lfInvBuildVariantArea` `app.js:11899`, calc `app.js:11950-12019`, add-row `lfInvAddLineItem` `app.js:11945`).

Buttons:

| Button | Handler | Notes |
|---|---|---|
| Save (`#lfi-save-btn`) | `_once(saveLfInvoice)` (`app.js:11787` → `app.js:12022-12030`) | closes modal, `renderInvoicesPage` + `renderLfDashKpis`, then **`showWixPullModal(rec, deduction.id)`** (`app.js:13700`) |
| Save & Send (`#lfi-send-btn`) | inline async (`app.js:11804-11861`) | `_saveLfInvoiceCore` → optional ShipStation push → pay link (`'lf'`) → `callSendEmail` → draft→sent flip via direct `DB.update('lf_invoices',...)` (`app.js:11833`) → cadence → `_clearReadyToSend` → Wix pull modal. **No `iv` deduction — LF stock lives in Wix** |
| Download PDF (`#lfi-pdf-btn`) | `generateLfInvoicePrint(id)` (`app.js:16420-16428`) | |
| Delete (`#lfi-delete-btn`, admin-only visible) | `deleteLfInvoice(id)` (`app.js:12144-12154`) | `_requireAdmin` + `deleteInvoiceWithCleanup` |

**`_saveLfInvoiceCore(id, isNew)`** (`app.js:12034-12142`): builds `lineItems` (variant lines get fractional `cases = units/caseSize`), carries `__shipping__` lines (`app.js:12100`), pushes/updates the `lf_invoices` doc, then creates/refreshes the **`lf_wix_deductions`** record keyed by `invoiceId` (`app.js:12122-12137`) — this is the LF "inventory deduction" analogue (`confirmed:false` until staff confirms in the Wix pull modal). Edits call `_syncCombinedParentForChild` (`app.js:12140`).

`markLfInvPaid` is a **toggle**: paid→sent ("Unpay") or →paid (`app.js:11718-11726`), then parent sync + `renderInvoicesPage`.

---

## 5. Combined invoices

### 5.1 Creation paths (all write parent + two children)

1. **Manual modal** `#modal-new-combined` (`index.html:3293-3383`), opened by `openNewCombinedModal()` (`app.js:12408-12424`; accounts filtered to `isPbf`). SKU grids `_ncivRenderSkuRows` (`app.js:12430-12498`), totals `_ncivCalcTotals` (`app.js:12500-12546`). **Create Combined Invoice** button → `saveNewCombinedInvoice()` (`app.js:12549-12668`): 2s latch; collects purpl + LF lines; **three** `getNextInvoiceNumber` calls (purpl, lf, combined — user-entered `#nciv-number` overrides the combined one, `app.js:12617-12619`); one `atomicUpdate` writes `retail_invoices` child, `lf_invoices` child (both with `combinedInvoiceId`), `combined_invoices` parent, and — if status ≠ draft — purpl `iv` deductions noted `'Invoice ' + combNum` with `invoiceId: purplId` (`app.js:12645-12662`). **Gap: no `lf_wix_deductions` record is created on this path** (portal + LF-modal paths create one). Ends by opening the combined preview.
2. **Pairing two existing invoices** — account modal "Create Combined Invoice" (`renderMacInvoicesTab` selectors `app.js:13652-13665` → `manualCreateCombined` `app.js:13688-13696`) → `createCombinedInvoice(purplInvId, lfInvId, accountId, portalOrderId)` (`app.js:12158-12206`): computes subtotals (`amount||total` fallback, `app.js:12170-12171`), writes parent + stamps `combinedInvoiceId` on both children (purpl child looked up in `retail_invoices` then legacy `iv`) in one `atomicUpdate`.
3. **Portal confirm** (dual-brand) — §10.1.

### 5.2 Parent/child consistency — `_syncCombinedParentForChild(childId)` (`app.js:12234-12271`)

Called from every child mutation (`markPaid` `app.js:15707`, `markRetailInvPaid` `app.js:2698`, `markLfInvPaid` `app.js:11723`, `_saveInvCore` edit `app.js:16560`, `_saveLfInvoiceCore` edit `app.js:12140`). Re-derives parent subtotals from current children, preserves any shipping delta baked into `grandTotal` (`app.js:12261-12262`), and flips parent status: paid only when *both* children paid; un-paying a child reverts a paid parent to `sent`.

### 5.3 Combined preview modal — `#modal-combined-invoice` (`index.html:3386-3473`)

`openCombinedInvoicePreview(combinedId)` (`app.js:13230-13478`). Left iframe `#civ-preview-frame` gets `buildCombinedInvoiceHTML` (`app.js:12948-12977`) → shared `buildInvoiceDocHTML` (`app.js:12792-12944`, the single unified document template for email/print/preview). Backfills a missing number via `getNextInvoiceNumber('combined')` (`app.js:13244-13248`); fetches a Stripe link unless paid (`app.js:13249`). Right rail shows subtotals, status + open/click tracking from account cadence (`app.js:13262-13267`).

Buttons (`index.html:3459-3468`):

| Button | Handler | Writes |
|---|---|---|
| Save Changes `#civ-btn-save` | `app.js:13317-13340` | date/due/terms/notes/delivery/fulfillment patched onto parent **and both children** in one `atomicUpdate` (LF child also gets `issued`/`due`) |
| Send Invoice to Customer `#civ-btn-gmail` | `app.js:13355-13428` | optional ShipStation push → `callSendCombinedInvoice` (`app.js:715` → functions `sendCombinedInvoice` `functions/index.js:64-101`) → on success one `atomicUpdate` marks parent+children `sent` (+`sentMessageId`) and, if parent was draft and no `iv` `out` rows exist for the purpl child, **deducts purpl inventory** from the purpl child's lineItems (skipping `__shipping__`) (`app.js:13376-13403`) → cadence entry → `renderAccounts`, `renderInvoicesPage`, account-modal tabs, reopen preview. Failure fallback: `mailto:` (`app.js:13424-13426`) |
| 📦 Push to ShipStation `#civ-btn-ship` | `app.js:13299-13311` | `pushInvoiceToShipStation(combinedId,'combined_invoices')` |
| 🏭 Push to Warehouse `#civ-btn-warehouse` | `app.js:13312-13315` | `pushToWarehouse` |
| Open Full View ↗ `#civ-btn-newtab` | `app.js:13344-13348` | blob URL, print button variant |
| Mark Both Paid `#civ-btn-paid` | `app.js:13472-13475` → `markCombinedPaid` (`app.js:12208-12227`) | parent + purpl child (retail then legacy `iv`) + LF child all `status:'paid'` in one `atomicUpdate` |
| Void Invoice `#civ-btn-void` (admin) | `app.js:13429-13463` | `_requireAdmin`; parent+children → `void` (+`voidedAt/By`), removes the LF `lf_wix_deductions` record, **deletes the purpl child's `iv` `out` rows** (inventory restored), resets linked `portal_orders` doc to `status:'new'` |
| Delete Invoice `#civ-btn-delete` (admin) | `app.js:13465-13470` → `deleteCombinedInvoice` (`app.js:12275-12329`) | deletes parent, both children, `iv` deductions, wix deduction, linked portal-sourced `orders`; resets the portal order **and its paired same-submission other-brand order** (60s window heuristic, `app.js:12309-12323`); re-renders invoices + portal orders |

### 5.4 Unified single-brand preview — `openInvoicePreview(type, id)` (`app.js:13066-13226`)

Reuses the same modal shell for purpl/LF. `type==='combined'` delegates (`app.js:13067`). Uses `_invoiceCol(id)` so legacy `iv`-collection purpl invoices resolve (`app.js:13070`). Backfills numbers; pay link per type; hides the other brand's subtotal row. Buttons rebound per-type: Save Changes (`app.js:13143-13154`, patches only this record), Send (`app.js:13164-13190`: `callSendEmail` → LF flips status inline / purpl calls `markInvoiceSent` → cadence → `_clearReadyToSend`), Ship/Warehouse (`app.js:13133-13140`), Mark Paid (`app.js:13192-13197` → `markRetailInvPaid`/`markLfInvPaid`), **Void** (`app.js:13199-13214`: sets `status:'void'` and removes purpl `iv` `out` rows; **not admin-gated here**, unlike the combined path), Delete (`app.js:13216-13220`, admin-visible → `deleteRetailInv`/`deleteLfInvoice`), Copy HTML (`app.js:13222-13223`).

---

## 6. Distributor invoices — `#modal-add-dist-invoice` (`index.html:2886`)

`_openDistInvModal(distId, existingId)` (`app.js:7648-7690`): 4 purpl SKU case inputs; number defaults to `peekNextInvoiceNumber()`; due date from distributor `paymentTermsDays` (`_mdinvUpdateDueDate` `app.js:7692`). Save → `saveDistInvoice` (`app.js:7705-7759`): prices come from `dist_pricing` for *new* lines but stored prices are preserved on edit (`app.js:7714-7727`); warns on $0-priced lines; writes `dist_invoices`; **no inventory interaction** (dist stock moves via POs elsewhere). Delete (admin) → `deleteDistInvoice` (`app.js:7771-7784`) also sweeps `iv` rows with matching `invoiceId` defensively. `markDistInvoicePaid` (`app.js:7761-7769`). Reminder email per invoice: `_sendDistInvoiceReminder` (`app.js:16239-16256`) via `callSendEmail`, stamps `reminderSentAt`. Legacy `unpaid`/`overdue` statuses are remapped to `sent` once at boot by `migrateInvoiceStatuses` (`app.js:13792-13802`, called `app.js:13874`).

---

## 7. Lifecycle state machines & inventory deduction

Statuses everywhere: `draft → sent → paid`, plus terminal `void`; `overdue` is **derived** (due < today while not paid/draft/void) — never stored (KPI/list logic `app.js:15752-15757`, `15862-15869`; dashboard badge `app.js:2124-2131`).

**Where purpl inventory (`iv` `out`, cans) is deducted — exactly one of:**

| Trigger | Location | Condition |
|---|---|---|
| Create non-draft (manual modal) | `_saveInvCore` `app.js:16547-16554` | `status !== 'draft'`, same atomicUpdate as the invoice doc |
| Create non-draft (combined modal) | `saveNewCombinedInvoice` `app.js:12651-12661` | purpl lines only |
| Draft → sent | `markInvoiceSent(id)` `app.js:16259-16289` | in-flight set guard; `alreadyDeducted = iv.some(invoiceId===id && type==='out')`; status flip + deductions in one atomicUpdate; skips `__shipping__` |
| Combined send | `app.js:13383-13397` | re-checks `alreadyDeducted` *inside* the atomic block |
| Delivery run "Create Invoice" | `createDeliveryInvoice` `app.js:9377-9427` | **deducts immediately even though status is `draft`** (invoice + `iv` rows + order `invoiceStatus:'invoiced'` in one atomicUpdate) |

**Reversal:** void (single: `app.js:13208`; combined: `app.js:13449-13451`) and every delete path strip `iv` `out` rows by `invoiceId`. LF has no `iv` ledger; its analogue is the `lf_wix_deductions` record (created on save/portal-confirm, removed on delete/void, confirmed via `showWixPullModal` `app.js:13700`).

**Mark paid:** `markRetailInvPaid` (`app.js:2693-2702`, routes via `_invoiceCol` for legacy `iv` rows), `markLfInvPaid` toggle (`app.js:11718`), `markCombinedPaid` (`app.js:12208`), `markDistInvoicePaid` (`app.js:7761`), legacy `markPaid` (`app.js:15701-15710`). All set `paidDate` + `paidAt` and (child paths) call `_syncCombinedParentForChild`. Stripe webhook is the fifth payer (§9).

**Delete:** `deleteInvoiceWithCleanup(id)` (`app.js:87-118`) — removes the record from whichever collection holds it, deletes its `iv` `out` rows and `lf_wix_deductions`, and if the record is a **child** of a combined invoice it deletes the parent and clears `combinedInvoiceId` on the surviving sibling (HIGH-5 comment: otherwise the sibling's dollars vanish from all `excludeChildren` reports). Also scrubs matching `cadence` entries off accounts. Wrappers: `deleteInvoice` (`app.js:16291`, admin), `deleteRetailInv` (`app.js:2704`, admin), `deleteLfInvoice` (`app.js:12144`, admin), `deleteInvRecord` (`app.js:16564`, **no admin gate**), `deleteCombinedInvoice` (own logic, §5.3).

---

## 8. Invoice numbering

- `peekNextInvoiceNumber()` (`app.js:12345-12349`) — preview only: `INV-` + max(settings counter, cache max + 1); cache max scans all four typed collections + legacy (`_maxCachedInvoiceNum` `app.js:12332-12343`).
- `getNextInvoiceNumber(type)` (`app.js:12353-12404`) — Firestore **transaction** on `workspace/main/config/main` → `invoice_settings.nextInvoiceNum`: reserves `assign = max(serverNext, cacheMax+1)` and advances the counter in the same tx (collision-safe across tabs/users). One retry, then a cache-derived fallback with a loud "verify not duplicate" toast (`app.js:12392-12401`). The `type` argument is ignored — one global sequence for all types. Settings page can seed/override the counter (`saveInvoiceSettings` `app.js:16301-16322`, `set-next-inv-num`).
- Numbers are backfilled lazily in previews for legacy records (`app.js:13074-13078`, `13244-13248`).

---

## 9. Stripe

- **Link generation (client):** `_getStripePayLink(invoice, type)` (`app.js:684-713`) → callable `createPayLink`. On failure shows a sticky error and falls back to the static `invoice_settings.stripeLink`. Called by every send/print/preview/reminder path with type `retail|lf|combined` (paid invoices skip it).
- **`createPayLink`** (`functions/index.js:955-1015`; near-duplicate `createStripePaymentLink` `functions/index.js:1021-1081`): auth-required; **server-side amount lookup** (`grandTotal||total||amount`, min $0.50) from `workspace/main/<col>` — client amount is ignored (TB-2); creates a Checkout Session with `metadata {invoiceNumber, invoiceId, invoiceType, accountId}`; success/cancel → `payment-success.html`.
- **`stripeWebhook`** (`functions/index.js:1085-1253`): signature-verified; only `checkout.session.completed`; idempotent via `stripeEventId` lookup in `workspace/main/audit_log` (`functions/index.js:1126-1132`). Marks the invoice `paid` (`paidVia:'stripe'`, `paidAmount`); flags `paidAmountMismatch` + appends a note if the charged amount differs from the current total (pay link predates an edit) (`functions/index.js:1157-1174`) — surfaced as the ⚠ badge (`app.js:15828`). Retail misses fall back to legacy `iv` (`functions/index.js:1180-1185`); orphan payments are audit-logged and ACKed (`functions/index.js:1186-1203`). Combined: children are marked paid too, with the parent-specific mismatch note stripped first (`functions/index.js:1209-1232`). Note: the webhook does **not** run the client's `_syncCombinedParentForChild`; it writes parent+children directly.
- Settings diagnostics: `testStripeConnection` → callable `stripeStatus` (`app.js:16344-16373`, `functions/index.js:913`).

---

## 10. ShipStation & warehouse

- **Push:** `pushInvoiceToShipStation(invoiceId, collection)` (`app.js:520-598`): needs an account address (`_parseAddress` `app.js:498`); combined parents gather line items from both children (`app.js:539-543`); variant lines expand to per-variant SKUs; calls callable `pushToShipStation` (`functions/index.js:1259-1335`, ShipStation V1 `orders/createorder`, `orderNumber = invoice number`); success stamps `deliveryMethod:'ship'`, `shipStationOrderId`, `shipStationPushedAt` + audit. Auto-invoked from portal confirm when method=ship (`app.js:15513-15517`) and from all Save-&-Send paths.
- **Webhook:** `shipStationWebhook` (`functions/index.js:1369-1642`): shared-secret (last 8 chars of the API key as `?secret=`) + resource-URL origin check (TB-1); fetches shipments, groups by `orderNumber`. `SAMPLE-` orders update account sample records transactionally, deduct 3 cans from farm pool, email the customer (`functions/index.js:1429-1552`). Invoice orders: finds the invoice **by `number`** across `retail_invoices`/`lf_invoices`/`combined_invoices` (`functions/index.js:1556-1559`; legacy `iv` not searched), idempotently replaces the `__shipping__` line, sets tracking/carrier/`readyToSend:true`, sets issue/due dates **only on first shipment** (`shippedAt` guard, `functions/index.js:1597-1607`), and updates `total`/`amount` — or, for combined, only `grandTotal` (`functions/index.js:1609-1615`; the client's `_syncCombinedParentForChild` later preserves this shipping delta, `app.js:12261`).
- **Client reaction:** `_checkShippedInvoices` (`app.js:605-616`, called on snapshot refresh) shows the green "Shipped!" banner with per-invoice Open buttons (`_showShippedBanner` `app.js:618-647`); sending clears `readyToSend` (`_clearReadyToSend` `app.js:651-657`).
- **Warehouse push** is a local-only flag (`pushToWarehouse` `app.js:15844-15848`) — no external call; `warehousePushedAt` drives the ✓ badge and button visibility.

---

## 11. Statement printing

`printAccountStatement(accountId)` (`app.js:13482-13587`), launched from the account modal header (`app.js:3438`) and the invoices tab of the account modal (`app.js:13671`). Aggregates purpl (dedup legacy) + LF, both `!combinedInvoiceId`, plus combined parents; draft/void/paid contribute $0 balance (`app.js:13505`); prints via `window.open` + auto `window.print()` (`app.js:13579-13586`). Dist invoices are **not** included on statements.

---

## 12. Cross-section map

### 12.1 Producers (things that create invoices)

| Source | Path | What it writes |
|---|---|---|
| Portal order confirm | `confirmPortalOrder` (`app.js:15223-15560`), Save button wired at `app.js:15201-15202` | Transactionally claims the `portal_orders` doc (and the paired other-brand doc from the same submission, `app.js:15275-15284`); reserves numbers up front (`app.js:15372-15388`); one `atomicUpdate` writes `orders` rows + either a combined trio (purpl child + LF child + parent, all `status:'draft'`, `source:'portal'`, `portalOrderId`) or a single purpl/LF draft (`app.js:15394-15499`); LF paths add an `lf_wix_deductions` record (`_lfWixDeductionFor` `app.js:15211-15220`); auto-ShipStation push if ship (`app.js:15513-15517`); bail-out paths restore the claimed status (B2 comments `app.js:15244-15249`, `15346-15353`). No inventory deduction at confirm (drafts deduct on send). |
| Delivery run | stop marked done → `offerDeliveryInvoice` banner (`app.js:9347-9374`) → `createDeliveryInvoice` (`app.js:9377-9427`); batch variant `createBatchDeliveryInvoices` (`app.js:9462-9481`) | `retail_invoices` draft with `source:'delivery_run'` + **immediate** `iv` deduction + order `invoiceStatus:'invoiced'`. Un-toggling a stop / removing it / clearing the route reverses order+invoice+`iv` (`app.js:9306-9341`, `9483-9510`, `9512-9539`) |
| Manual modals | §3, §4, §5.1, §6 | |
| Account modal | pairing combiner (§5.1.2); `openAddInv` alias (`app.js:2425-2427`) used by approval flows | |

### 12.2 Consumers (things that read invoices)

- **Dashboard:** `renderDash` calls `renderInvoiceReminders()` (`app.js:1497` → `app.js:2197-2274`; queues unpaid due-in-7d/overdue purpl+LF (children excluded) **and combined parents**, Send Reminder → `sendInvoiceReminder` `app.js:2276-2308` with pay link + `reminderSentAt` guard) and `renderInvoiceStatus()` (`app.js:1524` → `app.js:2076-2191`; order-level `invoiceStatus` KPIs plus a "Recent Invoices" table with print/paid/preview buttons). Quick actions count overdue + drafts via `_allInvoices({excludeChildren:true})` (`app.js:1273-1301`).
- **Accounts page:** per-card outstanding from `_allInvoices({accountId, excludeChildren})`, indexed once per render (`app.js:3157-3164`, `3308-3312`); account modal Invoices tab `renderMacInvoicesTab` (`app.js:13589-13686`) lists all three brands + combined-create UI + Statement button.
- **Reports:** all-brands Total Invoiced KPI excludes void (`app.js:9629-9637`); per-account outstanding (`app.js:9759`); LF reports read `lf_invoices` (`app.js:10556-10564`); **Year-End/Tax export** `exportYearEnd` (`app.js:10446-10495`) — paid-only CSV: purpl (dedup, children excluded), LF (children excluded), combined parents as **two rows** (purpl+LF subtotals), dist invoices.
- **Global search:** `retail_invoices` hits at `app.js:1257`.
- **Emails/cadence:** every send logs an `invoice_sent`/`invoice_reminder` cadence entry with `sentMessageId`; `resendWebhook` (`functions/index.js:691-782`) marks `opened`/`clicked` on those entries → badges in list, previews, account timeline.
- **Functions mutating invoices:** `stripeWebhook` (paid), `shipStationWebhook` (tracking/shipping/readyToSend/dates/totals). Both write Firestore directly; the client picks changes up via per-collection snapshot listeners (`db.js:208-233`).

---

## 13. Observations / risks (read-only findings)

1. **Admin-gate inconsistency:** `deleteInvRecord` (purpl modal Delete, `app.js:16564`) and the single-brand preview **Void** (`app.js:13199-13214`) skip `_requireAdmin`; every other delete/void path enforces it (combined void `app.js:13432`, deletes `app.js:16292/2706/12145/12276/7772`).
2. **Delivery-run invoices deduct inventory at `draft`** (`app.js:9408-9417`) while every other path deducts at send — consistent with "goods already handed over", but a draft-void of such an invoice via the preview modal correctly restores stock, whereas plain `deleteInvoiceWithCleanup` also does; a *status edit* to void via the purpl modal (`#iv-status` includes `void`) does **not** remove `iv` rows (`_saveInvCore` never strips deductions on edit).
3. **Delivery-run line-item shape** (`sku`/`amount`, no `skuId`) renders blank in the edit modal (§1.3) — editing and saving such an invoice can silently drop its lines (validation would then reject with "Enter at least one case quantity" only if all rows are zero).
4. **`saveNewCombinedInvoice` never creates an `lf_wix_deductions` record** (unlike the LF modal and portal paths), so manual combined invoices produce no Wix pull instruction (§5.1.1).
5. **Numbering type argument unused** — single global sequence; user-entered numbers bypass the counter and can collide (mitigated by `_maxCachedInvoiceNum` floor).
6. **ShipStation webhook matches only on the `number` field** across the three main collections — legacy `iv` invoices and dist invoices pushed to ShipStation would never receive tracking (`functions/index.js:1556`).
7. **Stripe pay links freeze the amount at generation** — mitigated (not prevented) by `paidAmountMismatch` flag + note + audit row (`functions/index.js:1157-1174`).
8. **Un-toggling a delivery stop cleans up only `source==='delivery_run'` retail invoices** — a portal- or manually-created invoice on the same account/day is safe (`app.js:9325-9331`), but combined children of deleted portal invoices are handled only via `deleteCombinedInvoice`/HIGH-5 sibling logic.
9. `markInvoiceSent`'s `alreadyDeducted` check reads the cache *before* the atomic block (`app.js:16265`) — the combined-send path fixed this by re-checking inside (`app.js:13384`); a double-click on markInvoiceSent is instead guarded by `_markSentInFlight` (`app.js:16258`).
