# 02 — Accounts & Prospects (architecture review)

Scope: ACCOUNTS tab (`renderAccounts`, account cards, `openAccount` modal + all tabs, create/edit/delete, paste-to-add) and PROSPECTS tab (`renderProspects`, prospect modal, convert-to-account, mark-lost, samples, CSV import). All line numbers refer to `/home/user/Purpl_CRM/public/app.js` (17,009 lines) and `/home/user/Purpl_CRM/public/index.html` unless stated otherwise. Read-only review; no code changes.

---

## 1. Data model & storage

Both entities live in the DB layer (`public/db.js`):

- `ac` (accounts) and `pr` (prospects) are **Firestore collections** (one doc per record) under `workspace/main/{ac,pr}` — `COLLECTION_KEYS` db.js:14-21.
- Reads are synchronous from an in-memory cache (`DB.a('ac')` db.js:668); writes go through `DB.push` / `DB.update` / `DB.remove` (db.js:670-689) which stamp `_updatedAt`, write the single doc immediately (`_writeDoc` db.js:639), and schedule a debounced batch save. Multi-collection mutations use `DB.atomicUpdate(fn)` (db.js:691-752) which diffs before/after id sets to propagate deletes and flushes everything after 50 ms.
- Remote snapshots re-render the current page via debounced `window.refreshCurrentPage` (db.js:274-278 → app.js:13879-13885), which **re-runs one-time migrations** (`migrateLfSkuVariants`, `restoreMyData`, `migrateAccountContacts`) plus `renders[currentPage]()` on every remote change.

Account record shape (accreted over time, all optional): `name, contact/phone/email` (flat, legacy), `contacts[]` ({id,name,role,email,phone,isPrimary}), `address/lat/lng` (flat, legacy), `locs[]` ({id,label,address,lat,lng,contact,phone,dropOffRules}), `type, territory, status(active|pending|paused|inactive), since, isPbf, fulfilledBy(distId|'direct'), skus[], par{}, pricePerCaseDirect/Dist/Custom, notes[], outreach[], samples[], cadence[], starred, lastOrder, lastContacted, nextFollowUp, orderPortalToken(+CreatedAt), emailOptOut`.

Prospect record: `name, contact, phone, email, address, lat/lng, type, territory, status(lead|contacted|sampling|negotiating|won|lost), source, priority(high|medium|low), nextAction, nextDate, isPbf, notes[], outreach[], samples[], lastContacted` (legacy alias `lastContact`), plus `lostAt/lostReason/lostNotes` and optionally `orderPortalToken`.

Startup migrations touching accounts: `migrateAccountContacts()` app.js:13776-13788 (backfills `contacts[]` from flat fields — runs on boot 13873 and every `refreshCurrentPage` 13882), `migrateInvoiceStatuses()` 13792, `restoreMyData()` 11243.

---

## 2. ACCOUNTS tab

### 2.1 Page chrome (index.html:316-355)

| Control | Handler | Effect |
|---|---|---|
| `#ac-search`, `#ac-type-filter`, `#ac-fulfill-filter`, `#ac-status-filter`, `#ac-sort` | read inside `renderAccounts()` app.js:3250-3254 (change handlers wired via nav/render plumbing) | filter/sort; reads `ac`, `dist_profiles` |
| Brand pills All / purpl / LF / both | `setAcBrandFilter(val)` app.js:3098-3103 | sets `_acBrandFilter`, re-runs `renderAccounts()` |
| Compact | `toggleAcCompact()` app.js:3105-3111 | CSS class toggle only, no re-render |
| 📋 Paste | `openPasteAccountModal()` app.js:13807 | opens `modal-paste-account` (index.html:2244) |
| + Add Account | `editAccount(uid())` (index.html:352) | opens edit modal with fresh id, `isNew=true` |

### 2.2 `renderAccounts()` app.js:3236-3359

- Populates `#ac-fulfill-filter` options from active `dist_profiles` (3241-3249).
- Filters: search over name/contact/territory/address (3256-3260); brand semantics (3263-3266): `lf` = `isPbf && !skus.length`, `purpl` = `!isPbf`, `both` = `isPbf && skus.length` — an LF account that also carries purpl SKUs appears only under All/Both.
- Sort 3271-3279; starred accounts always float to top.
- Perf indexes built once per render (3300-3312): `_acIdxOrders` (orders by accountId, cancelled excluded) and `_acIdxInv` (`_allInvoices({excludeChildren:true})` grouped by accountId) — consumed in `_acCardHTML` 3141/3157.
- Grouping (3314-3355): "Direct Accounts" group always expanded; one collapsible group per distributor (`fulfilledBy`), door counts from `dist_chains`; `toggleDistGroup` persists expansion in `_distGroupExpanded`.
- Shows loading skeleton until `DB._firestoreReady` (3284).

### 2.3 Account card — `_acCardHTML(a, muted)` app.js:3124-3234

Derived display: `acLastContacted(a)` app.js:3078-3096 = max of latest note date, latest outreach date, `a.lastContacted`, latest `cadence[].sentAt` — so email/invoice sends count as contact. "Needs Attention" = not muted (not dist-fulfilled), not `pending`, and last order OR last contact ≥ 30 days (3129). Velocity = mean gap between order dueDates (3144-3155). Outstanding = sum of non-paid/draft/void invoice amounts from `_acIdxInv` (3157-3164). Sample badge chain at 3199.

Card buttons (3192, 3195, 3224-3232):

| Button | Handler | Collections written | Re-render |
|---|---|---|---|
| ▼ N Locations | `toggleAcLocs(id)` 3361-3370 | none | DOM toggle only |
| ★ star | `toggleAccountStar(id)` 3113-3118 | `ac` (starred flip) | `renderAccounts()` |
| View | `openAccount(id)` 3409 | none | opens modal |
| Note | `quickNote(id)` 5993-6002 | `ac` (append `notes[]`, set `lastContacted`) via 3 chained `prompt()`s | `renderAccounts()` |
| Log Follow-Up | `logOutreach(id)` 6004 → `openLogOutreachModal('ac',id)` 6018 | see §2.10 | — |
| + Run | `addAccountToRun(id)` 9094-9105 | none directly; navigates to `orders-delivery` page, pre-fills route-builder stop via `prefillStop` | nav + delivery render |
| Edit | `editAccount(id)` 5360 | — | opens `modal-edit-account` |
| 🔗 Copy Link | `generateOrderLink(a.id)` 14368-14400 | `ac` (token fields) + **external Firestore** `accounts/{id}` doc; reuses existing token, mints only if absent | none (clipboard + toast) |
| Delete (admin only) | `deleteAccount(id)` 5526 | see §2.12 | `renderAccounts()` |

### 2.4 Account modal — `openAccount(id)` app.js:3409-3568 (markup index.html:2051-2170)

Header: name, status badge (`AC_STATUS`), brand badge (isPbf), sample badge `_sampleStatusBadge(a)` 3390-3407 (also checks `PortalDB.getOrders()` for unshipped portal sample requests), initials avatar.

Quick actions (3433-3439):
- **🧾 New Invoice** → `closeModal; openAddInv(id)` 2425 → `openInvModal(null, accountId, 'direct')` 2429 (invoice section cross-call).
- **✉️ Email** → `_macGoToEmailsTab()` 1385-1387 (clicks the emails tab).
- **🖨 Statement** → `printAccountStatement(id)` 13482-13587 (reads `_allPurplInvoices()`, `lf_invoices`, `combined_invoices` for the account, excludes combined children, drafts contribute $0 balance; opens print window).

Tab switching 3551-3565: each `.tab` gets an onclick closure over `id`; lazy renders per tab: `portal-orders → renderMacPortalOrdersTab(id)`, `samples → renderMacSamplesTab(id)`, `invoices → renderMacInvoicesTab(id)`, `emails → renderMacEmailsTab(id)`. Tab 0 (Overview) auto-clicked on open (3565). `openAccountToEmailsTab(id)` 3570-3576 = `openAccount` + 50 ms-delayed click on the emails tab.

Footer buttons (index.html:2162-2166, wired 3541-3548): Copy Order Link → `copyOrderLink(id)` 14402-14407 (→ `generateOrderLink`); Draft Outreach → `openDraftOutreachModal(id)` 4042; + New Order → close + `openNewOrder(id)` 8686 (orders section); Edit Account → close + `editAccount(id)`.

#### Overview tab (3441-3533)
Reads `contacts[]` (primary highlighted) with flat-field fallback; type/territory/since/lastOrder; SKU badges & par; multi-location selector (`#mac-loc-select` onchange → `_macShowLoc` 3372-3386); Last Contacted (`acLastContacted`); Next Follow-Up color-coded; Fulfilled By badge — clicking a distributor badge closes the account modal and calls `openDistributor(distId)` (3511, cross-section). Inline samples list with per-sample **Mark Done** → `markSampleFollowUpDone('ac',id,sampleId)` 6319-6328 (updates `ac.samples[]`, then **re-runs `openAccount(id)`**, resetting to Overview tab). **+ Log Sample** → `openLogSampleModal('ac', id)` 6240.

#### Orders tab (3480-3486)
Read-only: last 8 `orders` for the account (`DB.a('orders')`, sorted newest by `created`), rendered into `#mac-order-hist`. No buttons.

#### Outreach tab (3535-3538)
`renderAccountOutreach(a)` 3607-3632 renders `a.outreach[]` (type/regarding/outcome badges, contact, nextFollowUp). **+ Log Follow-Up** → `openLogOutreachModal('ac', id)` (§2.10).

#### Notes tab (3516-3517, 3578-3605)
`renderAccountNotes(a)` 3578-3590; **Save Note** → `addAccountNote(id)` 3592-3605: appends to `ac.notes[]`, sets `lastContacted=today()`, clears inputs, re-renders notes list only.

#### Portal Orders tab — `renderMacPortalOrdersTab(accountId)` app.js:15637-15674 (async)
Lazily `await PortalDB.load()` (14320-14336: reads **external Firestore** collections `portal_orders` + `portal_notify` into module cache) then `PortalDB.getAccountOrders(accountId)` 14363. Table of submissions (cases, cans = cases×`CANS_PER_CASE`, status via `_poStatusBadge`, delivery window, notes). **🔗 Copy Order Link** → `copyOrderLink(accountId)` in both empty and populated states.

#### Samples tab — `renderMacSamplesTab(accountId)` app.js:3783-3825
Buttons: **+ Log Sample** → `openLogSampleModal('ac', id)`; **📦 Send Sample Box** → confirm → `pushSampleToShipStation(accountId)` 6277-6317 — calls **Cloud Function** `pushToShipStation` (firebase.functions httpsCallable) with a free 3-can sample order, then on success appends a sample record (with `shipStationOrderId`, auto follow-up +7d) to `ac.samples[]`, `auditLog('sample_push',…)` and re-runs `openAccount(accountId)`. List rows show overdue/pending/done badges and **Mark Done** buttons.

#### Invoices tab — `renderMacInvoicesTab(accountId)` app.js:13589-13686
Reads three sources: `_allPurplInvoices()` (union of `retail_invoices` + legacy invoice-shaped rows in `iv`, app.js:47-50), `lf_invoices`, `combined_invoices` — all filtered to accountId. Buttons:
- **🖨 Statement of Account** → `printAccountStatement(accountId)` (13671).
- Per combined invoice: **Preview** → `openCombinedInvoicePreview(ci.id)` (13637, invoice section).
- For `isPbf` accounts with ≥1 unpaid purpl AND ≥1 unpaid LF invoice (not already combined): selectors `#civ-sel-purpl`/`#civ-sel-lf` + **Create Combined Invoice** → `manualCreateCombined(accountId)` 13688-13696 → `await createCombinedInvoice(purplId, lfId, accountId)` 12158 (invoice section; writes `combined_invoices` + stamps `combinedInvoiceId` on both children) then `openCombinedInvoicePreview`.

#### Emails/Cadence tab — `renderMacEmailsTab(id)` app.js:3830-3872
Renders `CADENCE_STAGES` (3902…, 13 stages, underscore ids) against `a.cadence[]`; per stage **Send ✉️ / Resend** →
- `invoice_sent` stage → `_openInvEmailPreview(id)` 3677-3687: `_latestAccountInvoiceId(accountId)` 3874-3881 (latest of purpl vs LF invoice) → `findInvoice` → `openEmailPreview('invoice-sent', id, {invoiceNumber, invoiceTotal, invoiceLink})`.
- others → `openEmailPreview(templateId, id)` 3658-3675 using `_STAGE_TEMPLATE_IDS` 3636-3650 (underscore↔hyphen mapping) and `getCadenceEmailTemplate(stage, account, extra)` 809.

Email preview modal buttons (3689-3779): `openEmailPreviewTab` (blob window), `toggleEmailBodyEdit` (live srcdoc editing), `copyEmailHTML`, `openEmailMailto`, **Send Email** → `sendEmailViaResend()` 3729-3756: opt-out gate on `ac.emailOptOut` (3738-3739), calls `callSendEmail` (Cloud Function wrapping Resend), fallback to `mailto:` on failure; both paths → `markCadenceEmailSent(sentMessageId)` 3758-3779: 60-second duplicate guard, appends `{stage, sentAt, sentBy, method:'manual', sentMessageId}` to `ac.cadence[]` via `_pushCadence` (app.js:160-163, caps at 500 entries), stamps `lastContacted`, closes preview, **reopens the account modal on the emails tab** (`openAccountToEmailsTab`), and `renderCadenceOverdue()` 1994 (dashboard widget). A separate log-only path `markCadenceSent(accountId, stageId, method, invoiceId)` 3884-3891 is used by invoice-send flows (`_sendWithCadence` 737 also appends cadence entries with `invoiceId` — those entries are what `_invEmailBadge` 139-148 and open/click tracking read). Below the stages, an email history table renders from `cadence[]` (3860-3871).

#### Draft Outreach (AI) — `openDraftOutreachModal(accountId)` 4042-4064, `generateOutreachDraft()` 4066-4122
Builds a prompt from account fields + last 3 outreach entries, calls `_callAnthropicApi` (Claude via api_settings); if "log this" checked, appends a synthetic `outreach[]` entry + `lastContacted`. `mdoOpenMailto` 4129, `mdoCopyBody` 4141, `mdoRegenerateClick` 4124.

### 2.5 Contacts sub-editor (edit modal) — app.js:5300-5358
`eacRenderContacts` 5319, `eacAddContact` 5325 (DOM-only append, radio group `eac-ct-primary`), `eacRemoveContact` 5348. Contacts are only persisted on `saveAccount`.

### 2.6 Create/Edit — `editAccount(id)` 5360-5426, `saveAccount(id, isNew)` 5440-5524
- Edit modal migrates legacy single contact/address into `contacts[]`/`locs[]` on the fly (5368-5370, 5397-5399).
- `fulfilledBy` select is populated from active `dist_profiles`; an inactive distributor currently assigned gets an injected option so save doesn't silently revert routing to direct (5379-5394).
- Save is `_once`-debounced (5416; `_once` 151-159). Duplicate-name confirm 5443-5444. Locations are geocoded via `PlacesAC.getCoords` (5462-5465). Record spreads `...existing` first (5489) to avoid dropping unknown fields; rewrites flat `contact/phone/email/address/lat/lng` from primary contact / first location for backward compat (5493-5499). Pricing fields parsed at 5509-5511.
- Writes: `DB.push('ac')` or `DB.update('ac')`; `auditLog('create'|'update','account',…)` 5520 (append-only `audit_log` collection); re-render `renderAccounts()`.
- **Bug (found):** `isPbf: qs('#eac-ispbf')?.checked || existing?.isPbf || false` (5506) — once an account is LF, **un-checking the box can never clear it** (`false || true` → true).

### 2.7 Delete — `deleteAccount(id)` 5526-5560 (admin-gated `_requireAdmin` 329)
Single `DB.atomicUpdate` cascade removing account-linked rows from **12 keys**: `ac, iv, orders, retail_invoices, lf_invoices, combined_invoices, pending_invoices, returns, dist_invoices, dist_pos, lf_wix_deductions, shipments`, plus stop removal in every `runs[]` doc and `today_run` config obj (5530-5549). Then external Firestore cleanup: deletes `accounts/{id}` doc and every `portal_orders` where `accountId==id` (5552-5556). `auditLog('delete',…)`.
**Gap (found):** the `iv` filter matches `r.accountId`, but inventory `out` rows created by invoicing (e.g. `createDeliveryInvoice` 9411-9417) carry only `invoiceId`/`sku` — no `accountId` — so deleting an account deletes its invoices but leaves their inventory deduction rows with dangling `invoiceId`s (stock history stays physically correct, references don't).

### 2.8 Paste-to-add — app.js:13805-13863
`openPasteAccountModal` 13807 → `previewPasteAccount` 13825 → `parsePasteRow` 13817-13823 (splits on `__` or tab: name, phone, email, address, city, state, dateContacted, notes…) → **Confirm** `confirmPasteAccount` 13846-13863: closes paste modal, opens `editAccount(uid())` and pre-fills name, one contact row, and first location address. **Note (found):** parsed `dateContacted` and `notes` are previewed but silently dropped — never written into the record.

### 2.9 Samples logging (shared ac/pr) — app.js:6238-6275
`openLogSampleModal(type,id)` 6240 stores `_logSampleCtx`; **Save** `saveLogSample()` 6256-6275 appends `{date, sku, qty, contact, notes, followUpDate, followUpDone:false}` to `ac.samples[]` or `pr.samples[]`; re-render = `renderProspects()` for pr, `openAccount(id)` for ac (modal jumps back to Overview tab).

### 2.10 Log Outreach modal (shared ac/pr/dist) — app.js:6018-6130
`openLogOutreachModal(kind,id)` 6018-6049 shows/hides rows per kind (contact: ac only; regarding pills: ac only; next-steps text: pr only). **Save** `saveLogOutreach()` 6051-6130:
- `ac`: append `outreach[]` entry `{type, contact, outcome, notes, nextSteps, nextFollowUp, regarding}`, set `lastContacted=date` and optionally `nextFollowUp`; re-renders `renderAccounts()` + live `renderAccountOutreach` if modal open.
- `pr`: append `outreach[]` `{type, date, note, outcome, nextSteps, nextFollowUp}`, set `lastContacted` and optionally `nextAction`/`nextDate`; `renderProspects()` + `renderProspectOutreach`.
- `dist`: writes `dist_profiles` (out of this section's scope).

---

## 3. PROSPECTS tab

### 3.1 Page chrome (index.html:358-386)
Search/stage/brand/sort selects read in `renderProspects()`; **Compact** → `togglePrCompact()` 5573-5580 (persisted in localStorage `pbf_pr_compact`); **📋 Import CSV** → `openImportProspects()` 6139; **+ Add Prospect** → `editProspect(uid())`.

### 3.2 `renderProspects()` app.js:5582-5685
Default view hides `won`/`lost` unless that stage is explicitly filtered (5594). Sorts by priority (`PRIORITY_ORDER` 5570) / nextDate / name. Card shows priority + sample badges (follow-up overdue / due within 7d, 5621-5630), last contacted (`lastContacted || lastContact` fallback), lost reason block, and a tappable "Next Steps" strip → `openLogOutreachModal('pr', id)` (5669).

Card buttons (5673-5682):

| Button | Handler | Writes | Re-render |
|---|---|---|---|
| View | `openProspect(id)` 5687 | — | modal |
| 📞 Log | `logProspectOutreach(id)` 6008 → outreach modal | `pr` | `renderProspects()` |
| Edit | `editProspect(id)` 5916 | — | modal |
| → Convert | confirm → `convertProspect(id)` 5839 | `pr`,`ac`,`orders` + external | `renderProspects()` |
| 🧪 Sample | `openLogSampleModal('pr',id)` | `pr.samples[]` | `renderProspects()` |
| ✕ (or ↩ Reactivate when lost) | `markProspectLost(id)` 6333 / `reactivateProspect(id)` 6369 | `pr` | `renderProspects()` |

### 3.3 Prospect modal — `openProspect(id)` 5687-5781 (markup index.html:2347)
Tabs: overview / outreach / notes (pure show/hide, 5769-5778 — no lazy loading). Overview shows contact/source/lastContacted/nextDate/nextAction, lost row with **Reactivate** (5728-5729), inline samples list with **Mark Done** (`markSampleFollowUpDone('pr',…)`) and **+ Log Sample**. Outreach tab: `renderProspectOutreach(p)` 5794-5816 + **Log Outreach** button. Notes tab: `_renderProspectNotes(p)` 5783 + **Add Note** → `addProspectNote(id)` 5818-5837 (appends note, sets `lastContacted`, and promotes note's next-action/date to prospect-level `nextAction`/`nextDate`). Footer: **Edit** → `editProspect`; **Convert** → confirm → `convertProspect(id)` (5766).

### 3.4 Create/Edit — `editProspect(id)` 5916-5945, `saveProspect(id,isNew)` 5947-5990
Flat form; Places autocomplete attached on open (5944); geocodes address on save (5956-5962); spreads `...existing` to preserve history; `DB.push('pr')` / `DB.update('pr')`; `renderProspects()`. Edit modal's Delete button actually routes to `markProspectLost(id)` (5940) — soft delete by default.

### 3.5 Convert to account — `convertProspect(id)` app.js:5839-5914
Builds `newAc` with a **new id** (`uid()`, 5845) preserving: identity fields, `lat/lng`, prospect metadata (`source, priority, nextAction, nextDate`), full history (`notes, outreach, samples, cadence, contacts`), `isPbf`, and — critically — the **portal token** `orderPortalToken(+CreatedAt)` (5877, so already-emailed personalized order links keep working; a missing token would be re-minted by the next mass send and orphan the old link). `skus:[]`, `par:{}` start empty (toast tells user to edit).

Migration steps:
1. **Local atomic** (5881-5888): remove prospect from `pr`, append account to `ac`, and rewrite any `orders` rows whose `accountId` was the prospect id → `{accountId:newAc.id, accountName}`.
2. **External `portal_orders`** (5891-5896): all docs with `accountId==oldId` updated to `{accountId:newAc.id, accountName, isProspect:false}` (fire-and-forget, warn on failure).
3. **External `accounts/{oldId}` doc** (5899-5909): if it exists, copied to `accounts/{newAc.id}` (merge) with updated accountId/accountName, then old doc deleted. This is the doc the portal's `lookupPortalToken` flow reads (cf. token writes at 14385, 16850-16858).

Then `closeModal('modal-prospect')`, `renderProspects()`, toast.
**Notes (found):** (a) despite the comment "mark prospect won", the prospect is *deleted*, not set to `status:'won'` — the Won stage filter only ever shows manually-marked wins; (b) `address` is carried flat but not converted into `locs[]` (openAccount/editAccount migrate it on the fly, so benign); (c) if the prospect's external token doc was written to the `prospects` collection (the `entityType==='prospects'` branch of `generateOrderLink` 14368-14392), step 3 checks only `accounts/{oldId}` and would miss it — currently unreachable since no live call site passes `'prospects'`, but a latent trap.

### 3.6 Mark lost / delete / reactivate — app.js:6331-6374
`markProspectLost(id)` 6333 opens `modal-mark-lost` (index.html:3110); **Confirm** `confirmMarkLost()` 6343-6351 sets `{status:'lost', lostAt, lostReason, lostNotes}`. **Permanent delete** `_deleteProspectPermanent()` 6353-6367: admin-gated, `auditLog`, `DB.remove('pr')`, plus best-effort delete of external `prospects/{id}` Firestore doc. `reactivateProspect(id)` 6369-6374 resets to `lead` and clears lost fields. `deleteProspect(id)` 6132 is just an alias for `markProspectLost`.

### 3.7 CSV import — app.js:6136-6235
`openImportProspects` 6139 (paste vs file sub-tabs); `_parseCSV` 6160-6181 (quoted-comma aware, header-normalized); `_csvMapProspect(row)` 6183-6204 maps flexible headers (business name/name/company…), stage map (cold/new→lead …), priority map, first note from a notes column. `_onImportProspectsFile` 6206 previews counts. **Import** `_runImportProspects()` 6220-6235: guards `DB._firestoreReady`, dedupes case-insensitively against existing `pr` names, bulk-inserts via one `DB.atomicUpdate`, `renderProspects()`, summary toast.

### 3.8 Hard-coded bulk seeds
`importTradeShowProspects()` 11333 (34 records → `pr`) and `importNEMShowAccounts()` 11422 (18 records → `ac`); both confirm-gated, name-dedupe, `DB._firestoreReady`-guarded.

---

## 4. Cross-section touchpoints

### 4.1 What the account modal calls outside its own section
| From | Target | Section |
|---|---|---|
| Quick action 🧾 (3436) | `openAddInv` 2425 → `openInvModal` 2429 (`ivAccountChange` 2634 / `ivTierChange` 2649 pull account pricing via `_ivGetPrice` 2563-2569) | Invoicing |
| Invoices tab (13664) | `createCombinedInvoice` 12158, `openCombinedInvoicePreview` | Invoicing |
| Statement (3438, 13671) | `printAccountStatement` 13482 reads `retail_invoices`+`iv`, `lf_invoices`, `combined_invoices` | Invoicing |
| Portal Orders tab (15641-15642) | `PortalDB.load/getAccountOrders` 14320/14363 (external `portal_orders`) + `copyOrderLink`/`generateOrderLink` 14402/14368 (external `accounts` collection + local `ac` token fields) | Portal |
| Samples tab (3792, 6287) | Cloud Function `pushToShipStation` | Shipping |
| Emails tab (3729-3756) | Cloud Function via `callSendEmail`; `getCadenceEmailTemplate` 809; `renderCadenceOverdue` 1994 (dashboard) | Email |
| Overview Fulfilled-By badge (3511) | `openDistributor(distId)` | Distributors |
| Footer + New Order (3542) | `openNewOrder(id)` 8686 → `createOrder` 8730 | Orders |
| Card + Run (3228) | `addAccountToRun` 9094 → delivery route builder | Delivery |

### 4.2 How accounts feed pricing into invoicing — `_calcPricePerCase(account)` app.js:23-28
Fallback chain: dist-fulfilled account (`fulfilledBy && !== 'direct'`) → `pricePerCaseDist`; else `pricePerCaseDirect || pricePerCaseCustom`; else constant `PURPL_DIRECT_PER_CASE` = $2.30×12 = **$27.60** (app.js:10-13). Consumers:
- `calcOrderValue(o)` 1744-1747 — order dollar values on dashboard/reports.
- `createDeliveryInvoice(accountId, ordId)` 9377-9420 — delivery-run invoices: each line gets `pricePerCase = _calcPricePerCase(ac)`; invoice + `iv` inventory `out` rows (cases×`CANS_PER_CASE`) + order `invoiceStatus` written in one `atomicUpdate`.
- Portal order confirmation (`effectivePrice`, 15357) — purpl total on portal-sourced invoices.
- Reports (10110, 10159, 10377) — revenue-per-account math.
The invoice modal itself uses the tier-explicit `_ivGetPrice(ac, tier)` 2563-2569 instead (no $27.60 fallback — blank price if the tier field is unset), so manual invoices and automated invoices can disagree for accounts with no pricing configured.

### 4.3 Inbound writers into `ac`/`pr` from other sections
- `approveApplication` 16829-16880: wholesale application → new `ac` with token (external `accounts` doc written too).
- `convertApplicationToProspect` 16966-17009: application → `pr` (marks `portal_inquiries` doc reviewed).
- `createProspectFromPortalOrder`/`createProspectFromPoId` 15065-15083: unmatched portal order → minimal `pr` lead.
- `linkPortalOrderToAccount` 15052: stamps `accountId/accountName/isMatched` onto a portal order.
- Invoice/email senders append to `ac.cadence[]` via `_sendWithCadence` 737 and stamp `lastContacted`; `deleteInvoiceWithCleanup` 87-118 strips cadence entries pointing at a deleted invoice (112-116).

---

## 5. Findings / risks (summary)

1. **`isPbf` can never be un-set** — `saveAccount` app.js:5506 (`checked || existing?.isPbf`).
2. **Paste-to-add drops parsed data** — `dateContacted`/`notes` parsed (13819-13822) but never persisted (13846-13863).
3. **Converted prospects vanish from win/loss analytics** — `convertProspect` deletes the `pr` row (5882) instead of marking `won`; comment at 5880 is stale.
4. **`deleteAccount` leaves dangling inventory rows** — `iv` cleanup keys on `accountId` (5532) but invoice-generated `out` rows only carry `invoiceId` (9411-9417).
5. **Sample/mark-done UX reset** — `saveLogSample`/`markSampleFollowUpDone` re-run `openAccount(id)` (6273, 6326), bouncing the user from the Samples tab back to Overview.
6. **Latent token-migration gap** — `generateOrderLink`'s `prospects`-collection branch (14370, 14385) has no counterpart in `convertProspect`'s external-doc migration (5899).
7. **Duplicate-send guard is only 60 s** and only per template stage (`markCadenceEmailSent` 3763); two operators >1 min apart double-send silently.
8. **Card-render cost is bounded** by the per-render indexes (3300-3312) but `acLastContacted` still scans notes/outreach/cadence per card per render — fine at current scale (~100s), worth an index if cadence arrays approach their 500-entry cap.
9. `quickNote` uses three blocking `prompt()`s (5994-5997) — inconsistent with every other note flow.
