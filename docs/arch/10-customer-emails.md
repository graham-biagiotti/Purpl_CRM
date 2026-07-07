# 10 — Customer-Facing Emails: As-The-Customer-Sees-Them Review

Read-only review of every email a customer can receive, ranked by customer impact.
Paths: `app.js` = `public/app.js`, `index.js` = `functions/index.js`. Verified against
08-emails.md / 00-foundation.md; line numbers as of this review (2026-07-07).

## Inventory (send surface → builder → from / reply-to / unsubscribe)

| Email | Builder | From | Reply-To | Unsub link |
|---|---|---|---|---|
| 14 cadence templates | `getCadenceEmailTemplate` (app.js:809-1123) via `buildEmailHTML` (761-807) | lavender@pbfwholesale.com | — | marketing 6 only (894, 930, 1057, 1074, 1092, 1109) |
| Broadcast (mass) | `buildEmailHTML(..., a.id)` (app.js:4905) | lavender@ | — | yes, per-recipient |
| purpl / LF / preview invoice | `buildPurplInvoiceEmailHTML` / `buildLfInvoiceEmailHTML` → `buildInvoiceDocHTML` (app.js:12979, 13004, 12792) | lavender@ (2529, 11830, 13174) | — | no (transactional) |
| Combined invoice | `buildCombinedInvoiceHTML` (12948) via `sendCombinedInvoice` (index.js:64) | lavender@ | **graham@pumpkinblossomfarm.com** (index.js:80) — the only reply-to anywhere | no |
| Invoice reminder | `buildInvoiceReminderHTML` (app.js:2310-2366) | lavender@ | — | no |
| Order confirmation (portal) | server-rendered in `sendOrderConfirmation` (index.js:107-280) | lavender@ (233) | — | no |
| Application received | server-rendered in `sendApplicationConfirmation` (index.js:286-390) | lavender@ (358) | — | no |
| Approved / Rejected (CRM) | cadence templates `approved`/`rejected` (app.js:16899, 16933) | lavender@ | — | approved: yes |
| Sample shipped | inline in `shipStationWebhook` (index.js:1480-1524) | lavender@ (1520) | — | no |
| Employee invite (internal) | inline in `inviteEmployee` (index.js:869-898) | lavender@ | — | no |

Unsubscribe plumbing verified end-to-end: link `https://purpl-crm.web.app/unsubscribe?id=<acId>`
(app.js:766) → hosting rewrite (firebase.json:17, purpl-crm site) → public `unsubscribe`
function (index.js:582-608) sets `emailOptOut` and always renders a friendly page. Note the
pbf-wholesale site (pbfwholesale.com) has **no** /unsubscribe rewrite (firebase.json:45-51) —
fine today because the links all point at purpl-crm.web.app; don't "fix" the domain in the
link without adding the rewrite.

---

## HIGH — customer sees wrong or broken content

### H1. Combined-invoice reminder emails say "Amount Due $0.00" — BROKEN
`buildInvoiceReminderHTML` computes `amount = collection === 'lf_invoices' ? (inv.total||0)
: (inv.amount || inv.total || 0)` (app.js:2312). Combined-invoice records carry **only
`grandTotal`** — no `amount`, no `total` (creation sites app.js:12173-12191, 12635-12643,
15459). The Dashboard reminder card shows the right number (`fmtC(inv.grandTotal)`,
app.js:2239→2268), but the email a combined-invoice customer receives renders
`$${parseFloat(0).toFixed(2)}` → **"Amount Due $0.00"** (app.js:2354) — while the "Pay Now"
Stripe button beside it (2357, server-priced via `createPayLink`, index.js:962-974) charges
the real total. A dual-brand customer gets a dunning email for $0.00 with a pay button for
hundreds of dollars. Fix: include `inv.grandTotal` in the amount fallback chain.

### H2. Header logos are near-invisible in Gmail / Outlook.com
Every branded header white-washes two **dark-purple** logos with
`filter:brightness(0) invert(1)` (PBF_HEADER_HTML app.js:395-405; reminder app.js:2335-2337;
order confirmation index.js:172-182; application confirmation index.js:325-327; sample
shipped index.js:1487-1489). CSS `filter` is unsupported by Gmail (web + apps) and
Outlook.com — the filter is stripped and the original assets render: verified
`public/images/lf-logo-circle-transparent.png` and the purpl logo are dark slate/indigo
purple, sitting on the `#6B4F9A→#9B73C4` gradient → dark-purple-on-purple, effectively
invisible in the most common client. Additionally the purpl logo URL forces AVIF
(`enc_avif`, app.js:395, 2335, index.js:172, 325, 1487) — Outlook desktop (Word renderer)
and older clients don't decode AVIF → broken-image box. Fix: host a pre-rendered white PNG
next to `lf-logo-circle-transparent.png` on purpl-crm.web.app and drop the filter trick.
(The invoice document header is fine — white background, un-filtered logos,
app.js:12857-12882.)

### H3. HTML entities leak into subject lines
`businessName`/`contactName` are HTML-escaped once (app.js:814-815) and then reused in
**plain-text subjects**: `approved` (897), `order-confirmation` (990), `payment-overdue`
(1026), `reorder-reminder` (1044), `delivery-followup` (1060), `thank-you` (1095). Any store
named "Joe's Market" or "Smith & Sons" gets a subject like
`Order confirmed — Joe&#39;s Market` / `Smith &amp; Sons` in their inbox. Subjects need the
raw string; only the HTML body needs `escHtml`.

---

## MEDIUM — misleading copy / identity issues

### M1. "Personalized link… no password needed" can point at the password-gated page
`portalLink` silently falls back to the generic `https://pbfwholesale.com/order` when the
account has no `orderPortalToken` (app.js:816-818), while the surrounding copy still says
"Click your personalized link below. Goes straight to your order form, no password needed"
(app.js:870, 907). Guard coverage is inconsistent:
- Emails page: `approved` is guarded (Send disabled until token exists + Generate button,
  app.js:4355-4364, 4376) — but **`preorder-announcement` is not guarded** despite the same
  button copy.
- Account-modal Cadence tab: `openEmailPreview('approved', …)` (app.js:3846-3848) has **no
  token guard at all** → `sendEmailViaResend` (3729) will happily send the broken promise.
- Mass template send is correct: token pre-pass mints tokens before sending
  (app.js:4994-5018). Approval flow is correct too (token created first, app.js:16833-16852).

### M2. Every cadence + broadcast email carries two different signatures
Each template body ends with an inline "Graham Biagiotti / Pumpkin Blossom Farm /
603-748-3038 · graham@pumpkinblossomfarm.com" block (e.g. app.js:841-843, 892-894,
928-930 … 1117-1119), and `buildEmailHTML` then unconditionally appends `_signatureHTML()` —
"Graham Biagiotti — Director of Sales … lavender@pbfwholesale.com" (app.js:787, 364-383).
Customers see back-to-back signatures advertising **two different contact addresses**.
Broadcast is worse: the AI prompt is told to end with the signature (app.js:4863) and the
wrapper appends the second one (4905). Pick one signature (and one advertised address —
see M5).

### M3. "First delivery the week of July 27" is effectively hard-coded
`extra.launchDate` is supported (app.js:820-825) but **no send path ever passes it** — grep
shows `launchDate` only in Portal Settings save/load and invoice-date logic (app.js:15263,
15583, 15614-15625). Changing the Portal Settings launch date updates the portal but every
`preorder-announcement` email keeps saying "week of July 27" (app.js:864). Same drift risk
for pricing: $2.30/can, $27.60/case, $3.29 MSRP are hard-coded in the template
(app.js:856-858); they currently match the source-of-truth constants (app.js:11-13) and
wholesale.html:352, but the portal's configurable `pricePerCase` (order.html:862,
app.js:15615) can diverge from the email with no warning. Also note: if `extra.launchDate`
is ever wired up with a bad value, `new Date(bad)` does **not** throw — the email would read
"week of Invalid Date" (the try/catch at app.js:822-824 won't catch it).

### M4. `invoice-sent` cadence template can show "$0.00" and promises an invoice it doesn't contain
- The Emails page and mass sender build `extra.invoiceTotal = fmtC(inv.total ||
  inv.grandTotal || 0)` (app.js:4343, 4446, 5044) — this misses `amount`, the only total on
  **legacy `iv` purpl invoices** (cf. app.js:12751, 2212), so those render "Amount Due
  $0.00". The cadence-tab path uses the opposite order `inv?.amount || inv?.total`
  (app.js:3684). Unify to `total || amount || grandTotal`.
- Body says "Please find your invoice for … below" (app.js:949) but contains only a
  number/amount summary; `extra.invoiceLink` (966) is never passed by any caller, so there
  is no document, no link, no pay button. The real invoice emails
  (`buildPurplInvoiceEmailHTML` et al.) are separate — this template invites "where's the
  invoice?" replies.
- Empty invoice number produces `Invoice  from Pumpkin Blossom Farm` (double space) in
  subjects (app.js:945, 1007, 1026).

### M5. Three sender identities, one working reply path
All mail is FROM bare `lavender@pbfwholesale.com` with **no display name** (index.js:38-39,
78, 233, 358, 870, 1520) — inboxes show "lavender" instead of "Pumpkin Blossom Farm". Only
`sendCombinedInvoice` sets `replyTo: graham@pumpkinblossomfarm.com` (index.js:80); every
other email that says "just reply to this email" (app.js:891, 927, 1001, 2358;
index.js:212) delivers replies to lavender@. Meanwhile inline signatures advertise
graham@pumpkinblossomfarm.com (app.js:843 etc.) and the footer/`_signatureHTML` advertise
lavender@ (app.js:377, 794). Recommend: `from: 'Pumpkin Blossom Farm <lavender@…>'`
everywhere, one consistent reply-to, one advertised address.

### M6. Sample-shipped email: dangling "portal link is below" + phantom "tracking link"
The sentence "…your personalized portal link is below." is unconditional (index.js:1504)
while the button only renders when `ac.orderPortalToken` exists (index.js:1505-1510) — a
token-less account is told to look for a link that isn't there. Carrier fallback says "See
tracking link" (index.js:1500) but the tracking number is plain text, never a link (1501).

### M7. "Pay Online" can silently fall back to a generic Stripe link
On `createPayLink` failure, `_getStripePayLink` returns `invoice_settings.stripeLink`
(app.js:704, 711) right after telling the operator the invoice "will go out WITHOUT a pay
button", and `_buildPaymentHTML` uses the same fallback (app.js:12674). If that settings
field holds a generic payment link, the customer gets a Pay button not tied to their
invoice/amount. Prefer: no button on failure (checks/ACH block still renders, 12676-12688).

---

## LOW / polish

- **L1. Preview ≠ sent for portal password.** The Emails-page preview fetches the real
  portal password (app.js:4347-4352) but `emailsPageSendEmail` rebuilds `extra` without it
  (4440-4448), so sent emails always show the `'purpleherb'` fallback (app.js:875, 912).
  Harmless today — `verifyPortalPassword` permanently accepts purpleherb (index.js:461-466)
  — but if a custom password is ever configured, preview and sent email will disagree.
  Copy-HTML / Open-in-Gmail rebuild with no extras at all (app.js:4412, 4420-4421), so their
  invoice-sent copies show "—" placeholders.
- **L2. No `List-Unsubscribe` header** on any Resend send (all `resend.emails.send` calls
  pass only from/to/subject/html) — footer link only. Fine at current volume; Gmail/Yahoo
  bulk-sender rules will want the one-click header if volume grows.
- **L3. Reminder due-date fallback reads oddly**: missing due date renders `dueLabel='Net
  30'` → "was due on **Net 30** and remains unpaid" / "Invoice X · Due Net 30"
  (app.js:2315, 2349-2350, 2355). Dashboard queue always has a due date (2205, 2219, 2233),
  so only reachable via future callers.
- **L4. Reminder subjects with a missing invoice number** produce doubled spaces:
  `Payment reminder —  (Store)` (app.js:2288-2290).
- **L5. `markCadenceEmailSent` 60-second duplicate guard** compares `c.stage === stageId`
  only after mapping (app.js:3761-3764) — resending to a *second contact* within 60s is
  blocked with "Already sent — duplicate blocked". Operator-facing, but it can make a real
  customer send silently not get logged.

## Verified good

- **Escaping**: every server-rendered interpolation goes through `escHtml` (index.js:17-19,
  150, 192-201, 313-314, 1495-1501); client templates escape name/business/password
  (app.js:814-815, 875, 912); broadcast body is escaped then `\n→<br>` (app.js:4891);
  `portalLink` scheme-pinned to http(s) (index.js:142-144); portal recipients are
  server-authoritative + idempotent (index.js:120-137, 297-311).
- **Render-safety of greetings**: `contactName` falls back through primary contact →
  `account.contact` → `'there'` everywhere (app.js:813-814, 2322-2324; index.js:192, 1479) —
  no "Hi undefined" path found.
- **Invoice document** (`buildInvoiceDocHTML`): all money passes through
  `parseFloat(...)||0` normalizers (app.js:12745, 12755-12756, 12770-12785, 12828), missing
  due date/terms/notes/portal-link blocks collapse cleanly (12895-12896, 12920, 12927,
  12932), table-based layout with fluid `width="720" max-width:100%` (12855) — Gmail/Outlook
  safe, prints via `@page` rules (12842-12848).
- **Mobile**: all shells use the fluid `width="600"` + `max-width:600px;width:100%` pattern
  (app.js:778-781, 2330; index.js:164-165, 321-322, 1484) with viewport meta; images have
  explicit width/height + alt. No fixed-width hazards beyond the 48px invoice gutters
  (acceptable).
- **Factual consistency**: Net 30, free delivery at 8+ purpl cases / $250 LF (combining),
  NH/MA/S-ME/S-VT area, and "invoices from lavender@pbfwholesale.com" are consistent across
  the templates (app.js:882-886, 919-923), order.html:383-435, 448, 486, wholesale.html:518-519,
  terms.html:100, and the server confirmation (index.js:206-208). Prices $2.30/$27.60/$3.29
  match the canonical constants (app.js:11-13).
- **Opt-out gates** match the unsubscribe page's promise ("you may still receive order and
  invoice confirmations", index.js:601): hard skip on broadcast/mass (app.js:4902, 5037),
  confirm-override on manual sends (4460, 3738-3739), no gate on transactional.

## Suggested fix order
1. H1 combined reminder $0.00 (one-line fallback chain) — app.js:2312.
2. H3 subject entities (build subjects from raw names) — app.js:814-815 + 6 subjects.
3. H2 white-logo PNGs, drop `filter`/AVIF — 5 header blocks.
4. M4 invoice-total fallback unification (`total||amount||grandTotal`) — app.js:4343, 4446, 5044.
5. M1 token guard on preorder-announcement + cadence-tab approved — app.js:4355, 3846.
6. M2/M5 single signature + display-name From/reply-to — app.js:787, index.js senders.
