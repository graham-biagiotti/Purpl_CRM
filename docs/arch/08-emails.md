# 08 — Emails Tab & Email Plumbing

Scope: the EMAILS page, template library, mass email, account-modal cadence tab, invoice
emails/reminders, unsubscribe flow, Resend integration, and the `cadence` array that acts as the
shared email ledger across Emails / Dashboard / Accounts. All paths relative to repo root;
`app.js` = `public/app.js`, `index.js` = `functions/index.js`.

---

## 1. Resend integration (server side)

All real sends go through Firebase callable functions that wrap the Resend SDK. Secrets:
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (`functions/index.js:7-8`).

| Callable | Auth | Notes |
|---|---|---|
| `sendEmail` (`functions/index.js:22-61`) | required | Generic send. Enforces `from` ∈ `ALLOWED_FROM = ['lavender@pbfwholesale.com']` (`index.js:13-15,30-32`). Returns `{success, id}` where `id` is the Resend message id. Supports optional `data.accountId`/`data.cadenceStage` → server-side `_logCadenceEntry` (`index.js:47-53`) — **but the client wrapper `callSendEmail` (app.js:422-431) never passes accountId, so this server-side logging branch is dead for all CRM paths**; the client logs cadence itself. |
| `sendCombinedInvoice` (`index.js:64-101`) | required | Hardcodes from + `replyTo: graham@…`. If `data.accountId` is passed it **also** logs a server-side `invoice_sent` cadence entry (`index.js:86-93`). |
| `sendOrderConfirmation` (`index.js:107-280`) | **public** | Called by the customer portal (`public/order.html:1340`, `public-wholesale/order.html:1334`). Hardened: requires `portalOrderId`, recipient is server-authoritative from the portal order doc (`index.js:120-131`), idempotent. Logs to `portal_orders.emailLog` (`index.js:245-254`) and to account cadence only when accountId matches the order (`index.js:257-263`). |
| `sendApplicationConfirmation` (`index.js:286-390`) | **public** | Called from wholesale site (`public/wholesale.html:861`). Bound to a real `portal_inquiries` doc, server-authoritative recipient, idempotent via `emailLog` check (`index.js:297-311`). Logs to `portal_inquiries.emailLog` (`index.js:365-378`). |
| `inviteEmployee` (`index.js:815+`) | admin | Sends invite email directly via Resend (`index.js:865-870`). |
| `shipStationWebhook` (`index.js:1369+`) | secret-gated | On a sample-box shipment, sends a "sample shipped" email with tracking + portal link directly via Resend (`index.js:1474-1528`), idempotent per shipment. No cadence entry — only `samples[]` update + audit log. |

**Tracking webhook** — `resendWebhook` (`index.js:691-782`): svix signature verification against
`req.rawBody` (`index.js:703-720`), accepts only `email.opened` / `email.clicked` (`index.js:726`).
Matches `event.data.email_id` against `sentMessageId` in three ledgers, in order:
1. `workspace/main/ac` account docs → `cadence[]` entries (`index.js:737-746`) — sets `opened/openedAt`, `clicked/clickedAt`.
2. `portal_inquiries.emailLog` (`index.js:749-760`).
3. `portal_orders.emailLog` (`index.js:763-774`).

Note it does a **full collection scan of all three collections per event** (`.get()` with no
query) — O(N) reads per open/click; fine at current scale, a cost/latency concern later. Also, the
client's whole-doc account writes can race with webhook field updates and clobber freshly-set
`opened` flags (client rewrites the full `cadence` array from its cache via `DB.update`).

`_logCadenceEntry` helper (`index.js:785-811`): appends `{id, sentAt, sentBy:'system',
method:'resend', ...entryData}` to `ac.cadence`, caps at 500 entries, stamps
`lastContacted` + `_updatedAt`.

---

## 2. The cadence array — shared ledger shape

Stored on each account record (`workspace/main/ac/{id}.cadence`, mirrored in the client cache as
`DB.a('ac')[i].cadence`). Appended via `_pushCadence(existing, entry)` (`app.js:160-163`), which
caps at the **last 500 entries** (same cap server-side, `index.js:800-802`).

Canonical entry shape (union of all writers):

```js
{
  id: uid(),                    // client uid() or server equivalent
  stage: 'invoice_sent',        // see stage-id note below
  sentAt: ISO datetime,         // markCadenceSent uses date-only today() (app.js:3885)
  sentBy: userName | 'system',
  method: 'resend' | 'gmail' | 'manual' | 'auto' | 'crm_confirm',
  to: email,                    // only some writers (Emails page, mass template, broadcast)
  sentMessageId: resendId,      // only on successful Resend sends — webhook join key
  invoiceId, invoiceRef,        // invoice sends/reminders (broadcast abuses invoiceRef for subject, app.js:4915)
  subject,                      // server-side _logCadenceEntry only
  opened, openedAt, clicked, clickedAt,  // added later by resendWebhook
}
```

**Stage-id duality**: `CADENCE_STAGES` (`app.js:3902+`) uses underscore ids
(`approved_welcome`, `invoice_sent`, …) while the HTML template library uses hyphen ids
(`approved`, `invoice-sent`, …). Mapping tables `_STAGE_TEMPLATE_IDS` (`app.js:3636-3650`) and its
inverse `_TEMPLATE_STAGE_IDS` (`app.js:3651-3653`) convert at write time
(`_TEMPLATE_STAGE_IDS[tplId] || tplId`). Templates **not** in the map are stored under their raw
hyphen id — notably `preorder-announcement`; `broadcast` is its own ad-hoc stage
(`app.js:4912`). Readers defensively match both spellings
(`c.stage === s.id || c.stage === s.id.replace(/-/g,'_')`, `app.js:4538-4539, 4580-4581`).

Consumers of the ledger:
- **Emails page KPIs** — total sent / sent-this-week / never-contacted count cadence entries (`app.js:4160-4174`).
- **Emails Overview grid** — per-account ✓/○ for 4 stages (`app.js:4571-4619`); overdue "welcome not sent" list via `getOverdueCadence` (`app.js:4533-4547`).
- **Emails History tab** — flattened all-account entry table with opened/clicked badges (`app.js:4622-4670`).
- **Recent Auto-Sends card** — filters entries whose stage ∈ `_AUTO_SEND_STAGES` (`app.js:4184-4246`).
- **Dashboard** — `renderCadenceOverdue` (`app.js:1994-2036`): flags active accounts missing an `approved_welcome` entry and invoices with no `invoice_sent` entry (matches on `c.invoiceId`).
- **Account modal Cadence tab** — `renderMacEmailsTab` (`app.js:3830-3872`): per-stage sent/pending dots + full history table with opened/clicked.
- **`lastContacted`** — stamped by nearly every send path; drives the mass-email "✓ Sent today" indicator and last-contact filters (`app.js:4759-4768, 4781`).

---

## 3. Template library

- `buildEmailHTML(headerHTML, accentColor, bodyHTML, unsubscribeAccountId)` (`app.js:761-807`) —
  600px branded shell; appends `_signatureHTML()` and, **only when a 4th arg is passed**, an
  unsubscribe footer linking `https://purpl-crm.web.app/unsubscribe?id=<accountId>`
  (`app.js:762-769`).
- `getCadenceEmailTemplate(stage, account, extra)` (`app.js:809-1123`) — 14 hyphen-id templates
  returning `{subject, from, body}`. Personalization: primary contact name, business name, portal
  link from `account.orderPortalToken` (`app.js:812-818`), `extra.portalPassword`,
  `extra.launchDate`, invoice fields, `extra.orderSummary`.
  - **Marketing templates (with unsubscribe link)**: `preorder-announcement` (app.js:894), `approved` (930), `reorder-reminder` (1057), `delivery-followup` (1074), `new-product` (1092), `thank-you` (1109). Broadcast bodies also get one (`app.js:4905`).
  - **Transactional (no link)**: `application-received`, `rejected`, `invoice-sent`, `first-order`, `order-confirmation`, `invoice-reminder`, `payment-overdue`, `custom`.
- A **second, legacy plain-text template set** lives inside `CADENCE_STAGES` (`app.js:3902+`,
  `subject()`/`body()` functions) — used only for labels/descriptions in current UI; the HTML
  library is what actually sends.
- `buildInvoiceReminderHTML(inv, collection, isOverdue)` (`app.js:2310-2366`) — standalone
  dual-brand reminder doc (LF green vs purpl purple accents), amount block, optional Stripe
  `_payLink` "Pay Now" button (`app.js:2357`). No unsubscribe link (transactional).

---

## 4. The EMAILS page (`index.html:1731-1893`, renderers `app.js:4157+`)

Tabs: Compose / Overview / History / Mass Email / Samples (`index.html:1734-1738`,
`switchEmailsTab` `app.js:4672-4682`).

- `renderEmailsPage()` (`app.js:4157-4182`) — KPIs, template column
  (`_renderEmailsTemplatesCol` 4248-4279), auto-sends card, right column, overview, history, mass.
- `_renderEmailsRightCol()` (`app.js:4292-4406`) — account picker (searchable select), opt-out
  warning banner (`app.js:4315-4317`), multi-contact SEND TO picker (`app.js:4318-4332`), live
  iframe preview, portal-password fetch for `preorder-announcement`/`approved`
  (`app.js:4347-4352`), and for `approved` a token guard that disables Send until a portal token
  exists (`app.js:4355-4364, 4376`) with a Generate button → `_emailsApprovedGenerateToken`
  (`app.js:4512-4531`, writes token to top-level `accounts` collection + local cache).

### Send buttons on this page

| Button | Handler | Callable | Log |
|---|---|---|---|
| "Send Email" (`app.js:4376`) | `emailsPageSendEmail` (`app.js:4436-4499`) | `sendEmail` per recipient (multi-contact loop, 300ms apart) | success: `{stage: mapped, method:'resend', to, sentMessageId}` + `lastContacted` (`app.js:4467-4475`); failure: opens `mailto:` and still logs `method:'gmail'` (`app.js:4477-4485`) — **optimistic**: a Gmail entry is written even if the user never sends the draft. Custom-template placeholder body is blocked (`app.js:4453-4456`). Opt-out = confirm override (`app.js:4460`). |
| "Open in Gmail" (`app.js:4375`) | `emailsPageOpenGmail` (`app.js:4416-4423`) | none (mailto) | nothing logged |
| "Copy HTML" (`app.js:4374`) | `emailsPageCopyHTML` (`app.js:4408-4414`) | none | nothing |
| (unwired helper) | `emailsPageMarkSent` (`app.js:4501-4510`) | none | `method:'manual'`, **no** `lastContacted` stamp |
| Overview "Compose Now" (`app.js:4562`) | selects template+account, jumps to Compose | — | — |

---

## 5. Mass Email (`renderMassEmail` `app.js:4718-4742`; markup `index.html:1749+`)

Account selection: `_meSelectedIds` set, brand/status/last-contact filters
(`_getMeFilteredAccounts` `app.js:4750-4770`), select/deselect-all helpers (4811-4830).

### 5a. Broadcast — `meBroadcastSend` (`app.js:4878-4935`)
AI-draftable subject/body (`meBroadcastGenerate` 4858-4875 via `callAnthropic` proxy). Loop with
in-flight guard, 300ms spacing. Per account: **hard skip if `emailOptOut`** (`app.js:4902`,
counted as "skipped (unsubscribed)"); body HTML-escaped and wrapped in `buildEmailHTML(...
a.id)` so each recipient gets a personal unsubscribe link (`app.js:4904-4905`). Calls `sendEmail`;
logs `{stage:'broadcast', method:'resend', invoiceRef: subject, sentMessageId}` + `lastContacted`
(`app.js:4910-4922`). Failures counted, not retried, no Gmail fallback.

### 5b. Template send — `meTemplateSend` (`app.js:4960-5067`)
- `custom` template blocked outright (`app.js:4966-4969`).
- Pre-flight confirm listing no-email skips and how many new portal links will be minted (`app.js:4973-4981`).
- **Token pre-pass** for `_TEMPLATES_NEED_LINK = ['preorder-announcement','approved']`
  (`app.js:4959, 4994-5018`): generates + persists `orderPortalToken` to the top-level `accounts`
  collection *before* any email goes out; any token failure **aborts the entire send**
  (`app.js:5009-5015`); accounts re-fetched afterwards (`app.js:5017`).
- Portal password fetched once (`app.js:5020-5026`); optional "all contacts" fan-out (`app.js:5028, 5034`).
- Per account: **hard skip on `emailOptOut`** (`app.js:5037`); per recipient `sendEmail` at 500ms
  spacing (`app.js:5058`); logs `{stage: mapped-or-raw tplId, method:'resend', to, sentMessageId}`
  + `lastContacted` (`app.js:5052-5055`).

### 5c. Batch session — `meBatchStart`/`_renderBatchWorker`/`meBatchNext` (`app.js:5070-5227`)
One-account-at-a-time AI drafting worker (`meBatchGenerate` `app.js:5156-5180`). **Never sends via
Resend** — only `mailto:` (`mebwOpenMailto` `app.js:5182-5190`) or clipboard. "Next →" logs to the
account's `outreach[]` array (not `cadence`) with `type:'email'` + `lastContacted`
(`app.js:5197-5213`). No opt-out gate (nothing is auto-sent).

---

## 6. Account-modal Cadence tab sends

`renderMacEmailsTab` (`app.js:3830-3872`) renders a Send/Resend button per `CADENCE_STAGES` stage
→ `openEmailPreview(templateId, accountId)` (`app.js:3658-3675`; invoice stage routes through
`_openInvEmailPreview` `app.js:3677-3687` which pulls the latest invoice for number/total).

Preview modal (`modal-email-preview`): editable subject + raw-HTML body textarea with live iframe
(`toggleEmailBodyEdit` 3695-3709), Copy HTML (3711), mailto (3720), and:

- **"Send Email"** → `sendEmailViaResend` (`app.js:3729-3756`): opt-out confirm override
  (`app.js:3738-3739`), `sendEmail` callable, then `markCadenceEmailSent(result?.id)`; on failure
  opens Gmail and calls `markCadenceEmailSent(null)`.
- `markCadenceEmailSent` (`app.js:3758-3779`): maps template→stage id, **60-second duplicate
  guard** (`app.js:3763-3764`), logs `{method:'manual', sentMessageId?}` + `lastContacted`.
  **Quirk: successful Resend sends from this path are recorded as `method:'manual'`** (hardcoded
  at `app.js:3769`) — they carry a `sentMessageId` so tracking works, but History/Method columns
  show "manual" unlike every other Resend path.
- `markCadenceSent` (`app.js:3884-3891`) — log-only helper; date-only `sentAt`, no
  `lastContacted`.

---

## 7. Invoice emails & reminders

All invoice sends are transactional: **no emailOptOut gate anywhere** (consistent with the
unsubscribe page's "you may still receive order and invoice confirmations", `index.js:601`).

| Send button | Handler | Callable | Cadence log |
|---|---|---|---|
| purpl invoice "Save & Send" (`#iv-send-btn`) | `openInvModal` onclick (`app.js:2505-2557`) | `sendEmail` (`app.js:2529`) with `buildPurplInvoiceEmailHTML` + Stripe pay link (`app.js:2524`) | `{stage:'invoice_sent', method:'resend', invoiceId, invoiceRef, sentMessageId}` + `lastContacted` (`app.js:2532-2542`); flips draft→sent via `markInvoiceSent` (2531, inventory deduction `app.js:16259+`) |
| LF invoice "Save & Send" (`#lfi-send-btn`) | `app.js:11804-11861` | `sendEmail` (`app.js:11830`) | same shape (`app.js:11835-11845`) |
| Invoice preview "Send Invoice to Customer" (`#civ-btn-gmail`, retail/LF preview) | `openInvoicePreview` (`app.js:13164-13190`) | `sendEmail` (`app.js:13174`) | same shape (`app.js:13179-13181`); mailto fallback none — error toast |
| Combined invoice "Send" (`#civ-btn-gmail`) | `openCombinedInvoicePreview` (`app.js:13355-13428`) | `sendCombinedInvoice` (`app.js:13367`) passing `accountId` | client logs `{stage:'invoice_sent', …, sentMessageId}` (`app.js:13407-13413`) **and** the callable logs its own server-side entry because accountId is passed (`index.js:86-93`) → **double cadence entry per combined send**, plus a client-cache/server write race on the `cadence` array. Also stamps `sentMessageId` + status 'sent' on all three invoice records atomically (`app.js:13376-13403`). Catch: mailto fallback, nothing logged (`app.js:13424-13426`). |
| Dashboard "Send Reminder" (💌 Invoice Reminders card) | `sendInvoiceReminder(invId, collection)` (`app.js:2276-2308`; button `app.js:2270`) | `sendEmail` via `_sendWithCadence` (`app.js:737-759`, its only caller) | success: `{stage:'invoice_reminder', method:'resend', invoiceId, invoiceRef, sentMessageId}` + `lastContacted` (`app.js:741-744`); failure: Gmail fallback still logs `method:'gmail'` (`app.js:753-756`). Marks `reminderSentAt` on the invoice so the card row disappears (`app.js:2299`). Queue built for retail/LF/combined at due-in-7d..overdue (`app.js:2210-2240`). |
| Distributor invoice ✉ | `_sendDistInvoiceReminder` (`app.js:16239-16256`) | `sendEmail` | **no cadence** (distributors aren't `ac` records); sets `dist_invoices.reminderSentAt` |

Application lifecycle (Applications page):
- **Approve** → `approveApplication` (`app.js:16894-16909`): sends `approved` template via
  `sendEmail`, logs `{stage:'approved_welcome', method:'auto', sentMessageId}` — **no
  `lastContacted` stamp** (`app.js:16907`).
- **Reject** → `rejectApplication` (`app.js:16923-16960`): sends `rejected` template; logs to the
  Firestore `portal_inquiries.emailLog` (not account cadence — no account exists), including a
  `method:'none'` audit entry when no email could be sent (`app.js:16946-16958`).
- Portal order confirm (CRM side) deliberately does **not** re-email — logs a
  `{stage:'order_confirmation', method:'crm_confirm'}` cadence entry only (`app.js:15527-15543`);
  the customer-facing email was already sent by the portal via `sendOrderConfirmation`.

---

## 8. Unsubscribe flow & opt-out gates

- **Link** in marketing emails → `https://purpl-crm.web.app/unsubscribe?id=<acId>`
  (`app.js:766`), rewritten to the `unsubscribe` function by `firebase.json:17`.
- **Server endpoint** (`index.js:582-608`): public, Admin SDK; sets
  `emailOptOut: true, emailOptOutAt` on `workspace/main/ac/{id}` (`index.js:594-598`); always
  returns a friendly branded page, even on error.
- **Legacy client deeplink** `?optout=ACCOUNT_ID` (`app.js:13979-13989`) still exists — sets
  `emailOptOut` via `DB.update` but only works for a logged-in CRM user; superseded by the server
  endpoint (comment at `index.js:578-581`).
- **Gates by send path**: hard skip — broadcast (`app.js:4902`) and mass template
  (`app.js:5037`), plus token pre-pass exclusion (`app.js:4977, 4995`); confirm-override — Emails
  page compose (`app.js:4460`) and cadence-tab preview modal (`app.js:3739`); no gate
  (transactional) — all invoice sends, invoice/dist reminders, order/application confirmations,
  approve/reject, sample-shipped webhook email.
- **UI surfaces**: red "✉ Unsubscribed" badge on account list rows (`app.js:3200`); warning banner
  in the Emails compose column (`app.js:4315-4317`). There is no in-app re-subscribe button; the
  unsubscribe page tells customers to reply to be re-added (`index.js:602`).

---

## 9. Findings / risks (summary)

1. **Combined-invoice sends double-log cadence** — client entry (`app.js:13407-13413`) + server
   `_logCadenceEntry` (`index.js:86-93`) both fire since `accountId` is now passed
   (`app.js:13367`); also a read-modify-write race on `ac.cadence` between client cache and Admin
   SDK.
2. **`sendEmailViaResend` mislabels method** — successful Resend sends from the cadence-tab modal
   log `method:'manual'` (`app.js:3769`), skewing History/Method reporting.
3. **Optimistic Gmail logging** — Emails-page and reminder failure paths log a `gmail` cadence
   entry + `lastContacted` when they merely *open* a mailto draft (`app.js:4477-4485, 753-756`),
   so the ledger can claim contact that never happened.
4. **`resendWebhook` full-collection scans** per open/click event (`index.js:737, 750, 764`) —
   O(N) Firestore reads; and client whole-doc account writes can clobber webhook-set
   `opened/clicked` flags.
5. **Stage-id fragmentation** — `preorder-announcement` and `broadcast` entries live under
   unmapped ids; any new consumer must remember the hyphen/underscore dual-matching idiom.
6. **`sendEmail`'s server-side cadence logging is dead code** for CRM callers (accountId never
   passed by `callSendEmail`, `app.js:422-431`) — the double-log in (1) is the one exception via
   `sendCombinedInvoice`.
7. `approveApplication` cadence entry skips `lastContacted` (`app.js:16907`); `markCadenceSent`
   writes date-only `sentAt` (`app.js:3885`) while everything else writes ISO datetimes — minor
   sort/compare inconsistencies in the History views.
