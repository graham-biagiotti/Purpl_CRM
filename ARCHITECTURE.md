# Purpl CRM — Master Architecture

Synthesized from the ten section reviews in `docs/arch/` (00-foundation … 09-map-reports-settings).
Written for the single operator running this live system. Every claim cites the source doc section
and, where load-bearing, the `file:line` it came from. No code was changed to produce this.

---

## 1. One-page mental model

The whole system is five layers. If you understand these, every trace in §3 follows.

```
┌─────────────────────────── FIRESTORE ────────────────────────────────────┐
│  workspace/main/{key}/{docId}   17 per-record collections (ac, orders…) │
│  workspace/main/config/main     ONE doc holding all config arrays+objs  │
│  TOP-LEVEL (outside DB layer):  portal_orders, portal_inquiries,        │
│    portal_settings, portal_config, accounts/prospects token index, users│
└───────────────┬──────────────────────────────▲──────────────────────────┘
     onSnapshot │ (per collection + config)    │ writes: immediate per-doc
                ▼                              │ + 500ms debounced batch
┌──────────────────────────────────────────────┴──────────────────────────┐
│  db.js DB._cache — in-memory, SYNCHRONOUS reads (DB.a / DB.obj)         │
│  writes: DB.push / update / remove / setObj / atomicUpdate              │
│  modal-open = "dirty" → remote snapshots deferred until modal closes    │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ _scheduleRefresh (120ms debounce, db.js:274)
                ▼
│  window.refreshCurrentPage → renders[currentPage]()  (app.js:13879)     │
│  nav(page) dispatch table renders{} (app.js:293-312) — ONE page active  │
                ▼
│  17 tabs, all in ONE file: public/app.js (~17,000 lines)                │
```

**Key properties** (doc 00 §2):

- **Reads are synchronous, writes are optimistic.** Every render reads `DB.a('key')` straight
  from cache; mutators update the cache first, then persist. There are no awaits in render paths.
- **"Atomic" means local-atomic.** `DB.atomicUpdate` (db.js:691) suppresses snapshot races and
  diff-deletes, but the Firestore writes are batched merge-sets, not a server transaction
  (doc 04 §1.1). Real Firestore transactions exist in exactly three places: invoice-number
  allocation (app.js:12353), the portal-order confirm claim (app.js:15228), and user-role
  bootstrap (functions/index.js:666).
- **Re-render = full recompute.** Any remote change (or local mutation) re-runs the active
  page's render function, which re-scans whole cached collections. Fine at ~hundreds of records.

**Cloud Functions surface** (functions/index.js, 21 exports — doc 00 §7): callables for email
(Resend), Stripe pay links, ShipStation push, AI drafting, role/invite; public callables for the
portal (config, password, token lookup, order history, confirmations); and three inbound
webhooks that **write back into the same Firestore data**: `stripeWebhook` (marks invoices paid),
`shipStationWebhook` (tracking, shipping lines, sample handling + a 3-can inventory deduction),
`resendWebhook` (open/click flags on cadence entries). The browser client picks up all
server-side writes via the snapshot listeners — there is no polling.

**The customer portal is a separate client.** `public/order.html` (and the wholesale
application page) talk to top-level collections `portal_orders` / `portal_inquiries` via public
callables and direct batched writes — **never through db.js** (doc 06 §1-2). The CRM staff side
mirrors these into its own `PortalDB` cache (app.js:14313) with a live `onSnapshot` capped at
500 docs (app.js:16764). So there are two data planes: the workspace plane (db.js-cached) and
the portal plane (direct Firestore), and the confirm flow in §3a is the bridge between them.

---

## 2. Collection ownership table

"Owner" = the tab whose UI creates/edits the data. Sources: doc 00 §3, doc 06 §1, doc 09 §3.3.

### Per-record collections (`workspace/main/{key}`)

| Key | What it holds | Owning tab | Other writers | Other readers |
|---|---|---|---|---|
| `ac` | Accounts (embedded `cadence[]`, `contacts[]`, `samples[]`, `notes[]`, portal token) | Accounts | Orders/Delivery (`lastOrder`), Emails (cadence, `lastContacted`), portal approve/confirm flows, CFs: `_logCadenceEntry`, `resendWebhook`, `shipStationWebhook`, `unsubscribe` | Dashboard, Map, Reports, Projections, Invoicing (pricing), Distributors (`fulfilledBy`) |
| `pr` | Prospects | Prospects | Portal (create-prospect-from-order/application), Emails (outreach) | Dashboard follow-ups, Map, Win/Loss report |
| `iv` | **Dual-purpose**: inventory ledger (cans) AND legacy purpl invoices | Inventory | 13 writers — see §3g | On-hand math everywhere, invoice lists (legacy rows), Stripe webhook fallback |
| `orders` | Wholesale orders (cases) | Orders & Delivery | Portal confirm, Local Line import, delivery `toggleStop` | Dashboard, Reports (all purpl revenue), Projections, Production demand |
| `retail_invoices` | purpl invoices | Invoices | Delivery run, portal confirm, Stripe + ShipStation webhooks | Dashboard KPIs, account cards, statements, year-end export |
| `lf_invoices` | Lavender Fields invoices | Invoices | Portal confirm, webhooks | LF reports, dashboard, statements |
| `combined_invoices` | Parent linking one purpl + one LF child (`grandTotal`) | Invoices | Portal confirm (dual-brand), Stripe/ShipStation webhooks | KPIs (parents excluded from dollar sums), statements, tax export |
| `dist_profiles` | Distributor master records | Distributors | Outreach/velocity/contact subwrites | Accounts (`fulfilledBy` options), Map DC pins, dashboard dist KPIs |
| `dist_reps` / `dist_pricing` / `dist_chains` / `dist_imports` | Reps, price tiers, chain groupings, depletion imports | Distributors | — | Pricing feeds PO/invoice valuation; chains feed door counts |
| `dist_pos` | Distributor POs (incl. shipment POs `isShipment:true`) | Distributors | — | Orders tab "Distributor Orders", Projections dist forecast, dist reports |
| `dist_invoices` | Distributor invoices | Distributors | Invoices hub (mark paid, reminders) | Invoices unified list/KPIs, dashboard, tax export |
| `audit_log` | Append-only trail (rules deny update/delete) | — (written everywhere via `auditLog()`) | CFs: stripeWebhook, shipStationWebhook | Settings → Audit tab; Stripe idempotency check reads it |
| `prod_hist` | Production run history | Production | — | — |
| `runs` | Archived delivery runs (miles/fuel/cost) | Orders & Delivery (`clearRoute`) | — | Delivery report |
| `shipments` | Planned inbound shipments (no ledger effect) | Production | — | — |

### Config-doc keys (all inside the single `workspace/main/config/main` doc)

| Key | Owner | Notes |
|---|---|---|
| `settings` | Settings | Many keys are dead (doc 09 §3.3); live: `default_payment_terms`, `lowStockThreshold`, `mpg`/`gasPrice`, warehouse coords, `noteSections` (dashboard scratchpad) |
| `costs` | Settings | COGS/margin/overhead → reports, dist pricing margins |
| `today_run` | Orders & Delivery | The one shared delivery run; also written by Map run mode |
| `invoice_settings` | Settings/Invoices | Numbering counter (`nextInvoiceNum` — the transaction target), terms, ACH/check text; read server-side by shipStationWebhook |
| `shipstation_settings` | Integrations | `storeId` live, `fromAddress` dead |
| `api_settings` | — | **Dead key** |
| `lf_skus` | Settings | LF catalog → LF invoicing, portal (staff only — customers get a hardcoded fallback, doc 06 §8.3) |
| `lf_wix_deductions` | Invoices/Delivery | Pending Wix stock pulls — the LF analogue of `iv` deductions |
| `pending_invoices`, `quick_notes`, `loose_cans`, `repack_jobs`, `pallets`, `pack_supply`, `returns`, `saved_reports` | Dashboard / Inventory / Reports | `saved_reports` also collects Local Line import logs (doc 09 §2.4) |
| `stock_locations`, `stock_transfers` | — | **Dead keys** |

### Top-level (portal plane, outside db.js)

| Collection | Written by | Read by |
|---|---|---|
| `portal_orders` | Customer submit (order.html:1285), staff status updates, CFs | Staff PortalDB + live listener, CFs (confirmation email, order history) |
| `portal_inquiries` | Wholesale application page | Applications UI, CFs |
| `portal_settings/config` | `savePortalSettings` mirror (app.js:15624) | Public CFs `getPortalConfig` / `verifyPortalPassword` |
| `portal_config/main` | `savePortalSettings` primary | CRM-side `PortalDB.getConfig` — **dual-write pair**, see §5 |
| `accounts` / `prospects` | Token minting (`generateOrderLink`, approvals, mass-send pre-pass) | `lookupPortalToken`, `getPortalOrderHistory` |
| `portal_notify`, `portal_tokens` | **Nothing** — dead (doc 06 §8.4, §4) | Notify tab (always empty) |
| `users`, `app_config/access_control` | `initUserRole`, `inviteEmployee` CFs | auth.js role bootstrap, Team tab |

---

## 3. THE CROSS-SECTION COMMUNICATION MAP

The chains below are the money paths. Each step lists what fires, what it writes, and where.

### 3a. Portal submission → staff confirm → orders + invoices + inventory + Wix pull

(doc 06 §2, §5-6)

1. **Customer submits** (order.html `submitOrder`, :1135-1382). One Firestore `batch()` writes up
   to two `portal_orders` docs (one per brand), joined by a shared `submissionId`
   (order.html:1244-1285). Fire-and-forget public callable `sendOrderConfirmation`
   (functions/index.js:107) emails the customer — recipient is server-authoritative from the
   order doc, idempotent via `emailLog`.
2. **Staff sees it live.** `_listenPortalOrders` snapshot (app.js:16764, limit 500) updates the
   sidebar badge + dashboard card and toasts "New portal order received!".
3. **Confirm** (`confirmPortalOrder`, app.js:15222-15560):
   - Firestore **transaction claims** the primary doc (`status:'confirmed'`) — the cross-tab
     idempotency guard (app.js:15228-15237); the paired brand doc is claimed by a second
     transaction (app.js:15269-15284). Bail-outs roll both claims back.
   - Invoice numbers reserved up front via the `getNextInvoiceNumber` transaction on the config
     doc (app.js:12353; dual-brand reserves purpl+lf+combined, app.js:15375-15381).
   - **One `DB.atomicUpdate`** (app.js:15394-15499) then writes into the workspace plane:
     `orders` (one per brand, `source:'portal'`, `combinedOrderGroupId`), `ac.lastOrder`,
     and either a combined trio (purpl child + LF child + `combined_invoices` parent, all
     `status:'draft'`) or a single-brand draft. LF paths also append an `lf_wix_deductions`
     record (`_lfWixDeductionFor`, app.js:15211).
   - Post-write: portal docs get `convertedOrderId`; auto-ShipStation push if delivery method
     is 'ship' (app.js:15513); a cadence entry `order_confirmation` / `method:'crm_confirm'` is
     logged on the account — no second customer email (app.js:15527).
4. **Inventory deducts later, at send.** Confirm creates drafts; `markInvoiceSent`
   (app.js:16259) writes the `iv` `out` rows on the first draft→sent flip (see §3b/§3g).
   The LF "deduction" is the Wix pull record, confirmed by staff in `showWixPullModal`
   (app.js:13700) — LF stock lives in Wix and never touches `iv`.
5. **Reversal**: voiding the combined invoice voids children, removes the Wix deduction, strips
   the `iv` out-rows, and resets the portal order to `status:'new'` (app.js:13440-13459).
   Caveat: the Confirm pipeline is transactional only on the portal doc — the orders/invoices
   land via the debounced cache layer, so a crash in between leaves a confirmed portal order
   with no invoice (doc 06 finding 5).

### 3b. Invoice lifecycle: draft → sent → paid, across all four types + webhooks

(doc 04 §7, §9-10)

**Statuses**: `draft → sent → paid`, terminal `void`. `overdue` is always **derived**
(due < today, not paid/draft/void) — never stored (app.js:15752-15757).

1. **Draft created** by: manual modals (purpl app.js:2429, LF app.js:11730, combined
   app.js:12408, dist app.js:7648), portal confirm (§3a), or the delivery run (§3c — the one
   path that deducts inventory at draft, app.js:9408).
2. **Draft → sent**:
   - Save & Send buttons: `_saveInvCore` / `_saveLfInvoiceCore` → Stripe pay link
     (`_getStripePayLink` app.js:684 → callable `createPayLink`, functions/index.js:955, which
     looks the amount up **server-side** — client amounts are never trusted) → `sendEmail`
     callable (Resend) → status flip. purpl flips via `markInvoiceSent` (app.js:16259) which
     also writes the `iv` deduction exactly once (`alreadyDeducted` guard, app.js:16265).
   - Combined send: `sendCombinedInvoice` callable → one atomicUpdate marks parent+children
     `sent` and deducts the purpl child's lines if not already (app.js:13376-13403).
   - Every send appends an `invoice_sent` cadence entry with `sentMessageId` to `ac.cadence`
     and stamps `lastContacted` (§3e).
3. **ShipStation writes back** (`shipStationWebhook`, functions/index.js:1369): matches the
   invoice **by `number`** across retail/lf/combined (legacy `iv` and dist invoices are never
   matched — doc 04 finding 6), injects/replaces a `__shipping__` line item, updates
   `total`/`amount` (combined: `grandTotal` only), sets tracking + `readyToSend:true`, and sets
   issue/due dates on **first** shipment only (functions/index.js:1597-1607). The client's
   snapshot refresh shows the green "Shipped!" banner (`_checkShippedInvoices`, app.js:605).
4. **Paid** — five payers: `markRetailInvPaid` (app.js:2693, routes legacy `iv` rows via
   `_invoiceCol`), `markLfInvPaid` (a toggle, app.js:11718), `markCombinedPaid` (app.js:12208),
   `markDistInvoicePaid` (app.js:7761), and **`stripeWebhook`**
   (functions/index.js:1085): signature-verified, idempotent via `stripeEventId` in
   `audit_log`, sets `paid/paidVia/paidAmount`, flags `paidAmountMismatch` if the invoice was
   edited after the pay link was minted (the ⚠ badge, app.js:15828), falls back to legacy `iv`,
   and cascades paid to combined children directly (functions/index.js:1209-1232).
5. **Parent/child sync**: every client-side child mutation calls
   `_syncCombinedParentForChild` (app.js:12234) — re-derives subtotals, preserves the
   webhook's shipping delta in `grandTotal`, parent is paid only when both children are.
6. **Delete**: `deleteInvoiceWithCleanup` (app.js:87-118) removes the doc, its `iv` out-rows,
   its Wix deduction, dissolves a combined parent (so the sibling's dollars don't vanish from
   `excludeChildren` reports), and scrubs matching cadence entries. It does **not** reset the
   linked order's `invoiceStatus` (doc 03 finding 6).

### 3c. Delivery run: stop → order → invoice → ledger

(doc 03 §4-5)

1. **Build the route.** Stops accumulate on the single shared `today_run` config object —
   from the route-builder form (`addStop` app.js:9197), an account card "+ Run"
   (app.js:9094), or the map's run mode (`mapAddToRun` app.js:14273). Stops are addressed by
   **array index**, not id (doc 03 §4.1).
2. **Mark stop done** (`toggleStop` app.js:9234): one atomicUpdate writes **four keys** —
   `today_run` (done flag + `ordId` link), `ac.lastOrder`, a new `orders` row
   (`status:'delivered'`, `source:'run'`), and, for LF items, an unconfirmed
   `lf_wix_deductions` record (app.js:9284-9291). Inventory is deliberately NOT deducted here.
3. **Offer invoice** banner (+200ms) → `createDeliveryInvoice` (app.js:9377): prices lines with
   `_calcPricePerCase(ac)` (app.js:23-28), claims a number via the transaction, then one
   atomicUpdate writes the `retail_invoices` **draft** + immediate `iv` `out` rows
   (cases×12, pool warehouse, keyed `invoiceId`) + `orders.invoiceStatus:'invoiced'`
   (app.js:9408-9422). This is the only path that deducts at draft — goods already left the van.
4. **All stops done** → delivery-cost modal (miles/fuel from `settings.mpg`/`gasPrice`,
   app.js:9562) stamps costs onto `today_run`, then the batch-invoice banner
   (`createBatchDeliveryInvoices` app.js:9462 — fire-and-forget, doc 03 finding 4).
5. **Clear Route** (app.js:9512) archives the run into the `runs` collection — the sole data
   source for the Delivery report (app.js:10034) — and resets `today_run`.
6. **Un-toggling a stop** reverses exactly its own records by stored links (order by `ordId`,
   invoice by `orderId`, `iv` by `invoiceId`, Wix deduction by id — app.js:9306-9338);
   `removeStop`/`clearRoute` still use the older account+date match and can hit the wrong
   record when one account has two stops in a day (doc 03 finding 2).
7. **Known trap**: delivery invoices store lines as `{sku, amount}` not `{skuId, lineTotal}`,
   so the purpl edit modal renders them blank (doc 03 §5 bug; doc 04 §1.3).

### 3d. Distributor shipment → PO + deduction → dist invoice

(doc 07 §3c-3d)

1. **Log Shipment** (`saveDistShipment` app.js:7266): values items from `dist_pricing`, then
   ONE atomicUpdate writes three things — a `dist_pos` record (`isShipment:true, shipId`),
   `iv` `out` rows per SKU (cases×12, warehouse, `source:'dist_shipment'`, `ref:shipId`), and
   `dist_profiles.lastOrderDate` (app.js:7320-7336). Deduction happens immediately regardless
   of the PO's status field.
2. **Manual PO** (`saveDistPO` app.js:7570) is billing-paperwork only: no inventory, and it
   does **not** update `lastOrderDate` — which is why the "Overdue Reorders" KPI (reads
   `lastOrderDate` only, app.js:6440) and the dist card (falls back to latest PO date,
   app.js:6497) can disagree (doc 07 §8).
3. **PO status cycling** (`cycleDistPOStatus` app.js:7600) never touches inventory —
   cancelling a shipment PO leaves the deduction in place; only **delete**
   (`deleteDistPO` app.js:7611) reverses, by filtering the `iv` rows with `ref===shipId`.
4. **Dist invoice** (`saveDistInvoice` app.js:7705): lines priced from `dist_pricing` for new
   lines, stored prices preserved on edit; unpriced lines confirm "$0". Dist invoices **never
   touch `iv`** — shipments move stock, invoices bill it. Paid/reminders flow through the same
   Invoices hub as everything else (§3b).
5. Note there are **two disconnected distributor price systems**: `dist_pricing` (what you
   charge the distributor) vs the per-account `ac.pricePerCaseDist` used by
   `_calcPricePerCase` for dist-fulfilled accounts (doc 07 §4).

### 3e. Email/cadence: who writes it, who reads it

(doc 08 §1-2, §6-7)

`ac.cadence[]` is the shared email ledger (capped at 500 entries, `_pushCadence` app.js:160;
same cap server-side). `lastContacted` is stamped by nearly every send.

**Writers** of cadence entries + `lastContacted`:

| Writer | Stage / method | Where |
|---|---|---|
| Emails page compose (`emailsPageSendEmail`) | mapped template stage, `method:'resend'` (or optimistic `'gmail'` on failure) | app.js:4436-4499 |
| Mass broadcast / template send | `'broadcast'` / mapped stage | app.js:4878, 4960 |
| Account-modal cadence tab (`markCadenceEmailSent`) | stage, `method:'manual'` even for Resend sends (quirk) | app.js:3758-3779 |
| All invoice Save-&-Send / preview-send paths | `invoice_sent` + `invoiceId` + `sentMessageId` | app.js:2532, 11835, 13179, 13407 |
| Dashboard reminder (`sendInvoiceReminder` → `_sendWithCadence`) | `invoice_reminder` | app.js:737-759, 2276 |
| Portal confirm (no email) | `order_confirmation`, `method:'crm_confirm'` | app.js:15527 |
| approveApplication | `approved_welcome`, `method:'auto'` — no `lastContacted` | app.js:16894-16909 |
| **Server**: `sendCombinedInvoice` + `_logCadenceEntry` | `invoice_sent` — double-logs on top of the client entry | functions/index.js:86-93, 785 |
| **Server**: `sendOrderConfirmation`, `shipStationWebhook` sample flow | cadence / `samples[]` updates | functions/index.js:257, 1444 |
| **Server**: `resendWebhook` | adds `opened/clicked` flags onto existing entries by `sentMessageId` — via a **full scan** of `ac` per event | functions/index.js:737-746 |

**Readers**:

- Dashboard "Action Required" card `renderCadenceOverdue` (app.js:1994): accounts missing
  `approved_welcome`, invoices with no matching `invoice_sent` (`c.invoiceId` join).
- Emails page KPIs, Overview stage grid, History tab, Recent Auto-Sends (app.js:4160-4246,
  4533-4670) — all defensively match both underscore and hyphen stage ids.
- Account modal Cadence tab (app.js:3830) and the open/click badge on invoice rows
  (`_invEmailBadge` app.js:139 joins cadence entries by `invoiceId`).
- `lastContacted` feeds `acLastContacted` (app.js:3078 — max of notes/outreach/cadence dates),
  which drives account cards, "Needs Attention" 30-day staleness, and mass-email filters.
- Opt-out: `unsubscribe` CF sets `ac.emailOptOut`; marketing sends hard-skip it, compose paths
  confirm-override, invoice/transactional sends ignore it by design (doc 08 §8).

### 3f. Where every money number originates

(doc 09 §2.3 — the single most useful table for reconciling numbers)

There are **two revenue bases** that legitimately disagree:

| Basis | What uses it | Why it can differ |
|---|---|---|
| **Orders × current account price** (`_calcPricePerCase`, app.js:23-28, fallback $27.60) | purpl Revenue/Account/SKU/Profit reports (app.js:10095-10405), Top-10, Going-Cold, MoM tiles, dashboard revenue + projections (`calcOrderValue` app.js:1744, `calcProjections` app.js:2746) | Reprices history at TODAY's price — changing an account's price rewrites reported past revenue. Orders exist even if never invoiced. |
| **Invoice records** (`amount`/`total`/`grandTotal` stored on docs) | Reports-page combined KPI (app.js:9632), Invoices tab KPIs (app.js:15850), dashboard Outstanding/Overdue/Payments, LF reports (paid `lf_invoices`, app.js:10556), account statements, **Year-End tax export** (paid-only, app.js:10446) | What was actually billed/collected. Combined **parents** are excluded from dollar sums (children carry the dollars); the tax export explodes parents into two subtotal rows. |

Further divergences to expect (doc 01 §4):

- Dashboard "Outstanding"/"Overdue" KPIs exclude `dist_invoices`; the Invoices tab includes
  them (app.js:1421-1427 vs 15880). The quick-actions overdue count uses yet a third scope.
- The dashboard "Invoice Status" card is built from `orders.invoiceStatus` — a manual,
  order-level flag (`setInvStatus` app.js:2368) that is a **parallel state machine** never
  reconciled with the invoice collections.
- Delivery report reads `runs` and ignores the date filter; order reports filter on `dueDate`
  only, so orders without a due date are invisible (app.js:9914-9917).

### 3g. Inventory: the `iv` ledger on one screen

(doc 05 §1, §6). Units: **ledger is CANS, orders/invoices are CASES**; every conversion is
`× CANS_PER_CASE (12)`. On-hand = `_onHand(sku,pool)` = clamped-at-0 sum of `in`+`return`−`out`
(app.js:122-135); pool defaults to `'warehouse'`; deductions never check availability.

**13 writers:**

| # | Flow | Direction | Key back-reference | Where |
|---|---|---|---|---|
| 1 | Receive finished packs | in | — | app.js:8138 |
| 2 | Repack job output (variety packs) | in | `repackId` | app.js:8217 |
| 3 | Ship pallet | out | `palletId` | app.js:8303 |
| 4 | Manual +Add/−Use | in/out | — | app.js:8501 |
| 5 | Log production run | in | `prodId` | app.js:8985 |
| 6 | Pool transfer (paired out+in) | both | `transferId` | app.js:8538 |
| 7 | Log return | return (counts as in) | — | app.js:8465 |
| 8 | Distributor shipment | out | `source:'dist_shipment'`, `ref:shipId` | app.js:7322 |
| 9 | purpl invoice created non-draft | out | `invoiceId` | app.js:16544 |
| 10 | Invoice draft→sent (`markInvoiceSent`) | out | `invoiceId` (guarded once) | app.js:16269 |
| 11 | Combined invoice created non-draft | out (purpl lines only) | `invoiceId` | app.js:12645 |
| 12 | Combined invoice sent | out | `invoiceId` | app.js:13376 |
| 13 | Delivery-run invoice (at draft!) | out | `invoiceId` | app.js:9408 |
| — | **Server**: sample shipped (ShipStation webhook) | out, 3 cans, farm pool | — | functions/index.js:1463 |

**Policy**: purpl stock deducts **when an invoice leaves draft** (or immediately for
delivery-run invoices); LF stock never touches `iv` — its analogue is `lf_wix_deductions`.

**Readers**: `_onHand` → inventory summary, dashboard Total-Inventory KPI + low-stock alerts,
Needs Attention per-pool checks, projections stock, `repInventory`; plus two inline re-sums
(production recommendation unclamped app.js:8897; dashboard prod-plan clamped app.js:2806) that
can disagree with each other.

**Reversers**: every invoice delete/void strips `out` rows by `invoiceId`; PO delete by
`ref`; pallet/repack/production deletes by their key. Danger zone: the Inventory Log tab can
delete **any** row by id — including one leg of a transfer pair or an invoice deduction — with
only a generic confirm (app.js:8506); and deleting an account orphans its invoice-linked
deductions because the cleanup filters `iv` on `accountId`, which deduction rows don't carry
(doc 02 finding 4, doc 05 §6.2).

---

## 4. "Same word, different data" glossary

| Term | Meaning #1 | Meaning #2 | How code disambiguates |
|---|---|---|---|
| **`iv`** | The inventory ledger: `{sku, type:'in'/'out'/'return', qty (cans), pool}` | Legacy purpl **invoices** that predate `retail_invoices` (rows with `number`/`invoiceNumber`) | Ledger math filters on `type`; invoice logic filters on `number||invoiceNumber` (`_allPurplInvoices` app.js:47). The Stripe webhook and pay-link lookup both include `iv` as an invoice collection. The single most confusing fact in the codebase (doc 05 §1.2). |
| **`due` vs `dueDate`** (and **`issued` vs `date` / `dateIssued`**) | LF invoices: `issued`/`due` | purpl: `date`/`dueDate`; dist: `dateIssued`/`dueDate`; portal-created LF rows use the purpl names | Every consumer does `x||y` fallbacks (doc 04 §1.3). Orders separately have `created` vs `dueDate` — reports filter on `dueDate`, reorder predictions on `created`, projections on `dueDate` (doc 01 §4.6). |
| **`total` vs `amount` vs `grandTotal`** | `amount` = manual purpl invoices | `total` = delivery-run/portal/LF/dist invoices; `grandTotal` = combined parents (children's subtotals + any shipping delta) | `_invAmt(inv) = grandTotal || amount || total` (app.js:120). ShipStation writeback updates `total`/`amount` on singles but only `grandTotal` on combined. |
| **`number` vs `invoiceNumber`** | Most invoices carry `number` | Delivery-run invoices carry only `invoiceNumber` | Lists fall back `x.number || x.invoiceNumber` (app.js:15762); the ShipStation webhook matches only `number`, so delivery invoices pushed to ShipStation would never receive tracking. |
| **Orders-based vs invoice-based revenue** | Orders × current account pricing (retroactive) | Stored invoice totals (billed/collected reality) | See §3f. Both are "revenue" on different screens; only the invoice basis feeds the tax export. |
| **Clamped vs raw stock** | `_onHand` clamps at 0 per sku/pool | `_onHandRaw` can be negative (pools can be over-deducted) | Warehouse + Farm can stop summing to Total when a pool is negative; the summary tab shows a warning banner (app.js:8046). Production recommendation uses unclamped sums; the dashboard prod-plan card clamps — the two can disagree (doc 05 finding 9). |
| **`invoiceStatus` (on orders) vs invoice `status`** | Manual per-order flag: not-invoiced/invoiced/paid (`setInvStatus` app.js:2368) | Real lifecycle on invoice docs: draft/sent/paid/void | Never reconciled — the dashboard "Invoice Status" card and its "Mark Paid" button operate purely on orders (doc 01 §4.3). |
| **`overdue`** | A derived display state (due < today) | A **stored** legacy status on old dist invoices | `migrateInvoiceStatuses` remaps stored `unpaid`/`overdue` → `sent` at boot (app.js:13792); everything current derives it. Three dashboard surfaces also count "overdue" over different invoice scopes (doc 01 §4.1). |
| **Cadence stage ids** | Underscore ids in `CADENCE_STAGES` (`invoice_sent`) | Hyphen ids in the template library (`invoice-sent`) | Mapping tables convert at write time; unmapped templates (`preorder-announcement`, `broadcast`) store raw hyphen ids, so readers match both spellings (doc 08 §2). |
| **"Distributor price"** | `dist_pricing` — per-distributor charge list feeding POs and dist invoices | `ac.pricePerCaseDist` — per-account value used by `_calcPricePerCase` for dist-fulfilled accounts | Two systems, never reconciled (doc 07 §4). |
| **`lastContacted`** | Stamped by real sends and logged outreach | Also stamped by optimistic Gmail fallbacks (a mailto draft that may never be sent) and 3-prompt quick notes | Doc 08 finding 3 — the ledger can claim contact that never happened. |
| **cases vs cans in the UI** | Pallet contents, projections "30d Need", shipment-modal inputs = cases | Ledger columns, production-run inputs (labeled "units") = cans | Several tables mix the two unlabeled (doc 05 finding 5). |

---

## 5. Architectural weak points, ranked

Descriptive only — what the shape of the risk is, not what to do about it.

1. **One 17,000-line `app.js` holds every tab's logic.** All 17 pages, all modals, all
   business rules share one global namespace and one render-dispatch table. Cross-section
   coupling is invisible until traced (this document exists because of that); any edit risks
   distant breakage, and the section docs found dozens of duplicated near-twin functions
   (`calcProjections` vs `calcProjectionsWindow`, two combined-pricing implementations, legacy
   column renderers) that drift independently.

2. **Stored-copy totals with `x||y` field drift.** Invoice dollars, subtotals, and dates are
   denormalized snapshots (`amount`/`total`/`grandTotal`, `date`/`issued`/`dateIssued`) written
   by six different producers with three naming conventions. Consistency depends on every
   mutation path remembering to re-sync (`_syncCombinedParentForChild` client-side — but the
   Stripe and ShipStation webhooks write parents/children directly and skip it), and every
   reader remembering the right fallback chain. The `paidAmountMismatch` flag exists precisely
   because a stored Stripe amount can diverge from an edited invoice.

3. **Dual-purpose `iv` collection.** Inventory ledger rows and legacy invoices share one
   collection, distinguished only by field presence. Every new reader/writer must know the
   idiom; the webhooks, pay-link lookup, delete cascades, and account deletion all carry
   special `iv` branches, and the account-delete cleanup already orphans deduction rows
   because it filters on a field only the invoice shape has.

4. **Dual-write portal config** (`portal_config/main` + `portal_settings/config`,
   app.js:15608-15626). The CRM reads one doc, the public portal reads the other, and only
   `savePortalSettings` mirrors them. Any other writer diverges the two silently — this
   already happened once (the order form not seeing price/mode changes) and the fix was to
   widen the mirror, not remove the split. Related standing item: `verifyPortalPassword`
   hardcodes acceptance of `purpleherb`, so rotating the password in Settings cannot revoke
   access (functions/index.js:466).

5. **Per-render full scans, at every layer.** Client: each render re-filters whole cached
   collections and rebuilds per-card derived values (`acLastContacted` scans
   notes+outreach+cadence per card); the dashboard recomputes projections three times per
   render; hidden legacy KPIs are still computed. Persistence: the debounced batch save
   merge-sets **every** cached item of a key, and the single config doc is rewritten whole on
   any config change (the coarsest lock in the system). Server: `resendWebhook` and the
   ShipStation sample branch do full-collection scans per event, and the portal listener's
   limit(500) is a hard visibility cap. All fine at today's scale; all grow linearly with data.

6. **Local-atomic writes bridging non-atomic boundaries.** `DB.atomicUpdate` is a cache-level
   convention, not a Firestore transaction. The portal confirm claims the portal doc
   transactionally but lands the orders/invoices through the debounced cache; delivery-run
   batch invoicing is a fire-and-forget async loop; `saveTodayRun` splits `prod_hist` and its
   ledger rows across separate pushes; and the two clean-up paths that still match by
   account+date instead of stored links (`removeStop`/`clearRoute`) can reverse the wrong
   record. Each is a small window where a crash or a same-day duplicate leaves half-applied
   state that only manual cleanup fixes.

7. **Parallel/orphaned state machines and dead surfaces.** `orders.invoiceStatus` never
   reconciles with invoice docs; the dashboard carries dead-but-computed KPIs and an
   unreachable LF-KPI renderer; the portal has a never-written `portal_notify` tab and a dead
   LF-submissions tab; Settings persists ~a dozen dead keys (including two dead config
   collections and `api_settings`); `createStripePaymentLink` is an unreferenced deployed
   function. None of it breaks anything today — but each is a trap for future changes that
   assume the surface is live.

---

*Source docs: `docs/arch/00-foundation.md` … `09-map-reports-settings.md`. Line numbers are as
of those reviews (app.js at 17,009 lines); treat them as anchors, not guarantees, after edits.*
