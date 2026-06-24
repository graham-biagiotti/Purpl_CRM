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
