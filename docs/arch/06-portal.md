# 06 — Portal Orders Tab & Customer Portal (End-to-End)

Scope: `public/order.html` (customer portal), the portal surface of `functions/index.js`,
and the staff-side PORTAL ORDERS page in `public/app.js` (renderPreOrders, tabs, confirm
pipeline, samples, applications, links, PortalDB, live listener/badge). All paths relative
to `/home/user/Purpl_CRM`.

---

## 1. Data model / collections touched

| Collection | Written by | Read by | Rules (firestore.rules) |
|---|---|---|---|
| `portal_orders` | customer create (order.html:1285), staff updates/deletes | staff (PortalDB), CFs | create public w/ field caps (rules:45-56); read/update staff (57-58); delete admin (59) |
| `portal_notify` | **nothing** (see §8.4) | PortalDB.load (app.js:14324) | public create, staff read (rules:63-72) |
| `portal_settings/config` | savePortalSettings mirror (app.js:15624-15626) | getPortalConfig, verifyPortalPassword, approve/mass-send password fetch | admin write / staff read (rules:75-78) |
| `portal_config/main` | PortalDB.saveConfig (app.js:14345) | PortalDB.getConfig (app.js:14350) — staff only | admin write / staff read (rules:81-84) |
| `portal_tokens` | PortalDB.setToken (app.js:14339, vestigial — no callers found) | — | admin write / staff read (rules:87-90) |
| `portal_inquiries` | wholesale.html create (:835) | renderApplications, CFs | public create w/ caps (rules:93-103) |
| `accounts` / `prospects` (top-level token index) | generateOrderLink, mass-send pre-pass, approveApplication, prospect-convert migration | lookupPortalToken, getPortalOrderHistory, _renderPoLinks | staff only (rules:36-42) |
| `workspace/main/*` (ac, pr, orders, iv, retail_invoices, lf_invoices, combined_invoices, config/main) | DB.atomicUpdate / DB.update (db.js `_basePath()` = `workspace/main`, db.js:67) | staff + Admin-SDK CFs | staff (rules:124-131) |

---

## 2. Customer portal — public/order.html

### 2.1 Boot & token/password entry
- `init()` (order.html:837-1015). Token from `?t=` param, cached in `sessionStorage['pbf_portal_token']` (841-843). Stripe return banners on `?paid=1|cancelled=1` (847-856).
- Config load: callable **getPortalConfig** (859-875) → sets `portalMode` ('preorder'|'liveorder'), `pricePerCase`, banner + submit-button label.
- **Token path** (877-923): shows spinner, calls **lookupPortalToken**. Found → `_applyMatchedAccount()`; not-found → form shown with "link may have expired" in `#error-msg` (901-907); network error → password gate with retry message in `#pw-error` (912-922, "B2" fix).
- **No token** (924-928): password gate shown; anonymous visitors get purpl-only default + LF SKUs preloaded (1008-1013).
- **`Enter` button / Enter key → `checkPortalPassword()`** (order.html:205-208, 1802-1823): callable **verifyPortalPassword**; valid → hides gate, shows form.
- `_applyMatchedAccount(data)` (930-1005): locks name, prefills billing email, sets brands (`_brandLf = isPbf`, 938-941), parses string address into ship fields (955-973), applies `portalPrefs` (billingEmail/leadTimeNeeded/deliveryNotes, 975-988). **Deliberately does NOT prefill quantities** (989-991). Then calls **getPortalOrderHistory** → `renderPastOrders` (993-1004).

### 2.2 Brand selection & cart
- **Brand cards → `toggleBrand('purpl'|'lf')`** (order.html:220, 228 → 568-579): at least one brand always selected; `updateBrandVisibility()` (581-601) shows/hides sections, dual-brand notice, lazy-loads LF SKUs.
- `loadLfSkus()` (819-835) reads `workspace/main/config/main` field `lf_skus` **directly from the client**. Anonymous/customer reads are denied by rules:124-125 (staff-only), so the catch path renders the hardcoded `LF_SKU_FALLBACK` price list (533-564) — see finding §8.3.
- purpl qty: `#classic-cases` `oninput=updateCans()` (309, 1017-1022). Coming-soon notify checkboxes (328, 340) and sample-box checkbox (351, listener 1024-1027) feed `checkSubmitEnabled()` (1029-1054), which also enforces the terms checkbox (442) and LF variant unit-assignment match.
- LF rows (rendered 603-685): cases input → `updateLfCalc`/`updateLfVariantCases` (687-731); variant +/- steppers → `stepLfUnit` (733-752, caps over-assignment); unit inputs → `updateLfVariantCalc` (754-779). Cart extraction: `getLfItems()` (787-809), `getLfTotal()` (811-817).

### 2.3 Submit → Firestore writes
**`Place Order` button → `submitOrder()`** (order.html:456, 1135-1382):
1. Validation: billing email regex (1159), complete ship address (1177-1180), qty sanity 0..100000 incl. variant lines (1218-1233, "LOW-11"), at-least-one-item/sample/notify (1235), terms (1239).
2. **Atomic batch** (1244-1285, "#5"): mints `_submissionId = db.collection('portal_orders').doc().id` (1256); writes up to two `portal_orders` docs in one `db.batch()`:
   - purpl doc (1259): full `orderData` (1182-1212) + `{brand:'purpl', submissionId}` — `items:[{sku:'classic', cases, cansPerCase:12, totalCans}]`, `status:'new'`, `isMatched/isProspect/isUnmatched`, shipAddress, requestSample, notifyMe, deliveryWindow, poNumber, notes.
   - LF doc (1260-1283): `{brand:'lf', submissionId, lineItems, total, ...same shared fields}`.
   - Sample-only/notify-only submissions force a purpl doc so the request isn't lost (1250).
3. On commit, for matched accounts: `accounts/{accountId}.update({'portalPrefs.*': ...})` (1300-1318) — **fails silently** under rules:36-38 (staff-only write); see §8.2.
4. Fire-and-forget callable **sendOrderConfirmation** (1340-1355) with `portalOrderId = purplRef?.id || lfRef?.id`.
5. `showThankYou()` (1069-1133) renders summary; **`Print Confirmation` → `printCurrentOrder()`** (482, 1583-1679) opens a print window from in-memory `_lastOrderData`.
6. Failure path: error banner + re-enabled button (1369-1381).

### 2.4 Order history (customer)
- `renderPastOrders(orders)` (1385-1462): collapsible list (toggle wired at 1398 → `toggleOrderHistory()` 1682-1694), status badges, **`View PDF` → `printPortalOrder(id)`** (1454 → 1464-1474) which uses the in-memory `_pastOrders` (portal can't read `portal_orders`; "LOW-12") and prints via `_printPortalOrderDoc` (1476-1575).
- Dead code: `loadOutstandingInvoices`/`renderOutstandingInvoices` (1697-1757) read `workspace/main/{retail,lf,combined}_invoices` — never called, no `#outstanding-invoices-section` element, and reads would be rules-denied anyway. `renderOrderHistory` (1768) and `applyPurplPrefill` (1760) are also uncalled.

---

## 3. Cloud Functions portal surface — functions/index.js

| Function | Lines | Auth | Reads | Writes |
|---|---|---|---|---|
| **getPortalConfig** | 445-454 | public | `portal_settings/config` | — (returns only `mode`, `pricePerCase`) |
| **verifyPortalPassword** | 458-474 | public | `portal_settings/config` | — . **Hardcoded master password `'purpleherb'` accepted at :466** before the stored one; see §8.1 |
| **lookupPortalToken** | 480-540 | public | `accounts` where `orderPortalToken==` (:493) → fresh data from `workspace/main/ac/{id}` (:497); then `prospects` (:509) → `workspace/main/pr`; fallback direct query of `workspace/main/ac|pr` (:523-537) | — . Returns `{found, isProspect, accountId, accountName, accountEmail, isPbf, address, portalPrefs}` |
| **getPortalOrderHistory** | 545-574 | public, token-gated | validates token maps to the claimed `accountId` against `accounts` then `workspace/main/ac` (:550-555); `portal_orders` where `accountId==`, desc, limit 10 (:557-561) | — . Returns sanitized subset (id, status, items, lineItems, submittedAt ISO, brand, total) |
| **sendOrderConfirmation** | 107-280 | public (intentional) | `portal_orders/{portalOrderId}` (:123-128) — recipient is **server-authoritative** `billingEmail||contactEmail` (:129-137, "HIGH-8"); idempotent via `emailLog` stage check (:134-136); portalLink scheme whitelist (:142-144) | Resend send (:232-237); `portal_orders.emailLog` arrayUnion (:245-254); cadence on `workspace/main/ac` only if accountId matches order (:257-263 via `_logCadenceEntry` :785-811); on send failure sets `confirmationEmailFailed:true` (:273-276) |
| **sendApplicationConfirmation** | 286-390 | public, bound to `portal_inquiries/{inquiryDocId}` | inquiry doc (:300-303); server-authoritative recipient (:304-311); idempotent (:308-310) | Resend; `portal_inquiries.emailLog` (:367-376); failure flag (:383-385) |
| **checkDuplicateApplication** | 434-441 | public | `portal_inquiries` where email== | — |
| **unsubscribe** | 582-608 | public onRequest (`/unsubscribe?id=`) | `workspace/main/ac/{id}` | sets `emailOptOut`, `emailOptOutAt` (:597); always renders friendly page |
| **resendWebhook** (portal-relevant part) | 691-782 | svix-verified | scans `workspace/main/ac` cadence, `portal_inquiries.emailLog`, `portal_orders.emailLog` for `sentMessageId` | marks opened/clicked (:743-772). Full-collection scans — O(N) per event |
| **shipStationWebhook** SAMPLE- branch | 1429-1552 | shared-secret (:1375-1381) | scans `workspace/main/ac` for `samples[].sampleOrderNumber` | tx-guarded sample status→shipped (:1444-1458, idempotent); **deducts 3 cans**: adds `workspace/main/iv` `{sku:'classic', type:'out', qty:3, pool:'farm'}` (:1463-1472); sends shipped email w/ portal link if `ac.orderPortalToken` (:1505-1510); audit log (:1531-1537); orphan logged (:1541-1550) |

---

## 4. Token minting & resolution

- **Format**: `generateSecureToken(prefix)` (app.js:195-200) — 24 CSPRNG bytes → base36, `btoa(entityId + ':' + rand)` URL-safe. Note: token embeds the entity id (decodable, not secret-critical since the random half carries entropy).
- **Mint sites** (all write to top-level `accounts`/`prospects` so lookupPortalToken's indexed query finds them, and mirror into the local `ac`/`pr` cache → `workspace/main/ac|pr`):
  1. **generateOrderLink(entityId, …)** (app.js:14368-14400) — reuses existing token, never rotates (:14374-14382); mints only if absent; copies `https://pbfwholesale.com/order?t=<token>` to clipboard. Wrapped by `copyOrderLink` (14402-14407) and used by All-Links tab + account modal.
  2. **Mass-send pre-pass** (app.js:4989-5018) — before a template blast that `_TEMPLATES_NEED_LINK`, mints tokens for every selected account lacking one, **awaited server-side before any email goes out**; aborts the whole send if any token write fails (:5009-5015).
  3. **approveApplication** (app.js:16829-16921) — mints token at account creation (:16834), stores on the new `ac` record (:16852-16853) and writes the top-level `accounts` index doc (:16869-16876); welcome email includes portal password fetched from `portal_settings/config` (:16898).
  4. **_emailsApprovedGenerateToken** (app.js:4512-4531) — Emails page manual generate+copy.
- **Preservation**: prospect→account conversion carries the existing token onto the new record (app.js:5875-5877) and migrates the top-level `accounts` doc + all `portal_orders.accountId` references (:5891-5908). Account deletion removes the token index doc and all the account's portal_orders (:5552-5556).
- **Resolution**: only via **lookupPortalToken** / **getPortalOrderHistory** (§3). The `portal_tokens` collection (rules:87-90, PortalDB.setToken app.js:14338-14342) is legacy — no caller.

---

## 5. Staff side — PORTAL ORDERS page (app.js)

### 5.1 PortalDB + live listener/badge
- **PortalDB** (app.js:14313-14364): in-memory mirror. `load()` fetches **all** of `portal_orders` + `portal_notify` (:14322-14325). `updateOrder()` writes Firestore then patches cache (:14355-14359).
- **_listenPortalOrders()** (app.js:16764-16803), started at login (app.js:13992): `onSnapshot` on `portal_orders` desc **limit(500)** — this snapshot overwrites `PortalDB._orders`, so 500 is the effective visibility cap (comment :16769-16772). Per snapshot: counts docs that are not confirmed/rejected/declined and not "handled sample-only" (:16780-16783) → `_updatePortalOrdersBadge(count)` (16805-16827) drives `#nav-portal-orders-badge` (index.html:98) + dashboard card; new-doc detection toasts "New portal order received!" and live-refreshes the page if open (:16788-16792).

### 5.2 Page & tabs
- `renderPreOrders(forceReload)` (app.js:14413-14424): loads PortalDB if needed, then `renderApplications()`, `_renderPoKpis()` (14426-14454: totals, matched/unmatched, cases/cans), `_renderPoTabs()` (14456-14465, click wiring on `#po-tabs .tab`), `_switchPoTab` (14467-14478).
- Tabs (index.html:830-836): **All Submissions / Unmatched / Confirmed / Notify Me List / All Links / 🧪 Sample Requests**.
- **Dead tab**: `_renderPoLf` (app.js:14852-14897) and its actions `createLfInvoiceFromPortal` (14899-14943), `linkPortalLfToAccount` (14945-14956), `discardLfPortalOrder` (14958-14964) target a `#po-pane-lf` / `data-po-tab="lf"` that no longer exists in `_switchPoTab`'s list or index.html — unreachable code (statuses `pending`/`discarded` it uses appear nowhere else).

### 5.3 Pair grouping
- `_samePortalSubmission(a,b)` (app.js:14604-14622): different brands AND — if either doc has `submissionId`, strict equality is the **only** pairing key (:14610); legacy fallback (pre-submissionId docs): <60s apart + positive shared identity (equal accountIds, or same non-empty name+email; matched↔unmatched never pairs) (:14612-14621).
- Used by the All tab grouper (14632-14648), Confirmed grouper (14730-14742), review modal (14981), decline (15091), delete (15109), confirm (15270).

### 5.4 All tab buttons (rows built at app.js:14669-14687)
| Button | Handler | Effect |
|---|---|---|
| account name link | `openAccount(accountId)` (:14667) | opens account modal |
| **Review** | `reviewPortalOrder(id)` (14970-15050) | if status 'new' → `PortalDB.updateOrder({status:'reviewed', reviewedAt})` (:14976-14978); renders both halves; unmatched rows get account select + modal buttons **`linkPortalOrderToAccount()`** (15052-15063: sets accountId/accountName/isMatched on the doc) and **`createProspectFromPortalOrder()`** (15065-15078: DB.push('pr'), marks reviewed); footer Confirm/Decline wired :15044-15047 |
| **Confirm** | `openConfirmPortalOrder(id)` (15127-15205) | see §6 |
| **Decline** | `declinePortalOrder(id)` (15085-15097) | confirm() then sets `status:'declined'` on the doc **and its unconfirmed pair** (badge fix comment :15087-15089) |
| **✕ Delete** | `deletePortalOrder(id)` (15099-15121) | `_requireAdmin` (app.js:329) + confirm; deletes doc and paired doc from `portal_orders` |
| Unmatched tab | `reviewPortalOrder`, `createProspectFromPoId(id)` (15080-15083) | (:14711-14712) |
| Notify tab | `_exportNotifyCSV()` (14795-14805) | CSV of `portal_notify` (:14781) |
| All Links tab | `_renderPoLinks` (14807-14849) reads top-level `accounts` collection; per-row **🔗 Copy Link → `generateOrderLink(a.id)`** (:14834, :14840) | |

### 5.5 Sample Requests tab
- `_dedupeSampleRequests` (app.js:14484-14501): groups `requestSample` docs by accountId||email so a dual-brand pair shows once; rep prefers the doc with a ship address.
- **✓ Approve & Ship → `_approveSampleRequest(id)`** (14529 → 14547-14560): requires matched account; `pushSampleToShipStation(accountId)` (app.js:6277-6317 — callable **pushToShipStation** functions/index.js:1259-1335 with `SAMPLE-<NAME>-<ts>` orderNumber, 3×`classic-sample` at $0; appends a `samples[]` entry `{type:'sample_box', sampleOrderNumber, shipStationOrderId}` to the account via DB.update); then flags **all sibling docs** `sampleApproved:true` (:14556-14558 via `_sampleSiblingIds` 14540-14545). Actual shipment→tracking/email/3-can deduction happens later in `shipStationWebhook` (§3 last row).
- **✗ Decline → `_declineSampleRequest(id)`** (14530 → 14562-14571): flags siblings `sampleDeclined:true`.
- Account list "🧪 Sample requested" badge derives from PortalDB (app.js:3400-3405).

### 5.6 Applications (rendered inside Portal Orders page + prospects section)
- `renderApplications()` (app.js:16647-16736): reads `portal_inquiries` (orderBy fallback :16662-16666); active = new/reviewed; `_updateApplicationsBadge` (16738-16760) drives `#nav-applications-badge` + dashboard card.
- **Approve → `approveApplication(docId)`** (16829-16921): builds account rec with fresh portal token, `DB.push('ac')`, writes top-level `accounts` token doc (:16869-16876), preserves application context as a note (:16879-16892), sends 'approved' welcome email w/ portal password + logs cadence (:16894-16909), sets inquiry `status:'approved', accountId` (:16912-16915).
- **Convert to Prospect → `convertApplicationToProspect`** (16966-17006): DB.push('pr'), inquiry → 'reviewed'.
- **Reject → `rejectApplication`** (16923-16964): sends rejection template, always appends an emailLog audit entry (even on no-email/failure :16951-16957), inquiry → 'rejected'.

---

## 6. Submission → Confirm → invoice + order + deduction chain

**`openConfirmPortalOrder(id)`** (app.js:15127-15205): resolves pair, shows brand summary, unmatched → account picker (`#mcpo-account-select`), editable purpl cases (`#mcpo-classic-qty`), notes, invoice date default today, Save → `confirmPortalOrder()`.

**`confirmPortalOrder()`** (app.js:15222-15560), guarded by `_confirmPortalInFlight` (:15222-15226):
1. **Claim primary in a Firestore transaction** (:15228-15236): read doc; if already `confirmed` → bail with toast (:15237); else set `status:'confirmed', confirmedAt:serverTimestamp` atomically. This is the cross-tab idempotency guard.
2. Unmatched: require picker selection; **rollback** the claim (`status` restored, `confirmedAt:null`) if none (:15240-15249, "B2"); else write accountId/accountName/isUnmatched:false (:15253).
3. Invoice date priority: modal-picked date → preorder `launchDate` from portal_config → today (:15256-15264).
4. **Claim the paired doc transactionally** (:15269-15284, "#4"): if its status is already confirmed elsewhere, `paired=null` and this half converts single-brand — prevents double combined invoices from two tabs.
5. Staff notes merged unless they're the untouched "Delivery: X" prefill (:15292-15300). purpl items honor the modal-edited case count for single-item orders (:15302-15321); LF items normalized (:15323-15342).
6. No items → toast + **rollback both claims** (:15344-15354).
7. Pricing `_calcPricePerCase(acct)` (app.js:23-28: per-account direct/dist price else default); due date = invoice date + terms (:15360-15364).
8. **Invoice numbers reserved atomically first** via `getNextInvoiceNumber(type)` (app.js:12353-12404): Firestore transaction on `workspace/main/config/main` `invoice_settings.nextInvoiceNum` (reserve-and-increment, retry once, cache fallback with loud warning toast :12393-12401). Dual-brand reserves purpl+lf+combined numbers (:15375-15381).
9. **One `DB.atomicUpdate`** (:15394-15499) writes to the local cache → persisted to `workspace/main/*`:
   - `orders`: one per brand, `status:'pending'`, `source:'portal'`, `linkedPortalOrderId`, `combinedOrderGroupId` (:15396-15414); `ac/pr.lastOrder` bumped (:15416-15421).
   - Dual: `retail_invoices` + `lf_invoices` (both `status:'draft'`, `combinedInvoiceId:combId`) + `combined_invoices` parent with subtotals/grandTotal (:15424-15462), plus an **`lf_wix_deductions`** record via `_lfWixDeductionFor` (15211-15220 — Wix stock-pull instruction, deduped later by invoiceId).
   - Single purpl: `retail_invoices` draft **with lineItems** so markInvoiceSent can deduct (:15463-15485). Single LF: `lf_invoices` draft + wix deduction (:15486-15498).
10. Post-write: `portalRef.update({convertedOrderId})` (:15502); paired doc gets confirmed/convertedOrderId (:15503-15510); optional auto **pushInvoiceToShipStation** when delivery method 'ship' (:15512-15517); cadence entry `order_confirmation` method `crm_confirm` on the account (no duplicate customer email — :15527-15543); prospect-convert prompt (:15546-15552).
11. Errors: catch-all toast (:15554-15556); in-flight flag cleared in finally.

**Inventory deduction (purpl)** happens downstream at **`markInvoiceSent(id)`** (app.js:16259-16289): on first draft→sent flip (guarded by `alreadyDeducted` scan of `iv` movements :16265-16266), one atomicUpdate writes `iv` `type:'out'` movements of `cases × 12` cans per line, pool = `inv.fulfillmentSource`, `invoiceId` back-reference (:16273-16284). Shipping pseudo-line `__shipping__` skipped (:16278).

**Reversals**: voiding a combined invoice voids children, removes the wix deduction, filters out the `iv` out-movements, and resets the portal order to `status:'new', confirmedAt:null, convertedOrderId:null` (app.js:13440-13459). `deleteCombinedInvoice` similarly deletes invoices/orders and resets both portal docs — but its pair matching still uses the **legacy 60s/brand heuristic**, not submissionId (app.js:12300-12324).

---

## 7. Idempotency / rollback inventory (quick reference)

| Guard | Where |
|---|---|
| Client submit: single batch, shared `submissionId` | order.html:1244-1285 |
| Confirmation email: emailLog stage check + server-authoritative recipient | functions/index.js:129-137 |
| Confirm claim tx (primary + paired), already-confirmed bail | app.js:15230-15237, 15275-15283 |
| Rollback on bail (no account / no items) restores both docs | app.js:15244-15249, 15346-15353 |
| Double-click guard `_confirmPortalInFlight` | app.js:15222-15226 |
| Invoice number reservation tx (+retry, +loud fallback) | app.js:12353-12404 |
| Send-time deduction once (`alreadyDeducted`), `_markSentInFlight` | app.js:16260-16266 |
| Sample ship tx + already-shipped skip; Stripe/Resend webhook idempotency | functions/index.js:1444-1459, 1125-1132, svix verify 703-720 |
| Void/delete restore portal order + inventory | app.js:13448-13459, 12269-12324 |

---

## 8. Findings

1. **Hardcoded portal password** — `verifyPortalPassword` permanently accepts `'purpleherb'` (functions/index.js:462-466) regardless of the admin-configured password; rotating the password in Settings cannot revoke it. Deliberate (comment cites config drift) but a standing backdoor in source.
2. **Customer `portalPrefs` write is dead** — order.html:1300-1318 updates `accounts/{id}` from an unauthenticated client; rules:36-38 require staff, so it permission-denies into the silent catch. Prefs prefill (order.html:975-988) therefore only ever reflects staff-written data; billing-email/lead-time "remembering" doesn't work. Fix belongs in a callable.
3. **LF price list falls back for customers** — `loadLfSkus` (order.html:819-835) reads `workspace/main/config/main` client-side; unauthenticated reads are denied (rules:124-125), so real customers always see the hardcoded `LF_SKU_FALLBACK` (order.html:533-564). If staff edit `lf_skus` prices, the portal keeps charging fallback prices. (Works only for a logged-in staff member testing the portal in the same browser.)
4. **Notify tab reads a never-written collection** — nothing writes `portal_notify` (only reader: app.js:14324; customer notify choices are stored as `notifyMe` on portal_orders, order.html:1206). The "Notify Me List" tab and CSV export will always be empty for new data.
5. **Confirm pipeline is not atomic across systems** — portal doc is confirmed in a Firestore tx, but the orders/invoices/deductions land via `DB.atomicUpdate` into the debounced local-cache persistence layer. A crash/offline window between :15234 and cache flush leaves a confirmed portal order with no invoice (only manual reset paths recover it).
6. **`deleteCombinedInvoice` pair reset uses the legacy 60s heuristic** (app.js:12310-12323) instead of `submissionId` — same-account submissions <60s apart could reset the wrong doc; confirm/decline/delete were already migrated to `_samePortalSubmission`.
7. **Dead code**: LF submissions tab suite (app.js:14852-14964), `PortalDB.setToken`/`portal_tokens`, order.html invoice widgets (1697-1757), `renderOrderHistory`/`applyPurplPrefill` (order.html:1760-1800).
8. **Scale caps**: portal listener limit(500) is the hard visibility window (app.js:16767-16772); `resendWebhook` full-collection scans (functions/index.js:737, 750, 764) and `shipStationWebhook`'s account scan (:1431) are O(N) per event.
