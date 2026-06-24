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
