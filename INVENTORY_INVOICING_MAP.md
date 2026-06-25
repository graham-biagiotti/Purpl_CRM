

# INVENTORY_INVOICING_MAP.md — Purpl CRM

**Date:** 2026-06-25
**Purpose:** Complete read-only map of how inventory and invoicing work in Purpl CRM today. Intended as the reference document for implementing a two-pool (warehouse/farm) inventory model.

---

## Part 1: INVENTORY

### 1.1 Data Model

All inventory transactions live in a single Firestore collection: **`iv`**. Every stock change -- in, out, return, or reversal -- is a record in this collection. There is no denormalized "current stock" field anywhere in the system.

#### iv Record Schema (all possible fields)

| Field | Type | Presence | Description |
|---|---|---|---|
| `id` | string | Always | `uid()`, also the Firestore document ID |
| `date` | string | Always | `YYYY-MM-DD` format |
| `sku` | string | Always | One of: `'classic'`, `'blueberry'`, `'peach'`, `'variety'`, `'raspberry'` |
| `type` | string | Always | `'in'`, `'out'`, or `'return'` (no `'adjust'` type exists) |
| `qty` | number | Always | Always in **CANS** (integer) |
| `note` | string | Always | Human-readable description |
| `_updatedAt` | string | Auto-set | ISO 8601, set by `DB._stamp()` on push/update |
| `invoiceId` | string | Optional | Links to retail/combined/dist invoice |
| `prodId` | string | Optional | Links to production run (`prod_hist`) |
| `repackId` | string | Optional | Links to repack job (`repack_jobs`) |
| `palletId` | string | Optional | Links to pallet record |
| `ordId` | string | Optional | Links to order record (legacy, no current creation path sets this) |
| `source` | string | Optional | Provenance marker, e.g. `'dist_shipment'` |
| `ref` | string | Optional | Shipment reference ID |
| `accountId` | string | Optional | Links to account (used in deletion filter) |
| `number` | string | Optional | Invoice number (legacy dual-purpose records) |
| `invoiceNumber` | string | Optional | Alternate invoice number field (legacy) |
| `status` | string | Optional | `'paid'` etc. (legacy invoices + paid marking) |
| `paidDate` | string | Optional | Set by `markInvoicePaid` fallback |
| `paidAt` | string | Optional | Set by `markInvoicePaid` fallback |
| `combinedInvoiceId` | string | Optional | Set by `createCombinedInvoice` legacy linking |

### 1.2 Stock-on-Hand Calculation

**Running sum, computed on every read.** There is no stored or cached on-hand value. The formula (e.g., lines 7692-7693 of `app.js`):

```javascript
const ins  = iv.filter(i => i.sku === skuId && (i.type === 'in' || i.type === 'return'))
               .reduce((t, i) => t + i.qty, 0);
const outs = iv.filter(i => i.sku === skuId && i.type === 'out')
               .reduce((t, i) => t + i.qty, 0);
const onHand = Math.max(0, ins - outs);
```

This is a pure event-sourcing / ledger pattern. Every read scans the entire `iv` collection filtered by SKU, sums ins (including returns) minus outs, and floors at zero.

### 1.3 Unit Consistency

- **Storage:** ALL `iv` records store quantity in **CANS** (the `qty` field is always in cans).
- **Conversion:** All paths originating from case-based inputs multiply by `CANS_PER_CASE` (12) before writing to `iv`. Conversion points: lines 6994, 7933, 9048, 12178, 12665, 15335, 15579.
- **Direct cans input:** Paths already dealing in cans (manual adjustments, returns, production runs, finished pack receipts, repack jobs) store the value directly.
- **No inconsistency found.** There is no path that accidentally stores cases instead of cans, or double-converts.

### 1.4 Location Model

Location tracking is layered ON TOP of the `iv` collection, not embedded within it. The `iv` records themselves have **no location field**.

| Component | Description |
|---|---|
| `stock_locations` collection | Named locations (default: `"Warehouse"`). Created via `addStockLocation()` at line 8202. |
| `stock_transfers` collection | Records transfers between locations via `saveStockTransfer()` at line 8224. |
| `_renderLocationsTable()` (line 8145) | Seeds the `"Warehouse"` location with global iv on-hand totals, then applies transfers from `stock_transfers` to compute per-location stock. This is a **computed view**, not stored per-location balances. |
| Settings: `warehouseRadiusMiles`, `warehouseLat`, `warehouseLng` (lines 10521-10523) | Used only for map pin display (line 13458), not for inventory logic. |

All inventory enters/exits through a single global pool (the `iv` collection). Locations are a secondary distribution layer.

### 1.5 Every Stock-Changing Path

#### 1.5.1 CREATION paths (add or remove stock)

| # | Path | Trigger | Direction | Function / Line | Input Unit | Stored Unit | SKU Source | Idempotency Guard |
|---|---|---|---|---|---|---|---|---|
| 1 | Distributor shipment | User creates shipment to distributor | OUT | Distributor shipment handler, line 6990 | CASES | CANS (`item.cases * CANS_PER_CASE`) | Per-SKU from shipment line items (`item.sku`) | **None** |
| 2 | Receive finished packs | User receives packs via Inventory > Receive tab | IN | `receiveFinishedPacks()`, line 7772 | CANS | CANS | Specific SKU from form | **None** |
| 3 | Repack job output | User saves a repack job via Inventory > Repack tab | IN | `saveRepackJob()`, line 7847 | CANS | CANS | Specific SKU from repack form | **None** |
| 4 | Pallet shipment | User marks pallet as shipped via Inventory > Pallets tab | OUT | `shipPallet()`, line 7933 | CASES | CANS (`cases * CANS_PER_CASE`) | Per-SKU from `p.contents` array | **None** |
| 5 | Manual adjustment | User clicks "+ Add" or "- Use" on Inventory > Summary tab | IN or OUT | `invAdjust(sku, type)`, line 8122 | CANS | CANS | Specific SKU from button's `onclick` | **None** |
| 6 | Production run | User saves production run via Production tab | IN | `saveTodayRun()`, line 8647 | CANS | CANS | Per-SKU from production schedule inputs | **None** |
| 7 | Delivery invoice creation | User toggles delivery stop as delivered | OUT | `createDeliveryInvoice()`, line 9047 (inside `DB.atomicUpdate`) | CASES | CANS (`li.cases * CANS_PER_CASE`) | Per-SKU from invoice line items | Atomic with invoice creation |
| 8 | Retail invoice save (non-draft) | User creates new retail invoice with status != 'draft' | OUT | `saveInvoice()` / `_saveInvCore()`, line 15579 | CASES | CANS (`li.cases * CANS_PER_CASE`) | Per-SKU from invoice line items | Draft check only (no dedup) |
| 9 | Invoice mark sent (draft to sent) | User marks draft retail invoice as sent | OUT | `markInvoiceSent(id)`, line 15335 | CASES | CANS (`cases * CANS_PER_CASE`) | Per-SKU from invoice line items | **YES** -- `alreadyDeducted` check at line 15328; `_markSentInFlight` Set at line 15321 |
| 10 | Combined invoice creation (non-draft) | User creates combined invoice with status != 'draft' | OUT | Lines 12176-12181 (inside `DB.atomicUpdate`) | CASES | CANS (`(li.cases) * CANS_PER_CASE`) | Per-SKU from purpl line items only | Draft check only (no dedup) |
| 11 | Combined invoice send (draft to sent) | User sends draft combined invoice via Gmail | OUT | Lines 12657-12665 (inside `DB.atomicUpdate`) | CASES | CANS | Per-SKU from purpl line items only | **YES** -- `alreadyDeducted` check inside `DB.atomicUpdate` (race-safe) |
| 12 | Customer return | User logs return via Inventory > Returns tab | RETURN (treated as IN for balance) | `saveReturn()`, lines 8088-8096 (inside `DB.atomicUpdate`) | CANS | CANS | Specific SKU from form | **None** |

**Of the 12 creation paths, only 2 have idempotency guards (paths 9 and 11). The remaining 10 have no protection against double-execution.**

#### 1.5.2 iv Record Fields Written by Each Creation Path

| # | Path | Fields Written |
|---|---|---|
| 1 | Distributor shipment | `{id, sku, type:'out', qty, date, source:'dist_shipment', ref:shipId, note}` |
| 2 | Receive finished packs | `{id, date, sku, type:'in', qty, note}` |
| 3 | Repack job output | `{id, date, sku, type:'in', qty, repackId, note}` |
| 4 | Pallet shipment | `{id, date, sku, type:'out', qty, palletId, note}` |
| 5 | Manual adjustment | `{id, date, sku, type, qty, note}` |
| 6 | Production run | `{id, date, sku, type:'in', qty, note:'Production run', prodId}` |
| 7 | Delivery invoice creation | `{id, date, sku, type:'out', qty, note, invoiceId}` |
| 8 | Retail invoice save (non-draft) | `{id, date, sku, type:'out', qty, note, invoiceId}` |
| 9 | Invoice mark sent | `{id, date, sku, type:'out', qty, note, invoiceId}` |
| 10 | Combined invoice creation (non-draft) | `{id, date, sku, type:'out', qty, note, invoiceId}` |
| 11 | Combined invoice send | `{id, date, sku, type:'out', qty, note, invoiceId}` |
| 12 | Customer return | `{id, date, sku, type:'return', qty, note}` |

#### 1.5.3 REVERSAL paths (delete / un-do stock changes)

| # | Path | Trigger | Function / Line | Mechanism | Filter Criteria |
|---|---|---|---|---|---|
| 13 | Delete invoice cleanup | User deletes a retail invoice | `deleteInvoiceWithCleanup(id)`, line 92 | Filters out iv records | `e.invoiceId === id && e.type === 'out'` |
| 14 | Delete account | User deletes an account from CRM | `deleteAccount(id)`, line 5219 | Removes iv records | `r.accountId === id` |
| 15 | Delete distributor invoice | User deletes a dist invoice | `deleteDistInvoice(invId)`, line 7434 | Filters out iv records | `e.invoiceId === invId && e.type === 'out'` |
| 16 | Delete repack job | User deletes a repack job | `deleteRepackJob(id)`, line 7859 | Filters out iv records | `e.repackId === id` |
| 17 | Delete pallet | User deletes a pallet | `deletePallet(palletId)`, line 7946 | Filters out iv records | `e.palletId === palletId` |
| 18 | Un-toggle delivery stop | User un-toggles a delivered stop | `toggleStop()` un-toggle branch, line 8971 | Removes orphaned records | iv 'out' entries whose `invoiceId` has no matching `retail_invoices` record |
| 19 | Remove stop from route | User removes a stop from a delivery route | `removeStop(i)`, line 9134 | Filters out iv records | iv 'out' entries whose `invoiceId` is in the set of deleted invoice IDs |
| 20 | Clear entire route | User clears all stops from a route | `clearRoute()`, line 9169 | Filters out iv records | All iv 'out' entries for the route's invoices |
| 21 | Delete order | User deletes an order | Order delete handler, line 8476 | Removes iv records | `e.ordId === id` |
| 22 | Delete production history | User deletes a production run entry | `delProdHist(id)`, line 8671 | Removes iv records | `e.prodId === id` (with legacy fallback: date+qty+note) |
| 23 | Delete finished pack receipt | User deletes a finished pack receipt | `delLooseCan(id, form)`, line 7782 | Removes single iv record | By record `id` |
| 24 | Delete single inventory log entry | User clicks delete on Inventory > Log tab entry | `delInvEntry(id)`, line 8129 | Removes single iv record | By record `id` |
| 25 | Delete combined invoice | User deletes a combined invoice | `deleteCombinedInvoice()`, line 11826 | Filters out iv records | `x.id === rec.purplInvoiceId` OR `(x.type === 'out' && invoiceId matches)` |
| 26 | Void combined invoice | User voids a combined invoice | Line 12722 | Filters out iv records | `invoiceId === rec.purplInvoiceId \|\| invoiceId === combinedId`, type `'out'` only. Checks existence first (line 12707). |

All reversal paths are safe to repeat (idempotent).

#### 1.5.4 MODIFICATION paths (change metadata, not quantities)

| # | Path | Trigger | Function / Line | Fields Written |
|---|---|---|---|---|
| 27 | Combined invoice legacy linking | Creating combined invoice that links to legacy purpl invoice in iv | `createCombinedInvoice()`, lines 11782-11783 | Sets `combinedInvoiceId` on existing iv record matching `purplInvId` |
| 28 | Mark combined paid (legacy fallback) | Marking combined invoice as paid | `markCombinedPaid()`, lines 11802-11803 | Sets `status:'paid'` on iv record matching `purplInvId` |
| 29 | Mark invoice paid (legacy fallback) | Marking retail invoice as paid, fallback to iv | `markInvoicePaid()`, line 14778 | Sets `status:'paid'`, `paidDate`, `paidAt` on single iv record |

All modification paths are idempotent (overwrite same fields).

---

## Part 2: INVOICING

### 2.1 Invoice Types

Purpl CRM has four active invoice types and one legacy type:

| Type | Collection | Description |
|---|---|---|
| **Retail (Purpl)** | `retail_invoices` | Standard invoices for direct retail accounts selling Purpl products |
| **Delivery Run** | `retail_invoices` (same collection) | Created automatically when delivery stops are toggled; structurally identical to retail invoices but created via `createDeliveryInvoice()` |
| **Combined** | `combined_invoices` | Bundles a Purpl child invoice + LF child invoice into one invoice for accounts that carry both brands |
| **Distributor** | `dist_invoices` | Invoices for distributor accounts |
| **LF (Lavender Fields)** | `lf_invoices` | Invoices for the Lavender Fields brand; uses `lf_wix_deductions` instead of `iv` for inventory |
| **Legacy (iv-based)** | `iv` collection directly | Some old invoices exist as records in the `iv` collection itself, with `number`, `status`, and other invoice fields. Referenced by `markInvoicePaid` fallback (line 14778) and `createCombinedInvoice` legacy linking (lines 11782-11783). |

### 2.2 Which Invoice Actions Touch Inventory

#### Retail (Purpl) Invoices

| Action | Touches iv? | Details |
|---|---|---|
| **Create** | YES, if status != `'draft'` | `_saveInvCore()` at lines 15572-15582 pushes `type:'out'` iv records. Draft invoices defer deduction. |
| **Send** (draft to sent) | YES | `markInvoiceSent()` at lines 15320-15342. Only if invoice was `'draft'` AND `alreadyDeducted` check (line 15330) finds no existing iv 'out' records for that `invoiceId`. |
| **Mark Paid** | NO | `markInvoicePaid()` at line 14778 only updates status fields. |
| **Delete** | YES (reversal) | `deleteInvoiceWithCleanup()` at line 92 filters out all iv records where `e.invoiceId === id && e.type === 'out'`. |

#### Delivery Run Invoices

| Action | Touches iv? | Details |
|---|---|---|
| **Create** | YES, always | Lines 9043-9056 atomically push invoice and iv 'out' entries together. Never created as draft. |
| **Send** | N/A | Not draft, already deducted at creation. |
| **Mark Paid** | NO | |
| **Delete** | YES (reversal) | Via `removeStop()` (line 9134) and `clearRoute()` (line 9169). |

#### Combined Invoices

| Action | Touches iv? | Details |
|---|---|---|
| **Create** | YES for purpl child only, if status != `'draft'` | `saveNewCombinedInvoice()` at lines 12172-12183. Uses `purplLines` only, with `invoiceId: purplId`. LF portion is never deducted from iv. |
| **Send** (draft to sent) | YES | Lines 12657-12665 deduct inside `DB.atomicUpdate`, but only if `wasDraft` is true and `alreadyDeducted` is false (race-safe). Deducts from purpl child's `lineItems` only. |
| **Mark Paid** | NO | `markCombinedPaid()` at lines 11791-11810 only updates status. |
| **Delete** | YES (reversal) | `deleteCombinedInvoice()` at lines 11826-11829 filters out iv for both `rec.purplInvoiceId` and `combinedId`. |
| **Void** | YES (reversal) | Lines 12701-12735 filter out iv 'out' entries for both `rec.purplInvoiceId` and `combinedId`. Checks existence first (line 12707). |

#### Distributor Invoices

| Action | Touches iv? | Details |
|---|---|---|
| **Create** | NO | `saveDistInvoice()` at lines 7371-7415 only pushes/updates the `dist_invoices` record. |
| **Send** | NO | No dedicated send flow that touches iv. |
| **Mark Paid** | NO | |
| **Delete** | YES (reversal) | `deleteDistInvoice()` at line 7434 filters out iv records where `e.invoiceId === invId && e.type === 'out'`. **NOTE:** Distributor shipment iv records are tagged with `source: 'dist_shipment'` and `ref: shipId` (not `invoiceId: invId`), so this delete may not match shipment-created records. This is either intentional (shipments and invoices are independent) or a latent bug. |

#### LF Invoices

| Action | Touches iv? | Details |
|---|---|---|
| **Create** | NO (uses `lf_wix_deductions` instead) | `_saveLfInvoiceCore()` at lines 11715-11730 creates records in the `lf_wix_deductions` collection. |
| **Send** | NO | Lines 11432-11434 only update status to `'sent'`. |
| **Mark Paid** | NO | |
| **Delete** | NO iv records touched | `deleteInvoiceWithCleanup()` line 93 cleans up `lf_wix_deductions` only. |

### 2.3 The Order-to-Invoice-to-Deduction Chain

The chain is: **order -> invoice -> inventory deduction**. There is NO direct order-to-inventory deduction path.

Line 8922 contains an explicit comment: `// Inventory deduction now happens at invoice creation, not delivery`.

**Delivery route flow:**

1. `toggleStop()` (line 8914) creates an order record.
2. Calls `offerDeliveryInvoice()` which calls `createDeliveryInvoice()` (line 9014).
3. `createDeliveryInvoice()` at lines 9043-9056 atomically creates the retail invoice AND pushes iv 'out' entries, tagged with `invoiceId: invoice.id`.
4. The iv records link back to the **invoice**, not the order. Link chain: order (has `invoiceStatus:'invoiced'`, `invoiceNumber`) -> invoice (has `orderId: ordId`) -> iv records (have `invoiceId: invoice.id`).

**Portal order flow:**

1. `confirmPortalOrder()` (lines 14379-14641) creates all invoices as `status: 'draft'` (lines 14530, 14556).
2. NO inventory deduction at creation.
3. Deduction happens later when the invoice is sent via `markInvoiceSent()` or the combined send flow.

**Legacy anomaly:** iv records CAN have an `ordId` field (line 8476 shows `DB.a('iv').filter(e=>e.ordId===id)` during order deletion), but no current creation path sets `ordId` on invoice-triggered iv records. This appears to be a legacy path that is no longer active.

### 2.4 Double-Deduction Prevention

There is no double-deduction risk in the current code:

1. Line 8922: `// Inventory deduction now happens at invoice creation, not delivery`. Orders do NOT deduct directly.
2. `markInvoiceSent()` at line 15330 checks `alreadyDeducted = DB.a('iv').some(x => x.invoiceId === id && x.type === 'out')`.
3. Combined send flow at line 12660 performs the same check INSIDE the atomic block (race-safe).
4. `_markSentInFlight` Set (line 15321) prevents concurrent calls to `markInvoiceSent()` for the same invoice id.
5. If `_saveInvCore()` is called with non-draft status (deducts at creation) and the same invoice later passes through `markInvoiceSent()`, the `alreadyDeducted` check catches it.

### 2.5 Combined Invoice Specifics

When the combined send flow runs (line ~12649):

- It deducts from the **purpl child invoice's** line items only.
- Finds the purpl child via `rec.purplInvoiceId`.
- Reads `purplInv.lineItems` from `cache.retail_invoices`.
- Each line item with `cases > 0` gets an iv 'out' entry with `invoiceId: rec.purplInvoiceId`.
- The LF child (lines 12668-12671) only gets its status updated to `'sent'`; no iv writes.

### 2.6 LF Inventory Handling

LF invoices do NOT deduct from the `iv` collection. LF inventory is tracked completely separately via the `lf_wix_deductions` collection. These records track what needs to be pulled from Wix (the external platform where LF inventory is managed).

When a combined invoice is created or sent, only the purpl portion generates iv 'out' records. The LF portion is explicitly skipped:
- `saveNewCombinedInvoice()` line 12172: only processes `purplLines`.
- Combined send flow line 12658: only processes `rec.purplInvoiceId`.
- LF send flow lines 11432-11434: only updates status.

---

## Part 3: PUSH-TO-FULFILLMENT (ShipStation)

### 3.1 Push Flow: Button Click to ShipStation Order

**Client side (`pushInvoiceToShipStation`, lines 491-557 of `app.js`):**

1. Resolves the invoice from the correct collection (`retail_invoices`, `lf_invoices`, or `combined_invoices`).
2. **Guard:** If `inv.shipStationOrderId` already exists, aborts with "Already pushed to ShipStation".
3. **Guard:** If the linked account has no address, aborts.
4. Parses shipping address via `_parseAddress(ac.shipAddress || ac.address)`.
5. Reads `shipstation_settings` from localStorage for `storeId`.
6. Builds `items` array from `inv.lineItems`, handling variant lines (sku concatenated as `skuId-variantId`, quantity from `vl.units || vl.cases || 1`).
7. Calls Firebase Cloud Function `pushToShipStation`.

**Server side (`pushToShipStation`, lines 1095-1171 of `functions/index.js`):**

1. Validates auth, invoiceNumber, shipTo, items.
2. Reads `SHIPSTATION_API_KEY` secret, constructs Basic auth header.
3. Builds payload: `orderNumber` = invoiceNumber, `orderStatus` = `'awaiting_shipment'`, `orderDate` = now, `shipTo`, `items`, `customField1` = invoiceNumber, `customField2` = accountName, `customField3` = brand. Optional `advancedOptions.storeId`.
4. POSTs to `https://ssapi.shipstation.com/orders/createorder`.
5. Returns `{ok: true, orderId: body.orderId, orderNumber: body.orderNumber}`.

**Client side (success callback):**

1. Updates invoice record: `deliveryMethod: 'ship'`, `shipStationOrderId: d.orderId`, `shipStationPushedAt: new Date().toISOString()`.
2. Writes audit log entry.
3. Toasts success.

### 3.2 Auto-Push Triggers

No manual button click needed for these paths:

| Invoice Type | Line | Condition |
|---|---|---|
| Retail invoice save | Line 2406 | `deliveryMethod === 'ship' && !shipStationOrderId` |
| LF invoice save | Line 11413 | Same pattern |
| Combined invoice save | Line 12636 | Same pattern |

### 3.3 Data Sent to ShipStation

| Field | Value |
|---|---|
| `orderNumber` | Invoice number (`inv.number \|\| inv.invoiceNumber`) |
| `orderStatus` | Always `'awaiting_shipment'` |
| `shipTo` | `{ name, street1, street2, city, state, postalCode, country, phone }` |
| `items` | Array of `{ sku, name, quantity, unitPrice }` |
| `customField1` | Invoice number (for webhook matching) |
| `customField2` | Account name |
| `customField3` | Brand (`'purpl'`, `'Lavender Fields'`, or `'purpl + LF'`) |
| `advancedOptions.storeId` | Optional, from settings |
| `customerEmail` | From account |
| `notes` | From invoice |

For sample boxes: sku = `'classic-sample'`, name = `'Sample Box -- Classic Lavender Lemonade'`, quantity = 3, unitPrice = 0. Order number is `'SAMPLE-' + sanitizedAccountName + '-' + timestamp`.

### 3.4 Double-Push Prevention

The `shipStationOrderId` field is the sole mechanism. Checked in five places:

| Location | Line | Mechanism |
|---|---|---|
| `pushInvoiceToShipStation` | Line 498 | Explicit guard with toast |
| Retail auto-push | Line 2406 | `&& !rec.shipStationOrderId` condition |
| LF auto-push | Line 11413 | `&& !inv.shipStationOrderId` condition |
| Combined auto-push | Line 12636 | `&& !rec.shipStationOrderId` condition |
| UI Ship button | Line 14909 | Only renders if `!r.inv.shipStationOrderId` |

There is no server-side guard, but ShipStation's `createorder` endpoint is upsert-by-orderNumber, so a double-push would update rather than duplicate.

### 3.5 ShipStation Webhook (Shipment Confirmation)

The webhook (`shipStationWebhook`, lines 1205-1462 of `functions/index.js`) receives a POST from ShipStation with a `resource_url`. Flow:

1. Validates `secret` query param (last 8 chars of API key) and that `resource_url` starts with `https://ssapi.shipstation.com/`.
2. Fetches `resource_url` with auth; returns shipment data including `orderNumber`, `trackingNumber`, `carrierCode`, `shipmentCost`, `shipDate`.
3. Groups shipments by `orderNumber`.

**For `SAMPLE-` orders:**
- Finds matching account/sample by scanning all accounts for `sampleOrderNumber`.
- Updates sample record: `trackingNumber`, `carrier`, `shippedAt`, `status: 'shipped'`.
- **Deducts 3 cans of `'classic'` from inventory** (lines 1289-1298).
- Sends confirmation email via Resend.

**For regular invoice orders:**
- Searches across `retail_invoices`, `lf_invoices`, `combined_invoices` matching `number == orderNumber`.
- Removes existing `__shipping__` line item (idempotent).
- Adds new `__shipping__` line item with real shipping cost.
- Recalculates invoice total and `dueDate`.
- Sets: `trackingNumber`, `carrier`, `shippedAt`, `deliveryMethod: 'ship'`, `readyToSend: true`.
- Writes audit log.
- **Does NOT deduct inventory.** Regular invoice inventory deduction happens client-side at save/send time.

### 3.6 The `readyToSend` Flag

A UI notification mechanism bridging the server-side webhook and client-side user action:

1. ShipStation webhook sets `readyToSend: true` on the invoice after shipment confirmation (line 1426).
2. On next Firestore snapshot refresh, `_checkShippedInvoices()` (line 564) scans all three invoice collections for `readyToSend: true`.
3. `_showShippedBanner()` (line 577) displays a fixed-position green "Shipped!" banner with a link to the invoice.
4. When the user opens and sends/reviews the invoice, `_clearReadyToSend()` (line 610) deletes the flag.

### 3.7 Existing Fulfillment-Method Flags

**`fulfilledBy` field on accounts (line 5195):**

| Value | Meaning | Pricing Impact |
|---|---|---|
| `'direct'` (default) | Purpl self-delivers or ships via ShipStation | Uses `pricePerCaseDirect` |
| Distributor ID (from `dist_profiles`) | Account served through that distributor | Uses `pricePerCaseDist` |

On distributor deletion, linked accounts reset to `'direct'` (line 7141).

**`deliveryMethod` field on invoices:**

Set to `'ship'` when pushed to ShipStation. Indicates the delivery mechanism but NOT the inventory source.

There is NO separate field distinguishing "fulfilled from warehouse/3PL" vs "fulfilled from farm."

---

## Part 4: RISK MAP — Paths Requiring Pool Awareness for Two-Pool Model

Every path below currently touches a single undifferentiated `iv` ledger. For a two-pool model (warehouse vs farm), each would need to know which pool to deduct from or credit to.

### 4.1 Pool Routing Signals Already Available

The system already has signals that could determine pool assignment:

| Signal | Interpretation |
|---|---|
| `deliveryMethod === 'ship'` (goes through ShipStation) | Warehouse / 3PL pool |
| `deliveryMethod !== 'ship'` AND `fulfilledBy === 'direct'` | Farm pool (hand-delivered) |
| `fulfilledBy !== 'direct'` (distributor) | Warehouse pool (shipped to distributor) |

### 4.2 Paths Grouped by Complexity

#### GROUP A: Paths where pool is unambiguous (low complexity)

These paths have a clear, deterministic pool assignment based on existing data.

| # | Path | Line(s) | Current Behavior | Pool Signal |
|---|---|---|---|---|
| 7 | Delivery invoice creation | 9047 | Deducts from global iv | Always farm pool (delivery routes are local hand-delivery) |
| 1 | Distributor shipment | 6990 | Creates iv 'out' with `source:'dist_shipment'` | Always warehouse pool (shipped to distributor). Already uses `stock_transfers` with `fromLocation: 'warehouse'`. |
| 6 | Production run | 8647 | Creates iv 'in' | Pool depends on where production output is stored; needs explicit assignment (likely farm initially, then transferred) |
| 2 | Receive finished packs | 7772 | Creates iv 'in' | Needs explicit pool selection in form |
| 3 | Repack job output | 7847 | Creates iv 'in' | Needs explicit pool selection in form |

#### GROUP B: Paths where pool depends on invoice/account context (medium complexity)

These paths need to look up account or invoice metadata to determine pool.

| # | Path | Line(s) | Current Behavior | Pool Determination |
|---|---|---|---|---|
| 8 | Retail invoice save (non-draft) | 15579 | Deducts from global iv | Check `deliveryMethod` on invoice: `'ship'` = warehouse, else farm |
| 9 | Invoice mark sent | 15335 | Deducts from global iv | Same as above |
| 10 | Combined invoice creation (non-draft) | 12176-12181 | Deducts purpl portion from global iv | Check `deliveryMethod` on the combined invoice record |
| 11 | Combined invoice send | 12657-12665 | Deducts purpl portion from global iv | Same as above |
| 4 | Pallet shipment | 7933 | Deducts from global iv | Pallets could move between pools or ship from warehouse; needs source pool on pallet record |
| 12 | Customer return | 8088-8096 | Credits global iv | Needs to credit the pool the original shipment came from |

#### GROUP C: Paths with no pool context (need new data or UI)

| # | Path | Line(s) | Current Behavior | Issue |
|---|---|---|---|---|
| 5 | Manual adjustment | 8122 | Adds/removes from global iv | User must select pool in the adjustment form |
| Sample webhook | `functions/index.js` 1289-1298 | Hardcoded deduction of 3 `'classic'` cans, no pool | Needs to deduct from warehouse pool (samples ship from 3PL). This is server-side code. |

#### GROUP D: Reversal paths (inherit pool from original record)

All reversal paths (13-26) filter/remove existing iv records. If the original records have a `pool` field, reversals automatically respect it by removing the correct records. No logic changes needed in reversal paths themselves, only the creation paths that produce the records they reverse.

| # | Path | Line(s) | Notes |
|---|---|---|---|
| 13 | Delete invoice cleanup | 92 | Filters by `invoiceId` -- inherits pool from original records |
| 14 | Delete account | 5219 | Filters by `accountId` -- inherits pool |
| 15 | Delete dist invoice | 7434 | Filters by `invoiceId` -- inherits pool |
| 16 | Delete repack job | 7859 | Filters by `repackId` -- inherits pool |
| 17 | Delete pallet | 7946 | Filters by `palletId` -- inherits pool |
| 18 | Un-toggle delivery stop | 8971 | Removes orphaned records -- inherits pool |
| 19 | Remove stop from route | 9134 | Filters by deleted invoice IDs -- inherits pool |
| 20 | Clear route | 9169 | Filters by route's invoice IDs -- inherits pool |
| 21 | Delete order | 8476 | Filters by `ordId` -- inherits pool |
| 22 | Delete production history | 8671 | Filters by `prodId` -- inherits pool |
| 23 | Delete finished pack receipt | 7782 | Removes by record ID -- inherits pool |
| 24 | Delete single log entry | 8129 | Removes by record ID -- inherits pool |
| 25 | Delete combined invoice | 11826 | Filters by `purplInvoiceId` / `combinedId` -- inherits pool |
| 26 | Void combined invoice | 12722 | Filters by `purplInvoiceId` / `combinedId` -- inherits pool |

#### GROUP E: Modification paths (no quantity change, no pool impact)

| # | Path | Line(s) | Notes |
|---|---|---|---|
| 27 | Combined invoice legacy link | 11782-11783 | Sets metadata field only |
| 28 | Mark combined paid | 11802-11803 | Sets status only |
| 29 | Mark invoice paid (fallback) | 14778 | Sets status only |

### 4.3 Stock-on-Hand Calculation Impact

The current stock-on-hand formula (lines 7692-7693) scans the entire `iv` collection filtered by SKU. For a two-pool model, every call site that computes on-hand would need an additional filter by pool:

```javascript
// Current (single pool)
const ins  = iv.filter(i => i.sku === skuId && (i.type === 'in' || i.type === 'return')).reduce(...);
const outs = iv.filter(i => i.sku === skuId && i.type === 'out').reduce(...);

// Two-pool (needs pool parameter)
const ins  = iv.filter(i => i.sku === skuId && i.pool === poolId && (i.type === 'in' || i.type === 'return')).reduce(...);
const outs = iv.filter(i => i.sku === skuId && i.pool === poolId && i.type === 'out').reduce(...);
```

The `_renderLocationsTable()` at line 8145 already computes per-location stock using `stock_transfers` as a secondary layer. A two-pool model could either replace this mechanism or coexist with it.

### 4.4 Known Anomalies

1. **Distributor invoice delete vs shipment iv records:** `deleteDistInvoice()` (line 7434) filters by `e.invoiceId === invId`, but distributor shipment iv records use `ref: shipId` (not `invoiceId`). These may not match.
2. **Legacy `ordId` on iv records:** `deleteOrder` at line 8476 filters by `ordId`, but no current creation path sets `ordId` on invoice-triggered iv records. Legacy/defensive code.
3. **Sample webhook hardcodes SKU and quantity:** Lines 1289-1298 always deduct 3 cans of `'classic'`, regardless of what was actually in the sample box.
4. **No idempotency on 10 of 12 creation paths:** Only paths 9 (markInvoiceSent) and 11 (combined send) have dedup guards. All other creation paths can double-execute if the user double-clicks or retries.