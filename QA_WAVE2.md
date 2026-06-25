# QA_WAVE2.md — Invoice Changes Verification

**Date:** 2026-06-25
**Scope:** Double-count check, four-type exercise, regression check on Wave 2 invoice refactoring

---

## 1. THE DOUBLE-COUNT CHECK

### How _allInvoices handles combined invoices

`_allInvoices()` (line 51) returns ALL records from all 5 collections:
- `retail_invoices` (tagged `_brand: 'purpl'`)
- `iv` legacy invoices (tagged `_brand: 'purpl'`, deduplicated against retail)
- `lf_invoices` (tagged `_brand: 'lf'`)
- `combined_invoices` (tagged `_brand: 'combined'`) — the PARENT records
- `dist_invoices` (tagged `_brand: 'dist'`)

The `excludeChildren` filter (line 62) removes records where `combinedInvoiceId` is set — these are the retail/lf CHILD records that belong to a combined invoice. The combined PARENT records are kept.

### Is combinedInvoiceId reliably set on children?

**YES.** Verified at 4 creation sites:
| Creation path | Sets combinedInvoiceId | Lines |
|---|---|---|
| `saveNewCombinedInvoice` | YES on both purpl child and LF child | 11780, 11786 |
| Manual combined creation | YES on both children | 12150, 12156 |
| Portal order confirm (isDual) | YES on both children | 14539, 14550 |
| `markCombinedPaid` | Does not create, only updates status | N/A |

### Every summing call site checked

| Call site | Line | excludeChildren | Sums $ | Double-count? |
|---|---|---|---|---|
| Dashboard overdue count | 1215 | YES | No (count only) | **NO** — counts distinct invoices |
| Dashboard draft count | 1216 | YES | No (count only) | **NO** |
| Account card outstanding | 3018 | YES | YES | **NO** — children filtered out, parent counted once |
| Reports Total Invoiced | 9262 | YES | YES | **NO** — children filtered out, parent counted once via grandTotal |
| Going Cold outstanding | 9389 | YES | YES | **NO** — same pattern |
| exportYearEnd | 10058 | N/A (manual) | YES | **NO** — manually filters `!x.combinedInvoiceId` on children, splits parent into purpl/LF subtotal rows |
| renderInvKpis | 14914 | N/A (manual) | YES | **NO** — excludes combined parents entirely, counts children (purpl via `_allPurplInvoices`, LF via raw `lf_invoices`). The LF line does NOT filter by `combinedInvoiceId`, but this is correct because combined parents are already excluded — the LF child amount is the right amount to count. |

### Verdict: **NO DOUBLE-COUNTING.**

The excludeChildren=true pattern is correct: combined parents carry `grandTotal`, children carry individual amounts, and `combinedInvoiceId` is reliably set on all children. When excludeChildren filters the children out, only the parent's `grandTotal` is summed — producing the right number.

The `_invAmt()` helper was also updated to prefer `grandTotal` (line 98: `parseFloat(inv.grandTotal || inv.amount || inv.total || 0)`), which correctly returns the parent's total for combined invoices.

---

## 2. FOUR-TYPE EXERCISE

### Mark PAID — all 4 types

| Type | Function | Collection | Sets paidDate | Sets paidAt | Also marks children | Verified |
|---|---|---|---|---|---|---|
| Retail | `markRetailInvPaid` (2587) | retail_invoices | YES | YES | N/A | RECONCILES |
| LF | `markLfInvPaid` (11322) | lf_invoices | YES | YES | N/A | RECONCILES |
| Combined | `markCombinedPaid` (11791) | combined_invoices + retail + lf | YES (all 3) | YES (all 3) | YES (atomicUpdate) | RECONCILES |
| Dist | `markDistInvoicePaid` (7417) | dist_invoices | YES | YES | N/A | RECONCILES |
| Stripe webhook | `stripeWebhook` (func:1007) | Correct collection via colMap | YES | YES | YES (if combined) | RECONCILES |

All 6 mark-paid paths write both `paidDate` (YYYY-MM-DD) AND `paidAt` (ISO timestamp).

### Mark SENT — all 4 types

| Type | Flow | findInvoice finds it | _invoiceCol correct | Inventory deducted | Verified |
|---|---|---|---|---|---|
| Retail | `markInvoiceSent(id)` (15321) | YES (retail_invoices) | YES → 'retail_invoices' | YES (lineItems iterated) | RECONCILES |
| LF | LF send flow (separate path) | N/A (LF has its own send) | N/A | No purpl inventory for LF | RECONCILES |
| Combined | Combined send flow (12649) | N/A (own atomicUpdate) | N/A (writes all 3 directly) | YES (from purpl child's lineItems) | RECONCILES |
| Dist | Dist send flow (separate path) | N/A (dist has own flow) | N/A | No purpl inventory for dist | RECONCILES |

**Note on combined:** `markInvoiceSent` CAN be called on a combined ID (findInvoice now finds it). It would set status='sent' correctly but skip inventory deduction because combined records have no `lineItems`. This is a no-op for inventory but not harmful — in practice, the combined send flow at line 12649 handles this correctly via its own atomicUpdate that deducts from the purpl child. No user path calls `markInvoiceSent` directly on a combined invoice.

### Delete — all 4 types

| Type | deleteInvoiceWithCleanup | Removes from collection | Cleans iv out-entries | Cleans cadence | Cleans combined parent | Verified |
|---|---|---|---|---|---|---|
| Retail | YES — loops _INV_COLS | YES | YES | YES | YES (if child of combined) | RECONCILES |
| LF | YES | YES | YES | YES | YES (if child of combined) | RECONCILES |
| Dist | YES — now found via _INV_COLS | YES | YES | YES | N/A | RECONCILES |
| Combined (parent) | YES — found via _INV_COLS | YES | YES | YES | N/A — but children NOT deleted | **PARTIAL** |

**Combined parent deletion note:** When deleting a combined parent via `deleteInvoiceWithCleanup`, the children (retail + LF records) are NOT deleted. This is a pre-existing design choice — there's a dedicated `deleteCombinedInvoice` function (line 11814) that handles both parent + children. In the UI, the combined invoice delete button calls `deleteCombinedInvoice`, not `deleteInvoiceWithCleanup`. So no orphan risk in practice, but the asymmetry exists.

---

## 3. REGRESSION

### Invoice modals — do they still resolve correctly?

| Modal | Lookup method | Uses findInvoice? | Regression risk |
|---|---|---|---|
| `openInvModal` (purpl) | `findInvoice(id)` | YES | NONE — searches all 5 collections now |
| `openLfInvoiceModal` | `DB.a('lf_invoices').find(...)` | NO (direct) | NONE — only opens LF invoices |
| `openCombinedInvoicePreview` | `DB.a('combined_invoices').find(...)` + `findInvoice(rec.purplInvoiceId)` | Partial | NONE — direct lookup for combined, findInvoice for purpl child |
| Dist invoice edit | Direct `DB.a('dist_invoices')` | NO | NONE — only opens dist invoices |

All invoice modals were already typed to their specific collection OR use findInvoice. The refactored findInvoice returns the same results for retail/lf/iv as before, and now additionally finds combined/dist which it couldn't before. No regression.

### Email previews

Email preview (`openEmailPreview` → `getCadenceEmailTemplate`) uses `findInvoice` indirectly via `_latestAccountInvoiceId` (line 3673). This function searches retail + lf + iv + combined but NOT dist (dist invoices use a separate distributor workflow). No regression — same behavior as before for retail/lf, and combined/dist aren't used in the cadence email flow.

---

## Summary

| Check | Verdict |
|---|---|
| Double-count (combined parents vs children) | **NO DOUBLE-COUNTING** — excludeChildren correctly filters; combinedInvoiceId reliably set |
| Mark paid (all 4 types) | **RECONCILES** — all set both paidDate and paidAt |
| Mark sent (all 4 types) | **RECONCILES** — each type uses its own flow; combined deducts from purpl child correctly |
| Delete (all 4 types) | **RECONCILES** (partial note: combined parent delete doesn't cascade to children, but dedicated function handles this) |
| Invoice modals (4 types) | **NO REGRESSION** |
| Email previews | **NO REGRESSION** |

### What I confirmed by reading code (not by running):
- All findings are code-traced, not runtime-tested — no live Firestore data was exercised
- The `combinedInvoiceId` invariant was verified at all 4 creation sites but not checked against live data
- Inventory deduction math was traced through the code but not verified with actual quantities

### What would need live testing:
- Open each invoice type in the UI, click Send, verify the toast and status change
- Create a combined invoice draft, send it, verify inventory deduction equals the purpl child's cases × 12
- Delete a combined invoice via the UI button, verify both parent and children are removed
- Check the dashboard and reports KPIs against manually-summed Firestore data
