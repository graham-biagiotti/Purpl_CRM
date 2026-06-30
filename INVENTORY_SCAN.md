# Inventory Subsystem Scan

_Full map of how cans move through the CRM. Two pools: **Warehouse** and
**Farm**. Stock is a ledger of `iv` entries `{sku, type, qty (cans), pool}`.
On-hand per pool = sum(in/return) − sum(out), clamped at 0 (`_onHand`, app.js:122)._

---

## 1. The workflow (how it actually works)

**Pool selection and the deduction are two separate moments — by design:**

1. **You pick the pool** when you create/confirm the order — the Warehouse/Farm
   "fulfillment" selector on the invoice form or portal-confirm modal.
2. **Cans come out** later, only when the invoice is **sent to the customer**,
   pulling from the pool you already picked. No re-asking at send.

Manual stock moves (receiving, repack, production, pallets, transfers, returns,
adjustments) are independent of invoices and each has its own pool control.

---

## 2. Every place cans are ADDED (`type: in` / `return`)

| Trigger | Function | Line | Pool | Who picks? |
|---|---|---|---|---|
| Receive finished packs | `receiveFinishedPacks` | 7996 | from `#recv-pack-pool` | **You** |
| Repack job output | `saveRepackJob` | 8075 | `warehouse` | hardcoded |
| Production run | `saveTodayRun` | 8843 | `warehouse` | hardcoded |
| Pool transfer (in side) | `poolTransfer` | 8399 | by direction | **You** |
| Return / damage credit | `saveReturn` | 8323 | from `#ret-pool` | **You** |

## 3. Every place cans are DEDUCTED (`type: out`)

### Invoice-driven (the "traditional workflow")
| Trigger | Function | Line | When | Pool | Guard |
|---|---|---|---|---|---|
| Mark retail draft **Sent** | `markInvoiceSent` | 15762 | **at send** ✅ | invoice's `fulfillmentSource` | `alreadyDeducted` (15747) |
| Create retail invoice as Sent | `_saveInvCore` | 16017 | at create-as-sent | invoice's `fulfillmentSource` | — |
| Send combined invoice | `sendCombinedInvoice` | 12968 | **at send** ✅ | invoice's `fulfillmentSource` (purpl child only) | `alreadyDeducted` (12960) |
| Create combined as Sent | `saveNewCombinedInvoice` | 12440 | at create-as-sent | modal `#nciv-fulfillment` (purpl only) | — |
| Confirm portal order | `confirmPortalOrder` | 14757 | **no deduction** — creates DRAFTs only | — | — |

> LF invoices never create `iv` deductions (LF stock lives on Wix). Combined
> invoices only deduct the **purpl** child.

### Manual / operational (not invoice-driven — left as-is)
| Trigger | Function | Line | Pool | Who picks? |
|---|---|---|---|---|
| Ship pallet | `shipPallet` | 8161 | `warehouse` | hardcoded |
| Distributor shipment | `saveDistShipment` | 7237 | `warehouse` | hardcoded |
| Manual adjust (− Use) | `invAdjust` | 8359 | from `#inv-adj-pool` | **You** |
| Pool transfer (out side) | `poolTransfer` | 8398 | by direction | **You** |
| Sample box shipped | `shipStationWebhook` (functions) | 1438 | `farm`, 3 cans, classic | hardcoded |

## 4. Every place deductions are REVERSED
| Trigger | Function | Line | Removes |
|---|---|---|---|
| Delete invoice | `deleteInvoiceWithCleanup` | 87 | all `out` where `invoiceId === id` |
| Void combined invoice | `sendCombinedInvoice` (void) | 13025 | all `out` for that invoice/combined |
| Delete pallet | `deletePallet` | 8174 | all `out` where `palletId === id` |
| Delete repack job | `deleteRepackJob` | 8087 | all `in` where `repackId === id` |
| Delete a log row | `delInvEntry` | 8366 | that single entry |

---

## 5. The 8 inventory tabs
| Tab | Render fn | Shows |
|---|---|---|
| Stock Summary | `_invSummary` (7905) | KPI cards + per-SKU on-hand by pool; +Add / −Use |
| Locations | `_invLocations` (8372) | Warehouse↔Farm transfer form |
| Receive | `_invReceive` (7955) | Loose cans + finished packs intake (pool dropdown) |
| Repack Jobs | `_invRepack` (8012) | Loose → finished pack jobs |
| Pallets | `_invPallets` (8094) | Pallet build + ship |
| Supplies | `_invSupplies` (8181) | Packaging supplies (not cans) |
| Log | `_invLog` (8237) | Last 60 ledger entries + delete |
| Returns | `_invReturns` (8261) | Return/damage form + history |

---

## 6. Issues found (ranked)

1. **Default pool was Farm, not Warehouse** — *FIXED this session.* Every finished
   can enters Warehouse, but invoice deductions defaulted to the empty Farm pool,
   so per-pool totals drifted from Total Stock (the 3,852 vs 3,840 you spotted).
   Defaults are now Warehouse; Farm stays a deliberate choice.

2. **"Push to Warehouse" is a stub** (`pushToWarehouse`, 15328) — only sets a label +
   timestamp; sends nothing to any warehouse/3PL. Parked pending intake method.

3. **`pushToWarehouse` doesn't re-tag the ledger** — flipping an already-sent invoice
   to "warehouse" changes the label but leaves the already-deducted cans in their
   original pool, so the invoice and ledger can disagree. (Low impact.)

4. **Per-pool clamp at 0 hides over-deduction** — `_onHand` returns `max(0, …)`, so
   deducting from a pool with insufficient stock silently vanishes instead of warning.
   This is what let the Farm mis-pool go unnoticed.

5. **Sample boxes are hardcoded** to farm / 3 cans / classic (functions/index.js:1438) —
   fine today, but no way to change without code.

---

## 7. Where pool gets chosen (the selectors)
| Dropdown | Form | Options |
|---|---|---|
| `#iv-fulfillment` | Single retail invoice | Warehouse / Farm |
| `#mcpo-fulfillment` | Portal order confirm | Warehouse / Farm |
| `#nciv-fulfillment` | New combined invoice | Warehouse / Farm |
| `#civ-edit-fulfillment` | Edit combined invoice | Warehouse / Farm |
| `#recv-pack-pool` | Receive finished packs | Warehouse / Farm |
| `#inv-adj-pool` | Stock Summary adjust | Warehouse / Farm |
| `#ret-pool` | Returns | Warehouse / Farm |
| `#pool-xfer-dir` | Locations transfer | direction |

_All default to Warehouse as of this session._
