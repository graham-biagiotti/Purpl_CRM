# Purpl CRM — Comprehensive Test & Audit Results

**Date:** 2026-04-17
**Branch:** `claude/fix-order-confirmation-page-tEOGJ` (based on master)
**Auditor:** Automated deep audit (4 parallel analysis agents + Playwright test suite)

---

## 1. Playwright Test Suite Results

**Total tests run:** ~85 (with retries)
**Passed:** 40+ | **Failed:** 45+ (including retries)

### Passing Tests (confirmed working)
- Auth injection / IndexedDB pre-population
- Account list rendering (30 seeded accounts visible)
- Brand filtering (purpl-only, LF-only, clear filters)
- Account CRUD: add, edit, delete
- Account location management
- Dashboard KPI rendering, topbar title, needs-attention, follow-ups, invoice status
- Data integrity: invoice creation, delete cascade, orphan scans
- Delivery page load, tab rendering, route builder, add stop
- Firestore rules: unauthenticated portal_orders create works
- Distributor delete cascade (atomically removes all child records)

### Failing Tests (bugs found)

#### Accounts — Modal & Detail Issues
| Test | Failure | Likely Cause |
|------|---------|-------------|
| Special character account name renders | Layout break | escHtml escaping may interfere with card rendering for names with `<`, `>`, `&` |
| Account detail modal opens (ac001) | Timeout | Modal open relies on clicking `.ac-card-name` but selector may not match after DOM changes |
| Emails/Cadence tab rendering | Timeout (1m) | Cadence stage dots/indicators not found — UI may have changed since tests were written |
| Outreach tab rendering | Timeout (1m) | Outreach entries not rendering in expected selectors |
| Search filter | Timeout | Search input selector or filter behavior changed |
| Log note on account | Timeout | Note save flow or Notes tab selector changed |

#### Dashboard Issues
| Test | Failure | Likely Cause |
|------|---------|-------------|
| Never-contacted KPI | Element not found | KPI card structure may have changed (sectioned notes replaced old notepad) |
| Quick Notes scratchpad | Element not found | Quick notes section renamed or restructured |

#### Data Integrity Issues
| Test | Failure | Likely Cause |
|------|---------|-------------|
| Edit account preserves arrays | Fails | The edit-save flow may drop `outreach`, `noteLog`, `samples` arrays — **potential data loss bug** |
| Phase 1 seed: 80 accounts loaded | Fails | db.js `_applyData` changes may affect how large seed data is read |

#### DB Race Condition Tests
| Test | Failure | Likely Cause |
|------|---------|-------------|
| `_firestoreReady` is true after boot | Fails | Tests directly inspect `DB._firestoreReady` — the debounced `_save` changes may affect timing |
| `_save()` blocked when not ready | Fails | `_save()` was refactored to use `_doSave()` with debounce — test checks old behavior |
| `_save()` proceeds when ready | Fails | Same — test expects synchronous `setDoc` call, but save is now debounced |

#### Delivery Issues
| Test | Failure | Likely Cause |
|------|---------|-------------|
| Orders tab lists seeded orders | Timeout | Tab rendering or selector changed |
| New Order modal / save / empty form | Timeout | Modal button selector changed |
| Order detail modal | Timeout | Detail modal open flow changed |
| Route builder account selector | Timeout | Selector for stop account dropdown changed |

#### Distributor Issues
| Test | Failure | Likely Cause |
|------|---------|-------------|
| Pipeline groups render | Timeout | Distributor page pipeline layout changed |

---

## 2. Data Integrity Findings

### [CRITICAL] `saveSettings()` silently resets `payment_terms` to 30
**File:** app.js:9158
**Description:** `parseInt(qs('#set-payment-terms')?.value)||30` reads from element `#set-payment-terms` which does NOT exist in the DOM. The actual element is `#set-default-terms`. Result: every time global settings are saved, `payment_terms` is overwritten to 30.
**Impact:** Any custom payment terms (Net 7, Net 15, Net 45, Net 60) are silently destroyed.

### [HIGH] LF orders blocked by Firestore rules
**File:** order.html:1183 vs firestore.rules:21
**Description:** LF orders set `status: 'pending'` but Firestore rules require `status == 'new'`. Also, LF orders use `lineItems` field but rules require `items`. Both checks fail = **all Lavender Fields portal orders are silently rejected**.
**Impact:** LF ordering from the wholesale portal is completely broken.

### [HIGH] `deleteAccount()` leaves orphaned LF/combined invoices and active portal tokens
**File:** app.js:4059-4073
**Description:** Cleanup covers `ac`, `iv`, `orders`, `retail_invoices`, `returns` but misses `lf_invoices`, `combined_invoices`, `pending_invoices`, and the external `accounts` Firestore collection (portal tokens). Also misses `today_run` stops.
**Impact:** Orphaned LF invoices inflate outstanding balances. Deleted accounts can still place orders via active portal tokens.

### [HIGH] XSS in renderApplications() via JSON.stringify in onclick
**File:** app.js:3412-3414 (approximately — in the wholesale applications section)
**Description:** `onclick="approveApplication('${app._docId}', ${JSON.stringify(app).replace(/"/g,'&quot;')})"` — only double quotes escaped, not single quotes or backslashes. A crafted wholesale application can inject JavaScript.
**Impact:** External attacker submits malicious wholesale application → admin clicks Approve → arbitrary JS executes in admin's browser.

### [MEDIUM] `calcOrderValue()` ignores user's `target_margin` setting
**File:** app.js:876-885
**Description:** Fallback pricing uses hardcoded `2.2x` markup: `(costs.cogs[i.sku]||2.15) * 2.2 * CANS_PER_CASE`. The user has a configurable `target_margin` (default 60%) in settings, but it's never read by pricing functions. Same 2.2x hardcode in `createDeliveryInvoice()`, `repRevenue()`, `repAccounts()`, `repProfit()`.
**Impact:** Revenue projections, reports, and auto-generated invoices all use 2.2x regardless of configured margin.

### [MEDIUM] `iv` collection serves dual purpose (inventory + purpl invoices)
**File:** app.js:537-559
**Description:** The `iv` array stores both inventory transactions (`type: 'in'/'out'/'return'`) and purpl invoice records (`number`, `amount`, `status`). Dashboard outstanding calculation filters by `(x.accountId || x.number)` to distinguish them, but this convention is fragile.
**Impact:** If any future code adds `accountId` to an inventory entry, it would be incorrectly counted as an outstanding invoice.

### [MEDIUM] Inventory returns not counted consistently
**File:** app.js:6362-6364, 1790-1791, 574-577
**Description:** Production planning includes `type === 'return'` as inbound stock, but inventory summary table, dashboard KPIs, and reports do NOT. Different stock numbers shown in different places.
**Impact:** User sees different on-hand quantities depending on which page they check.

### [MEDIUM] `importLLOrders()` has no `_firestoreReady` guard
**File:** app.js:8985
**Description:** Unlike `importTradeShowProspects` and `importNEMShowAccounts`, the Local Line CSV import does not check `DB._firestoreReady` before writing.
**Impact:** If triggered during the slow-load window, imported data could be overwritten when Firestore snapshot arrives.

### [MEDIUM] CSV prospect import has no duplicate detection
**File:** app.js:4702-4713
**Description:** `_runImportProspects()` appends all parsed prospects without checking for existing records by name. Re-importing the same CSV creates duplicates.
**Impact:** Duplicate prospect records.

### [LOW] Due date math uses `864e5` — off by 1 day during DST
**File:** app.js:1472, 1620, 6042, 7613, 7639
**Description:** `Date.now() + terms * 864e5` assumes 24-hour days. During DST spring-forward/fall-back, a day is 23 or 25 hours, which can shift the computed date.
**Impact:** Due dates could be off by one day twice a year.

### [LOW] Dashboard "needs attention" at 30 days vs Reports "going cold" at 45 days
**File:** app.js:896 vs 7933
**Description:** Dashboard flags accounts at 30 days, but the Going Cold report starts at 45 days. An account at 35 days shows a warning on dashboard but isn't in the report.
**Impact:** Inconsistent visibility of at-risk accounts.

---

## 3. Order Portal Findings

### [HIGH] Zero-quantity orders can be submitted
**File:** order.html:979-998
**Description:** `checkSubmitEnabled()` enables submit if any "notify me" checkbox is checked, even with zero cases. Orders with empty `items` arrays are written to Firestore.
**Impact:** Spam zero-dollar orders in the pipeline.

### [MEDIUM] No graceful handling of expired/invalid tokens
**File:** order.html:806-939
**Description:** Invalid `?t=` tokens silently fall through to the anonymous form. No error message, no "link expired" notice.
**Impact:** Returning users with revoked tokens see confusing anonymous form, may create duplicate accounts.

### [MEDIUM] Race condition in parallel account/prospect token lookup
**File:** order.html:810-938
**Description:** Both `accounts` and `prospects` collection queries fire in parallel. If both find a match (same token in both), one overwrites the other's state.
**Impact:** Rare: order could be attributed to wrong entity.

### [MEDIUM] Partial order writes with no rollback
**File:** order.html:1190-1303
**Description:** Multi-brand orders use `Promise.all([purplPromise, lfPromise])`. If one succeeds and one fails, the successful write persists but the user sees "submission failed". They resubmit, creating a duplicate for the successful brand.
**Impact:** Duplicate orders for one brand.

---

## 4. Email & Cloud Functions Findings

### [HIGH] Rate limiting is in-memory only — not enforced in production
**File:** functions/index.js:15-28
**Description:** `rateLimitMap` is a plain JavaScript `Map` in Cloud Function instance memory. Instances are stateless and auto-scale — each gets a fresh empty Map. Also, `sendEmail`, `sendCombinedInvoice`, and `sendOrderConfirmation` do NOT call `checkRateLimit` at all.
**Impact:** No rate limiting anywhere. Email functions can be called at arbitrary rates.

### [MEDIUM] Resend webhook has no signature validation
**File:** functions/index.js:208-255
**Description:** Accepts any POST without verifying Resend webhook signatures (`svix` headers).
**Impact:** Anyone who knows the endpoint URL can forge open/click tracking events.

### [MEDIUM] Webhook reads/rewrites entire accounts array on every event
**File:** functions/index.js:222-249
**Description:** Reads full `workspace/main/data/store` document, iterates all accounts and cadence entries, writes back. O(n*m) per webhook event. No transaction.
**Impact:** Performance degrades with account count. Concurrent webhooks can overwrite each other.

### [MEDIUM] Combined invoice and order confirmation emails never log cadence entries
**File:** functions/index.js:67-97, 99-185
**Description:** `sendCombinedInvoice` and `sendOrderConfirmation` return the Resend message ID but never write cadence tracking entries to Firestore. The webhook handler looks for `sentMessageId` matches that will never exist.
**Impact:** Open/click tracking is broken for combined invoices and order confirmations.

### [LOW] `submitWholesaleForm` Cloud Function is dead code
**File:** functions/index.js:188-202
**Description:** The wholesale form writes directly to Firestore from the browser, bypassing this function entirely.
**Impact:** Unnecessary deployed function. Wholesale form has no server-side rate limiting.

---

## 5. Firestore Rules Findings

### [CRITICAL] Accounts and prospects collections are publicly readable
**File:** firestore.rules:7-8, 13-14
**Description:** `allow read: if true` on both collections. Anyone with the Firebase config (public in HTML) can read all customer data: names, emails, phones, addresses, portal tokens.
**Impact:** Full PII exposure. Portal tokens can be extracted to impersonate any account.

### [HIGH] Portal order field validation mismatched with LF orders
**File:** firestore.rules:20-22
**Description:** Rules require `items` field and `status == 'new'`. LF orders use `lineItems` and `status: 'pending'`. All LF orders are blocked.
**Impact:** LF ordering completely broken.

### [MEDIUM] Anonymous auth could bypass catch-all rule
**File:** firestore.rules:51-53
**Description:** Catch-all requires `request.auth != null`. If anonymous auth is enabled on the project, anyone can sign in anonymously and get full read/write to the entire CRM database.
**Impact:** If anonymous auth enabled: complete data compromise.

### [MEDIUM] Portal settings publicly readable (pricing exposed)
**File:** firestore.rules:37-38
**Description:** `allow read: if true` on `portal_settings`. Wholesale pricing is exposed.
**Impact:** Competitors can see pricing.

---

## 6. Calculation Audit

### [MEDIUM] Production planning gap: units are correct but labeling is confusing
**File:** app.js:1924-1926
**Description:** `wk` is labeled "weeklyUnits" in velocity data but is actually weekly CASES. The gap calculation correctly converts to cans via `* CANS_PER_CASE`. Math is correct but variable naming is misleading.

### [LOW] Distributor 30-day projection uses integer truncation
**File:** app.js:1983
**Description:** `Math.round(30/avgFreq)*avgVal` — if frequency is 45 days, rounds to 1 full order. If 100 days, rounds to 0. Not proportional.
**Impact:** Over- or under-stated distributor projections.

### [LOW] MoM report shows raw numbers, no percentage change
**File:** app.js:8023-8028
**Description:** Section is labeled month-over-month but shows flat totals without computing % change.

### [LOW] Invoice reminder uses exact-day match for "due in 7 days"
**File:** app.js:1289-1290
**Description:** `if (days !== -7 && days <= 0) return;` — only surfaces invoices on exactly the 7-days-before date. Invoices due in 6, 5, 4, 3, 2, 1 days are skipped.
**Impact:** One-day reminder window — easy to miss.

---

## 7. UI State & Service Worker Findings

### [MEDIUM] Multiple modals can stack without closing previous
**File:** app.js:9244-9253
**Description:** `openModal(id)` adds `'open'` class without closing any currently-open modal. Some call sites manually close first (inconsistent).
**Impact:** Two overlays visible simultaneously; backdrop click may only close one.

### [MEDIUM] Service worker has no "new version available" notification
**File:** sw.js:1-39
**Description:** Uses `skipWaiting()` + `clients.claim()` for immediate activation. Network-first strategy. But the initial page load that triggered the update runs old JS. No mechanism to notify user of new version.
**Impact:** After deploy, users run old code until hard refresh. If data structures changed, could cause errors.

### [LOW] Tab state in modals resets on each open
**File:** app.js:2435-2436
**Description:** Always clicks first tab when opening account/prospect modal. Last-viewed tab not preserved.
**Impact:** Minor UX friction.

### [LOW] Stale data after navigation — NOT a bug
**Description:** Each `nav()` call triggers fresh `DB.a()` reads. Real-time listener refreshes on remote changes. Well-designed.

---

## 8. Security Summary

| Issue | Severity | Status |
|-------|----------|--------|
| Accounts/prospects publicly readable | CRITICAL | Rules deployed but `allow read: if true` still present |
| LF portal orders blocked by rules | HIGH | New rules break LF ordering |
| XSS via wholesale application JSON | HIGH | Unpatched |
| No rate limiting on emails | HIGH | No server-side enforcement |
| Zero-quantity orders accepted | HIGH | No validation |
| Anonymous auth catch-all bypass | MEDIUM | Depends on project config |
| No webhook signature validation | MEDIUM | Unpatched |

---

## 9. Priority Fix List

### Must Fix Immediately
1. **Fix Firestore rules** — allow LF orders (`status in ['new','pending']`, accept both `items` and `lineItems`)
2. **Fix `saveSettings()` payment_terms** — read from correct DOM element
3. **Fix `deleteAccount()`** — add cleanup for `lf_invoices`, `combined_invoices`, `pending_invoices`
4. **Fix wholesale application XSS** — escape JSON in onclick attributes properly
5. **Lock down accounts/prospects read rules** — restrict to token-based queries only (requires restructuring portal lookup)

### Should Fix Soon
6. Add `_firestoreReady` guard to `importLLOrders()`
7. Add duplicate detection to CSV prospect import
8. Fix inventory return counting consistency
9. Fix invoice reminder to show "due within 7 days" range, not exact day
10. Add webhook signature validation to Resend endpoint
11. Add cadence logging to combined invoice / order confirmation emails

### Fix When Possible
12. Add rate limiting to email Cloud Functions
13. Add "new version available" banner to service worker
14. Fix modal stacking (close previous before opening new)
15. Align dashboard attention (30d) and report cold (45d) thresholds
16. Make `calcOrderValue` use user's `target_margin` setting

---

*Generated by automated audit — 2026-04-17*
