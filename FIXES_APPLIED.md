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
