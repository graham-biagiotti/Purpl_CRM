# Inventory Shakedown Report
**Date:** 2026-03-27
**Method:** Grep + targeted function reads — no full-file scan.

---

## Summary

| Flow | Result |
|---|---|
| Flow 1 — Receive Stock | ✅ PASS |
| Flow 2 — Complete Delivery Run | ⚠️ PARTIAL |
| Flow 3 — Confirm Portal Order | ⚠️ PARTIAL |
| Flow 4 — Manual Order Entry | ⚠️ PARTIAL |
| Flow 5 — Distributor Shipment | ✅ PASS |
| Flow 6 — Inventory Dashboard | ✅ PASS |
| Flow 7 — Velocity Calculation | ⚠️ PARTIAL |
| Flow 8 — Projections / Runway | ❌ FAIL |

---

## Flow-by-Flow Results

---

### Flow 1 — Receive Stock ✅ PASS

**Functions:** `saveTodayRun()` (line 3672), `receiveFinishedPacks()` (line 2975), `saveRepackJob()` (line 3030)

All three write to the `iv` array in the DB cache → Firestore.

```
// Production run (saveTodayRun)
DB.push('iv', {id, date, sku, type:'in', qty, note:'Production run', prodId})
// qty = units as entered in production form (step="6" implies cans)

// Finished packs receipt (receiveFinishedPacks)
DB.push('iv', {id, date, sku, type:'in', qty, note:'6pack receipt...'})

// Repack job output (saveRepackJob)
DB.push('iv', {id, date, sku:outSku, type:'in', qty:outQty, note:'Repack job...'})
```

- All writes go to collection `'iv'` ✅
- All writes use `type:'in'` ✅
- Dashboard reads `DB.a('iv')` — same collection ✅
- KPI updates immediately after save ✅

**Units note:** The production form uses `step="6"` with label "units", implying qty = cans. All delivery deductions also use cans. This is consistent. However the Receive Finished Packs form does not specify units explicitly — recommend adding a "cans" label to the input to prevent user confusion.

---

### Flow 2 — Complete a Delivery Run ⚠️ PARTIAL

**Function:** `toggleStop()` (line 3829) via `DB.atomicUpdate`

```javascript
DB.atomicUpdate(cache => {
  cache['today_run'] = run;                              // done flag
  cache['ac'] = [...].map(a => a.id===ac2.id ? {...a, lastOrder:today()} : a);  // lastOrder
  cache['iv'] = [..., ...newIvEntries];                  // inventory deduction
  cache['orders'] = [..., newOrd];                       // order record
});
```

**Cans deducted from inventory:**
`qty: i.qty * CANS_PER_CASE` — i.qty is CASES from the stop form. CANS_PER_CASE applied correctly. ✅

**Order record:**
Written to `cache['orders']` → appears in Orders section. ✅

**Account lastOrder:**
Updated atomically in `cache['ac']`. ✅ Clears "Needs Attention" flag immediately.

**Draft invoice:**
❌ NOT auto-created. `offerDeliveryInvoice()` renders a **dismissible banner** after a 200ms `setTimeout`. If Graham navigates away, taps another stop, or dismisses it, no invoice is created. `createDeliveryInvoice()` (called if the banner button is clicked) correctly writes to `DB.push('inv_log_v2', invoice)` → Firestore.

**Dashboard stock:**
Goes down immediately — `renderInventory()` and `renderDash()` called after the atomic write. ✅

---

### Flow 3 — Confirm Portal Order ⚠️ PARTIAL

**Function:** `confirmPortalOrder()` (line 5753) — recently fixed to use DB cache.

| Check | Result | Note |
|---|---|---|
| Writes to DB cache? | ✅ YES | Uses `DB.atomicUpdate` |
| Order appears in Orders section? | ❌ NO | Order written to `cache['ord']` — nothing in the app reads `DB.a('ord')` |
| Inventory deducted? | ✅ YES | `cache['iv']` entry with `type:'out'`, qty in cans |
| Account lastOrder updated? | ✅ YES | `cache['ac']` or `cache['pr']` updated atomically |
| Draft invoice created? | ✅ YES | `cache['inv_log_v2']` entry with status:'draft' |
| Portal order status updated? | ✅ YES | Direct Firestore `portalRef.update({status:'confirmed'})` |

**The remaining bug:** The order is written to `cache['ord']` (as specified). However, no page in the app reads `DB.a('ord')`. The Orders section, dashboard revenue KPIs, account order history, and velocity calculations all read `DB.a('orders')`. Portal-confirmed orders are invisible everywhere except the portal pre-orders page.

**Fix:** Change `cache['ord']` to `cache['orders']` in `confirmPortalOrder()` so portal orders appear in the Orders section and feed into velocity/projections.

---

### Flow 4 — Manual Order Entry ⚠️ PARTIAL

**Functions:** `saveNewOrder()` (line 3517) → `createOrder()` (line 3501)

```javascript
DB.atomicUpdate(cache => {
  cache['orders'] = [...(cache['orders']||[]), ord];
  cache['ac'] = [...].map(a => a.id===accountId ? {...a, lastOrder:today()} : a);
});
```

- Order written to `cache['orders']` — visible in Orders section ✅
- Account lastOrder updated atomically ✅
- Inventory is **NOT deducted** at order creation ⚠️

Inventory is only deducted when the order status is cycled to `'delivered'` in `cycleOrderStatus()` (line 3606):

```javascript
if (newStatus==='delivered' && o.status!=='delivered' && o.source!=='run') {
  (o.items||[]).forEach(item=>{
    DB.push('iv', {type:'out', qty: item.qty * CANS_PER_CASE, note:'Order delivered', ordId:id});
  });
}
```

CANS_PER_CASE applied correctly ✅. The deduction only happens once (guarded by status check) ✅. But if Graham never cycles the order to delivered, stock is never reduced.

**Invoice:** User is prompted via `confirm2('Create an invoice for this order now?')` — not auto-created. ⚠️

---

### Flow 5 — Distributor Shipment ✅ PASS

**Function:** `saveDistShipment()` (line 2302)

```javascript
// Inventory deduction — per SKU, in CANS
DB.push('iv', {sku, type:'out', qty: item.cases * CANS_PER_CASE, source:'dist_shipment', ...});

// PO record
DB.push('dist_pos', poRec);

// Stock transfer record
DB.push('stock_transfers', {fromLocation:'warehouse', toLocation:`dist:${distId}`, ...});

// Distributor lastOrder
DB.update('dist_profiles', distId, d=>({...d, lastOrder: date}));
```

- Warehouse inventory correctly deducted using `CANS_PER_CASE` ✅
- Stock transfer record created ✅
- Distributor PO record created (appears in distributor order history) ✅
- Distributor `lastOrder` updated ✅
- Note: Distributor shipments do NOT appear in the main `orders` list (they live in `dist_pos`) — this appears to be intentional by design.

---

### Flow 6 — Inventory Dashboard ✅ PASS

**Function:** `_invSummary()` (line 2893), reads `DB.a('iv')`

```javascript
const ins  = iv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty, 0);
const outs = iv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty, 0);
const packs = Math.max(0, ins - outs);  // net stock in cans
```

- Reads from `DB.a('iv')` — same collection all writes use ✅
- Formula is correct: all ins minus all outs ✅
- All delivery deductions use `CANS_PER_CASE` to convert cases → cans ✅
- CANS_PER_CASE not hardcoded — defined once at line 10, used via constant ✅
- The Locations tab correctly converts cans to cases: `Math.floor((ins-outs)/CANS_PER_CASE)` ✅

**Label note:** The dashboard KPI labels the result as "Finished Packs X units" but `packs` is actually in cans (all iv entries are in cans). This is a display label issue but the underlying numbers are consistent.

---

### Flow 7 — Velocity Calculation ⚠️ PARTIAL

**Function:** `calcProjections()` (line 571), `calcProjectionsWindow()` (used on projections page)

```javascript
const allOrders = DB.a('orders').filter(o=>o.status!=='cancelled');
// Per account:
const recentOrds = acOrds.filter(o=>daysAgo(o.dueDate)<=90);
// i.qty = cases, summed over items:
totalUnits[i.sku] += i.qty;  // total cases in window
weeklyUnits[s.id] = totalUnits[s.id] / weeksInPeriod;  // cases/week
avgDays = average interval between orders (days)
```

- Reads `DB.a('orders')` ✅
- Formula: average order-to-order interval + weekly case rate ✅
- Velocity expressed in **cases/week per SKU** ✅
- Updates whenever new orders are logged to `orders` ✅

**Gap:** Reads only from `'orders'`. Portal-confirmed orders are in `'ord'` — they are **excluded** from velocity. If portal orders are a significant portion of Graham's business, velocity/projections will be understated. Fixing the portal order collection name (see Flow 3) resolves this.

---

### Flow 8 — Projections / Runway ❌ FAIL

**Function:** `renderProjectionsPage()` (line 648), `stockFor()` (line 683)

```javascript
const stock = stockFor(s.id);   // cans (ins - outs from iv)
const wk    = weeklyBySku[s.id]; // cases/week
const daysSupply = wk > 0 ? Math.round(stock / (wk / 7)) : null;
```

**The bug — unit mismatch:**

- `stock` is in **cans** (raw sum from `iv` array)
- `wk` is in **cases/week** (summed from `orders.items[].qty` which is in cases)
- `wk / 7` = cases/day

```
stock(cans) / (wk/7)(cases/day) = cans × day / cases = CANS_PER_CASE × days
```

The result is inflated by a factor of `CANS_PER_CASE` (12). If you have 120 cans on hand and sell 1 case/day, the formula returns `120 / (1/7) = 840 days` instead of the correct `120 / (12/7) = 70 days`.

**Correct formula:**
```javascript
const daysSupply = wk > 0
  ? Math.round(stock / (wk * CANS_PER_CASE / 7))
  : null;
```

This also affects the gap calculation at line 714:
```javascript
const gap = d30u - stock;  // cases (demand) - cans (stock) — also wrong units
```
Should be:
```javascript
const gap = d30u - Math.floor(stock / CANS_PER_CASE);  // cases vs cases
```

---

## Critical Bugs

### Bug 1 — Portal Orders Written to `'ord'`, Read from `'orders'` (Flow 3)
**Severity: High**

`confirmPortalOrder()` writes the order to `cache['ord']`. No page reads `DB.a('ord')`. Portal orders are invisible in Orders, revenue KPIs, account history, velocity, and projections.

**Fix:** Change `cache['ord']` → `cache['orders']` in `confirmPortalOrder()`.

---

### Bug 2 — Projections Runway Formula Off by Factor of 12 (Flow 8)
**Severity: Medium**

`daysSupply` is computed as `stock_cans / (cases_per_week / 7)`. Units don't match. Result is 12× too high. The "Production Planning" table will always show far more days of supply than actually exist, giving false confidence.

**Fix:**
```javascript
// In renderProjectionsPage(), stockFor() result is in cans:
const daysSupply = wk > 0
  ? Math.round(stock / (wk * CANS_PER_CASE / 7))
  : null;

// Gap calculation:
const gap = d30u - Math.floor(stock / CANS_PER_CASE);
```

---

### Bug 3 — Delivery Invoice Not Auto-Created (Flow 2 & 4)
**Severity: Medium**

Both delivery run completions and manual order delivery only prompt for invoices via dismissible banners. Uninvoiced deliveries accumulate silently.

---

### Bug 4 — Manual Orders Not Inventory-Deducted Until Marked Delivered (Flow 4)
**Severity: Low**

For manual/portal orders, inventory is only deducted when status is cycled to 'delivered'. If an order is never status-updated, stock is never reduced. This is a workflow discipline issue as much as a code issue, but it means the inventory dashboard can be overstated.

---

## Hardcoded 12s

**None found.** `grep -n "\* 12\b\|/ 12\b"` returned zero results. Every multiplication or division by 12 uses `CANS_PER_CASE` or `PORTAL_CANS_PER_CASE`. ✅

---

## Collection Name Conflicts / Duplicate Constants

### Duplicate constant: `PORTAL_CANS_PER_CASE`

```javascript
// Line 10:
const CANS_PER_CASE = 12;

// Line 5248:
const PORTAL_CANS_PER_CASE = 12;
```

Two separate constants with identical values for the same thing. `PORTAL_CANS_PER_CASE` is only used in the portal subsystem (lines 5358, 5372, 5433, 5612, 5736, 5765, 5951). If the pack size ever changes, one constant would be updated and the other missed.

**Fix:** Remove `PORTAL_CANS_PER_CASE` and replace all uses with `CANS_PER_CASE`.

### `inv_log_v2` naming confusion

`inv_log_v2` is the **invoice** array, not an inventory log. Its name implies it tracks inventory movements, which is what `iv` does. This causes confusion when reading code. The old standalone Firestore collection `inventory_log` (removed by recent fix) compounded this.

| Array key | Actual purpose |
|---|---|
| `iv` | Inventory movements (ins and outs in cans) |
| `inv_log_v2` | Invoice records |

No runtime conflict — just a misleading name.

### `ord` vs `orders` — the live split

| Key | Written by | Read by |
|---|---|---|
| `orders` | `createOrder()`, `toggleStop()` | Every order view, dashboard, velocity, projections |
| `ord` | `confirmPortalOrder()` (after fix) | Nothing |

This is the active data silo. See Bug 1.

---

## Recommended Fix Order

| Priority | Fix | Impact |
|---|---|---|
| 1 | Change `cache['ord']` → `cache['orders']` in `confirmPortalOrder()` | Portal orders become visible everywhere |
| 2 | Fix projections runway: `stock / (wk * CANS_PER_CASE / 7)` | Runway numbers correct (currently 12× too high) |
| 3 | Fix projections gap: `d30u - Math.floor(stock / CANS_PER_CASE)` | Gap calculation matches units |
| 4 | Remove `PORTAL_CANS_PER_CASE`, replace with `CANS_PER_CASE` | Single source of truth for pack size |
| 5 | Auto-create invoice on delivery confirmation | Stops uninvoiced deliveries accumulating |
| 6 | Add "cans" label to Receive Finished Packs qty input | Prevents user entering wrong units |

---

*Report generated by static code trace. No data was modified.*
