# 00 — Foundation: Data Layer, Auth, Shell, Service Worker, Cloud Functions

Read-only architecture review of the purpl CRM foundation. All paths absolute; line numbers as of this review.

Scope: `public/db.js` (whole file), `public/auth.js`, `public/sw.js`, the `public/index.html` shell (script load order, sidebar, dispatch), the `renders{}`/`nav()` routing and toast/modal/confirm helpers in `public/app.js`, and a full inventory of `functions/index.js`.

---

## 1. Boot sequence & script load order

`public/index.html` loads scripts at the bottom of `<body>`, in this exact order:

| Order | Script | Ref |
|---|---|---|
| 1 | Chart.js 4.4.0 CDN (in `<head>`) | index.html:12 |
| 2 | Inline dark-theme bootstrap (`localStorage purpl_theme`) | index.html:23 |
| 3 | Firebase **compat** SDK v10.12.2: app, auth, firestore, functions | index.html:3198-3201 |
| 4 | Inline shim exposing modular-style APIs on `window.FirebaseAppAPI` / `window.FirebaseAuthAPI` / `window.FirestoreAPI` (wrapping the compat SDK) | index.html:3204-3224 |
| 5 | `firebase-config.js` (defines `window.FIREBASE_CONFIG`) | index.html:3227 |
| 6 | `db.js` (defines the `DB` singleton — no side effects at load) | index.html:3228 |
| 7 | `places.js` (Google Places helper for the map) | index.html:3229 |
| 8 | `app.js` (all business logic; defines `nav`, `renders`, `toast`, `openModal`…, and `window.onAppReady`) | index.html:3230 |
| 9 | `auth.js` (registers `DOMContentLoaded → bootApp()`) | index.html:3231 |
| 10 | Inline: build delivery qty inputs on DOMContentLoaded | index.html:3234-3252 |
| 11 | Inline: service-worker registration + "new version" banner | index.html:3476-3496 |

Ordering matters: db.js and auth.js consume `window.FirestoreAPI` (shim at index.html:3216), and auth.js calls `window.onAppReady()` (auth.js:158) which app.js must have defined (app.js:13868). app.js must load before auth.js.

### Boot flow (auth.js)

`bootApp()` (auth.js:5) runs on DOMContentLoaded (auth.js:232):

1. `initializeApp(FIREBASE_CONFIG)`, `getAuth`, `getFirestore` (auth.js:10-12). The browser app **never** connects to emulators (comment auth.js:14-18).
2. `enableIndexedDbPersistence(db)` (auth.js:21). On failure (usually second tab), sets `window._persistenceDisabled` and toasts a loud warning that offline edits will not survive browser close (auth.js:27-36).
3. Wires sign-in UI: Google popup (auth.js:49), email/password (auth.js:59), Enter-to-submit (auth.js:77), forgot-password (auth.js:83), sign-out button with `confirm()` (auth.js:96).
4. `onAuthStateChanged` (auth.js:103):
   - signed in → hide auth screen, show loading screen; 10 s "slow connection" timer (auth.js:110).
   - `await DB.init(user.uid, db)` (auth.js:116) — hard failure shows "Unable to load data" and stops.
   - Role bootstrap (auth.js:130-151): reads `users/{uid}`; if missing, calls the `initUserRole` callable (auth.js:134). Role stored in `window._userRole`; server rejection (`permission-denied` / not-authorized) signs the user straight back out with "Access not authorized" (auth.js:143-148). Client can never self-assign a role.
   - `checkMigration()` (auth.js:153, defined 176): if legacy `pcrm5_*` localStorage data exists and `purpl_migrated` is unset, shows an import banner on the dashboard (auth.js:190-208) → `runMigration()` → `DB.importFromLocalStorage()` (auth.js:214, db.js:754).
   - show `#app-shell`, then `window.onAppReady()` (auth.js:155-158).
5. `beforeunload` + `pagehide` both call `DB._flushPendingSave()` (auth.js:169-173) — the entry point of the recovery-blob pipeline (§4.3).

`window.onAppReady` (app.js:13868) runs seed/one-time migrations (`seedIfEmpty`, `migrateLfSkuVariants`, `restoreMyData`, `migrateAccountContacts`, `migrateInvoiceStatuses`, app.js:13869-13874), defines `window.refreshCurrentPage` (app.js:13879-13885), wires sidebar nav clicks (app.js:13890-13892), modal backdrop/✕ close (app.js:13894-13900), page-specific buttons, filters (`setupFilters`, app.js:11189), and the mobile hamburger/sidebar overlay (app.js:13954+).

---

## 2. Data flow: Firestore ↔ DB cache ↔ UI

```
                       ┌────────────────────────── Firestore ──────────────────────────┐
                       │ workspace/main/{key}/{docId}   (17 collections, one doc/record)│
                       │ workspace/main/config/main     (single config doc)             │
                       └───────────────┬───────────────────────────▲───────────────────┘
        initial load: _loadAll /       │ onSnapshot (per collection │  writes: _writeDoc /_deleteDoc
        _loadFromCollections           │ + config doc)              │  batch _saveCollection / _saveConfig
        (db.js:93,186)                 ▼ (db.js:200)                │  (db.js:639,651,501,551)
                       ┌───────────────────────────────────────────┴───────────────────┐
                       │                 DB._cache  (in-memory, synchronous)            │
                       │   reads:  DB.a/get/obj    writes: push/update/remove/set/      │
                       │   (db.js:664-668)                 setObj/atomicUpdate          │
                       └───────────────┬────────────────────────────────────────────────┘
                                       │ _scheduleRefresh (120 ms debounce, db.js:274)
                                       ▼
                     window.refreshCurrentPage → renders[currentPage]() (app.js:13879-13885)
                                       ▼
                            DOM render of the active page only
```

Key properties:

- **Read path is synchronous.** Every render function reads `DB.a('key')` straight from `_cache` — no awaits in the UI. Cache is fully hydrated before `onAppReady` (all collection loads in parallel, db.js:186-198).
- **Write path is optimistic.** Mutators update `_cache` first, then persist (immediate per-doc write + debounced batch safety net, §4).
- **Multi-user sync** comes from `onSnapshot` listeners on all 17 collections plus the config doc (db.js:200-268). Local echoes (`hasPendingWrites`) are ignored (db.js:212-213, 238). Remote changes are **deferred** (`_pendingRemoteChanges = true`) while a modal is open (`_dirty`), an `atomicUpdate` is in flight, or the key is in `_saveDirtyKeys` (db.js:218-220, 245-249); otherwise the cache is replaced from the snapshot and a debounced re-render fires.
- **Dirty flag = modal open.** `openModal()` calls `DB.markDirty()` when the modal id contains edit/add/new/log (app.js:11171-11174); `closeModal()` calls `DB.markClean()` (app.js:11177). `markClean` deliberately does **not** reload from server (db.js:594-605 — a reload once wiped a just-created invoice; the snapshot listeners reconcile instead). `applyPendingRemote()` (db.js:607) is the explicit "Load Changes" hard refresh, and it waits for in-flight writes to settle first. `_showRemoteChangeWarning` is intentionally a no-op (db.js:624-631) — it produced false positives from a user's own write echoes.
- Two storage tiers (db.js:13-51): high-churn record types get **one Firestore doc per record** under `workspace/main/{key}` (`COLLECTION_KEYS`); small/rarely-changing arrays and settings objects live inside the **single config doc** `workspace/main/config/main` (`CONFIG_ARRAY_KEYS` + `OBJ_KEYS`, `_configRef` db.js:75-78).
- **Migrations at init** (db.js:98-151): legacy single-doc (`workspace/main/data/store`, db.js:81-84) → per-collection via `_migrateFromSingleDoc` (db.js:281); older per-user path `users/{uid}/data/store` (db.js:313-324); and a one-time move of `prod_hist`/`runs`/`shipments` out of config into their own collections (db.js:126-151).
- **Portal data is outside DB.** The CRM's Portal Orders page and account-portal features read/write top-level collections (`portal_orders`, `portal_inquiries`, `portal_settings`, `accounts`, `prospects` token indexes) directly via `firebase.firestore()` (e.g. app.js:1500, 4518, 5554, 5891, 12306, 14323, 14811) — these never pass through `DB._cache`.

---

## 3. Collection catalog

### 3.1 COLLECTION_KEYS (db.js:14-21) — one doc per record under `workspace/main/{key}`

| Key | Contents | Primary readers/writers (app.js sections) |
|---|---|---|
| `ac` | Accounts (with embedded `cadence[]`, `contacts[]`, `samples[]`, `notesLog[]`, portal tokens) | Heaviest key (~190 refs). ACCOUNTS (app.js:3063-3560, `renderAccounts` 3236), Dashboard widgets (1389+), Emails page (4157), Map (14009), Reports (9618), Projections (2877), portal-sync writes. Server-side writers: `_logCadenceEntry`, `resendWebhook`, `shipStationWebhook` sample flow, `unsubscribe` (functions/index.js:785, 737, 1431, 594) |
| `pr` | Prospects (pipeline stages, outreach log) | PROSPECTS (app.js:5562-6370, `renderProspects` 5582); Map; Dashboard follow-ups |
| `iv` | Dual-purpose: inventory ledger entries (cans in/out) **and** legacy purpl invoices | INVENTORY (`renderInventory` app.js:7984); invoice helpers merge legacy iv invoices into all invoice views (`_allPurplInvoices`/`_allInvoices` app.js:47-68); `shipStationWebhook` writes 3-can sample deductions (functions/index.js:1463); `stripeWebhook` fallback marks legacy iv invoices paid (functions/index.js:1182) |
| `orders` | Wholesale orders | ORDERS & DELIVERY (`renderOrdersDelivery` app.js:8557, `renderOrders` 8637, `renderDelivery` 9116); Dashboard pending orders (2039); Production planning |
| `retail_invoices` | Standalone purpl invoices | RETAIL INVOICES (app.js:2378+), INVOICES PAGE (`renderInvoicesPage` 15726, `renderInvColPurpl` 15908); paid via `stripeWebhook`; shipping lines via `shipStationWebhook` |
| `lf_invoices` | Lavender Fields invoices | LF INVOICES (`renderLfInvoicesPage` app.js:11656, `renderInvColLf` 16020); same webhooks |
| `combined_invoices` | Parent invoices combining purpl+LF children | Combined-invoice modals (index.html:3292-3473), `renderInvColCombined` (app.js:16094), `deleteInvoiceWithCleanup` dissolves parent/sibling links (app.js:87-118); `stripeWebhook` cascades paid → children (functions/index.js:1209-1232) |
| `dist_profiles` | Distributor master records | DISTRIBUTORS (app.js:6376+, `renderDistributors` 6556) |
| `dist_reps` | Distributor sales reps | `renderDistRepsHTML` (app.js:6983) |
| `dist_pricing` | Distributor price tiers | `renderDistPricingHTML` (app.js:7008) |
| `dist_pos` | Distributor purchase orders | `renderDistOrdersHTML` (app.js:7047) |
| `dist_invoices` | Distributor invoices | `renderDistInvoicesHTML` (app.js:7079), `renderInvColDist` (16174) |
| `dist_chains` | Chain/store groupings per distributor | `renderDistStoresHTML` (app.js:7111), account detail (3340) |
| `dist_imports` | Depletion-report import records | `renderDistImportsHTML` (app.js:7131), import flow (7917-7940) |
| `audit_log` | Append-only audit trail (`APPEND_ONLY_KEYS`, db.js:28; rules deny update/delete) | Written by `auditLog()` (app.js:315) everywhere; read by `renderAuditLog` (app.js:9920). Server writers: `stripeWebhook` (paid/orphan/mismatch, functions/index.js:1166,1190,1235), `shipStationWebhook` (shipped/sample events, 1531,1543,1620) |
| `prod_hist` | Production history entries | PRODUCTION (`renderProduction` app.js:8853, push 8982) |
| `runs` | Completed delivery runs | Delivery save (app.js:9543), Reports (10035) |
| `shipments` | Inbound stock shipments | Production/schedule (app.js:8854, 9025) |

### 3.2 CONFIG_ARRAY_KEYS (db.js:39-43) — arrays inside `workspace/main/config/main`

| Key | Contents | Readers/writers |
|---|---|---|
| `saved_reports` | Saved report definitions | Reports (`renderSavedReports` app.js:10508; push 10503) |
| `loose_cans` | Loose-can inventory rows | Inventory receive/repack tabs (app.js:8028, 8116, 8147) |
| `repack_jobs` | Repack job records | Inventory repack tab (app.js:8155-8228) |
| `pallets` | Pallet records | Inventory pallets tab (app.js:8029, 8237-8260) |
| `pack_supply` | Packaging supplies | Inventory supplies tab (app.js:8324-8365) |
| `quick_notes` | Dashboard sticky notes | Dashboard (`renderQuickNotes` app.js:1532; push 1689) |
| `stock_locations` | — | **Unused in app.js (0 refs) — dead key** |
| `stock_transfers` | — | **Unused in app.js (0 refs) — dead key** |
| `lf_skus` | Lavender Fields SKU catalog | Settings (`renderLfSkuSettings` app.js:11497), LF invoicing (~24 refs) |
| `lf_wix_deductions` | Pending Wix-order stock deductions | Dashboard badge (app.js:1290), LF/inventory confirm flow (9289) |
| `pending_invoices` | Pending invoice queue | Dashboard (app.js:1506); cleaned on account delete (5537) |
| `returns` | Product returns | Inventory returns tab (app.js:8423, 8473) |

### 3.3 OBJ_KEYS (db.js:51) — objects inside the config doc

| Key | Contents | Readers/writers |
|---|---|---|
| `settings` | Global settings (payment terms, gas price, low-stock threshold, …) | Helpers `_payTerms`/`_gasPrice`/`_lowStock` (app.js:18-20); Settings page (`renderSettings` 10897, `saveSettings`) |
| `costs` | COGS per SKU, target margin, overhead | `_costs()` (app.js:15); Projections; Settings |
| `today_run` | Today's delivery-run state (stops, items) | Delivery (`renderDelivery` app.js:9117, 9214), Production schedule (8959) |
| `invoice_settings` | Invoice numbering/terms | Invoices page (`loadInvoiceSettings`, dispatched at app.js:310); read server-side by `shipStationWebhook` for Net-X terms (functions/index.js:1598-1600) |
| `api_settings` | — | **Unused in app.js (0 refs) — dead key** |
| `shipstation_settings` | Store ID, from-address | Integrations (app.js:467-532, 6282). Note db.js:49-50: this key was once missing from OBJ_KEYS and silently reverted on reload |

---

## 4. Write pipeline

### 4.1 Mutators (db.js:663-752)

- `DB.set(k,v)` / `DB.setObj(k,v)` (db.js:665,667) — replace value, then `_save(k)`.
- `DB.push(k,v)` (db.js:670) — stamps `_updatedAt` for collection keys (`_stamp` db.js:669), appends to cache, `_save(k)`, **plus** immediate `_writeDoc` for collection keys.
- `DB.update(k,id,fn)` (db.js:675) — find-by-id, apply `fn`, stamp, `_save(k)`, immediate `_writeDoc`. Returns false + warn if id missing.
- `DB.remove(k,id)` (db.js:686) — filter out of cache, `_save(k)`, immediate `_deleteDoc` for collection keys.
- `DB.atomicUpdate(fn)` (db.js:691) — multi-key transaction:
  1. Sets `_atomicInProgress` (blocks snapshot application, db.js:218/247).
  2. Diffs before/after id-sets per collection so **deletions are explicit** `_deleteDoc` calls (C1 fix, db.js:697, 719-721) — never inferred from cache absence.
  3. Stamps every surviving item (`_updatedAt = now`), except append-only rows (L5, db.js:707); new ids get immediate `_writeDoc` (db.js:710).
  4. Schedules saves for all keys, then after 50 ms force-flushes every `_saveCollection` + `_saveConfig`, clears `_saveDirtyKeys` (M13, db.js:743-747), and clears `_atomicInProgress` in a `finally` (db.js:732-751). A throwing mutator also clears the flag and rethrows (db.js:724-729).

### 4.2 Debounce & persistence

```
mutator → _save(key) (db.js:329) → _scheduleSave(key): add to _saveDirtyKeys, 500 ms timer (db.js:343-347)
        → _doSave(key) (db.js:490): COLLECTION_KEYS → _saveCollection(key)
                                    CONFIG/OBJ keys  → _saveConfig()
  (collection keys ALSO get an immediate per-doc _writeDoc at mutation time — the batch is a safety net)
```

- `_writeDoc` (db.js:639): immediate `set(item, {merge:true})`; on failure re-queues the key for debounced batch save. `_deleteDoc` (db.js:651) same for deletes.
- `_saveCollection(key)` (db.js:501): one batched merge-set of every cached item. **Never deletes** (C1 comment db.js:506-511). For append-only keys it first reads existing ids and only creates new docs (a merge-set on an existing `audit_log` doc would be an UPDATE the rules reject and would sink the whole batch, db.js:513-522 and 22-28).
- Error handling (db.js:527-548 collection; 559-580 config): permanent Firestore codes (`permission-denied` etc.) → loud toast, **no retry**; transient → up to 3 retries at 2s/4s/6s; after 3 failures the key returns to `_saveDirtyKeys` and waits for the window `online` listener to re-drive it with per-key backoff reset (M11, db.js:165-181).
- `_saveConfig()` (db.js:551): rewrites the whole config doc (`_dbVersion: 2` + all CONFIG_ARRAY_KEYS + OBJ_KEYS) with `{merge:true}`; same permanent/transient classification (LOW-1).
- Sync status UI: `_updateSyncUI` drives `#sync-dot` / `#sync-label` in the sidebar (db.js:583-590; index.html:136-139) — Saved / Saving… / Sync error.
- `importFromLocalStorage` / `_forceSave` / `_saveCollectionSync` / `_saveConfigSync` (db.js:754-821): the legacy-data import path; id-deduplicated append, then awaited batch saves.

### 4.3 Unload recovery blob (HIGH-2 / H1 / H2 / M14 / M15)

- On `beforeunload`/`pagehide` (auth.js:169-173) → `_flushPendingSave()` (db.js:351): synchronously writes `localStorage['pcrm_recovery_' + uid]` containing, for each dirty key, only collection items whose `_updatedAt` is within `RECOVERY_WINDOW_MS` (30 min, db.js:36) plus dirty config values (db.js:359-374). Merges with any existing blob from another same-user tab, newest `_updatedAt` per id wins (M15, db.js:378-400). Then fires the async `_writeDoc`s / `_saveConfig` anyway (db.js:404-417).
- On next init → `_replayRecovery()` (db.js:426): discards blobs >24 h (db.js:434); re-asserts an item only if (a) it exists on the server and the local copy is newer by >5 s skew margin (db.js:444-449), or (b) it's missing server-side AND was touched within the recovery window just before close (db.js:452-453) — so a legitimate remote deletion is never resurrected (H1). Config values are restored only into empty/missing server slots (db.js:472-481). Restored items are re-written via `_writeDoc` + `_saveConfig`, a toast reports the count (db.js:484), and the blob is removed.

---

## 5. Render dispatch & shell

### 5.1 Sidebar (index.html:59-149)

`<nav class="sidebar" id="main-sidebar">`, grouped Sales / Operations / Insights / Admin (index.html:70,83,108,125). Links are `<a data-page="…">`; wired in `onAppReady` (app.js:13890-13892). Pages: dashboard, accounts, prospects, orders-delivery, invoices, inventory, pre-orders (with portal-orders + applications badges, index.html:98), distributors, emails, map, production, projections, reports, settings, integrations. Bottom: sync indicator, theme toggle, sign-out (index.html:135-148). Mobile: hamburger (index.html:156) + `#sidebar-overlay` backdrop (index.html:3169) + mobile bottom nav synced in `nav()` (app.js:267-269).

Each page is a `<div class="page" id="page-{name}">` inside `.main` (index.html:175-1893); exactly one carries `.active`.

### 5.2 nav() and renders{} (app.js:258-312)

`nav(page)` (app.js:258):
1. Closes all open modals (`.overlay.open`, app.js:259).
2. Deactivates all `.page`s and sidebar links; activates `#page-{page}` and the matching `.sb-nav a[data-page]` (app.js:260-265); syncs mobile bottom nav (267-269).
3. Sets `#topbar-title` from a titles map (dashboard gets a live date suffix, app.js:270-286); clears `#topbar-actions` (287-288).
4. `currentPage = page; renders[page]?.()` (app.js:289-290).

`renders{}` dispatch table (app.js:293-312):

| Page key | Render call | Definition |
|---|---|---|
| `dashboard` | `renderDash` | app.js:1389 (composes `renderDashQuickActions` 1273, `renderDashPayments` 1316, `renderDashActivity` 1353, `renderQuickNotes` 1532, `renderAttention` 1750, `renderFollowUps` 1861, `renderReorderPredictions` 1941, `renderCadenceOverdue` 1994, `renderPendingOrders` 2039, `renderInvoiceStatus` 2076…) |
| `accounts` | `renderAccounts` | app.js:3236 |
| `distributors` | `renderDistributors` | app.js:6556 (+ per-tab `renderDistTab` 6675) |
| `prospects` | `renderProspects` | app.js:5582 |
| `inventory` | `renderInventory` | app.js:7984 (tabs: summary/locations/receive/repack/pallets/supplies/log/returns, app.js:8008) |
| `orders-delivery` | `renderOrdersDelivery` | app.js:8557 (tabs via `switchODTab` 8587 → `renderOrders` 8637 / `renderDelivery` 9116) |
| `orders` (legacy) | `()=>nav('orders-delivery')` | app.js:301 — redirect kept for deep links |
| `delivery` (legacy) | `()=>{ nav('orders-delivery'); switchODTab('route-builder'); }` | app.js:302 |
| `production` | `renderProduction` | app.js:8853 |
| `map` | `renderMap` | app.js:14009 |
| `projections` | `renderProjectionsPage` | app.js:2877 |
| `reports` | `renderReports` | app.js:9618 |
| `integrations` | `renderIntegrations` | app.js:10701 |
| `settings` | `()=>{ renderSettings(); loadShipStationSettings(); }` | app.js:10897, 470 |
| `pre-orders` | `renderPreOrders` | app.js:14413 (async; reads `portal_orders` directly from Firestore) |
| `invoices` | `()=>{ renderInvoicesPage(); loadInvoiceSettings(); }` | app.js:15726 |
| `emails` | `renderEmailsPage` | app.js:4157 |

Re-render entry point: `window.refreshCurrentPage` (app.js:13879-13885) re-runs idempotent migrations, `_checkShippedInvoices()`, then `renders[currentPage]?.()`. It is invoked by db.js on initial load (db.js:183), after debounced remote snapshots (`_scheduleRefresh`, db.js:274-278, 120 ms coalesce — H4 fix for render storms), and after recovery replay (db.js:485).

### 5.3 Toast / modal / confirm helpers

- `toast(msg, dur=3000)` (app.js:184-191): sets text on the single `#toast` div (index.html:3159), toggles `.show`, auto-clears; re-entrant safe via `el._t` timer. Used by db.js/auth.js via `window.toast` guards (e.g. db.js:178, 484, 534; auth.js:33).
- `confirm2(msg)` (app.js:193): thin wrapper over `window.confirm` — ~39 call sites; no custom confirm modal exists.
- `openModal(id)` (app.js:11165-11175): closes any other open `.overlay`, opens `#id`; if the id contains `edit|add|new|log` → `DB.markDirty()` (freezes remote snapshot application while editing).
- `closeModal(id)` (app.js:11176-11184): always `DB.markClean()`; with no id closes every overlay. Backdrop-click and `.modal-close` wiring at app.js:13894-13900.
- `qs(sel)` (app.js:11186) — querySelector shorthand used throughout.
- `_dbLoadingHTML(rows)` (app.js:204-208): shimmer skeleton before first snapshot.
- Offline banner IIFE (app.js:211-222) toggles `#offline-banner` (index.html:53) on `navigator.onLine`.
- `_requireAdmin(action)` (app.js:329-333) — toast-gated admin check backed by `window._userRole`.

---

## 6. Service worker (public/sw.js)

- Cache name `purpl-crm-v130`, bumped every deploy (sw.js:2). Precached shell: `/`, index.html, style.css, firebase-config.js, db.js, auth.js, app.js, places.js, manifest.json (sw.js:3-13).
- `install`: cache shell + `skipWaiting()` (sw.js:15-19). `activate`: delete old caches, `clients.claim()`, then `postMessage({type:'SW_UPDATED'})` to all windows (sw.js:21-31).
- `fetch`: same-origin GET only; **network-first** with cache fallback; 200 `basic` responses are re-cached (sw.js:33-46). So the app always gets fresh files online and still boots offline.
- Client side (index.html:3476-3496): registration tracks whether a controller already existed so the first-ever install doesn't show the update banner; `SW_UPDATED` shows a fixed "new version — Reload/Dismiss" banner, never stacked.
- Hosting sets `Cache-Control: no-cache` on js/css/html and sw.js (firebase.json:31-34), so the network-first SW is the only caching layer.

---

## 7. Cloud Functions inventory (functions/index.js, 1642 lines)

Runtime: firebase-functions **v2** (`onCall`/`onRequest`, index.js:1), Admin SDK (index.js:3-5). Secrets via `defineSecret`: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SHIPSTATION_API_KEY` (index.js:7-11). `ANTHROPIC_API_KEY` is a plain env var (index.js:403). Email from-address allowlist: `lavender@pbfwholesale.com` only (index.js:13-15). Fallback admin: `grahambiagiotti@gmail.com` (index.js:621-623).

| # | Export | Trigger | Auth | Reads | Writes | Called by |
|---|---|---|---|---|---|---|
| 1 | `sendEmail` (index.js:22) | onCall | required | — | Resend send; `workspace/main/ac/{accountId}.cadence` via `_logCadenceEntry` (785) | app.js:424 (email preview send) |
| 2 | `sendCombinedInvoice` (index.js:64) | onCall | required | — | Resend send (fixed from/replyTo); cadence entry `invoice_sent` | app.js:717 |
| 3 | `sendOrderConfirmation` (index.js:107) | onCall | **public** (portal) | `portal_orders/{portalOrderId}` — recipient is server-authoritative from the order (HIGH-8, 120-137); idempotent per order (134) | Resend send; `portal_orders.emailLog` arrayUnion (241-254); cadence if accountId matches (257-263); `confirmationEmailFailed` flag on failure (273-275) | order.html:1340, public-wholesale/order.html:1334, app.js:728 (CRM resend) |
| 4 | `sendApplicationConfirmation` (index.js:286) | onCall | **public** | `portal_inquiries/{inquiryDocId}` — recipient bound to inquiry (MED-2, 297-311); idempotent (308) | Resend send (fixed template); `portal_inquiries.emailLog`; `confirmationEmailFailed` on failure | wholesale.html:861, public-wholesale/index.html:861 |
| 5 | `callAnthropic` (index.js:393) | onCall | required | — (proxies to api.anthropic.com, claude-sonnet-4, ≤5000-char prompt, 1000 max_tokens) | — | app.js:4018 (AI email drafting) |
| 6 | `checkDuplicateApplication` (index.js:434) | onCall | **public** | `portal_inquiries` where email == | — | wholesale.html:815, public-wholesale/index.html:815 |
| 7 | `getPortalConfig` (index.js:445) | onCall | **public** | `portal_settings/config` (returns only `mode`, `pricePerCase`) | — | order.html:859 (both sites) |
| 8 | `verifyPortalPassword` (index.js:458) | onCall | **public** | `portal_settings/config.portalPassword`; hard-coded accept of `purpleherb` (466) | — | order.html:1807 (both sites) |
| 9 | `lookupPortalToken` (index.js:480) | onCall | **public** | token index in `accounts`/`prospects`, fresh data from `workspace/main/ac`/`pr` (DM-3, 493-537) | — | order.html:887 (both sites) |
| 10 | `getPortalOrderHistory` (index.js:545) | onCall | **public** (token proves ownership, 550-556) | `portal_orders` by accountId (last 10) | — | order.html:993 (both sites) |
| 11 | `unsubscribe` (index.js:582) | onRequest, invoker public | none (email link) | `workspace/main/ac/{id}` | sets `emailOptOut`, `emailOptOutAt` (597); always renders friendly HTML | `/unsubscribe` hosting rewrite (firebase.json:17) from marketing-email links |
| 12 | `initUserRole` (index.js:625) | onCall | required | `users/{uid}`, `app_config/access_control` allowlist | creates `users/{uid}` with role (transaction, 666-684); seeds/updates allowlist (649, 659-661); `bootstrapAdminAssigned` flag | auth.js:134 (first sign-in) |
| 13 | `resendWebhook` (index.js:691) | onRequest, invoker public | svix signature over `req.rawBody` (703-720) | full scans of `workspace/main/ac`, `portal_inquiries`, `portal_orders` to match `sentMessageId` (737-773) | sets opened/clicked flags on cadence/emailLog entries | Resend webhook (email.opened / email.clicked) |
| 14 | `inviteEmployee` (index.js:815) | onCall | required + caller must be admin (821-824) | `users/{caller}`, `users/{invitee}` | creates Auth user; `users/{uid}` doc (never downgrades an admin, 846-855); allowlist arrayUnion (858-861); password-reset link + Resend invite email | app.js:11027 (Settings → Team tab) |
| 15 | `stripeStatus` (index.js:913) | onCall | required | env STRIPE_SECRET_KEY | creates a $1 test Checkout session; returns step-by-step diagnostic, never throws | app.js:16350 (Integrations diagnostics) |
| 16 | `createPayLink` (index.js:955) | onCall | required | invoice looked up **server-side** by type→collection map incl. legacy `iv` (TB-2, 962-974) — client amount never trusted | Stripe Checkout session (metadata: invoiceId/type/number/accountId); returns `{ok,url}` | app.js:687 (invoice "payment link") |
| 17 | `createStripePaymentLink` (index.js:1021) | onCall | required | same as createPayLink | same | **No client callers** — superseded by createPayLink (comment index.js:952-954); dead deployment kept for the stuck revision |
| 18 | `stripeWebhook` (index.js:1085) | onRequest, invoker public | Stripe signature over rawBody (1097-1099) | `workspace/main/audit_log` idempotency by stripeEventId (1126-1132); invoice doc for amount-mismatch compare (1159-1173) | marks invoice paid (`status/paidAt/paidVia/stripeSessionId/paidAmount`, 1134-1146) in mapped collection with `iv` fallback (1180-1185); cascades to combined children (1209-1232); audit entries `paid` / `paid_orphan` / `paid_amount_mismatch` | Stripe (checkout.session.completed) |
| 19 | `pushToShipStation` (index.js:1259) | onCall | required | env SHIPSTATION_API_KEY | POST `ssapi.shipstation.com/orders/createorder` (30 s timeout); optional storeId | app.js:567 & 6287 (invoice "Ship" actions) |
| 20 | `shipStationStatus` (index.js:1338) | onCall | required | GET `/stores` (15 s timeout) | — | app.js:482 (Integrations connection test) |
| 21 | `shipStationWebhook` (index.js:1369) | onRequest, invoker public | shared secret = last 8 chars of API key in `?secret=` (TB-1, 1375-1381); `resource_url` origin pinned to ssapi.shipstation.com (1388-1392) | fetches shipment resource; scans `workspace/main/ac` for SAMPLE- orders (1431); queries invoices by `number` across retail/lf/combined (1556-1559); `workspace/main/config/main` for terms (1598) | Samples: tx-guarded `samples[]` update (M16, 1444-1458), 3-can `iv` deduction (1463), shipped email, audit. Invoices: tracking/carrier/shipping line item/total; issue+due dates only on first shipment (M7, 1597-1607); `readyToSend`; audit `shipped` | ShipStation (on-ship webhook) |

Cross-cutting server notes:
- `escHtml` (index.js:17) used for all interpolated email HTML; `portalLink` additionally scheme-restricted to http(s) (MED-3, index.js:142-144).
- `_logCadenceEntry` (index.js:785-811) caps `cadence[]` at 500 entries and bumps `lastContacted` + `_updatedAt`.
- Scaling smell: `resendWebhook` and the sample branch of `shipStationWebhook` do **full-collection scans** of `ac` / `portal_inquiries` / `portal_orders` per event (index.js:737, 751, 765, 1431) — O(N) reads per email-open event.
- Client wrapper pattern: app.js calls use `firebase.functions().httpsCallable(...)`; Stripe/ShipStation functions return `{ok:false, error}` instead of throwing because v2 onCall wraps thrown errors as opaque `internal` (comment index.js:1019-1020).

---

## 8. Foundation-level observations (no changes made)

1. **Dead keys**: `stock_locations`, `stock_transfers` (CONFIG_ARRAY_KEYS) and `api_settings` (OBJ_KEYS) have zero references in app.js — persisted and re-saved on every `_saveConfig` for nothing.
2. **Dead function**: `createStripePaymentLink` (functions/index.js:1021) has no callers; `createPayLink` is its replacement.
3. **Config doc is a single contention point**: every `_saveConfig` rewrites all 12 arrays + 6 objects (db.js:551-557); the config snapshot listener defers ALL remote config while ANY config key is dirty (db.js:245-249). Fine at this scale, but it's the coarsest lock in the system.
4. **Whole-collection batch on every debounced save**: `_saveCollection` merge-sets every cached item of the key (db.js:518-522), not just changed ones — correctness is fine (merge-set), but write volume grows with collection size. The immediate `_writeDoc` path already covers the common case.
5. **`iv` is double-duty** (inventory ledger + legacy invoices), threaded through invoice helpers (app.js:45-83), Stripe fallback (functions/index.js:1180-1185), and pay-link lookup — the single most confusing data-model fact for anyone new to the codebase.
6. **Portal data bypasses the DB layer** entirely (direct `firebase.firestore()` from app.js), so Portal Orders has its own load/refresh path (`renderPreOrders(forceReload)`, app.js:14413) and none of db.js's dirty/recovery protections.
7. `verifyPortalPassword` hard-codes acceptance of `purpleherb` (functions/index.js:466) — deliberate per comment, but it means the Settings password field can never actually rotate the gate.
