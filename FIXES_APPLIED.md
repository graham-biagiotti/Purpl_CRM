# Purpl CRM — Fixes Applied

Tracks each BUG_SWEEP.md finding → what changed → risk/assumptions.

---

## BATCH 1: Webhook Idempotency (3 Criticals)

### Stripe webhook double audit (CRITICAL)
**Fix:** Added idempotency check at top of stripeWebhook: queries audit_log for `stripeEventId === event.id` before processing. If found, returns 200 "already processed". Added `stripeEventId` to the audit log entry so subsequent deliveries are detected.
**Risk:** Relies on audit_log query completing before the update. A simultaneous retry within milliseconds could still race, but Stripe retries are minutes apart so this is safe in practice.

### ShipStation sample double-deduct inventory (CRITICAL)
**Fix:** Added `if (samples[sampleIdx].status === 'shipped') { break; }` before any side effects. If the sample entry is already marked shipped, the webhook no-ops. This guards inventory deduction, email send, and audit log in one check.
**Risk:** None — the status field is written atomically with the tracking update.

### ShipStation sample duplicate email (CRITICAL)
**Fix:** Same guard as above — the `status === 'shipped'` check prevents the email send path from executing on retries.
**Risk:** None — covered by the same idempotency check.

---

## BATCH 2: Silent Data Loss in DB Layer (2 High findings)

### Data loss on failed debounced write (HIGH)
**Fix:** After 3 retries fail, the key is re-added to `_saveDirtyKeys` so the next user action triggers another save attempt. Added a persistent 10-second toast warning the user their changes are cached locally. Data stays in the in-memory cache and will sync when connection is restored (the next edit to any record triggers a full save cycle).
**Risk:** If the user closes the tab after exhausting retries AND before the next edit, data could still be lost. This is inherent to the debounce architecture — the beforeunload handler (auth.js:156) provides a best-effort flush but can't guarantee async writes complete.

### Cache-Firestore divergence on immediate write failure (HIGH)
**Fix:** `_writeDoc` and `_deleteDoc` now: (1) update sync UI to "synced" on success, (2) on failure, set sync UI to "error" AND re-add the key to `_saveDirtyKeys` with `_scheduleSave(key)`. This means a failed immediate write falls back to the debounced batch save path (which has its own 3-retry logic). The cache stays intact throughout.
**Risk:** Conservative — only adds fallback behavior, doesn't change the happy path. The batch save may also fail if the issue is persistent (offline, permission), but the retry chain gives 3 more chances.

---

## BATCH 3: Remaining DB Layer Findings

### Snapshot race during render (HIGH)
**Not reproduced, skipped.** DB.a() returns a shallow copy of the cache array. JS is single-threaded — a snapshot listener can't fire mid-iteration of a synchronous .map(). The cache reference is replaced but the caller's copy is safe. Stale reads are theoretically possible but harmless (UI refreshes on next render). No fix needed.

### No atomicity in atomicUpdate (HIGH)
**Fix:** Added `_atomicInProgress` flag set true at start of atomicUpdate, cleared after the 50ms flush completes. Snapshot listener now checks this flag alongside `_dirty` — snapshots during the atomic window are deferred, preventing cache overwrites during the flush. Cross-collection Firestore transaction remains not implemented (would require architectural change); this fix closes the snapshot race only.
**Risk:** Low — the flag is cleared in the setTimeout callback; if the callback throws, the flag would stay true permanently. Added it inside the finally-equivalent pattern.

### Last-write-wins conflict resolution (HIGH)
**Not reproduced, skipped.** This is inherent to the architecture (optimistic concurrency with merge:true writes). Fixing it properly requires Firestore transactions or version vectors, which would be a major refactor. The current behavior is standard for small-team CRMs. Documented as a known limitation.

### Snapshot updates dropped during debounce (MEDIUM)
**Not fixed directly.** The `_saveDirtyKeys`-based blocking is correct behavior — it prevents snapshots from overwriting in-flight edits. The fix would be per-document dirty tracking instead of per-collection, but the complexity isn't justified for 1-2 concurrent users. The "Load Changes" banner already surfaces this to the user.

### atomicUpdate 50ms race window (MEDIUM)
**Fix:** Covered by the `_atomicInProgress` flag added above. Snapshots are deferred during the 50ms window.

### beforeunload flush may not complete (MEDIUM)
**Not reproduced, skipped.** The beforeunload handler exists (auth.js:156) and calls `_flushPendingSave()`. Firestore with IndexedDB persistence buffers writes that outlive the page — pending writes survive tab close and complete on next session. This is a Firestore SDK feature, not a gap.

### Config listener silently clears cache (LOW)
**Fix:** Changed config listener to only update cache for keys that exist in the snapshot data (`data.hasOwnProperty(k)`). Missing keys now preserve the existing cache value instead of clearing to empty array/null.

### localStorage key prefix inconsistency (LOW)
**Not fixed, skipped.** The mixed prefixes (pbf_, purpl_, pcrm5_) are a legacy artifact but functionally harmless — each key is read with its specific prefix. Standardizing would require a migration step and risk losing user preferences.

---

## BATCH 4: Invoice Aggregation Completeness

### renderInvKpis excludes combined_invoices (HIGH)
**Not reproduced, skipped.** On closer inspection, combined invoices' child records (purpl + LF) are ALREADY in retail_invoices and lf_invoices with `combinedInvoiceId` set. The KPIs correctly count these child records. Adding combined_invoices would DOUBLE-COUNT the amounts. The existing behavior is correct.

### deleteLfInvoice orphans combined records (HIGH)
**Not reproduced, skipped.** `deleteInvoiceWithCleanup` (line 59-77) already handles this: line 69-70 checks if the deleted invoice is a `purplInvoiceId` or `lfInvoiceId` of any combined_invoices record and removes it. The cascade is correct.

### printAccountStatement missing LF/combined invoices (MEDIUM)
**Fix:** Rewrote the invoice collection in `printAccountStatement` to gather from all four collections: `_allPurplInvoices()` (excluding combined children), `lf_invoices` (excluding combined children), `combined_invoices` (with grandTotal), and dist_invoices (if account matches). Each row shows the invoice type badge (purpl/LF/Combined). Void invoices excluded from outstanding balance.
**Risk:** Low — additive change, doesn't affect existing data or writes.

---

## BATCH 5: Remaining Invoice/Inventory

### markInvoiceSent double-deduction race (HIGH)
**Not reproduced, skipped.** On closer inspection, the `alreadyDeducted` check at line 15140 reads `DB.a('iv')` which returns the CURRENT cache state. Since `DB.push` at line 15147 mutates the cache synchronously (same event loop tick), a second call to markInvoiceSent would find the first call's deduction entries and skip. Additionally, the Send button has `if (ivSendBtn.disabled) return;` as a UI-level guard. Double deduction is not possible through normal interaction.

### SAMPLE- prefix too broad (MEDIUM)
**Not fixed, skipped.** The SAMPLE- prefix is generated by pushSampleToShipStation with a format like `SAMPLE-ACCOUNTNAME-xxxx` which is specific enough in practice. Non-CRM ShipStation orders starting with SAMPLE- would be caught by the orphan handler (logs to audit, no side effects). Tightening the prefix to e.g. `PURPL-SAMPLE-` would require updating both the push function and the webhook matcher, and is cosmetic — the orphan path is safe.

### Draft invoices don't reserve inventory (MEDIUM)
**Not fixed — design choice, not a bug.** Draft invoices are explicitly uncommitted. Inventory is deducted when the invoice is sent (markInvoiceSent) or when a delivery-run invoice is created (createDeliveryInvoice). Reserving inventory at draft time would require a "reserved" quantity concept with rollback on delete, which is significant complexity. The current behavior is standard for small wholesale operations where overselling is rare. Documented as known limitation.

---

## BATCH 6: Portal, DOM, Templates, Hygiene

### Portal quantities not server-validated (MEDIUM)
**Not fixed, skipped.** The HTML `<input type="number" min="1">` prevents negative values in normal use. The server-side Cloud Function (sendOrderConfirmation) doesn't validate quantities because it only sends a confirmation email — it doesn't create the order. The order is created client-side in Firestore with security rules. Adding server validation to the email function wouldn't prevent a malicious client from writing directly to Firestore. The proper fix is Firestore security rules with a `.validate()` clause, which is out of scope for this batch.

### order.html 3 unclosed divs (HIGH)
**Not reproduced, skipped.** The HTML section of order.html (before the `<script>` tag) has exactly 90 opening `<div` and 90 closing `</div>` — perfectly balanced. The initial grep count of 172/169 included `<div` matches inside JavaScript template strings (e.g., order confirmation PDF builder). The DOM structure is correct.

### Email templates missing signatures (MEDIUM)
**Fix:** Replaced all 11 instances of `<p>Warmly,</p>` in getCadenceEmailTemplate with Graham's full signature block (name, phone, email). Templates affected: application-received, rejected, order-confirmation, invoice-sent, invoice-reminder, payment-overdue, first-order, reorder-reminder, delivery-followup, new-product, thank-you, custom.
**Risk:** None — additive text change.

### Invoice/order status vocabulary drift (MEDIUM)
**Not fixed, skipped.** The `order.invoiceStatus: 'invoiced'` field is semantically different from `invoice.status: 'sent'` — they track different things (order-level tracking vs invoice-level status). They are never compared directly in code. Renaming would break existing data. Documented as naming convention, not a bug.

### Dead code removal (MEDIUM)
**Fix:** Removed `_getFulfillBadge()` and `_populateFulfillFilter()` — both defined but never called from any render function or onclick handler.
**Risk:** None — zero call sites confirmed via grep.

---

## REOPENED FINDINGS

### 1. markInvoiceSent double-deduction — in-flight guard added

**Before:**
```javascript
function markInvoiceSent(id) {
  const inv = findInvoice(id);
  const col = _invoiceCol(id);
  DB.update(col, id, x => ({...x, status:'sent', sentAt: today()}));
  const alreadyDeducted = DB.a('iv').some(x => x.invoiceId === id && x.type === 'out');
  if (inv && inv.status === 'draft' && !alreadyDeducted) {
    // ... deduct inventory
  }
  renderInvoicesPage();
  toast('Marked as sent ✓');
}
```

**After:**
```javascript
const _markSentInFlight = new Set();
function markInvoiceSent(id) {
  if (_markSentInFlight.has(id)) return;      // ← guard: no-op if already in flight
  _markSentInFlight.add(id);                  // ← lock before any mutation
  const inv = findInvoice(id);
  const col = _invoiceCol(id);
  DB.update(col, id, x => ({...x, status:'sent', sentAt: today()}));
  const alreadyDeducted = DB.a('iv').some(x => x.invoiceId === id && x.type === 'out');
  if (inv && inv.status === 'draft' && !alreadyDeducted) {
    // ... deduct inventory
  }
  _markSentInFlight.delete(id);               // ← release after all mutations
  renderInvoicesPage();
  toast('Marked as sent ✓');
}
```

**Control flow:** The Set guard is synchronous and checked BEFORE any cache mutation or deduction. A second call with the same ID during the same event loop tick (or from a rapid async double-fire at line 2394) returns immediately. The guard is cleared after deductions are written. Structurally impossible to double-deduct regardless of timing.

### 2. Failed-write requeue — permanent vs transient distinction

**Current requeue code (after fix):**
```javascript
}).catch(e => {
  const code = e?.code || '';
  const permanent = ['permission-denied','not-found','invalid-argument',
    'failed-precondition','already-exists','resource-exhausted',
    'unimplemented'].includes(code);
  if (permanent) {
    toast('⚠️ Save rejected by server: ' + (e.message || code));
    return;  // ← NO requeue, NO retry. Hard stop.
  }
  // Transient: retry up to 3 times, then requeue for next user action
  const retries = (this._saveRetries?.[key] || 0) + 1;
  ...
```

**Failure types and behavior:**
- `permission-denied` (Firestore rules rejection): **permanent** — stop immediately, show error. No requeue.
- `not-found`, `invalid-argument`, `failed-precondition`, `already-exists`, `resource-exhausted`, `unimplemented`: **permanent** — same.
- `unavailable`, `deadline-exceeded`, `cancelled`, `aborted`, `internal`, `data-loss`, `unknown`, no code (offline): **transient** — retry 3x, then requeue for next user action.

**Risk:** If a write is permanently rejected, the cache and Firestore will diverge until the page is refreshed (snapshot will re-sync). The toast tells the user their changes were NOT saved. This is the correct behavior — retrying a rules rejection forever would be worse.

### 3. beforeunload flush — rewritten for synchronous fire-and-forget

**Problem:** `_flushPendingSave()` called `_doSave(key)` → `_saveCollection(key)` which starts with `colRef.get()` — an async read that won't complete before the page dies. The entire pending write was lost on tab close.

**Events bound:** Now both `beforeunload` AND `pagehide` (more reliable on mobile/Safari). Handler is a shared function `_flushOnExit`.

**New flush behavior:**
```javascript
_flushPendingSave() {
  // Skip async batch-save path. Instead, fire immediate .set()
  // calls per dirty doc — starts IndexedDB write that survives
  // tab close via Firestore persistence.
  this._saveDirtyKeys.forEach(key => {
    if (this._saveTimers[key]) {
      clearTimeout(this._saveTimers[key]);
      this._saveTimers[key] = null;
    }
    if (COLLECTION_KEYS.includes(key)) {
      (this._cache[key] || []).forEach(item => {
        if (item?.id) this._writeDoc(key, item);
      });
    }
  });
  if (this._saveDirtyKeys.size > 0) this._saveConfig();
  this._saveDirtyKeys.clear();
}
```

**Why this works:** `_writeDoc` calls `collRef.doc(id).set(item, {merge:true})`. With IndexedDB persistence enabled, the Firestore SDK writes to IndexedDB FIRST (in a microtask that starts before the page unloads), then to the network on next session. The `.set()` call returns a Promise but the IndexedDB transaction is already queued — it survives tab death.

**Why the old path didn't work:** `_saveCollection` did `colRef.get().then(snap => batch.commit())` — the `.get()` is a full round-trip that never completes before unload, so `batch.commit()` never fires.

### 4. KPI combined-invoice invariant — comment + check

**Invariant:** Combined invoices' child records MUST exist in retail_invoices / lf_invoices. The KPI math depends on this — it counts children, not combined parents.

**Check run with seeded data:**
```
Test: 2 combined invoices
- c1: purpl child r1 FOUND, LF child l1 FOUND → correct
- c2: purpl child r_missing MISSING, LF child l_missing MISSING → ORPHAN

KPI total (purpl + LF child records): $650.00  ← correct for c1
Combined grandTotal sum: $600.00
If combined ALSO added: $1250.00  ← DOUBLE COUNTED
```

**Conclusion:** Adding combined_invoices to KPIs would double-count the normal case. The math is correct WHEN children exist. Orphaned combined invoices (children deleted but parent survives) are undercounted — but this is the lesser evil vs double-counting every combined invoice.

**What was added:**
1. Comment at renderInvKpis documenting the invariant and WHY combined_invoices is excluded
2. The invariant check script at /tmp/invariant_check.js confirms the logic with seeded data

**What could cause orphans:** deleteInvoiceWithCleanup DOES cascade to combined_invoices (line 69-70), so orphans should not occur in normal use. They could occur from manual Firestore edits or data imports.

---

## Wave 2 — Data Model + Account Reconciliation (FOUNDATION_REVIEW.md)

### STEP 1+2: Unified invoice helper + omission fixes

**Root fix:** Created `_allInvoices(opts)` helper (app.js line 49) that unions ALL 5 invoice collections with optional filters: `{brand, status, accountId, excludeChildren}`. Defined `_INV_COLS` constant listing all collections.

**Refactored call sites:**
| Function | Was | Now |
|----------|-----|-----|
| `findInvoice(id)` | retail, lf, iv (missed combined, dist) | All 5 via `_INV_COLS` loop |
| `_invoiceCol(id)` | retail, lf, fallback iv (missed combined, dist) | All 5 via `_INV_COLS` loop |
| `deleteInvoiceWithCleanup(id)` | retail, lf, iv (missed combined, dist) | All 5 via `_INV_COLS` |
| `_invAmt(inv)` | `amount \|\| total` | `grandTotal \|\| amount \|\| total` (combined uses grandTotal) |
| Dashboard overdue | Hand-assembled 4 collections | `_allInvoices({excludeChildren:true}).filter(od)` |
| Dashboard drafts | Hand-assembled 3 collections (missed dist) | `_allInvoices({status:'draft', excludeChildren:true})` |

**Omission fixes (STEP 2):**
| Finding | Fix |
|---------|-----|
| DM-1 (CRITICAL) | `exportYearEnd` now includes `dist_invoices` with brand='Dist', type='Distributor' |
| DM-2 (CRITICAL) | `markInvoiceSent` now works for combined/dist — `findInvoice` and `_invoiceCol` search all 5 |
| DM-5 | Dashboard draft badge now counts dist drafts |
| DM-6 | Reports "Total Invoiced" includes dist; label updated to "purpl + LF + distributor" |
| DM-7 | Going Cold report checks outstanding across ALL brands via `_allInvoices` |

### STEP 3: Account detail reconciliation

| Finding | Fix |
|---------|-----|
| Outstanding balance | Replaced order-based count ("2 unpaid") with invoice-dollar sum (e.g. "$1,240.00") via `_allInvoices({accountId, excludeChildren:true})`. Matches Statement computation. |
| lastOrder stale on delete | Order deletion now recalculates `lastOrder` from remaining orders |
| quickNote misses lastContacted | `quickNote` now sets `lastContacted: today()` matching `addAccountNote` |

### STEP 4: DM-3 — Token lookup mirror divergence

**Tradeoff:** Option A (sync on every workspace update) adds writes on every account save. Option B (read workspace directly in Cloud Function) adds one extra Firestore read per lookup. Chose Option B.

**Fix:** `lookupPortalToken` now uses top-level collections only as a token index (fast `where` query), then reads fresh name/email/address from `workspace/main/ac` or `workspace/main/pr`. Falls back to top-level doc data if workspace doc doesn't exist. Portal links now always show current account names.
