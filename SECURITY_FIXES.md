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

