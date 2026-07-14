# 13 — External-System Dependencies & Registration Requirements

Scope: everything the code assumes exists **outside this repo** — secrets, dashboard registrations, DNS, and Firestore config docs — that code review cannot validate. Verified against `functions/index.js`, `public/*.js`, `firebase.json`, `.firebaserc` as of 2026-07-14.

Deployment evidence worth knowing up front: Firebase v2 functions **fail to deploy** if a `defineSecret` secret does not exist in Secret Manager. Since the app is live, all five declared secrets (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SHIPSTATION_API_KEY`) **exist** — but existence says nothing about the *value* being correct, nor about the external-side registrations (webhook endpoints, domain verification, DNS) that pair with them.

---

## 1. Firebase Secrets (Secret Manager)

Declared at `functions/index.js:11-15`. Which functions mount which secret:

| Secret | Mounted by (functions) | Where read |
|---|---|---|
| `RESEND_API_KEY` | `sendEmail` (27), `sendCombinedInvoice` (69), `sendOrderConfirmation` (112), `sendApplicationConfirmation` (287), `inviteEmployee` (827), `shipStationWebhook` (1385) | `process.env.RESEND_API_KEY` (39, 78, 229, 354, 879, 1493) |
| `RESEND_WEBHOOK_SECRET` | `resendWebhook` (703) | `process.env.RESEND_WEBHOOK_SECRET` (708) |
| `STRIPE_SECRET_KEY` | `stripeStatus` (925), `createPayLink` (967), `createStripePaymentLink` (1033), `stripeWebhook` (1097) | `process.env.STRIPE_SECRET_KEY` (930, 987, 1053, 1101) |
| `STRIPE_WEBHOOK_SECRET` | `stripeWebhook` (1097) | `process.env.STRIPE_WEBHOOK_SECRET` (1102) |
| `SHIPSTATION_API_KEY` | `pushToShipStation` (1271), `shipStationStatus` (1354), `shipStationWebhook` (1385) | `process.env.SHIPSTATION_API_KEY` (1278, 1357, 1391, 1409) |
| `ANTHROPIC_API_KEY` | **NONE — `callAnthropic` (index.js:393) has no `{secrets:[...]}` binding and no `defineSecret`** | `process.env.ANTHROPIC_API_KEY` (403) |

**Verify (owner):** `firebase functions:secrets:access <NAME>` (prints the value), or Google Cloud Console → Security → Secret Manager → purpl-crm project. To confirm a secret is actually *attached* to a function: Cloud Console → Cloud Functions → function → "Variables & Secrets" tab.

**Behavior when unset/wrong:**
- `RESEND_API_KEY` empty → `new Resend(undefined)` → send throws → `HttpsError('internal', 'Email send failed…')`. **Visible** sticky error in CRM; portal orders get `confirmationEmailFailed: true` (index.js:273-276), inquiries likewise (383-386). The invite email path swallows the error (`console.warn`, 910-912) — invite "succeeds" but the employee never gets the email.
- `RESEND_WEBHOOK_SECRET` unset → `resendWebhook` returns 500 "Webhook secret not configured" (708-713). **Silent** to users: open/click badges simply never appear.
- `STRIPE_SECRET_KEY` unset/wrong-format → `{ok:false, error:'STRIPE_SECRET_KEY is not set…'}` (987-989, 1053-1055). **Visible** — pay-link generation fails with a readable message; `stripeStatus` gives a step report (930-935).
- `STRIPE_WEBHOOK_SECRET` unset → `stripeWebhook` 500s (1103); wrong → every event 400s "Invalid signature" (1111-1114). **Silent** to staff: customers pay, invoices never flip to `paid`.
- `SHIPSTATION_API_KEY` unset → push returns visible error with the fix command (1279). Wrong value → ShipStation 401 surfaced in the error string (1340-1343). But it *also* silently changes the webhook secret (see §2.1).
- `ANTHROPIC_API_KEY` → **can never be set via Secret Manager as the UI instructs** (`public/app.js:16525` tells the admin to run `firebase functions:secrets:set ANTHROPIC_API_KEY`, but with no `secrets:` binding on `callAnthropic` the secret is never mounted). Only a `functions/.env` file (none in repo; only `.env.local` which is emulator-only and excluded from deploy by `firebase.json` `"*.local"` ignore) or a manually-set Cloud Run env var could populate it. Failure is **visible**: `failed-precondition: 'AI features not configured'` (index.js:404) on every AI action (`_callAnthropicApi`, app.js:4026-4027; used at 4109, 4876, 5186).

---

## 2. Inbound Webhooks (require registration on the EXTERNAL side)

### 2.1 `shipStationWebhook` — index.js:1384
- **Endpoint:** `https://us-central1-purpl-crm.cloudfunctions.net/shipStationWebhook?secret=<SECRET>` (v2 also exposes a `*.run.app` URL — check Cloud Console for the exact one).
- **Expected secret derivation (index.js:1391):** `(process.env.SHIPSTATION_API_KEY || '').trim().slice(-8)` — the **last 8 characters of the stored SHIPSTATION_API_KEY value** (if the key is stored as `key:secret`, that's the last 8 chars of the API *secret*). Missing/wrong → 403 (1392-1396). **Rotating the ShipStation key silently invalidates the registered webhook URL.**
- **External registration:** ShipStation → Settings (gear) → Integrations → API Settings → Webhooks → New Webhook → event **"On Items Shipped"** (SHIP_NOTIFY), target URL above *including* `?secret=`. There is **no in-app setup or check** — "Test Connection" only lists stores (docs/arch/12 §MED-6).
- **What it drives (all silent if unregistered):** tracking numbers + carrier on invoices, `__shipping__` line + total recalc, `shippedAt`/`issued`/`dueDate` stamping, `readyToSend` flag (CRM "ready to send" prompt, app.js:604), sample-box status→shipped + 3-can inventory deduction + "sample shipped" customer email (index.js:1443-1567).
- **Failure mode:** completely silent — indistinguishable from "no shipments happened." Invoices sent without shipping charges, tracking never recorded, sample recipients never get their tracking email. Note the handler ACKs 200 even on errors (1674-1686) so ShipStation never retries; errors do at least land in `workspace/main/audit_log` (`shipstation_webhook_error`, `shipstation_unmatched`).
- **Verify:** ShipStation API Settings page shows the webhook + its URL (confirm the `?secret=` suffix matches last-8 of the key via `firebase functions:secrets:access SHIPSTATION_API_KEY`); Cloud Console → Functions → shipStationWebhook → Logs (look for "invalid or missing secret" 403s vs. successful POSTs after a real shipment); or check `audit_log` for any `action:'shipped'` rows.

### 2.2 `stripeWebhook` — index.js:1096
- **Endpoint:** `https://us-central1-purpl-crm.cloudfunctions.net/stripeWebhook`.
- **Events required:** only `checkout.session.completed` is processed (1117-1120); everything else is ACK'd "ignored".
- **External registration:** Stripe Dashboard → Developers → Webhooks → Add endpoint → URL above → select `checkout.session.completed` → copy the **Signing secret** (`whsec_…`) → `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`. The signing secret is **per-endpoint** — re-creating the endpoint requires re-setting the secret.
- **What it drives:** invoice `status:'paid'` + paid metadata across retail/lf/combined/dist (+ legacy `iv` fallback, 1191-1196), combined→children cascade (1220-1243), paid-amount-mismatch flagging (1168-1185), audit rows.
- **Failure mode:** **silent and nasty** — pay links still work (they're created by `createPayLink` with only `STRIPE_SECRET_KEY`), the customer's card is charged, but the invoice never flips to paid and reminder/dunning flows keep firing at paid customers. "Pay links work" is NOT evidence the webhook is registered.
- **Verify:** Stripe Dashboard → Developers → Webhooks → endpoint shows recent `checkout.session.completed` deliveries with 200 responses; or make a $0.50 test invoice payment and watch the invoice flip to paid; or check `workspace/main/audit_log` for `changedByEmail:'stripe-webhook'` rows.

### 2.3 `resendWebhook` — index.js:702
- **Endpoint:** `https://us-central1-purpl-crm.cloudfunctions.net/resendWebhook`.
- **Events required:** `email.opened`, `email.clicked` (737); others ACK'd "ignored". Signature verified with svix against `RESEND_WEBHOOK_SECRET` using `req.rawBody` (714-731).
- **External registration — TWO steps:** (a) Resend Dashboard → Webhooks → Add endpoint → URL above → select opened + clicked events → copy signing secret (`whsec_…`) → `firebase functions:secrets:set RESEND_WEBHOOK_SECRET`; (b) **open/click tracking must be enabled on the sending domain** (Resend Dashboard → Domains → pbfwholesale.com → enable Open Tracking / Click Tracking) — without it Resend never emits these events at all, regardless of webhook registration.
- **What it drives:** 👁 Opened / 🔗 Clicked badges throughout the CRM — cadence entries (app.js:145-146, 3863, 3872, 4236-4239, 4654-4657), invoice tracking rows (13406-13408), inquiry/order emailLog (16872). **Yes — all open/click intelligence is 100% dependent on this webhook**; there is no polling fallback.
- **Failure mode:** silent — every sent email shows "Not yet opened" forever. Wrong secret → 401 per event (visible only in function logs and Resend's delivery-attempt history).
- **Verify:** Resend Dashboard → Webhooks → endpoint delivery history shows 200s; Resend → Domains → tracking toggles on; function logs show "ok"/"no match" rather than 401.

---

## 3. Outbound API Dependencies

| NAME | Needed by (workflow) | Where code reads it | How to verify configured | Failure mode if missing/wrong |
|---|---|---|---|---|
| **Resend API key** | Every email: cadence/manual emails, invoices, order + application confirmations, employee invites, sample-shipped emails | Secret → `process.env.RESEND_API_KEY`; client callers throughout `public/app.js` (e.g. 740, 2538), `order.html:1363`, `wholesale.html:861` | `firebase functions:secrets:access RESEND_API_KEY`; Resend Dashboard → API Keys | Visible `internal` errors on send; portal/inquiry docs flagged `confirmationEmailFailed`; invite email silently skipped |
| **Resend verified domain `pbfwholesale.com`** | Same as above — ALL sends are `from: lavender@pbfwholesale.com` (`ALLOWED_FROM`, index.js:17-19; hardcoded at 82, 233, 359, 881, 1535; app.js has ~40 hardcoded uses; `sendCombinedInvoice` sets `replyTo: graham@pumpkinblossomfarm.com`, index.js:84) | from-addresses in code | Resend Dashboard → Domains → pbfwholesale.com = **Verified** (SPF + DKIM DNS records present at the DNS host) | Resend 403 "domain not verified" → same visible send errors; if DKIM/SPF later break, sends succeed but land in spam (silent) |
| **Stripe secret key** (`sk_live_`/`sk_test_`) | Pay-link generation (`createPayLink` is the live path; `createStripePaymentLink` legacy), pay-online button in invoice emails | Secret → index.js:987, 1053; format-checked `sk_` prefix | In-app: Settings → Stripe **Test** button (calls `stripeStatus`, gives step-by-step report incl. key prefix/length); Stripe Dashboard → Developers → API keys | Visible `{ok:false}` sticky error; CRM falls back to generic `invoice_settings.stripeLink` if set — whose payments the webhook **cannot match** (no metadata; docs/arch/12 HIGH-1) |
| **ShipStation API key** | Push invoice/sample orders to ShipStation; connection test; webhook resource fetch | Secret → index.js:1278, 1357, 1409. **Format:** V1 Basic auth `base64(apiKey:apiSecret)` — if the stored value contains `:` it's treated as `key:secret`, else whole string is key with empty secret (1281-1284). A key-only value will 401 against the real API, so the stored value **must be `key:secret`** | In-app: Settings → ShipStation **Test Connection** (lists stores = auth OK); or `firebase functions:secrets:access SHIPSTATION_API_KEY` and confirm it contains a colon | Visible error on push ("SHIPSTATION_API_KEY not set" or "ShipStation 401"); ALSO silently breaks the inbound webhook secret (§2.1) if rotated |
| **ShipStation `storeId` setting** | Optional order routing to a specific ShipStation store | CRM Settings → saved to Firestore-backed `shipstation_settings.storeId` (app.js:461-463), sent on push (app.js:575, 6308) → `advancedOptions.storeId` (index.js:1327-1329) | Settings page shows the value; `shipStationStatus` returns the valid store list to pick from | Blank = orders go to default store (fine). Wrong ID = ShipStation 400/order lands in wrong store; if webhook was registered store-scoped elsewhere, tracking sync silently misses |
| **ShipStation `fromAddress` setting** | **DEAD** — saved/loaded (app.js:462-470) but never included in the push payload (index.js:1286-1329 has no ship-from field) | `shipstation_settings.fromAddress` | n/a | None — configuring it does nothing; ship-from comes from ShipStation's own store settings. (Distinct from `invoice_settings.fromAddress`, app.js:16459, which IS used on rendered invoice docs) |
| **Anthropic API key** | AI email drafting / AI features (`_callAnthropicApi` at app.js:4026; call sites 4109, 4876, 5186) | `process.env.ANTHROPIC_API_KEY` (index.js:403) — **no defineSecret, no secrets binding** | Trigger any AI action: "AI features not configured" = missing. Cloud Console → Cloud Functions → callAnthropic → Variables & Secrets (should show it — it won't) | Visible failed-precondition error. **Unfixable by the documented command alone** — needs a code change (add `defineSecret('ANTHROPIC_API_KEY')` + `{secrets:[...]}`) or a `functions/.env` entry. Also pinned to model `claude-sonnet-4-20250514` (index.js:414) — a model retirement breaks it externally |
| **Google Places/Maps key** | Address autocomplete (all address fields, CRM + wholesale application form), geocoding, territory map | Hardcoded `window.GOOGLE_PLACES_KEY` in `public/firebase-config.js:13` (and mirrored in `public-wholesale/firebase-config.js`); loaded by `places.js:27,48` | console.cloud.google.com → APIs & Services: **Places API** + **Maps JavaScript API** enabled, billing active; Credentials → key restrictions must include ALL serving domains (`purpl-crm.web.app`, `pbfwholesale.com`, `pbf-wholesale.web.app`) | **Silent** — `console.warn` only (places.js:52); autocomplete quietly absent, addresses saved without lat/lng, map tab shows "add your key" placeholder (index.html:1913). Referrer-restriction missing a domain = works on one site, silently dead on the other |
| **Firebase Auth providers** | CRM staff sign-in (Google popup + email/password, `auth.js:7,52`); invite flow uses `generatePasswordResetLink` (index.js:874) | Firebase web config `firebase-config.js:23-30` (public, fine) | Firebase Console → Authentication → Sign-in method: Google + Email/Password enabled; Settings → Authorized domains includes serving domains | Visible sign-in popup error. Password-reset links come from Firebase's default email unless templates/custom domain configured |

---

## 4. DNS / Domain Assumptions

| NAME | Needed by | Where code assumes it | Verify | Failure mode |
|---|---|---|---|---|
| **`pbfwholesale.com` → `pbf-wholesale` hosting site** | Every portal link in every outbound email: `https://pbfwholesale.com/order?t=<token>` (app.js:821-822, 3928, 3988; index.js:1523 in sample email); marketing-footer links (app.js:878, 891, index.js:216) | hardcoded URLs | Firebase Console → Hosting → pbf-wholesale → Custom domains shows pbfwholesale.com **Connected**; `dig pbfwholesale.com` → Firebase A records; `curl -I https://pbfwholesale.com/order` → 200 | **Silent from CRM's view** — every emailed portal/order link is dead for customers; orders just stop arriving |
| **Unsubscribe URL host `purpl-crm.web.app`** | CAN-SPAM unsubscribe in marketing emails: `https://purpl-crm.web.app/unsubscribe?id=<acctId>` (app.js:768) → hosting rewrite `/unsubscribe → function unsubscribe` (`firebase.json` purpl-crm site) → index.js:593 | app.js:763-770; firebase.json rewrites | `curl 'https://purpl-crm.web.app/unsubscribe?id=test'` → branded HTML page (not 404) | Silent — recipients click, get 404, stay subscribed (compliance risk). Note rewrite exists ONLY on the purpl-crm site, and function sets `invoker:'public'` in code (OK) |
| **Email image assets** | Logos in every email header: `https://purpl-crm.web.app/images/purpl-wordmark-white.png`, `lf-logo-white.png` (index.js:176,182,325-327,1502-1504; app.js:395,401,2344-2346) | hardcoded | `curl -I` both URLs → 200 | Silent — broken-image icons in all customer emails |
| **Resend click-tracking links** | When click tracking is on, Resend rewrites links through its tracking domain | external to repo | Resend → Domains → tracking config | If tracking disabled: links work but `email.clicked` never fires (badges dead). If enabled with a custom tracking domain whose DNS is wrong: links themselves break |

---

## 5. Firestore Config Documents That Must Exist (data, not code)

| Doc | Fields consumed | Consumers | Failure mode if absent |
|---|---|---|---|
| `portal_settings/config` | `mode`, `pricePerCase`, `launchDate`, `deadline*`, `portalPassword` | `getPortalConfig` (index.js:456-465), `verifyPortalPassword` (479-484), CRM direct reads (app.js:4358, 5034, 17047) | Graceful: portal defaults to `mode:'preorder'`, `pricePerCase:null` (no pricing shown). Password gate never locks out — `'purpleherb'` is hardcoded-accepted (index.js:477). Written by Settings save (app.js:15773-15775) |
| `portal_config/main` | legacy mirror of the above | `PortalDB.saveConfig/getConfig` (app.js:14487, 14492) — **CRM-internal only; the customer portal never reads it** (comment at app.js:15767-15770) | Benign; defaults returned (14493-14494). Both docs are written on every Settings save — drift only if edited by hand |
| `workspace/main/config/main` | `lf_skus` (LF catalog); `invoice_settings.terms` / `settings.payment_terms` | `getLfCatalog` (index.js:448-453) → customer order form (order.html:823); shipStationWebhook due-date calc (index.js:1627-1630, defaults Net 30) | Portal shows hardcoded `LF_SKU_FALLBACK` catalog (stale prices); terms default to 30 — both silent |
| `app_config/access_control` | `allowedEmails[]`, `bootstrapAdminAssigned` | `initUserRole` (index.js:653-695), `inviteEmployee` (869-872) | Self-healing: auto-seeded with `FALLBACK_ADMIN_EMAILS = ['grahambiagiotti@gmail.com']` (632-634, 658-663). Non-fallback users blocked with visible "Access not authorized" |
| `accounts`/`prospects` token mirrors | `orderPortalToken` | `lookupPortalToken` (index.js:504-548), `getPortalOrderHistory` (561-566); CRM writes mirror at app.js:17016 | Personalized portal links show "not found"; visible to customer as invalid-link |

---

## 6. Hosting Targets / Deploy Mapping

- `.firebaserc`: single project `purpl-crm`, **no target aliases** — `firebase.json` maps by `"site"` key directly: `purpl-crm` site ← `public/`, `pbf-wholesale` site ← `public-wholesale/` (with `predeploy: node sync-wholesale.js` copying shared pages).
- **Both hosting sites must exist in the project** (`firebase hosting:sites:list`). Deploy fails loudly if not.
- `public-wholesale/` is generated by `sync-wholesale.js` at predeploy — deploying pbf-wholesale via any path that skips predeploy serves stale portal pages (silent).
- Functions: single codebase `default`, Node 24 runtime (functions/package.json engines).

## 7. Dead / Aspirational External Hooks (configure nothing)

- **Zapier webhook** (Settings UI, index.html:1186-1217): tells you to deploy `functions/webhook.js` — **that file does not exist**. Saving a URL (app.js:10744-10751) stores a string nothing reads. Dead.
- **Distributor "Webhook Active" badge** (app.js:7167): renders a `webhookEnabled` flag; no backing function or registration anywhere. Display-only.
- `window.OLD_OWNER_UID` (firebase-config.js:20): one-time migration hook, blank = inert.
- `functions/.env.local` contains a `RESEND_API_KEY` — emulator-only (excluded from deploy by `"*.local"` ignore in firebase.json). **It is not gitignored** (functions/.gitignore doesn't cover it) — a live-looking key may be committed to the repo; rotate if real.

---

## 8. Likely-Unconfigured Suspects (failure-mode ↔ symptom matching)

1. **ShipStation webhook registration + `?secret=` param** — the #1 suspect for "tracking numbers/shipping charges never appear" and "sample-shipped emails never went out." Zero in-app visibility, manual registration, secret derived from last-8 of the API key (breaks silently on key rotation), and the handler ACKs 200 on errors so ShipStation never retries. Check `audit_log` for ANY `action:'shipped'` row ever; none = unregistered or wrong secret.
2. **Resend webhook + domain tracking toggles** — if 👁/🔗 badges have *never* appeared on any email, either the endpoint was never added in Resend, the svix secret doesn't match, or open/click tracking is simply off on the domain. Two independent switches; both silent. (The rawBody fix comment at index.js:719-721 proves this pipeline was broken once already.)
3. **`ANTHROPIC_API_KEY`** — near-certainly non-functional in production: no secret binding exists, so even following the app's own instructions (`firebase functions:secrets:set …`) cannot mount it. Every AI action should currently show "AI features not configured." Fix requires a code change, not just configuration.
4. **Stripe webhook endpoint registration** — "pay links work" proves only `STRIPE_SECRET_KEY`. If any customer paid and the invoice stayed unpaid/dunning continued, the endpoint or its signing secret is wrong. Check Stripe Dashboard delivery log + `audit_log` for `changedByEmail:'stripe-webhook'`.
5. **Google Places key restrictions on `pbfwholesale.com`** — autocomplete working in the CRM but not on the public wholesale/application form (or vice versa) = referrer restriction missing a domain; failure is console-only.
6. **`pbfwholesale.com` DNS → pbf-wholesale site** — if portal orders dried up despite emails going out, verify the custom-domain connection; every emailed order link hardcodes this host.
