# POOL_DESIGN.md — Two-Pool Inventory Model Proposal

**Date:** 2026-06-25
**Status:** PROPOSAL — awaiting approval before implementation
**Based on:** INVENTORY_INVOICING_MAP.md

---

## DECISION 1 — Pool Assignment Rule

### The Rule

Every iv record gets a `pool` field at write time. The value is one of: `'warehouse'` or `'farm'`.

### Pool Assignment Table (all 12 creation paths)

| # | Path | Pool | Signal | Reasoning |
|---|---|---|---|---|
| 1 | Distributor shipment | `warehouse` | Always — distributor orders ship from warehouse | Distributors are served via warehouse/3PL. The existing `stock_transfers` code at line 7003 already assumes `fromLocation: 'Warehouse'`. |
| 2 | Receive finished packs | **User selects** | New dropdown in Receive form: "Receiving at: Warehouse / Farm" | Finished packs could arrive at either location. Production might happen at farm but packs might ship from co-packer to warehouse. Can't assume. Default: `warehouse`. |
| 3 | Repack job output | `farm` | Always — repacking happens at the farm | Repack is a hands-on farm operation. If this changes, it can be overridden via manual adjustment. |
| 4 | Pallet shipment | `warehouse` | Always — pallets ship from warehouse | Pallets are a warehouse/fulfillment concept. |
| 5 | Manual adjustment | **User selects** | New dropdown in adjustment form: "Pool: Warehouse / Farm" | The whole point of manual adjustments is to correct either pool. Must be explicit. |
| 6 | Production run | `farm` | Always — production happens at the farm | Cans come off the production line at the farm. They later get transferred to warehouse. |
| 7 | Delivery invoice (route stop) | `farm` | Always — delivery routes are local hand-delivery from the farm | Graham loads the van at the farm and delivers. This is the defining characteristic of "farm pool." |
| 8 | Retail invoice save (non-draft) | `deliveryMethod` on the invoice | `'ship'` → `warehouse`; anything else → `farm` | Shipped orders are fulfilled from warehouse/3PL. Hand-delivered or picked-up orders come from farm stock. |
| 9 | Invoice mark sent (draft→sent) | Same as #8 | Read `deliveryMethod` from the invoice record | Same logic — the invoice already has `deliveryMethod` set before send. |
| 10 | Combined invoice create (non-draft) | Same as #8 | Read `deliveryMethod` from the combined invoice | Combined invoices can be shipped or delivered. |
| 11 | Combined invoice send (draft→sent) | Same as #8 | Read `deliveryMethod` from the combined invoice | Same. |
| 12 | Customer return | **User selects** | New dropdown in return form: "Return to: Warehouse / Farm" | Returns could go to either location. Default: `farm` (most returns happen locally). |

**Server-side path (ShipStation sample webhook):**

| Path | Pool | Signal |
|---|---|---|
| SAMPLE- webhook (3 cans deduction) | `warehouse` | Always — sample boxes ship from warehouse/3PL |

### Edge Cases

**Q: What if a retail invoice has no `deliveryMethod` set?**
Default to `farm`. Most invoices without an explicit method are hand-delivered. The user can correct via manual adjustment if wrong.

**Q: What about `fulfilledBy` on the account?**
`fulfilledBy` indicates who SELLS to the end customer (direct vs distributor), not where stock ships FROM. An account with `fulfilledBy: 'direct'` could still receive shipped orders (from warehouse) or hand-delivered orders (from farm). The `deliveryMethod` on the individual invoice is the correct signal, not the account-level field.

**Q: What about orders pushed to ShipStation but not yet shipped?**
The pool is assigned at inventory deduction time (invoice send), not at ShipStation push time. ShipStation push doesn't deduct inventory. If an invoice has `deliveryMethod: 'ship'`, the deduction at send time stamps `pool: 'warehouse'` regardless of whether it's been pushed to ShipStation yet.

---

## DECISION 2 — Storage Mechanism

### Recommendation: `pool` field on each iv record

Add a `pool` field (string: `'warehouse'` or `'farm'`) to every iv record at write time. Modify the on-hand calculation to filter by pool.

```javascript
// Current (lines 7692-7693)
const ins  = iv.filter(i => i.sku === skuId && (i.type === 'in' || i.type === 'return'))
               .reduce((t, i) => t + i.qty, 0);
const outs = iv.filter(i => i.sku === skuId && i.type === 'out')
               .reduce((t, i) => t + i.qty, 0);

// New — with pool filter
function _onHand(skuId, pool) {
  const f = i => i.sku === skuId && (!pool || i.pool === pool);
  const ins  = iv.filter(i => f(i) && (i.type === 'in' || i.type === 'return')).reduce((t, i) => t + i.qty, 0);
  const outs = iv.filter(i => f(i) && i.type === 'out').reduce((t, i) => t + i.qty, 0);
  return Math.max(0, ins - outs);
}

// Usage:
_onHand('classic', 'warehouse')  // warehouse stock
_onHand('classic', 'farm')       // farm stock
_onHand('classic', null)         // global total (backward-compatible)
```

### Backfilling existing records

Existing iv records have no `pool` field. Two options:

**Option A (recommended): Default missing pool to `'farm'`.**
The `_onHand` function treats `!i.pool` as matching any pool filter (for backward compatibility in `_onHand(sku, null)`). For pool-specific queries, treat records without `pool` as `'farm'` since historically all stock was managed from the farm.

```javascript
const effectivePool = i.pool || 'farm';
```

No Firestore migration needed. New records get stamped; old records default to farm.

**Option B: Backfill migration.** Write a one-time migration that stamps `pool: 'farm'` on every existing iv record. Cleaner data but ~N Firestore writes (could be hundreds/thousands depending on history).

**Recommendation:** Option A — no migration, default to farm. Simpler, no risk of corrupting existing data. The on-hand function handles both stamped and unstamped records.

---

## DECISION 3 — stock_locations / stock_transfers

### Current System

- `stock_locations`: named locations (default "Warehouse", user can add more)
- `stock_transfers`: records that move CASES between locations
- `_renderLocationsTable()` (line 8145): seeds "Warehouse" with global iv totals, then applies transfers to compute per-location stock

The current system is a **computed overlay** — it doesn't change the iv ledger, it redistributes the global total across named locations using transfer records.

### Recommendation: REPLACE with the pool model

**Reasoning:**
1. The current system is fundamentally incompatible with pools. It assumes all stock starts in "Warehouse" and gets redistributed — but in the two-pool model, stock enters at different pools from the start.
2. Having both pools (on iv records) AND locations (computed from transfers) creates two competing answers to "where is my stock?"
3. The current `stock_transfers` collection stores quantities in CASES, while iv stores in CANS — a unit mismatch that adds conversion complexity.
4. The "Warehouse" location in the current system is conceptually the same as the `warehouse` pool.

**What happens to existing transfer data:**
- `stock_transfers` records become obsolete — they were redistributing a single global pool, which no longer exists
- `stock_locations` records (just "Warehouse" and any user-added locations) become obsolete
- Both collections can be left in place (ignored) or cleaned up in a future pass
- No data loss — the iv ledger (the source of truth) is unchanged

**What replaces them:**
- The `pool` field on iv records provides the primary split (warehouse vs farm)
- Warehouse→farm transfers become paired iv entries (see Decision 4)
- The inventory UI shows two columns (Warehouse / Farm) instead of a locations table
- If the user needs more granular locations within a pool (e.g., multiple warehouse zones), that can be layered on later — but it's not needed now

### Tradeoff

| | Replace | Coexist |
|---|---|---|
| Complexity | Lower — one system, one truth | Higher — two overlapping systems |
| Migration | Ignore old collections, no breakage | Keep old code + add new pool logic |
| User confusion | None — clean model | "Which location view do I trust?" |
| Future flexibility | Add sub-locations later if needed | Already have locations but they fight with pools |

**Recommendation: Replace.** The current location system has minimal data (likely just the default "Warehouse" and a few transfers). The pool model supersedes it cleanly.

---

## DECISION 4 — Warehouse→Farm Transfers

### Mechanism: Paired iv entries

A transfer of N cans of SKU X from warehouse to farm creates TWO iv records atomically:

```javascript
DB.atomicUpdate(cache => {
  const xferId = uid();
  cache.iv = [...(cache.iv || []),
    { id: uid(), date: today(), sku, type: 'out', qty, pool: 'warehouse',
      note: `Transfer to farm`, transferId: xferId },
    { id: uid(), date: today(), sku, type: 'in',  qty, pool: 'farm',
      note: `Transfer from warehouse`, transferId: xferId },
  ];
});
```

**Why paired iv entries instead of a separate `pool_transfers` collection:**
1. The iv ledger is already the single source of truth — transfers that live inside it are automatically reflected in on-hand calculations with no special handling
2. No new collection to manage
3. Reversals work naturally — delete both records by `transferId`
4. The `transferId` field links the pair for audit/display purposes

**Idempotency:** The `atomicUpdate` ensures both records are written together. To prevent double-clicks, add a transfer-in-flight guard (same pattern as `_markSentInFlight`):

```javascript
const _transferInFlight = new Set();
function transferBetweenPools(sku, qty, fromPool, toPool) {
  const key = `${sku}-${qty}-${fromPool}`;
  if (_transferInFlight.has(key)) return;
  _transferInFlight.add(key);
  // ... atomicUpdate ...
  _transferInFlight.delete(key);
}
```

**UI:** Replace the current transfer form (from/to location dropdowns) with a simpler "Move to Farm" / "Move to Warehouse" form with SKU and quantity inputs.

---

## Anomaly Confirmation: deleteDistInvoice vs shipment iv records

**Confirmed: NOT a bug.** Distributor shipments and distributor invoices are separate concepts:

- `saveDistShipment()` (line 6948) creates iv records with `source: 'dist_shipment'` and `ref: shipId` — these deduct inventory when product physically ships to the distributor
- `saveDistInvoice()` (line 7371) creates a `dist_invoices` record for billing — it does NOT deduct inventory
- `deleteDistInvoice()` (line 7434) filters by `invoiceId` — this correctly doesn't touch shipment iv records because shipments and invoices are independent

The only scenario where this matters: if someone creates a dist invoice AND a shipment for the same distributor, deleting the invoice doesn't reverse the shipment's inventory deduction. That's correct — the physical shipment happened regardless of the billing record.

For the two-pool model: distributor shipment iv records (path #1) get stamped `pool: 'warehouse'`. Distributor invoices don't touch iv at all, so no pool logic needed there.

---

## Summary: Implementation Scope

| Area | Effort | Details |
|---|---|---|
| Add `pool` field to 12 creation paths | Medium | Each path needs pool assignment per the table in Decision 1. Paths 2, 5, 12 need new form dropdowns. |
| Modify on-hand calculation | Low | One function change, but called from multiple UI render sites |
| Replace stock_locations UI with pool view | Medium | New inventory summary showing warehouse/farm columns per SKU |
| Add transfer-between-pools form | Low | Simple form + paired iv entry via atomicUpdate |
| Server-side: sample webhook pool stamp | Low | One line change in functions/index.js |
| Backfill: no migration needed | None | Old records default to 'farm' |
| Remove stock_locations/transfers UI | Low | Delete render code, keep collections dormant |

**Total: ~12 code paths to modify, 1 new function, 1 UI replacement. No Firestore migration.**
