# 11 — Customer Portal Experience Review (retailer's-eye view)

Scope: what a retailer actually experiences on pbfwholesale.com/order — token entry,
password entry, order form, submission, confirmation email, history/print, return
visits, mobile, /unsubscribe, and the wholesale.html application form. Read-only
review, verified against `public/order.html`, `functions/index.js`,
`firestore.rules`, `public/app.js`, `public/wholesale.html`, `sync-wholesale.js`,
`firebase.json`, and the deployed mirror `public-wholesale/order.html`.
All paths relative to `/home/user/Purpl_CRM`. Findings ranked by likelihood a real
retailer hits them.

---

## Flow verdicts (summary)

| Flow | Verdict |
|---|---|
| 1. Token resolution | Works; not-found and network-error paths both recover (B2 fix verified). Expired-token notice renders below the fold (see F10). |
| 2. Password path | Works; hardcoded `purpleherb` accepted forever (functions/index.js:466). Minor UX issues (F14). |
| 3. Order form | Functional; LF catalog is always the hardcoded fallback for real customers (F2); qty/variant validation solid. PO field is a hidden input — customers cannot enter a PO (order.html:407). |
| 4. Submission | Atomic batch + submissionId in source, but NOT in the deployed mirror (F1); no network timeout → silent infinite "Submitting..." on flaky connections (F3). |
| 5. Confirmation email | Recipient server-authoritative + idempotent (good); totals incomplete for LF/variants (F9). |
| 6. History + print | Works from in-memory data; prospects always see empty history (F11); depends on an unverifiable composite index (F12). |
| 7. Return-visit re-fill | Customer-entered prefs never persist — the write is permission-denied and silently swallowed (F6). |
| 8. Mobile | Usable; iOS auto-zoom on every field focus (F4); print may fail in in-app browsers (F16). |
| 9. /unsubscribe | Friendly and functional for accounts; claims success even when nothing was recorded (F15). |
| 10. wholesale.html application | Works; generic submit failure is silent because `#ws-error` doesn't exist (F13). |

---

## F1 — CRITICAL: the deployed portal is behind source; live site lacks submissionId and the live-mode price display

`public-wholesale/` is what pbfwholesale.com serves (firebase.json site `pbf-wholesale`,
public dir `public-wholesale`), regenerated from `public/` only by the predeploy hook
(`sync-wholesale.js`). The mirror currently **differs** from source:

- Mirror line ~1254 writes the purpl doc **without `submissionId`** and never mints one
  (source: order.html:1256, 1259, 1266). So live submissions still pair by the legacy
  fuzzy <60s account+time heuristic — the exact bug submissionId was added to fix
  (same-account purpl+LF halves mis-grouping, wrong-doc confirm/decline/delete downstream,
  app.js:14604-14622).
- Mirror nests the price display inside the preorder branch (mirror ~869-872), so in
  `liveorder` mode the per-case price is **not shown on the live site**. Source shows it in
  both modes (order.html:870-874).

Every retailer hits this until the next `firebase deploy` of the wholesale site. Nothing
in the customer's view looks broken — it silently serves last quarter's logic. Verify with
`diff public/order.html public-wholesale/order.html` (26 lines today).

## F2 — HIGH: LF section always shows the hardcoded fallback catalog to real customers (known M5 — still current)

`loadLfSkus()` (order.html:819-835) reads `workspace/main/config/main` **directly from the
unauthenticated client**. firestore.rules:124-131 restrict all `workspace/**` reads to staff,
so every real customer permission-denies into the catch and renders `LF_SKU_FALLBACK`
(order.html:533-564, hardcoded prices/variants). Consequences:

- Staff price edits, new SKUs, archived SKUs/variants in Settings never reach customers;
  the portal quotes and submits fallback prices (`lineItems[].unitPrice`, `total` come from
  the rendered list — order.html:787-817), which then feed the confirmation email and the
  staff review screen.
- Only a logged-in staff member testing in their own browser sees the real catalog — so
  the bug is invisible in ad-hoc staff testing.
- Side effect: `renderLfSkus`'s "Last order: N cases" prefill plumbing (order.html:617-641,
  665-666) is dead — every call site passes `prevOrder=null` (order.html:592, 942, 1012, 1812),
  and the prefs that would feed it never save (F6).

Fix direction: serve `lf_skus` from `getPortalConfig` (functions/index.js:445-454) or a
dedicated public callable.

## F3 — HIGH: on a flaky/offline connection, submit hangs forever with no feedback

`submitOrder()` disables the button, sets "Submitting..." (order.html:1136-1140), then calls
`_batch.commit()` (order.html:1285). The Firestore web SDK **never rejects a write while
offline** — the promise stays pending until server ack. There is no timeout, so a retailer on
spotty mobile data sees "Submitting..." indefinitely: no error, no retry guidance, and the
`.catch` (order.html:1369-1381) never fires. If they give up and refresh, the queued write is
lost (no offline persistence enabled) and the order silently vanishes. Contrast: wholesale.html
wraps its submit in a 15s watchdog (wholesale.html:809-812) — order.html has nothing.
Recommendation: same watchdog pattern + "still trying / check your connection" message.

## F4 — HIGH (annoyance, every iPhone): iOS auto-zoom on field focus

Form inputs are 14px (order.html:45); the viewport meta (order.html:5) has no
`maximum-scale`. Mobile Safari zooms the page on every input focus — on a form with 10+
fields (account, address, quantities, notes) the page jumps repeatedly and the retailer must
pinch back out each time. Fix: 16px font-size on inputs (or at minimum on text/email fields).
Related small-target issue: LF variant +/− steppers are 28px (order.html:626-628), below the
44px touch-target guideline, adjacent to each other.

## F5 — MEDIUM-HIGH: "Notify me" checkbox is a black hole staff-side

Customer notify choices are stored only as `notifyMe` on the portal_orders doc
(order.html:1206). Nothing writes `portal_notify` (rules:63-72 allow it; no writer exists).
The staff "Notify Me List" tab and its CSV export read only `portal_notify`
(app.js:14770-14793, 14324) and will always show "No notification signups yet." The choice
is visible solely inside the per-order review modal (app.js:14987), so when Blueberry/Peach
launch, the natural workflow (open Notify tab → export → blast) mails nobody. Retailers who
ticked the box (a submit-enabling action on its own — order.html:1040) never hear back.

## F6 — MEDIUM-HIGH: return-visit re-fill never remembers what the customer typed

After a successful submit the portal writes `portalPrefs.*` to `accounts/{accountId}` from the
unauthenticated client (order.html:1300-1318). firestore.rules:36-38 make `accounts` staff-only,
so this permission-denies into the silent `.catch` (order.html:1316-1318) every time. Result:
`portalPrefs` prefill on the next visit (order.html:975-988 — billingEmail, leadTimeNeeded,
deliveryNotes) only ever reflects staff-written data; `purplLastCases`/`lfLastOrder` are never
saved, so `applyPurplPrefill` (order.html:1760-1766) and the LF "Last order" notes stay dead.
The "Welcome back — your details are pre-filled from your last order" banner (order.html:240-242)
over-promises. Fix belongs in a callable (server writes prefs bound to the token).

## F7 — MEDIUM: pre-order success screen wording never appears

`showThankYou()` targets `#ty-subtext` for the pre-order copy (order.html:1074-1075:
"Pre-order received! We'll confirm availability and delivery timing soon.") but **no element
with that id exists** — the thank-you block (order.html:471-496) has `#ty-heading` and an
anonymous `<p>` ("We'll be in touch shortly to confirm your delivery window.",
order.html:480). So in preorder mode the customer gets generic live-order wording on screen
(the email gets it right — functions/index.js:193, 206-208). Related polish: after a submit
error in preorder mode the button label resets to "Place Order" instead of "Submit Pre-Order"
(order.html:1379 hardcodes it; `showError` at 1066 does it correctly).

## F8 — MEDIUM: purpl price shown to the customer can differ from the invoiced price

The portal displays and totals purpl at the global `portal_settings.pricePerCase`
(functions/index.js:450-453 → order.html:870-874, thank-you total 1082-1085, email total
1322-1325, print 1589-1596). Nothing stores that quoted price on the portal_orders doc. Staff
confirm prices the invoice via `_calcPricePerCase(acct)` (app.js:23-28) — per-account
direct/distributor price when set. An account with custom pricing sees $X/case on the portal
and confirmation email, then gets invoiced $Y. Quote the account price for matched tokens (or
persist the quoted price on the order for staff visibility).

## F9 — MEDIUM: confirmation email totals are incomplete

`sendOrderConfirmation` renders exactly the `items` array the client builds
(order.html:1321-1337 → functions/index.js:147-152):

- LF **variant** lines are sent with `total: ''` (order.html:1331) — units only, no dollars.
- There is **no LF subtotal or order grand total** anywhere in the email (the on-screen
  thank-you shows "LF Total" — order.html:1102 — the email doesn't).
- The purpl line shows a total only when `pricePerCase` is configured (order.html:1324).

What's right: pre-order vs order wording (index.js:193, 206-208), the sample-box paragraph
when requested (index.js:209), ship-to block (index.js:195-202), server-authoritative
recipient from the order doc + idempotency (index.js:120-137), scheme-checked portal link
(index.js:142-144), and failure flagging `confirmationEmailFailed` (index.js:273-276).

## F10 — MEDIUM: expired/revoked-token message renders below the fold

Token not-found → the form is shown and the message ("This order link may have expired…
contact graham@…", order.html:901-907) goes into `#error-msg` — which lives at
order.html:455, directly above the submit button, roughly 8 cards down the page. The retailer
lands on what looks like a normal blank form (unmatched mode) and may never see the notice;
they can still submit, but as an unmatched order with retyped details. Move the notice to a
top-of-page banner. (The network-error path is properly handled: password gate + retry
message in `#pw-error`, order.html:909-923.)

## F11 — MEDIUM-LOW: prospects never see their order history

`getPortalOrderHistory` validates the token only against `accounts` and `workspace/main/ac`
(functions/index.js:550-555) — never `prospects`/`workspace/main/pr`, even though
`lookupPortalToken` happily resolves prospect tokens (index.js:509-537) and order.html calls
history unconditionally for any matched entity (order.html:993). A prospect who received a
pre-order link and ordered sees "No previous orders yet" forever (validation fails → `{orders:[]}`).

## F12 — MEDIUM-LOW: history depends on a console-managed composite index

The history query (`where accountId == … orderBy submittedAt desc`, functions/index.js:557-561)
requires a composite index. There is **no `firestore.indexes.json` in the repo** and
firebase.json declares none — the index exists only if someone created it manually. If it's
missing/dropped, the CF throws, the client catch (order.html:1001-1004) renders the empty
state, and every customer quietly loses history with zero alerting.

## F13 — MEDIUM-LOW: wholesale.html application failure is silent

`wsSubmitApplication`'s generic catch writes to `document.getElementById('ws-error')`
(wholesale.html:871-875) — **that element does not exist** (only `#ws-apply-err` at
wholesale.html:658, which is used solely for the pre-submit validation reset at :779). A
Firestore failure re-enables the button with no message at all; the duplicate-application
path at least falls back to `alert()` (wholesale.html:820-826). Otherwise the application flow
is solid: 15s watchdog (809-812), server-side duplicate check (functions/index.js:434-441),
rules-capped `portal_inquiries` create (rules:93-103), idempotent server-recipient
confirmation email (index.js:286-390).

## F14 — LOW: password-gate polish

- `verifyPortalPassword` permanently accepts `purpleherb` (functions/index.js:462-466) —
  deliberate, so customers are never locked out, but rotating the Settings password can't
  revoke access. The stored-password comparison is exact-match (`pw === stored`, index.js:473)
  while the hardcoded one is trimmed/lowercased — a stored password with different casing or
  stray whitespace fails confusingly.
- Network failure during verify shows "Incorrect password. Please try again."
  (order.html:1817-1819 reuses `#pw-error`'s default text) — wrong message for the situation.
- If the customer arrived via the token-network-error path (B2 message injected into
  `#pw-error`, order.html:918-922) and then types a wrong password, the stale "We couldn't
  load your account…" message is re-shown instead of "Incorrect password"
  (checkPortalPassword only toggles display, order.html:1814).

## F15 — LOW: /unsubscribe tells everyone they're unsubscribed, even when nothing was recorded

The endpoint (functions/index.js:582-608) only updates `workspace/main/ac/{id}`
(index.js:594-597). An id that isn't an account (or a mangled id) still renders the success
page "…has been removed from our marketing email list" — with `name` falling back to "your
account" — while no opt-out was written. Deliberately reassuring-by-design (comment at :605),
but combined with broadcasts that skip only `emailOptOut` accounts (app.js:4902), a failed
unsubscribe means the customer keeps getting marketing they believe they opted out of.
The happy path is good: friendly page, transactional-emails caveat, no error leakage.

## F16 — LOW: print/PDF relies on `window.open`

Both `printCurrentOrder` (order.html:1623) and `_printPortalOrderDoc` (order.html:1522) open a
new window and `document.write` the confirmation. In in-app browsers (Instagram/Facebook
webviews, some corporate mail apps) `window.open` returns null → immediate TypeError on
`w.document`, and the button silently does nothing. Also "View PDF" (order.html:1454-1474)
serves in-memory data only — correct workaround for rules (LOW-12), but after ~10 orders the
server caps history at 10 (functions/index.js:560), so older orders are unreachable.

## F17 — Minor notes

- Status badge shows raw staff statuses to customers, including "DECLINED" in red
  (order.html:1411-1418) — accurate but blunt; no explanation or next step offered.
- Optional-chaining (`?.`) is used throughout (e.g., order.html:995, 1039); Safari <13.1 /
  older Android WebView dies on parse — whole portal blank. Acceptable in 2026, worth knowing.
- `renderLfSkus` interpolates `s.name`/`v.name` unescaped (order.html:625, 645, 669) —
  staff-controlled config only, low risk; `escHtml` is used elsewhere.
- The dual-brand notice says "invoiced separately — one invoice per line"
  (order.html:361-363) while the thank-you and print say "combined invoice"
  (order.html:1126, 1668) — staff-side actually creates a combined invoice
  (app.js:15424-15462). The brand-selector copy is the stale one.
- Sample-only / notify-only submissions correctly force a purpl doc so nothing is lost
  (order.html:1246-1250); sample requests on LF-only orders ride the LF doc's
  `requestSample` (order.html:1276) and are picked up by the staff dedupe
  (app.js:14484-14501). Verified working.
- Ship-address validation requires street/city/state/zip (order.html:1177-1180) but no
  zip-format or state-code check beyond `maxlength`; state uppercased at submit
  (order.html:1174). Adequate.
- Qty validation LOW-11 (0..100000 integers incl. variant lines, order.html:1218-1233) and
  the variant unit-assignment gate (order.html:1042-1053, over-assignment capped at
  order.html:738-747) both verified sound. Edge: variant units with cases=0 can't happen via
  UI (picker hidden + zeroed, order.html:714-724).
