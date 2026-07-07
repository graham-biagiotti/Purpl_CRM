# Architecture Review — Dashboard Tab

Scope: `#page-dashboard` (public/index.html:175–314) and `renderDash()` plus everything it calls (public/app.js:1389–1530). Read-only review; citations are `file:line`.

## 1. Entry points / render triggers

| Trigger | Where |
|---|---|
| App boot → `nav('dashboard')` | app.js:13995 (inside `window.onAppReady`, app.js:13868) |
| Sidebar / mobile nav click → `nav(page)` → `renders['dashboard'] = renderDash` | app.js:258–291, 293–294 |
| Firestore real-time listener → `window.refreshCurrentPage()` → `renders[currentPage]()` | app.js:13879–13885 |
| Data mutations that force a dash refresh: `rescheduleOrder` (app.js:2064), order delete (app.js:8821), `cycleOrderStatus` (app.js:8846), `delProdHist` (app.js:9013) | — |

`renderDash()` (app.js:1389) bails if `!DB._firestoreReady`, then calls, in order: `renderDashQuickActions`, `renderDashPayments`, `renderDashActivity`, inline KPI computation, `loadScratchpad`, `renderAttention`, `renderReorderPredictions`, `renderInvoiceReminders`, an async `portal_inquiries` query, a `pending_invoices` injection into `#dash-attention`, `renderFollowUps`, `renderPendingOrders`, `renderInvoiceStatus`, `renderProjections`, `renderProdPlan`, `renderCadenceOverdue`, `renderDistDashKPIs`, `renderLfDashKpis` (app.js:1391–1529).

All `DB.a(key)` reads are synchronous from the in-memory cache of Firestore collections under `workspace/main/<key>` (db.js:14–21) or config-doc arrays under `workspace/main/config/main` (db.js:39–43: `lf_wix_deductions`, `pending_invoices`, `quick_notes`, `loose_cans`, `pallets`, ...). `DB.obj('settings')` also lives in that config doc (db.js:51). Two dashboard data sources bypass the DB layer and hit top-level Firestore collections directly: `portal_inquiries` (app.js:1500–1503, 16655) and `portal_orders` (live `onSnapshot`, app.js:16764–16803).

## 2. Card-by-card map: source collections → owning section

The dashboard is the cross-section hub; it owns almost no data of its own (only the Notes scratchpad).

| Dashboard card (index.html) | Renderer (app.js) | Reads (collections) | Owning section |
|---|---|---|---|
| Notes scratchpad (:177–190) | `loadScratchpad` :1555 | `settings.noteSections` (config doc) | Dashboard itself |
| Low-stock alert (:192) | inline in `renderDash` :1446–1462 | `iv` (via `_onHand` :122), `settings.lowStockThreshold` | Inventory |
| New-applications alert (:194) | `_updateApplicationsBadge` :16738 (fed by async query :1500 and `renderApplications` :16647) | Firestore `portal_inquiries` (status=='new') | Prospects (Applications section) |
| Portal-orders alert (:196) | `_updatePortalOrdersBadge` :16805 (fed by live listener :16764) | Firestore `portal_orders` | Portal Orders (`pre-orders` page) |
| Quick actions strip (:199) | `renderDashQuickActions` :1273 | `retail_invoices`, `iv`, `lf_invoices`, `combined_invoices`, `dist_invoices` (via `_allInvoices` :52), `orders`, `lf_wix_deductions` | Invoices, Orders, Invoices (LF deductions) |
| KPI: Active Accounts (:203) | `renderDash` :1429 | `ac` (status=='active'; "+N pending" subtext) | Accounts |
| KPI: Outstanding (:204) | :1421–1432 | `retail_invoices`+`iv` (`_allPurplInvoices` :47) + `lf_invoices` | Invoices |
| KPI: Total Inventory (:205) | :1437–1443 | `iv` via `_onHand` | Inventory |
| KPI: Overdue (:206) | :1425–1433 | same as Outstanding, filtered `dueDate < today` | Invoices |
| KPI: Prospects / Follow-up Due (:211–212) | :1464–1471 | `pr` | Prospects |
| Needs Attention (:233–237) | `renderAttention` :1750 | `ac`, `iv` (per-pool low stock), `pr`, `dist_invoices`, `dist_profiles`, samples on `ac`/`pr` | Accounts, Inventory, Prospects, Distributors |
| + injected "ready to invoice" rows | `renderDash` :1506–1520 | `pending_invoices` (status=='pending') | Invoices (portal combined-order flow) |
| Reorder Predictions (:241–244) | `renderReorderPredictions` :1941 | `ac`, `orders` (interval of `o.created`) | Orders/Accounts (derived) |
| Follow-ups (:248–251) | `renderFollowUps` :1861 | `ac` (`nextFollowUp`, `notes[].nextDate`), `pr` (`nextDate`) | Accounts + Prospects |
| Invoice Status (:257–261) | `renderInvoiceStatus` :2076 | `orders` (status=='delivered', `invoiceStatus` field), plus Recent Invoices table from `retail_invoices`/`lf_invoices`/`combined_invoices` | Orders (legacy per-order invoice tracking) + Invoices |
| Pending Orders (:264–268) | `renderPendingOrders` :2039 | `orders` (status=='pending'), `ac` | Orders |
| Recent Payments (:271–274) | `renderDashPayments` :1316 | `retail_invoices`+`iv`, `lf_invoices`, `combined_invoices`, `dist_invoices` (status=='paid') | Invoices |
| Recent Activity (:277–280) | `renderDashActivity` :1353 | `audit_log` (append-only, db.js:28) | global |
| Action Required / cadence card (:282–286) | `renderCadenceOverdue` :1994 | `ac` (`cadence[]`), `retail_invoices`+`iv`, `lf_invoices` | Accounts (Emails tab) + Invoices |
| Invoice Reminders (DOM created at runtime, inserted before `#dash-dist-kpis`) | `renderInvoiceReminders` :2197–2252 | `retail_invoices`+`iv`, `lf_invoices`, `combined_invoices` (unpaid, due ≤7d out or overdue, no `reminderSentAt`), `ac.email` | Invoices |
| Distributor KPIs (:292) | `renderDistDashKPIs` :7953 | `dist_profiles`, `dist_chains`, `dist_invoices`, `dist_pos`, `ac` (fulfilledBy) | Distributors |
| Revenue Projections (:295–302) | `renderProjections` :2730 / `calcProjections` :2746 | `orders`, `ac` | Projections page |
| Production Planning (:305–310) | `renderProdPlan` :2801 | `iv`, plus `calcProjections()` | Production / Inventory |
| LF KPIs | `renderLfDashKpis` :13755 — **dead code**, see §5.1 | `ac`, `lf_invoices`, `lf_wix_deductions` | Invoices/Accounts |

## 3. Every button / click / link on the dashboard

### 3.1 Topbar (visible on dashboard; shared across pages)
| Control | Handler | Reads | Writes | Effect |
|---|---|---|---|---|
| `+ Account` (index.html:169) | `editAccount(uid())` | `ac` | on save: `ac` | opens account editor modal |
| `+ Prospect` (index.html:170) | `editProspect(uid())` | `pr` | on save: `pr` | opens prospect editor modal |
| Global search (index.html:166) | `_globalSearchRun` app.js:1236; result click → `_gsNavigate` :1222 | `ac`, `pr`, `dist_profiles`, `retail_invoices`, `lf_invoices`, `combined_invoices`, `dist_invoices` | none | `nav()` to owning page + opens record modal |

### 3.2 Notes scratchpad (dashboard-owned data)
| Control | Handler | Writes |
|---|---|---|
| textarea `oninput` (index.html:186) | `debounceNoteSectionSave` app.js:1625 → `_flushNoteSave` :1630 | `settings.noteSections` via `DB.setObj('settings')` (Firestore config doc) |
| section row click / dblclick / × (built in `_renderNoteSidebar` :1576–1599) | `selectNoteSection` :1614, `renameNoteSection` :1655, `deleteNoteSection` :1667 | `settings.noteSections` |
| `+ Add Section` (:1603) | `addNoteSection` :1642 | `settings.noteSections` |

One-time migration of `localStorage.pbf_dash_notes` into the General section (app.js:1560–1565).

### 3.3 Alert cards & quick actions
| Control | Handler | Navigates to |
|---|---|---|
| Low stock "View Inventory" (app.js:1456) | `nav('inventory')` | Inventory |
| Applications "Review Applications" (app.js:16753) | `nav('prospects')` | Prospects |
| Portal orders "Review Orders" (app.js:16820) | `nav('pre-orders')` | Portal Orders |
| QA card: N Overdue invoices (app.js:1292) | `nav('invoices')` | Invoices |
| QA card: N Draft invoices (:1293) | `nav('invoices')` | Invoices |
| QA card: N Orders to schedule (:1294) | `nav('orders-delivery')` | Orders |
| QA card: N LF deductions pending (:1295) | `nav('invoices')` | Invoices |

All quick-action cards are read-only navigation; no writes.

### 3.4 Needs Attention card
Rows are clickable (`onclick=i.action`, app.js:1852–1857):
| Row type | Click target | Built at |
|---|---|---|
| Account 30+ days no order (direct or dist-fulfilled) | `openAccount(id)` | app.js:1755–1768 |
| Low stock per SKU/pool (<48 cans warehouse/farm) | `nav('inventory')` | :1771–1776 |
| Prospect follow-up overdue | `openProspect(id)` | :1778–1780 |
| Account follow-up overdue (no newer contact, via `acLastContacted` :3078) | `openAccount(id)` | :1783–1788 |
| Overdue distributor invoice | `openDistributor(distId)` | :1791–1794 |
| Distributor 30+ days no contact / follow-up overdue | `openDistributor(id)` | :1797–1808 |
| Sample follow-up due ≤7d / overdue (from `ac`/`pr` `samples[]`) | `openProspect` or `openAccount` | :1811–1833 |
| "Log Contact" button (account rows only) | `openAccount(accountId)` (stopPropagation) | :1856 |
| Injected `pending_invoices` rows: "Review & Invoice" | `nav('invoices')` | :1517 |

No direct writes; badge `#dash-attention-badge` = total item count (:1836–1844) while list shows only first 10 (:1852).

### 3.5 Reorder Predictions
Row click → `openAccount(a.id)` (app.js:1982). Pure read (`ac`, `orders`). No writes.

### 3.6 Follow-ups card
| Control | Handler | Writes |
|---|---|---|
| Row click | `openAccount(id)` / `openProspect(id)` (app.js:1916) | none |
| "Done" button | `dashMarkFollowUpDone(id, type)` app.js:1927 | account: `ac` — sets `nextFollowUp:null`, appends `outreach` entry (:1931). prospect: `pr` — nulls `nextDate`/`nextAction`, appends `outreach` (:1934). Then `renderFollowUps()` only. |

Quirk: for follow-ups derived from `a.notes[].nextDate` (app.js:1874–1884) "Done" clears `nextFollowUp` (already null) but never clears the note's `nextDate`, so the item reappears on next render.

### 3.7 Invoice Status card
| Control | Handler | Reads/Writes |
|---|---|---|
| `+ New Invoice` header btn (index.html:259) | `openAddInv()` app.js:2425 → `openInvModal(null)` :2429 | opens purpl invoice modal; save writes `retail_invoices` (+ `iv` stock-out on send) |
| "Mark Paid" on overdue delivered order (app.js:2120) | `setInvStatus(orderId,'paid')` :2368 | **writes `orders`** (`invoiceStatus`, `paidDate`) — order-level, not invoice-collection |
| Recent Invoices: 🖨️ | `generateInvoicePrint(id)` / `generateLfInvoicePrint(id)` (:2147, 2162) | read-only print view |
| Recent Invoices: `✓ Paid` (purpl row, :2148) | `markRetailInvPaid(id)` :2693 | writes `retail_invoices` or legacy `iv` (via `_invoiceCol` :78), syncs combined parent (`_syncCombinedParentForChild`, :2698) |
| Recent Invoices: Edit (LF, :2163) | `openLfInvoiceModal(id)` | LF invoice modal (writes `lf_invoices` on save) |
| Recent Invoices: Preview (combined, :2176) | `openCombinedInvoicePreview(id)` | read-only preview |

### 3.8 Pending Orders card
| Control | Handler | Writes |
|---|---|---|
| `View all →` (index.html:266) | `nav('orders-delivery')` | none |
| Row icon/body click (app.js:2047–2048) | `openOrderDetail(id)` :8776 | modal has its own delete/status/reschedule writes to `orders`, `iv`, `ac.lastOrder` (:8807–8834) |
| "Reschedule" (:2052) | `rescheduleOrder(id)` :2057 | writes `orders.dueDate` via `prompt()`, then full `renderDash()` |

### 3.9 Recent Payments / Recent Activity
Payments rows clickable → `openInvModal` / `openLfInvoiceModal` / `openCombinedInvoicePreview` / `editDistInvoice` (app.js:1323–1335, 1345). Activity rows are not clickable (app.js:1362–1370).

### 3.10 Invoice Reminders card (runtime-inserted)
| Control | Handler | Writes |
|---|---|---|
| "Send Reminder" (app.js:2270) | `sendInvoiceReminder(invId, collection)` :2276 | fetches Stripe pay link (`_getStripePayLink` :684), sends email via `_sendWithCadence` :737 → `callSendEmail` :422 (Cloud Function/Resend); on success writes `reminderSentAt` to that invoice collection (:2299) and appends `invoice_reminder` entry to `ac.cadence` + `lastContacted` |

### 3.11 Action Required (cadence-overdue) card
"Send Now" (app.js:2034) → `openAccountToEmailsTab(id)` :3570 (opens account modal, clicks Emails tab). No direct write; actual sends happen in the modal.

### 3.12 Projections / Production Planning
Projections card: no interactive elements (app.js:2736–2743). Production Planning: "Open Production" → `nav('production')` (index.html:308).

### 3.13 Drill-down filter handlers (dashFilter*)
| Handler | Effect |
|---|---|
| `dashFilterBrand(val)` app.js:1715 | sets module-global `_acBrandFilter`, `nav('accounts')`, `renderAccounts()` |
| `dashFilterStatus(val)` :1721 | sets `#ac-status-filter` select, `nav('accounts')`, re-renders |
| `dashFilterFulfill(val)` :1728 | sets `#ac-fulfill-filter` to `direct` or `__any_dist__` (option added by `renderAccounts` :3247, filter applied :3268), re-renders |

**These handlers are currently unreachable from the UI**: the brand-stat rows carrying their `onclick`s are rendered into `#dash-kpi-accounts` (app.js:1474–1491), which sits inside the hidden "Legacy KPI targets" div (index.html:221–228, `display:none`). The visible "+N pending" subtext on the Active Accounts KPI (:1429) has no onclick. Dead-but-wired UI.

## 4. Dashboard numbers whose definition differs from the owning tab

1. **Overdue — three different definitions.**
   - Quick-actions "Overdue invoices" (app.js:1277–1278): `_allInvoices({excludeChildren:true})` — includes **dist_invoices and combined parents**, excludes combined children.
   - KPI "Overdue" (app.js:1425–1427): purpl (`retail_invoices`+`iv`) + `lf_invoices` only — **includes combined children individually, excludes combined parents and dist invoices**. A combined invoice therefore counts twice here (its 2 children) vs once in quick actions; an overdue dist invoice shows in quick actions but not the KPI.
   - Invoices tab `renderInvKpis` (app.js:15850–15891): purpl + LF + **dist** in dollars, children included / parents excluded.
2. **Outstanding**: dashboard KPI (app.js:1422–1424) excludes `dist_invoices`; Invoices tab Outstanding (app.js:15880–15885) includes them. Distributor dollars only appear on the dashboard inside the separate Dist KPI strip ("Outstanding Inv.", app.js:7964–7974).
3. **Invoice Status card ≠ Invoices tab at all**: its Not-Invoiced/Invoiced/Paid/Overdue counts come from delivered **orders'** manual `invoiceStatus` field, with overdue meaning `daysAgo(invoiceDate||dueDate) > payment terms` (app.js:2076–2091) — not from any invoice collection and not `dueDate < today`. Its "Mark Paid" writes to `orders`, so it will not reconcile with the Invoices tab.
4. **Pending orders count vs list**: the quick-action count dedupes by `combinedOrderGroupId` (app.js:1280–1289) but the Pending Orders card (and Orders tab) list each order row individually (app.js:2040) — the two dashboard numbers can disagree with each other.
5. **Prospects KPI** (app.js:1468) counts ALL prospects including won/lost; the hidden legacy "Open Prospects" KPI (:1402, :1492) and the Prospects tab's actionable view exclude won/lost. "Follow-up Due" uses `nextDate <= today` (:1467) while Needs-Attention uses strict `< today` (:1778) — a follow-up due *today* counts in the KPI but not the attention card.
6. **Reorder Predictions vs Projections**: dash reorder card computes intervals from `o.created` (app.js:1955–1957); `calcProjections`/Projections page uses `o.dueDate` (app.js:2756–2772). Same concept, different date field → different due predictions.
7. **Attention badge** shows total flag count while the card renders only the first 10 (app.js:1839 vs 1852) — badge can read 23 with 10 rows visible. Same pattern for reminders (queue length, all rendered) is fine.
8. **Total Inventory** KPI (app.js:1437) matches Inventory tab "Total Stock" (`_invSummary` app.js:8035) — both `Σ _onHand(sku, null)` clamped at ≥0 — consistent, but `renderProdPlan` re-implements the same sum inline (app.js:2807–2811) instead of reusing `_onHand`.

## 5. Latent issues noted (read-only observations)

1. **`renderLfDashKpis` is dead**: it early-returns unless `#dash-lf-kpis` exists (app.js:13756–13757) and no such element exists anywhere in index.html (the legacy targets are `#dash-kpi-lf-*`, index.html:224–225, which are inside the guard'd-out branch). LF-specific KPIs are effectively replaced by the combined KPIs; the function and its hidden targets are vestigial.
2. **Wrong fallback page id**: `renderInvoiceReminders` falls back to `#page-dash` (app.js:2251) but the real id is `page-dashboard` (index.html:175). Harmless today because the `#dash-dist-kpis` anchor exists, but the fallback would silently no-op.
3. **Hidden-but-computed KPIs**: Revenue (30d), Accounts w/ brand drill-downs, Open Prospects, Alerts (`overdue+lowStock`) are computed every render (app.js:1400–1404, 1473–1493) into the `display:none` legacy div — wasted work plus the unreachable `dashFilter*` click handlers (§3.13).
4. **`renderDash` mutates `#dash-attention` after `renderAttention`** by prepending pending-invoice rows via `el.innerHTML = new + el.innerHTML` (app.js:1508–1519), which destroys and recreates the previously attached DOM; ordering dependency is implicit (works only because it runs after `renderAttention()` at :1495).
5. **`rescheduleOrder` re-renders the entire dashboard** (app.js:2064) for a single field change; other order mutations do the same (order delete :8821, `cycleOrderStatus` :8846) even when the dashboard is not the current page.
6. Follow-up "Done" doesn't clear note-derived follow-ups (see §3.6).
