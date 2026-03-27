# Purpl CRM Shakedown Report
**Date:** 2026-03-27
**Branch:** claude/modernize-purpl-crm-fY9Mp
**App:** https://purpl-crm.web.app
**Method:** Static code trace — read only the relevant functions, no full-codebase scan.

---

## How the DB Layer Works (Critical Context)

Before reading the test results, understand the architecture:

`db.js` implements a **Firestore-backed in-memory cache**. All data lives in a
**single Firestore document** at `workspace/main/data/store`. The public API
(`DB.get`, `DB.set`, `DB.push`, `DB.update`, `DB.atomicUpdate`, etc.) writes
to this cache and then calls `setDoc()` to persist. There is **no localStorage
in the write path** — calls that look like `DB.set()` go to Firestore.

However, there is a **second Firestore data universe** used by the portal
subsystem: `confirmPortalOrder()` and `generateOrderLink()` write to standalone
Firestore collections (`orders/`, `accounts/`, `inventory_log/`, `invoices/`)
that are **completely separate** from the DB cache document. This split is the
root cause of several broken features.

---

## Summary

| | |
|---|---|
| **Total tests** | 10 |
| ✅ Working | 5 |
| ⚠️ Partial | 3 |
| ❌ Broken | 2 |

---

## Test Results

---

### TEST 1 — Log a Follow-Up on an Account
**Function:** `saveLogOutreach()` — `app.js:1672`
**Data path:** FIRESTORE

```
DB.update('ac', id, a=>({
  ...a,
  lastContacted: date,
  outreach: [...(a.outreach||[]), entry],
  ...(nextDate ? {nextFollowUp: nextDate} : {}),
}));
```

- Saves outreach entry (type, date, contact, outcome, notes) to `ac` array in DB cache → Firestore ✅
- Sets `lastContacted` to the logged date ✅
- Sets `nextFollowUp` on the account if a next date is provided ✅
- Also works via `addAccountNote()` at `app.js:1136` which sets `lastContacted: today()` ✅

**Result: ✅ WORKS — Saves to Firestore, updates lastContacted and nextFollowUp correctly.**

---

### TEST 2 — Log a Follow-Up on a Prospect
**Function:** `saveLogOutreach()` — `app.js:1732` (the `else` branch for `kind === 'pr'`)
**Data path:** FIRESTORE

```
DB.update('pr', id, p=>({
  ...p,
  outreach: [...(p.outreach||[]), entry],
  lastContact: date,
  ...(next ? {nextAction: next} : {}),
  ...(nextDate ? {nextDate} : {}),
}));
```

- Saves to `pr` array in DB cache → Firestore ✅
- Sets `lastContact` (note: different field name than accounts — `lastContact` vs `lastContacted`) ✅
- Sets `nextDate` and `nextAction` if provided ✅
- Minor inconsistency: prospect outreach entry lacks `contact` and `outcome` fields that account entries have ⚠️

**Result: ✅ WORKS — Saves to Firestore. Minor field-name inconsistency between accounts and prospects.**

---

### TEST 3 — Build a Delivery Run
**Functions:** `addStop()` — `app.js:3807`, `mapAddToRun()` — `app.js:5209`, `renderDelivery()` — `app.js:3739`
**Data path:** FIRESTORE

- `renderDelivery()` reads run from `DB.obj('today_run')` → Firestore ✅
- Accounts are loaded from `DB.a('ac')` → Firestore ✅
- `addStop()` writes stop to `today_run` via `DB.setObj('today_run', run)` → Firestore ✅
- `mapAddToRun()` uses `DB.atomicUpdate()` to append a stop → Firestore ✅
- Starting a run saves immediately to Firestore via the DB cache ✅

**Result: ✅ WORKS — All read/write operations use Firestore via DB cache.**

---

### TEST 4 — Complete a Delivery Run
**Function:** `toggleStop()` — `app.js:3829`
**Data path:** FIRESTORE (via `DB.atomicUpdate`)

Four things happen in a single `DB.atomicUpdate()` call at `app.js:3862`:

**1. Order record created:**
`cache['orders'] = [...(cache['orders']||[]), newOrd]`
→ Written to `orders` array in `workspace/main/data/store` ✅ FIRESTORE

**2. Inventory deducted:**
`cache['iv'] = [...(cache['iv']||[]), ...newIvEntries]`
→ Written to `iv` array in `workspace/main/data/store` ✅ FIRESTORE
→ Deduction is in CANS (qty × CANS_PER_CASE) ✅

**3. Account lastOrder updated:**
`cache['ac'] = (cache['ac']||[]).map(a => a.id===ac2.id ? {...a, lastOrder:today()} : a)`
→ Written to `ac` array in `workspace/main/data/store` ✅ FIRESTORE

**4. Invoice auto-draft created:**
❌ NOT auto-created. After the atomic write, `offerDeliveryInvoice()` is called via
`setTimeout()` which renders a dismissible banner at the top of the delivery page.
The user must click "Create Invoice" to trigger `createDeliveryInvoice()`.
If the user taps another stop or navigates away, no invoice is created.
`createDeliveryInvoice()` when clicked DOES save correctly to `DB.push('inv_log_v2', invoice)` → Firestore.

**Result: ⚠️ PARTIAL — 3 of 4 work atomically. Invoice is NOT auto-drafted — it is user-prompted via a banner that can be dismissed or missed.**

---

### TEST 5 — Portal Order Approval
**Function:** `confirmPortalOrder()` — `app.js:5753`
**Data path:** DIRECT FIRESTORE (NOT the DB cache)

Uses `firebase.firestore().batch()` to write to **standalone Firestore collections**.

**1. Order in orders collection:**
`firebase.firestore().collection('orders').doc(orderId)`
→ ✅ Written to Firestore
→ ❌ BUT this is a **different** `orders` collection than the DB cache reads from.
`DB.a('orders')` reads the `orders` array inside `workspace/main/data/store`.
Portal orders will **not appear** in the app's Orders list, account order history, dashboard KPIs, or invoices.

**2. Portal order status updated:**
`batch.update(portalRef, { status: 'confirmed', ... })`
→ ✅ Written to `portal_orders/{id}` in Firestore

**3. Account lastOrder updated:**
`firebase.firestore().collection('accounts').doc(d.accountId).update({ lastOrder: todayStr })`
→ ❌ Written to a standalone `accounts/{id}` collection that is **not** the DB cache.
`DB.a('ac')` reads the `ac` array in `workspace/main/data/store`. The account's
`lastOrder` in the app is NOT updated. The Needs Attention dashboard will still flag this account.

**4. Inventory log entry created:**
`firebase.firestore().collection('inventory_log').doc()`
→ ✅ Written to Firestore
→ ❌ BUT the DB cache reads inventory from `iv` array in `workspace/main/data/store`.
This deduction does **not reduce** inventory shown on the Inventory dashboard.

**5. Draft invoice created:**
`firebase.firestore().collection('invoices').doc(invoiceId)`
→ ✅ Written to Firestore
→ ❌ BUT the app's invoice list reads from `DB.a('inv_log_v2')` (the DB cache array).
Portal invoices will **not appear** in the app's Invoices list.

**Result: ❌ BROKEN — The batch write uses standalone Firestore collections that are invisible to the rest of the app. Orders, inventory deductions, account updates, and invoices created via portal confirmation are siloed and never reflected in the CRM's main views.**

---

### TEST 6 — Inventory Levels
**Function:** `renderInventory()` → `_invSummary()` — `app.js:2893`
**Data path:** FIRESTORE (via DB cache)

- Reads from `DB.a('iv')` for finished packs (ins/outs) ✅
- Reads from `DB.a('loose_cans')` for loose can count ✅
- Reads from `DB.a('pallets')` for pallet count ✅
- Numbers are accurate for deliveries logged via `toggleStop()` (those write to `cache['iv']`) ✅
- **Accuracy gap:** Portal order confirmations write inventory deductions to a separate
  `inventory_log` Firestore collection (not `iv` in the cache). Portal order inventory
  deductions are **not visible** on this dashboard ⚠️

**Result: ⚠️ PARTIAL — Inventory reads correctly from Firestore cache. Accurate for manual/run deliveries. Portal-confirmed orders do not reduce inventory shown here.**

---

### TEST 7 — Add a New Account
**Function:** `saveAccount()` — `app.js:1309`
**Data path:** FIRESTORE

- Reads existing account via `DB.a('ac').find(...)` ✅
- Geocodes address via `PlacesAC.getCoords(addrEl)` and stores `lat`/`lng` on the record ✅
- Supports multi-location accounts; geocodes each location row independently ✅
- New account: `DB.push('ac', rec)` → Firestore ✅
- Edit existing: `DB.update('ac', id, ()=>rec)` → Firestore ✅
- Preserves existing `notes`, `outreach`, `lastOrder` on save (spread of existing record) ✅

**Result: ✅ WORKS — Saves to Firestore with lat/lng from Places autocomplete.**

---

### TEST 8 — Add a Prospect and Convert to Account
**Functions:** `saveProspect()` — `app.js:1581`, `convertProspect()` — `app.js:1505`
**Data path:** FIRESTORE

`saveProspect()`:
- Geocodes address via `PlacesAC.getCoords()` ✅
- `DB.push('pr', rec)` or `DB.update('pr', ...)` → Firestore ✅
- Preserves existing `notes` and `outreach` on edit ✅

`convertProspect()`:
- Copies ALL prospect fields to new account record ✅
- Carries over `notes` and `outreach` history ✅
- Uses `DB.atomicUpdate()` — marks prospect `status: 'won'` AND creates new account in a **single Firestore write** ✅

**Result: ✅ WORKS — Both functions use Firestore. Conversion is atomic, preserves all history.**

---

### TEST 9 — Copy Order Link
**Functions:** `copyOrderLink()` — `app.js:5327`, `generateOrderLink()` — `app.js:5307`
**Data path:** ❌ localStorage (copyOrderLink) → Firestore (generateOrderLink)

`copyOrderLink(accountId)` (called from the account modal and portal links page):

```javascript
async function copyOrderLink(accountId) {
  const accounts = JSON.parse(localStorage.getItem('pcrm5_ac') || '[]');  // ← BROKEN
  const account = accounts.find(a => a.id === accountId);
  if (!account) { toast('Account not found'); return; }
  await generateOrderLink(accountId, account.name, account.email || '');
}
```

- Reads accounts from `localStorage.getItem('pcrm5_ac')` — **this key is never written** in the cloud version. Data lives in Firestore, not localStorage.
- `localStorage.getItem('pcrm5_ac')` returns `null` → parses to `[]` → account not found → `toast('Account not found')` → **link is never generated**.
- Should read from `DB.a('ac').find(a => a.id === accountId)` instead.

`generateOrderLink()` is correct when called directly:
- Writes token to `firebase.firestore().collection(entityType).doc(entityId).set({...}, {merge:true})` ✅
- Uses `merge: true` ✅
- Copies URL to clipboard ✅
- Note: Writes token to the standalone `accounts/` collection, not the DB cache. The token won't appear in the account record viewed in the app, but the portal order system reads from this collection.

**Result: ❌ BROKEN — `copyOrderLink` reads from `localStorage.getItem('pcrm5_ac')` which is always empty. Every "Copy Order Link" button click in the app silently fails with "Account not found".**

---

### TEST 10 — Dashboard Data
**Function:** `renderDash()` — `app.js:172`
**Data path:** FIRESTORE (via DB cache)

- Revenue 30d: reads `DB.a('orders')` → Firestore ✅
- Active accounts count: reads `DB.a('ac')` → Firestore ✅
- Open prospects: reads `DB.a('pr')` → Firestore ✅
- Low stock alerts: reads `DB.a('iv')` → Firestore ✅
- `renderAttention()` — `app.js:343`:
  - Flags accounts with no order in 30+ days (reads `ac.lastOrder`) ✅
  - Flags low inventory from `DB.a('iv')` ✅
  - Flags overdue prospect follow-ups from `DB.a('pr')` ✅
  - Flags overdue account follow-up dates from `ac.nextFollowUp` ✅
  - **Gap:** Because portal-confirmed orders don't update the DB cache's `ac.lastOrder`,
    accounts that received portal orders will still be flagged as "No order in X days" ⚠️
- Quick notes: `DB.a('quick_notes')` → Firestore ✅
- Activity feed (`renderFollowUps`): reads DB cache → Firestore ✅

**Result: ✅ WORKS — Dashboard reads correctly from Firestore. One gap: portal orders don't update account lastOrder in the DB cache, causing false "Needs Attention" flags.**

---

## Critical Issues (Fix First)

### 1. Portal Order Confirmation — Data Silo (TEST 5)
**Severity: Critical | Daily Impact: High**

`confirmPortalOrder()` writes to standalone Firestore collections (`orders/`, `accounts/`,
`inventory_log/`, `invoices/`) that the app never reads. The DB cache reads everything from
`workspace/main/data/store`.

Consequences:
- Portal-confirmed orders are invisible in the Orders list, account history, and revenue KPIs
- Inventory on the dashboard is NOT reduced when a portal order is confirmed
- Account `lastOrder` is not updated → false "Needs Attention" flags persist
- Portal invoices don't appear in the Invoices section

**Fix:** After the batch write, sync results back into the DB cache:
```javascript
DB.atomicUpdate(cache => {
  cache['orders'] = [...(cache['orders']||[]), newOrderObj];
  cache['iv'] = [...(cache['iv']||[]), invEntry];
  cache['inv_log_v2'] = [...(cache['inv_log_v2']||[]), draftInvoice];
  cache['ac'] = (cache['ac']||[]).map(a => a.id===d.accountId ? {...a, lastOrder:todayStr} : a);
});
```
Or rewrite `confirmPortalOrder` to use `DB.atomicUpdate` exclusively instead of the standalone batch.

---

### 2. Copy Order Link — localStorage Read Bug (TEST 9)
**Severity: High | Daily Impact: High**

`copyOrderLink(accountId)` at `app.js:5327` reads from `localStorage.getItem('pcrm5_ac')`.
This key does not exist in the cloud version. Every "Copy Order Link" button click fails silently.

**Fix (one line):**
```javascript
// Replace:
const accounts = JSON.parse(localStorage.getItem('pcrm5_ac') || '[]');
// With:
const accounts = DB.a('ac');
```

---

### 3. Delivery Invoice Not Auto-Created (TEST 4)
**Severity: Medium | Daily Impact: Medium**

When a stop is marked done, invoicing is not automatic — a dismissible banner is shown.
If Graham navigates away or dismisses it, no invoice is created. This causes uninvoiced
deliveries to accumulate silently.

**Fix options:**
- Auto-create the invoice inside `DB.atomicUpdate()` in `toggleStop()`, or
- Make the banner sticky/persistent until explicitly dismissed with a reason, or
- Add an "Uninvoiced deliveries" counter to the dashboard Alerts KPI.

---

## localStorage vs Firestore Audit

All DB cache operations (`DB.get`, `DB.set`, `DB.push`, `DB.update`, `DB.remove`,
`DB.atomicUpdate`, `DB.setObj`, `DB.obj`) write to **Firestore**, not localStorage.
The names are misleading but the implementation is correct.

### Functions that still touch localStorage directly:

| Function | File:Line | What it reads | Impact |
|---|---|---|---|
| `copyOrderLink()` | `app.js:5328` | `localStorage.getItem('pcrm5_ac')` | **BREAKS** Copy Order Link — account never found |
| `DB.importFromLocalStorage()` | `db.js:189` | All `pcrm5_*` keys | One-time migration utility — no live impact |

### Functions that write to standalone Firestore collections (outside DB cache):

| Function | File:Line | Collections written | Visible to app? |
|---|---|---|---|
| `confirmPortalOrder()` | `app.js:5753` | `orders/`, `accounts/`, `inventory_log/`, `invoices/` | ❌ NO |
| `generateOrderLink()` | `app.js:5312` | `accounts/{id}` or `prospects/{id}` | ❌ NO (token not in DB cache) |
| `_renderPoLinks()` | `app.js:5557` | reads from `accounts/` collection | Reads from its own silo |

---

## Recommended Fix Order

| Priority | Fix | Impact |
|---|---|---|
| 1 | **`copyOrderLink` localStorage bug** — 1-line fix, completely broken feature | High |
| 2 | **`confirmPortalOrder` data silo** — sync results back to DB cache after batch commit | Critical |
| 3 | **Invoice auto-creation or persistent prompt** — stop uninvoiced deliveries from slipping | Medium |
| 4 | **`generateOrderLink` token storage** — store token in `DB.update('ac', ...)` so it's visible in the app | Low |
| 5 | **Dashboard "Needs Attention" gap** — will auto-resolve once fix #2 is in place | Low |

---

*Report generated by static code trace. No data was modified.*
