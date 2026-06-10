# AUDIT_FABLE.md — Adversarial Audit of Purpl CRM

**Date:** 2026-06-10
**Model:** Fable 5
**Scope:** Read-only. No changes made. 4 adversarial agents + manual verification.

---

## Critical

### C1. sendCombinedInvoice never passes accountId to Cloud Function
**file:** app.js:11624, functions/index.js:85
**What's wrong:** `callSendCombinedInvoice(to, rec.accountName, subject, html)` sends 4 params. The Cloud Function checks `if (data.accountId && messageId)` before logging a cadence entry — but `data.accountId` is always undefined.
**Failure scenario:** Admin sends a combined invoice. Email sends fine. But the server-side cadence entry is never created. The resendWebhook that matches open/click events by `sentMessageId` will never find a match in the account's cadence, so email tracking (opened/clicked badges) silently fails for ALL combined invoices.
**Why the client-side cadence log (line 11663) doesn't fully compensate:** It logs correctly, BUT the webhook searches the server-written cadence (via `_logCadenceEntry` path in workspace/main/ac). If the webhook fires before the client's debounced save commits, the messageId won't be in Firestore yet.
**Proposed fix:** Add `accountId: rec.accountId` and `invoiceNumber: rec.number || rec.invoiceNumber` to the callSendCombinedInvoice params; update function signature.

### C2. Prospect-to-account conversion: naked .set() on external accounts doc
**file:** app.js:4823
**What's wrong:** `firebase.firestore().collection('accounts').doc(newAc.id).set({...data, accountId, accountName})` — no `{merge: true}`. If an `accounts/{newAc.id}` doc already exists (e.g., an employee just generated a portal token for the new account in a different tab), this overwrites it completely, destroying the `orderPortalToken`.
**Failure scenario:** Admin converts prospect → account. Meanwhile, another admin generated a portal token. The conversion wipes the token. Customer's portal link stops working with no indication.
**Proposed fix:** Add `{merge: true}` to the `.set()` call.

---

## High

### H1. DB.update() silently does nothing if record was deleted
**file:** db.js:438–441
**What's wrong:** `const i = a.findIndex(x => x.id === id); if (i >= 0) { ... }` — if the record doesn't exist in cache (e.g., another user just deleted it), the update is silently discarded. No error, no toast, no return value.
**Failure scenario:** User A edits account phone number. User B deletes the account. User A clicks Save. Toast says nothing (save function continues past DB.update). User A thinks the account was saved; it wasn't.
**Proposed fix:** Return a boolean from DB.update; callers check it and toast an error.

### H2. Listener can overwrite local mutations for non-modal saves
**file:** db.js:176–181
**What's wrong:** When `_dirty` is false (most list-view actions like "Mark Paid", "Mark Sent", status toggles), the snapshot listener REPLACES the entire cache array for that collection. If a remote snapshot arrives between the local cache mutation and the debounced save (500ms window), the local change is reverted.
**Failure scenario:** Admin clicks "Mark Paid" on an invoice. 200ms later, a Firestore listener snapshot arrives with the pre-paid state (from another user's unrelated write to the same collection). Cache is replaced. The debounced save fires — writing the old (unpaid) state back to Firestore, undoing the paid mark.
**Probability:** Low for single-user; increases with each additional concurrent user.
**Proposed fix:** Set a per-key dirty flag on `DB.update()` that clears after the debounced save commits, preventing listener replacement during the window.

---

## Medium

### M1. Pallet conversion naked .set() same pattern as C2
**file:** app.js:4823 (same line — the entire prospect-to-account external doc write)
**Already covered by C2.**

### M2. saveDistRep builds fresh object — drops unknown fields
**file:** app.js:6370–6381
**What's wrong:** Unlike `saveAccount` (which spreads `...(existing||{})`), `saveDistRep` constructs a new object from scratch. Any fields on the dist_reps record not in the explicit list are lost on save.
**Failure scenario:** A dist_rep record has a custom `tags` field added via Firestore console. Admin edits the rep's phone number. Save wipes `tags`.
**Proposed fix:** Add `...(existing||{})` spread at top of rec construction.

### M3. Invoice number can skip values (never duplicates, but gaps)
**file:** app.js:10974–11018
**What's wrong:** `peekNextInvoiceNumber()` scans the cache for the max invoice number, but the cache may not yet reflect a just-committed Firestore transaction. The next peek could return max(stale cache, Firestore counter)+1, skipping a number.
**Failure scenario:** User creates INV-0042. Transaction commits nextInvoiceNum=42. Cache still shows max=41 (listener hasn't fired). Next peek returns max(42,41)+1=43. INV-0042 exists, INV-0043 is created next. No duplicate, but gap — bad for sequential audit trails.
**Proposed fix:** After transaction commits, the DB.setObj already updates cache (line 10990). Verify listener doesn't overwrite it before next peek. Low priority since gaps don't cause data loss.

### M4. Stripe payment + manual Mark Paid = two audit log entries
**file:** app.js (markCombinedPaid) + functions/index.js (stripeWebhook)
**What's wrong:** If a customer pays via Stripe AND the admin simultaneously clicks Mark Paid, both succeed (both write status='paid') and both create audit entries.
**Failure scenario:** Audit log shows the invoice was paid twice. Accounting review questions the duplicate entry. No data corruption, just noise.
**Proposed fix:** Webhook could check `if (existing.status === 'paid') return 200;` before writing. Low priority.

---

## Low

### L1. Employee can bypass _requireAdmin via browser console Firestore write
**file:** firestore.rules (workspace catch-all allows auth write)
**What's wrong:** Firestore rules allow any authenticated user to write to `workspace/main/*`. The app-level `_requireAdmin` guard only blocks UI actions. An employee could open DevTools and run `firebase.firestore().doc('workspace/main/ac/someId').delete()`.
**Blast radius:** They could delete accounts, invoices, settings. Audit log wouldn't capture it (the auditLog function didn't run). Unlikely unless intentionally malicious.
**Proposed fix (future):** Add Firestore security rules that check user role for destructive operations on sensitive subcollections. Significant rule refactor.

### L2. External 'accounts' collection duplicates data from workspace/main/ac
**file:** app.js:3629, 14887
**What's wrong:** Portal tokens are written to BOTH `workspace/main/ac/{id}` (via DB) and `accounts/{id}` (via direct Firestore write). lookupPortalToken only reads the external `accounts` collection. If the external write fails silently, the portal link breaks even though the token exists in workspace data.
**Proposed fix:** Have lookupPortalToken also check workspace/main/ac as fallback. Or use a transaction to ensure both writes succeed.

### L3. DIST_INV_STATUS still has 'unpaid'/'overdue' entries
**file:** app.js:5254–5260
**What's wrong:** The status map includes both old (`unpaid`, `overdue`) and new (`draft`, `sent`, `paid`, `void`) statuses. New distributor invoices are created with `draft` but old data may still have `unpaid`. The map handles both, so rendering works — but the dual vocabulary could confuse report queries.
**Proposed fix:** On next data cleanup pass, migrate old dist_invoices from unpaid→sent, overdue→sent.

### L4. LF invoices use 'unpaid' status while other invoice types use 'draft'/'sent'
**file:** app.js:10474–10503 (saveLfInvoice status options)
**What's wrong:** LF invoices default to 'unpaid' while retail and combined default to 'draft'. KPI filters handle both correctly (`!['paid','draft','void']` catches 'unpaid'), but the inconsistency makes status-based reporting fragile.
**Proposed fix:** Future standardization pass to align all invoice types on draft/sent/paid/void.

### L5. Par value interpolated without escHtml
**file:** app.js:2649
**What's wrong:** `${v}` (par level value) inserted into innerHTML without escHtml. Value is parseInt'd on save so it's always a number in practice, but if Firestore data is manually edited, it could inject HTML.
**Proposed fix:** Wrap in `escHtml(String(v))`.

---

## Needs Verification

### V1. Does Firestore listener's hasPendingWrites reliably prevent cache replacement?
**Test:** Open two browser tabs. In Tab A, click Mark Paid on an invoice. In Tab B, immediately edit and save a different invoice in the same collection. Check if Tab A's paid status sticks or reverts after Tab B's listener fires.

### V2. Does the Stripe webhook actually receive req.rawBody in Firebase Functions v2?
**Test:** Send a test payment through Stripe. Check the Cloud Functions log for the stripeWebhook function — if it logs "Stripe webhook signature failed", rawBody is not populating correctly. If it logs "ok" or "no match", the signature verification works.

### V3. Portal token resilience when external accounts write fails
**Test:** Approve a wholesale application while the external Firestore `accounts` collection is temporarily unreachable (e.g., disable the collection's rules briefly). Then try the portal link — does lookupPortalToken find the token?
