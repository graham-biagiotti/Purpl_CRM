# FOUNDATION_REVIEW.md -- Purpl CRM

**Date:** 2026-06-25
**Scope:** Firestore security rules, data model architecture, Cloud Functions trust boundaries, account detail tab data reconciliation

---

## Part 1: Backend Foundation Audit

---

### 1a. Firestore Security Rules

Source: `firestore.rules`

#### Architecture Overview

The rules file defines explicit matches for `users`, `accounts`, `prospects`, `portal_orders`, `portal_notify`, `portal_inquiries`, `portal_settings`, and `workspace/{path=**}`. All other collections fall through to a global catch-all: `match /{document=**} { allow read, write: if request.auth != null; }`. This is an **allow-by-default** posture for authenticated users.

#### Collection-Level Access Matrix

| Collection | READ | WRITE (create) | WRITE (update) | WRITE (delete) |
|---|---|---|---|---|
| `users/{userId}` | Own doc or admin | Self only | Admin only | Admin only |
| `accounts/{accountId}` | Any authed | Any authed | Any authed | Any authed |
| `prospects/{prospectId}` | Any authed | Any authed | Any authed | Any authed |
| `portal_orders/{orderId}` | **Anyone (incl. unauthed)** | **Anyone (incl. unauthed)** | Any authed | Admin only |
| `portal_notify/{docId}` | Any authed | **Anyone (incl. unauthed)** | Any authed (via catch-all) | Any authed |
| `portal_inquiries/{docId}` | Any authed | **Anyone (incl. unauthed)** | Any authed | Any authed |
| `portal_settings/{docId}` | Any authed | Admin only | Admin only | Admin only |
| `portal_tokens` | Any authed (catch-all) | Any authed (catch-all) | Any authed (catch-all) | Any authed (catch-all) |
| `portal_config` | Any authed (catch-all) | Any authed (catch-all) | Any authed (catch-all) | Any authed (catch-all) |
| `workspace/{path=**}` | Any authed | Any authed | Any authed | Any authed |

#### Findings

**[CRITICAL] SR-1: Privilege escalation via user document creation**

- **Description:** The `create` rule on `users/{userId}` is `request.auth != null && request.auth.uid == userId` with no field validation.
- **Current behavior:** A new user can create their own user document with `{role: 'admin'}`, granting themselves admin privileges across the entire system. The `isAdmin()` helper reads `role` from this document.
- **Risk:** Complete authorization bypass. Any user who signs up via Firebase Auth (Google sign-in is open by default) can self-elevate to admin, gaining write access to `portal_settings`, delete access to `portal_orders`, and `inviteEmployee` Cloud Function access.
- **Proposed fix:** Add field validation to the `create` rule: `&& request.resource.data.role == 'viewer'` or `&& !('role' in request.resource.data)`. Alternatively, create user documents exclusively via an `auth.onCreate` Cloud Function using the Admin SDK.

**[CRITICAL] SR-2: Public read on portal_orders leaks customer PII**

- **Description:** The rule `allow read: if true` on `portal_orders` permits unauthenticated list and get operations.
- **Current behavior:** Any unauthenticated user can call `db.collection('portal_orders').get()` and retrieve all orders, including `accountName`, `billingEmail`, order items, and notes.
- **Risk:** Customer PII exposure. Billing emails, company names, order contents, and delivery addresses are publicly enumerable.
- **Proposed fix:** Change read rule to `allow read: if request.auth != null` or restrict to admin. The create validation (field presence, type checks, size limits) is well-implemented and should be retained.

**[HIGH] SR-3: Global catch-all rule is allow-by-default**

- **Description:** `match /{document=**}` with `allow read, write: if request.auth != null` grants full CRUD on every collection not explicitly matched.
- **Current behavior:** `portal_tokens`, `portal_config`, and any future collection added to the app are immediately readable and writable by all authenticated users.
- **Risk:** `portal_tokens` -- if used for portal authentication, any signed-in user can read, forge, or delete tokens for other users. `portal_config` -- any authenticated user can overwrite application configuration. New collections added during development inherit permissive access by default.
- **Proposed fix:** Remove the catch-all rule. Define explicit rules for each collection. At minimum, restrict the catch-all to `isAdmin()`.

**[HIGH] SR-4: Audit log writable by any authenticated user**

- **Description:** `workspace/main/audit_log` falls under `match /workspace/{path=**}` which grants full read/write to any authenticated user.
- **Current behavior:** Any signed-in user can create, modify, or delete audit log entries.
- **Risk:** Defeats the purpose of an audit trail. A user who performs an unauthorized action can delete the corresponding audit entry.
- **Proposed fix:** Make `audit_log` read-only at the rules level. All writes should go through the Admin SDK (Cloud Functions).

**[MEDIUM] SR-5: No role-based access within workspace data**

- **Description:** All workspace subcollections (`ac`, `pr`, `iv`, `retail_invoices`, `lf_invoices`, `combined_invoices`, `dist_invoices`, `orders`, `invoice_settings`, `production`, `cadence`, `lf_skus`, `lf_wix_deductions`, `dist_profiles`) are equally accessible to every authenticated user.
- **Current behavior:** There is no distinction between a read-only viewer and a full admin within CRM data.
- **Risk:** Any authenticated user can modify or delete financial records, invoices, orders, and production data.
- **Proposed fix:** Introduce role-based conditions on write operations within the workspace match, e.g., `allow write: if isAdmin() || isEmployee()`.

**[MEDIUM] SR-6: portal_config not explicitly protected**

- **Description:** `portal_config` falls through to the permissive catch-all, unlike `portal_settings` which correctly requires admin for writes.
- **Current behavior:** Any authenticated user can overwrite portal configuration values.
- **Risk:** Configuration tampering (e.g., changing `mode` or `pricePerCase` values that affect portal behavior).
- **Proposed fix:** Add an explicit match for `portal_config` with `allow write: if isAdmin()`.

**[MEDIUM] SR-7: accounts and prospects have no ownership model**

- **Description:** Both top-level `accounts` and `prospects` collections use `allow read, write: if request.auth != null` with no ownership or role check.
- **Current behavior:** Any authenticated user can delete or overwrite any account or prospect record.
- **Risk:** If Firebase Auth with Google sign-in is open, a user who signs up can immediately modify all account and prospect data.
- **Proposed fix:** Restrict writes to admin/employee roles, or add ownership checks.

---

### 1b. Data Model

Source: `public/app.js`, `public/db.js`

#### Architecture Overview

The CRM has undergone a migration from single-document storage to per-collection storage. The canonical CRM data lives under `workspace/main/*` subcollections (`ac`, `pr`, `iv`, `retail_invoices`, `lf_invoices`, `combined_invoices`, `dist_invoices`, `orders`, etc.). Top-level `accounts` and `prospects` collections exist as portal token lookup mirrors. Invoices are split across five collections.

#### Findings

**[CRITICAL] DM-1: Year-end tax export omits distributor invoices**

- **Description:** `exportYearEnd` (lines 10034-10074) exports paid invoices from `retail_invoices`, `lf_invoices`, and `combined_invoices` but does NOT include `dist_invoices`.
- **Current behavior:** Paid distributor invoices are completely absent from the tax export CSV.
- **Risk:** Financial reporting gap. Tax filings based on this export will understate revenue from distributor channels.
- **Proposed fix:** Add `DB.a('dist_invoices').filter(...)` to the `exportYearEnd` aggregation, with the same paid-status and date-range filters applied to other collections.

**[CRITICAL] DM-2: markInvoiceSent silently fails for combined/dist invoices**

- **Description:** `markInvoiceSent` (line 15289) uses `findInvoice(id)` and `_invoiceCol(id)`, which search only `retail_invoices`, `lf_invoices`, and `iv`.
- **Current behavior:** If called with a combined or distributor invoice ID, `findInvoice` returns null, `_invoiceCol` falls back to `'iv'`, and `DB.update('iv', id, ...)` writes to a nonexistent record. The db.js warning at line 479 is logged but no error surfaces to the user.
- **Risk:** Invoice sent status is silently lost. If a future code path or the unified list exposes a "Mark Sent" action for these invoice types, the operation will appear to succeed but have no effect.
- **Proposed fix:** Extend `findInvoice` and `_invoiceCol` to search `combined_invoices` and `dist_invoices`, or add explicit `markCombinedSent` / `markDistSent` functions.

**[HIGH] DM-3: Top-level accounts/prospects diverge from workspace data**

- **Description:** Top-level `accounts/{id}` and `prospects/{id}` collections store a subset of fields (`orderPortalToken`, `name`, `email`, `isPbf`) as a portal token lookup mirror. There is no sync mechanism.
- **Current behavior:** When an account's name or email is edited in the CRM (`DB.update('ac', ...)`), the top-level `accounts/{id}` document is NOT updated. `_renderPoLinks` (line 13939) reads only from the top-level collection and shows stale names. The `lookupPortalToken` Cloud Function (functions/index.js line 406) searches the top-level collection first and returns stale `accountName`/`accountEmail`.
- **Risk:** Portal order links display outdated account names. Customer-facing order confirmations may use outdated email addresses.
- **Proposed fix:** Either (a) update the top-level document whenever the workspace document is updated, or (b) eliminate the top-level collection and have `lookupPortalToken` query `workspace/main/ac` directly.

**[HIGH] DM-4: No unified invoice lookup spans all five collections**

- **Description:** There is no `_allInvoices()` helper. Each aggregation site re-implements multi-collection logic.
- **Current behavior:**
  - `_allPurplInvoices()` (line 44): `retail_invoices` + `iv` (purpl brand only).
  - `findInvoice()` (line 48): `retail_invoices`, `lf_invoices`, `iv` (misses `combined_invoices`, `dist_invoices`).
  - `_invoiceCol()` (line 53): `retail_invoices`, `lf_invoices` (falls back to `iv` for unknown IDs).
  - `deleteInvoiceWithCleanup(id)` (line 59-78): `retail_invoices`, `lf_invoices`, `iv` only.
- **Risk:** Every new feature that touches invoices must manually assemble the correct collection set. Omissions produce silent data gaps (as evidenced by DM-1, DM-5, DM-6).
- **Proposed fix:** Create a single `_allInvoices()` helper that unions all five collections, with optional brand/type filters. Refactor `findInvoice`, `_invoiceCol`, and `deleteInvoiceWithCleanup` to use it.

**[MEDIUM] DM-5: Dashboard draft count omits dist_invoices**

- **Description:** The dashboard quick-action "Draft invoices to send" badge (lines 1195-1197) aggregates drafts from `retail_invoices`, `lf_invoices`, and `combined_invoices`.
- **Current behavior:** Distributor draft invoices are not counted. Users do not see a badge prompting them to send distributor drafts.
- **Risk:** Distributor drafts may sit unsent without visibility.
- **Proposed fix:** Add `DB.a('dist_invoices').filter(x => x.status === 'draft' && ...)` to the draft count.

**[MEDIUM] DM-6: Reports "Total Invoiced" label is misleading**

- **Description:** The KPI at lines 9237-9242 is labeled "Total Invoiced (All Brands)" but excludes `dist_invoices`.
- **Current behavior:** The reported total understates actual invoiced revenue.
- **Risk:** Misleading financial reporting. Users may believe the total is comprehensive when it is not.
- **Proposed fix:** Either add `dist_invoices` to the sum, or change the label to "Total Invoiced (Purpl + LF)".

**[MEDIUM] DM-7: Going Cold report only checks purpl outstanding**

- **Description:** The Going Cold report (line 9365) uses `_allPurplInvoices()` to check for outstanding invoices.
- **Current behavior:** For each cold account, only purpl-brand outstanding invoices are shown. If an account has unpaid LF or distributor invoices, they are not included.
- **Risk:** An account with significant unpaid LF invoices could appear to have zero outstanding balance in the cold report.
- **Proposed fix:** Include `lf_invoices` and `dist_invoices` outstanding amounts.

**[LOW] DM-8: iv collection serves dual duty**

- **Description:** The `iv` collection holds both inventory ledger entries (`type: 'in'/'out'/'return'`) and legacy invoice records (items with `number`/`invoiceNumber`).
- **Current behavior:** Inventory functions filter on `i.type==='in'`/`i.type==='out'`, so legacy invoice records are correctly excluded. But every inventory calculation iterates through the full `iv` collection including invoice records.
- **Risk:** No correctness bug, but increased working set size and potential confusion for developers.
- **Proposed fix:** Migrate remaining legacy invoice records out of `iv` into `retail_invoices`, then enforce that `iv` only contains inventory entries.

**[LOW] DM-9: prod_hist/runs/shipments migration performs unnecessary reads**

- **Description:** The migration code in `db.js` (lines 109-134) re-reads the config doc on every `_loadAll()` call, even after the one-time migration has completed.
- **Current behavior:** The guard (`Array.isArray(arr) && arr.length > 0`) prevents re-migration, but the extra Firestore read on every app init is unnecessary overhead.
- **Risk:** Minor performance cost (one extra Firestore read per app load).
- **Proposed fix:** Set a `migrationComplete` flag on the config doc and skip the read when the flag is present.

---

### 1c. Cloud Functions Trust Boundaries

Source: `functions/index.js`

#### Architecture Overview

The backend exposes 18 Cloud Functions: 14 `onCall` functions and 4 `onRequest` webhooks. Authentication patterns vary: some are admin-gated, some require any auth, and some are intentionally public (portal-facing). Two webhooks accept inbound requests from Stripe and ShipStation.

#### Findings

**[CRITICAL] TB-1: ShipStation webhook has no signature validation and leaks API credentials**

- **Description:** `shipStationWebhook` is an `onRequest` endpoint that performs no verification of the caller's identity. ShipStation webhooks lack a native signature mechanism, and this function implements no alternative (IP allowlist, shared secret, etc.).
- **Current behavior:** The function reads `payload.resource_url` from the request body and fetches that URL using the ShipStation API key in the `Authorization` header. If an attacker discovers the endpoint URL and POSTs a request with `resource_url` pointing to a server they control, the ShipStation API key is sent to that server. All shipment data from the fetched resource is trusted and used to: update invoice tracking/totals/dates, add shipping cost line items and recalculate totals, set `readyToSend` flags, send customer-facing emails, deduct inventory (3 cans for SAMPLE- orders), and create audit log entries.
- **Risk:** Credential theft (ShipStation API key). Remote invoice/inventory manipulation. Ability to send emails to customers and create fraudulent audit entries.
- **Proposed fix:** Validate that `resource_url` starts with `https://ssapi.shipstation.com/`. Additionally, implement a shared-secret query parameter in the webhook URL configuration, or restrict inbound requests to ShipStation's published IP ranges.

**[CRITICAL] TB-2: createPayLink / createStripePaymentLink accept client-supplied prices**

- **Description:** Both `createPayLink` and `createStripePaymentLink` are `onCall` functions that use `data.amount` directly as the Stripe `unit_amount` without server-side verification.
- **Current behavior:** Any authenticated user can create a Stripe checkout session for any amount (minimum $0.50) against any invoice. The `stripeWebhook` marks the invoice as paid based on metadata (`invoiceId`, `invoiceType`) that was set from unverified client data. A user could generate a payment link for $0.50 on a $5,000 invoice, complete payment, and the webhook would mark the invoice as fully paid.
- **Risk:** Revenue loss. Invoices can be marked paid for arbitrary amounts below their actual total.
- **Proposed fix:** In both functions, look up the invoice by `data.invoiceId` and `data.invoiceType` in Firestore and use the server-side total as the Stripe `unit_amount`. Reject the request if the client-supplied amount does not match.

**[CRITICAL] TB-3: sendOrderConfirmation allows unauthenticated HTML injection into emails**

- **Description:** `sendOrderConfirmation` is a public `onCall` function (no auth check). It injects `data.orderSummary` as raw HTML into the email body at line 151: `${data.orderSummary || ''}`.
- **Current behavior:** An unauthenticated caller can send emails with arbitrary HTML content to any email address (`data.to`) using the business's branded email domain. The caller also controls `data.accountId` (can write cadence entries to any account) and `data.portalOrderId` (can write emailLog entries to any portal_orders document).
- **Risk:** Phishing attacks using the business's legitimate email domain. Arbitrary Firestore document writes via `accountId` and `portalOrderId`.
- **Proposed fix:** Either require authentication, or escape `data.orderSummary` before insertion. Restructure `orderSummary` as structured data (item names, quantities, prices) that the server renders into a fixed HTML template.

**[HIGH] TB-4: sendApplicationConfirmation is a branded-email spam vector**

- **Description:** `sendApplicationConfirmation` is a public `onCall` function that sends branded emails to `data.to` without authentication.
- **Current behavior:** While the email template is fixed (no arbitrary HTML injection), an attacker can send the business's branded confirmation email to any email address. The `data.inquiryDocId` parameter allows unauthenticated writes to arbitrary `portal_inquiries` documents (setting `confirmationEmailFailed` flag and `emailLog` entries).
- **Risk:** Spam/phishing from the business's email domain (recipients see a legitimate sender). Arbitrary Firestore writes.
- **Proposed fix:** Rate-limit by IP or require a CAPTCHA token. Validate that `inquiryDocId` corresponds to a recently-created inquiry with matching `data.to` email.

**[HIGH] TB-5: verifyPortalPassword uses plaintext comparison with no rate limiting**

- **Description:** `verifyPortalPassword` is a public `onCall` function that compares `data.password` via plaintext equality (`pw === stored`) against a value stored in Firestore.
- **Current behavior:** No hashing, no rate limiting, no brute-force protection. JavaScript `===` string comparison is not constant-time, making the function susceptible to timing attacks.
- **Risk:** Password compromise via brute force or timing attack.
- **Proposed fix:** Hash the stored password (bcrypt/scrypt). Implement rate limiting (e.g., Firebase App Check, or a counter with exponential backoff). Use a constant-time comparison function.

**[HIGH] TB-6: lookupPortalToken returns PII with no rate limiting**

- **Description:** `lookupPortalToken` is a public `onCall` function that accepts a token (minimum 5 characters) and returns `accountName`, `accountEmail`, `address`, `portalPrefs`, and `accountId`.
- **Current behavior:** No rate limiting. Searches `accounts`, `prospects`, and `workspace/main/ac` collections sequentially.
- **Risk:** Token brute-force could enumerate accounts and leak PII (names, emails, full addresses).
- **Proposed fix:** Increase minimum token length. Implement rate limiting. Consider returning only the information needed for portal operation (e.g., account name for display) rather than full address and preferences.

**[MEDIUM] TB-7: sendEmail / sendCombinedInvoice allow arbitrary HTML and have no IDOR protection**

- **Description:** Both are authenticated `onCall` functions that accept `data.html` (arbitrary HTML sent to Resend unsanitized) and `data.accountId` (used for cadence logging without ownership verification).
- **Current behavior:** Any authenticated user can send arbitrary HTML emails via the business's email domain and write cadence entries to any account.
- **Risk:** Email abuse by any authenticated user. Cadence data pollution across accounts.
- **Proposed fix:** Restrict to admin/employee roles. Validate that `accountId` belongs to the caller's assigned accounts (if ownership model exists) or restrict cadence writes to admin.

**[MEDIUM] TB-8: callAnthropic has no RBAC**

- **Description:** `callAnthropic` is an authenticated `onCall` function with no role check.
- **Current behavior:** Any authenticated user (not just admins) can proxy requests to the Anthropic API with arbitrary system prompts. Input is validated (string type, 5000 char cap on `data.prompt`), but `data.systemPrompt` has no restrictions.
- **Risk:** API cost abuse. Potential for prompt injection if system prompts are not restricted.
- **Proposed fix:** Add `isAdmin()` or `isEmployee()` role check.

**[MEDIUM] TB-9: pushToShipStation trusts all client data without Firestore verification**

- **Description:** `pushToShipStation` is an authenticated `onCall` function. All line items (`sku`, `name`, `quantity`, `unitPrice`), shipping address (`shipTo`), and order metadata are taken directly from client data.
- **Current behavior:** No server-side verification against actual invoice or order records in Firestore. An authenticated user could push fabricated orders to ShipStation.
- **Risk:** Fraudulent shipments, incorrect inventory deductions (when ShipStation webhook fires back).
- **Proposed fix:** Look up the invoice/order by ID in Firestore and use server-side data for line items, quantities, and addresses.

**[MEDIUM] TB-10: stripeWebhook inherits trust boundary violation from createPayLink**

- **Description:** `stripeWebhook` correctly validates the Stripe signature. However, the metadata it uses to identify and mark invoices as paid (`session.metadata.invoiceId`, `session.metadata.invoiceType`) was originally set by `createPayLink`/`createStripePaymentLink` from unverified client data.
- **Current behavior:** A manipulated payment link (wrong amount or wrong invoiceId) causes the webhook to mark the wrong invoice as paid or mark an invoice paid for the wrong amount. Has idempotency via `stripeEventId` (good). Has orphan payment handling (good).
- **Risk:** Downstream effect of TB-2. The webhook is technically secure but operates on tainted metadata.
- **Proposed fix:** Fixing TB-2 (server-side amount verification) resolves this issue.

**[LOW] TB-11: checkDuplicateApplication is an email enumeration oracle**

- **Description:** Public `onCall` function that accepts `data.email` and returns a boolean `exists` value.
- **Current behavior:** An attacker can test whether specific email addresses have submitted portal applications.
- **Risk:** Low -- reveals only whether an email exists in `portal_inquiries`, not account data.
- **Proposed fix:** Add rate limiting or CAPTCHA.

**[LOW] TB-12: stripeStatus creates real Stripe sessions without RBAC**

- **Description:** Authenticated `onCall` function that creates a real $1.00 Stripe checkout session as a connectivity test.
- **Current behavior:** Any authenticated user can trigger creation of real Stripe sessions.
- **Risk:** Low -- the session amount is fixed and the purpose is diagnostic. Could be abused at volume.
- **Proposed fix:** Restrict to admin role.

---

### Foundation Verdict

**Is this backend a sound foundation to keep building on?**

The backend is functional and serves the current user base, but it has structural weaknesses that become increasingly dangerous as the application grows or is exposed to untrusted users.

**The three most urgent problems are:**

1. **The security rules operate on an allow-by-default posture.** The global catch-all grants any authenticated user full access to every collection not explicitly matched, including `portal_tokens` and `audit_log`. Combined with the user document creation vulnerability (SR-1), a brand-new Google sign-in user can self-elevate to admin and access everything. This is the single highest-priority fix.

2. **The Stripe payment flow trusts client-supplied prices.** Any authenticated user can create a payment link for an arbitrary amount and have invoices marked as paid via the webhook. This is a direct revenue-loss vulnerability.

3. **The ShipStation webhook has no authentication and leaks API credentials.** An attacker who discovers the endpoint URL can steal the ShipStation API key, manipulate invoices, send emails to customers, and deduct inventory.

The data model is workable but carries accumulated technical debt from the invoice collection split. The lack of a unified invoice helper means every aggregation site is a potential omission bug, and the year-end tax export already has one (DM-1). The top-level `accounts`/`prospects` mirror collections (DM-3) will continue to diverge from workspace data without a sync mechanism.

**Recommendation:** Fix the three critical security issues (SR-1, TB-1, TB-2) before adding new features. The data model issues (DM-1 through DM-7) are correctness bugs that should be addressed in the next development cycle. The remaining security rules (SR-3 through SR-7) should be hardened as part of a dedicated security sprint.

The foundation is salvageable but not sound in its current state. Building new features on top of these trust boundary violations will compound the risk.

---

## Part 2: Account Detail Tab -- Data Reconciliation

---

### Metric-by-Metric Trace

#### 1. Outstanding Balance

| View | Source | Collections | Status |
|---|---|---|---|
| Account card "Outstanding" (line 2999) | `DB.a('orders').filter(o => o.accountId === a.id && o.status === 'delivered' && (o.invoiceStatus \|\| 'none') !== 'paid')` | `orders` only | **DISCREPANCY** |
| Statement of Account (line 12722) | `_allPurplInvoices()` + `lf_invoices` + `combined_invoices`, children excluded, parents counted | `retail_invoices`, `iv`, `lf_invoices`, `combined_invoices` | RECONCILES internally |
| Dashboard outstanding (lines 1339-1342) | `_allPurplInvoices()` + `lf_invoices`, children included, combined parents excluded | `retail_invoices`, `iv`, `lf_invoices` | RECONCILES (children sum equals parent grandTotal) |
| Invoices sub-tab (line 12827) | No outstanding total displayed | -- | N/A |

**Finding:** The card-level "Outstanding" is an order-based count of delivered-but-unpaid orders, not an invoice-based dollar sum. It is a fundamentally different measure than the invoice-based outstanding shown on the dashboard and statement. Invoices created independently of orders (e.g., via "New Invoice") never appear in this count. `dist_invoices` are absent from all account-level outstanding calculations. No single view on the account detail tab shows a dollar-denominated outstanding total -- the user must click "Statement" to see one.

#### 2. Total Cans / Cases Sold

**Status: N/A** -- Not displayed anywhere on the account detail tab. The order history table (line 3268) shows `x${i.qty}` per line item without unit labels. Since `qty` is in cases (confirmed by `createOrder` at line 8373), "x2" means 2 cases (24 cans), but this is ambiguous to the user. The Portal Orders sub-tab (line 14699) correctly shows both Cases and Cans columns.

#### 3. Velocity / Order Count

| Metric | Source | Filter | Status |
|---|---|---|---|
| Velocity (card, lines 2984-2997) | `DB.a('orders').filter(o => o.accountId === a.id && o.status !== 'cancelled')` | Excludes cancelled; uses `dueDate` for intervals | RECONCILES |
| Order history (detail, line 3265) | `DB.a('orders').filter(o => o.accountId === id)` | No status filter; sorted by `created` desc; limited to 8 | RECONCILES |

**Finding:** Velocity excludes cancelled orders; the history table includes them. This is intentional (velocity should ignore cancellations). Both pull from the `orders` collection by `accountId`. No double-count risk from combined invoices or per-location records. Multi-location accounts have exactly one `accountId`, so all orders aggregate correctly.

**Verdict: RECONCILES**

#### 4. Last Order Date

| View | Source | Updated by |
|---|---|---|
| Card (line 2976) | `a.lastOrder` flat field | `createOrder` (line 8386), run-based order (line 8911), portal approval (line 14488) |
| Detail modal (line 3242) | `a.lastOrder` flat field | Same |

**Finding:** `lastOrder` is set to `today()` when an order is created, NOT to the order's `dueDate`. If a user creates a future-dated order, `lastOrder` reflects today. When the most recent order is deleted (line 8452+), `lastOrder` is NOT recalculated -- it retains the stale date from the deleted order. The field can become permanently wrong.

**Verdict: DISCREPANCY** -- stale on order deletion; semantic mismatch with velocity (which uses `dueDate`).

#### 5. Last Contacted Date

| View | Source |
|---|---|
| Card (line 2980) | `acLastContacted(a)` -- checks `a.notes[last].date` and `a.outreach[last].date` |
| Detail modal (line 3273) | `acLastContacted(a)` -- same |

| Update path | Sets `a.lastContacted`? | Appends to notes/outreach? |
|---|---|---|
| `addAccountNote` (detail modal, line 3382) | YES | YES |
| `quickNote` (card button, line 5661) | **NO** | YES |
| `saveLogOutreach` (line 5739) | YES | YES |
| Email cadence sends (lines 678, 689) | YES | YES |

**Finding:** `quickNote` appends a note to `a.notes[]` but does NOT update `a.lastContacted`. The card display uses `acLastContacted()` which derives the date from `notes[last].date`, so the card appears correct. But any code that reads `a.lastContacted` directly (lines 4488, 4491, 4505, 4520, 4778, 4844, 3867 -- filters, reports, cadence logic) will see stale data. Additionally, `acLastContacted()` only checks the LAST element of `a.notes[]` and `a.outreach[]`, assuming chronological append order. Backdated entries would produce incorrect results.

**Verdict: DISCREPANCY** -- card display is correct but `a.lastContacted` flat field diverges after `quickNote`. Filters and reports that use the flat field show stale data.

#### 6. Buttons

All 22 buttons across the account card and detail modal were traced:

| # | Button | Function | Status |
|---|---|---|---|
| 1 | New Invoice (header, line 3219) | `openAddInv(id)` | RECONCILES |
| 2 | Email (header, line 3220) | `_macGoToEmailsTab()` | RECONCILES |
| 3 | Statement (header, line 3221) | `printAccountStatement(id)` | RECONCILES (dist_invoices omitted, see #1) |
| 4 | Edit (overview, line 3325) | `editAccount(id)` | RECONCILES |
| 5 | New Order (overview, line 3326) | `openNewOrder(id)` | RECONCILES |
| 6 | AI Draft (overview, line 3328) | `openDraftOutreachModal(id)` | RECONCILES |
| 7 | Copy Link (overview, line 3332) | `copyOrderLink(id)` | RECONCILES |
| 8 | Add Note (notes tab, line 3372) | `addAccountNote(id)` | RECONCILES |
| 9 | Log Follow-Up (outreach tab, line 3322) | `openLogOutreachModal('ac', id)` | RECONCILES |
| 10 | Log Sample (samples tab, line 3568) | `openLogSampleModal('ac', accountId)` | RECONCILES |
| 11 | Send Sample (samples tab, line 3570) | ShipStation push | RECONCILES |
| 12 | Mark Done (samples tab, line 3600) | `markSampleFollowUpDone` | RECONCILES |
| 13 | Copy Order Link (portal tab, line 14689) | `copyOrderLink(accountId)` | RECONCILES |
| 14 | Statement (invoices tab, line 12909) | `printAccountStatement` | RECONCILES |
| 15 | Preview (invoices tab, line 12875) | `openCombinedInvoicePreview` | RECONCILES |
| 16 | Create Combined (invoices tab, line 12902) | `manualCreateCombined` | RECONCILES |
| 17 | View (card, line 3063) | `openAccount(id)` | RECONCILES |
| 18 | Note (card, line 3064) | `quickNote(id)` | **PARTIAL** -- does not update `a.lastContacted` |
| 19 | Log Follow-Up (card, line 3065) | `logOutreach(id)` | RECONCILES |
| 20 | + Run (card, line 3066) | `addAccountToRun(id)` | RECONCILES |
| 21 | Edit (card, line 3067) | `editAccount(id)` | RECONCILES |
| 22 | Copy Link (card, line 3068) | `generateOrderLink(...)` | RECONCILES |

No button targets a wrong element ID or no-ops. All `onclick` handlers reference valid function names. Element IDs use the `#mac-` prefix consistently within the account modal.

**Verdict: RECONCILES** (one partial discrepancy on `quickNote` propagation, documented in #5 above).

#### 7. Per-Location Records

Locations are stored as `a.locs[]` on the account record (lines 3006, 3247, 5063). Orders, invoices, notes, outreach, and samples are stored at the ACCOUNT level with no `locationId` field. All metrics aggregate by `accountId` across all locations. Adding or removing locations does not create or remove transaction records.

**Verdict: RECONCILES** -- no per-location decomposition exists, so no double-counting or omission is possible.

---

### Reconciliation Summary

| Metric | Status | Root Cause |
|---|---|---|
| Outstanding Balance (card) | **DISCREPANCY** | Order-based count vs. invoice-based dollars; dist_invoices absent |
| Outstanding Balance (statement) | RECONCILES | Correct multi-collection sum with double-count avoidance |
| Total Cans/Cases Sold | N/A | Not displayed |
| Velocity | RECONCILES | Consistent order-based calculation |
| Order Count/History | RECONCILES | Status filter differs from velocity (intentional) |
| Last Order | **DISCREPANCY** | Stale on order deletion; uses creation date not dueDate |
| Last Contacted | **DISCREPANCY** | `quickNote` skips `a.lastContacted` flat field update |
| Buttons (22 total) | RECONCILES | All functional; quickNote propagation noted |
| Per-Location Records | RECONCILES | All data is account-level; no decomposition |

---

## Prioritized Action List

### Immediate (security -- do before next deploy)

| # | Finding | Action |
|---|---|---|
| 1 | SR-1 | Add field validation to `users/{userId}` create rule to prevent self-elevation to admin |
| 2 | SR-2 | Change `portal_orders` read rule from `if true` to `if request.auth != null` |
| 3 | TB-1 | Validate `resource_url` origin in `shipStationWebhook`; add shared-secret query parameter |
| 4 | TB-2 | Server-side invoice amount lookup in `createPayLink` / `createStripePaymentLink` |
| 5 | TB-3 | Escape or restructure `data.orderSummary` in `sendOrderConfirmation`; add rate limiting |

### Short-term (security hardening -- next sprint)

| # | Finding | Action |
|---|---|---|
| 6 | SR-3 | Remove global catch-all rule; define explicit rules per collection |
| 7 | SR-4 | Make `audit_log` read-only at rules level; write only via Admin SDK |
| 8 | TB-4 | Rate-limit `sendApplicationConfirmation`; validate `inquiryDocId` |
| 9 | TB-5 | Hash portal password; add rate limiting to `verifyPortalPassword` |
| 10 | TB-6 | Increase token length; rate-limit `lookupPortalToken` |

### Medium-term (data model -- next development cycle)

| # | Finding | Action |
|---|---|---|
| 11 | DM-1 | Add `dist_invoices` to `exportYearEnd` |
| 12 | DM-4 | Create unified `_allInvoices()` helper; refactor `findInvoice`, `_invoiceCol`, `deleteInvoiceWithCleanup` |
| 13 | DM-2 | Extend `markInvoiceSent` to handle combined and dist invoices |
| 14 | DM-3 | Sync top-level accounts/prospects on workspace update, or eliminate the mirror |
| 15 | DM-5 | Add `dist_invoices` to dashboard draft count |
| 16 | DM-6 | Fix "Total Invoiced (All Brands)" label or add dist_invoices to sum |
| 17 | DM-7 | Add LF and dist outstanding to Going Cold report |

### Low-priority (reconciliation and UX)

| # | Finding | Action |
|---|---|---|
| 18 | Outstanding (Part 2, #1) | Replace order-based card "Outstanding" with invoice-based dollar sum, or relabel |
| 19 | Last Order (Part 2, #4) | Recalculate `lastOrder` on order deletion |
| 20 | Last Contacted (Part 2, #5) | Update `a.lastContacted` in `quickNote` to match `addAccountNote` behavior |
| 21 | DM-8 | Migrate legacy invoice records out of `iv` collection |
| 22 | DM-9 | Skip migration read when `migrationComplete` flag is set |
