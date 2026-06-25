# POOL_SWEEP.md — Two-Pool Inventory Bug Sweep

**Date:** 2026-06-25
**Scope:** Pool commits (9e937ff through fe36509) — now live
**Method:** Code trace against all 12 creation paths, all reversal paths, all on-hand call sites

---

## Critical

### PS-1: poolTransfer allows overdraft — creates stock from nothing

**File:** `public/app.js` line 8253
**Repro:** Warehouse has 10 cans of Classic. User transfers 100 cans warehouse→farm. Warehouse on-hand floors to 0 (line 111: `Math.max(0, ...)`), farm shows +100. Net stock increased by 90 cans — 90 cans created from nothing.
**Root cause:** `poolTransfer()` does not validate that the source pool has sufficient stock before writing the paired iv entries.
**Proposed fix:** Before the `atomicUpdate`, check `_onHand(sku, fromPool) >= qty`. If insufficient, toast an error and abort.

### PS-2: Five stale on-hand computations bypass _onHand — give wrong per-pool numbers

All five compute stock the old way (manual filter/reduce on iv, no pool awareness). Today they return the GLOBAL total (all pools summed), which is numerically correct for "total stock" views. But they are fragile — any future change assuming these are pool-aware will silently produce wrong numbers.

| # | File:Line | Context | Actual behavior |
|---|---|---|---|
| a | `app.js:1349-1350` | Dashboard "Low Stock" KPI | Sums all pools — shows global total, not per-pool |
| b | `app.js:1383-1384` | Dashboard "Total Cans" KPI | Same — global total |
| c | `app.js:1713-1714` | Dashboard low-stock alert badge | Same — triggers on global stock, not per-pool |
| d | `app.js:2812-2813` | Demand forecast `stockFor()` | Same — forecasts from global stock |
| e | `app.js:8179-8181` | `_renderLocationsTable()` | Seeds "Warehouse" with global total, ignoring pool field entirely |

**Impact today:** Dashboard KPIs show total stock across both pools. If all stock is in warehouse (historical default), numbers match. Once farm has non-zero stock, the dashboard "Low Stock" alert fires based on global total — a SKU could be critically low at the farm but dashboard says "OK" because warehouse has plenty.
**Proposed fix:** Replace all five with `_onHand(sku, null)` for global totals, or `_onHand(sku, 'farm')` / `_onHand(sku, 'warehouse')` where per-pool is appropriate. Specifically, the low-stock alert (c) should probably check BOTH pools independently.

---

## High

### PS-3: _renderLocationsTable still callable — shows wrong numbers

**File:** `public/app.js` lines 8161-8181 (function), 8227/8235 (call sites)
**Repro:** If `addStockLocation()` or `deleteStockLocation()` is called, `_renderLocationsTable()` runs. It computes stock by scanning ALL iv records without pool filtering and assigns the entire global total to "Warehouse" (line 8181). With the pool model live, this double-counts farm stock as warehouse stock.
**Current exposure:** The "Add Location" and "Delete Location" UI was replaced in index.html with the pool transfer form, so users can't trigger these functions through the UI. But the functions still exist as dead code with active `_renderLocationsTable()` calls.
**Proposed fix:** Delete `_renderLocationsTable()`, `_populateXferSelects()`, `addStockLocation()`, `deleteStockLocation()`, and the old `transferStock()` functions. They're dead code that would give wrong numbers if ever called.

---

## Medium

### PS-4: No pool filtering on delivery stop un-toggle reversal

**File:** `public/app.js` lines 9002-9004 (un-toggle), 9170 (removeStop), 9205 (clearRoute)
**Behavior:** These reversal paths filter by `invoiceId` to remove iv 'out' entries. They do NOT filter by pool. This is CORRECT — `invoiceId` is unique, so the right records are removed regardless of pool. The pool field on the removed records is irrelevant since removal adjusts on-hand automatically.
**Verdict:** Safe. Noted for completeness — no fix needed.

### PS-5: deleteDistInvoice reversal may not match distributor shipment iv records

**File:** `public/app.js` line 7447
**Behavior:** `deleteDistInvoice()` filters by `e.invoiceId === invId`. Distributor shipment iv records use `ref: shipId`, not `invoiceId`. These are intentionally separate concepts (shipment = physical movement, invoice = billing record). The delete correctly removes only invoice-linked iv records, not shipment-linked ones.
**Verdict:** Not a bug — confirmed intentional separation. But if a distributor invoice ever gains its own iv deduction path (it currently doesn't), the pool on those records would need to be warehouse.

### PS-6: _invLocations() still renders pool-xfer-sku dropdown but ignores pool for the locations table

**File:** `public/app.js` line 8153
**Behavior:** `_invLocations()` was modified to populate the pool transfer SKU dropdown. It no longer calls `_renderLocationsTable()` or `_populateXferSelects()`. The old functions still exist but are only called from `addStockLocation()` and `deleteStockLocation()` (which are unreachable from the UI).
**Verdict:** Low risk — unreachable code. Flag for cleanup (see PS-3).

---

## Low

### PS-7: Pool transfer in-flight guard uses value-based key, not intent-based

**File:** `public/app.js` line 8247
**Behavior:** Guard key is `${sku}-${qty}-${dir}`. Two rapid transfers of different quantities for the same SKU in the same direction both go through. A true duplicate (same sku, same qty, same direction, same moment) is blocked. This is sufficient for accidental double-clicks.
**Proposed improvement:** Could add a 2-second global cooldown, but value-based key is pragmatically fine.

### PS-8: Historical records default to warehouse in _onHand but have no pool field for reversals

**File:** `public/app.js` line 108
**Behavior:** `_onHand` treats `i.pool || 'warehouse'` — records without pool field are counted as warehouse. When these records are deleted via reversal (e.g., `deleteInvoiceWithCleanup`), the removal correctly subtracts them from wherever they were being counted (warehouse). No inconsistency.
**Verdict:** Safe. Noted for completeness.

---

## Verification Summary

| Check | Status |
|---|---|
| 1. Conservation (transfer atomicity) | **PS-1: OVERDRAFT BUG** — no balance check before transfer |
| 2. Wrong-pool stamps | **ALL CORRECT** — every path stamps per approved table |
| 3. On-hand call sites | **PS-2: 5 STALE SITES** — bypass _onHand, give global totals |
| 4. Historical default | **CONSISTENT in _onHand** — `i.pool \|\| 'warehouse'` on line 108. Stale sites (PS-2) don't apply any default but sum all records, which equals global total. |
| 5. Reversals | **CORRECT** — all filter by unique ID, inherit pool automatically |
| 6. Negative/edge | **PS-1: TRANSFERS CAN OVERDRAFT** — _onHand floors at 0 but transfers don't pre-validate |
