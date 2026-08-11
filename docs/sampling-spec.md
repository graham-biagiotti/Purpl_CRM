# In-Store Sampling (Demo Days) — Build Spec

Status: PLANNED (no code yet). Owner-approved flow: the sampler (one dedicated
person, not Graham) owns her own schedule and is the confirmer. Graham is
informed, never in the critical path.

**Owner constraints (verbatim intent):** purpl-only sampling — no LF anywhere
in this flow. The sampler is not tech-savvy: her ENTIRE experience is two
emails and one tap. Big buttons, plain language, no statuses, no login,
nothing she can break; recovery from her mistakes is always on Graham's side
(cancel + resend from the CRM card).

## Roles
- **Store**: existing account; requests a demo day via personalized link.
- **Sampler**: one person, set once in Settings (name / cell / email). Confirms
  or proposes dates via one-time action links. No CRM login.
- **Graham**: router/overseer. Gets FYIs; can cancel or step in on any card.

## 0. Setup (Settings)
New "In-Store Sampling" block in Settings:
- sampler name, cell, email (warehouse-partner-email pattern)
- minimum lead time in days (default 7)
- optional blocked weekdays
Stored on the settings object; no new collection.

## 1. Invite
- New email template `sampling-invite` on the Emails page (single + mass send).
- Copy: purpl-specific — what we provide (our sampler, purpl, cups, ice,
  table), what the store provides (foot traffic, a spot for the table).
- Personalized link: `https://pbfwholesale.com/sampling?t=<orderPortalToken>`
  (existing token — no password).
- Logged to cadence stage `sampling_invite`; honors emailOptOut and
  _invRecipient-style gates.
- "Invite to sampling" button on the account detail modal for one-offs.

## 2. Public page — sampling.html
- New page on wholesale hosting (COPY_AS_IS sync). purpl-branded (wordmark
  + brand purple #4D2A6F) — NOT the dual-brand header; this is purpl-only.
- Reads `?t=` → lookupPortalToken → greets store by name, prefills identity.
- NO valid token → friendly refusal screen (personal-link explanation +
  contact mailto). Accounts only; no anonymous requests.
- If the account already has an open (pending/proposed/confirmed) request →
  show its status instead of the form. One open request per account, enforced
  client-side AND server-side.

## 3. Form fields
- Store name + address (prefilled; address editable for off-site demos)
- Day-of contact: name*, cell*, email
- Date #1*, backup date (picker enforces lead time + blocked weekdays),
  time window* (morning / midday / afternoon)
- Logistics: table location, power outlet (y/n), parking/load-in notes,
  busiest hours, free-text notes
- Submit: double-click guard + timeout recovery (ws application form pattern)

## 4. Submission machinery
- Client calls NEW callable CF `submitSamplingRequest` (never a direct
  Firestore write).
- CF validates: token → accountId; dates parseable, >= lead time, not blocked;
  no existing open request (returns the existing one instead of duplicating).
- Writes to NEW top-level collection `sampling_requests`:
  { id, accountId, accountName, storeAddress, contact{name,cell,email},
    date1, date2, timeWindow, logistics{table,power,parking,busyHours,notes},
    status:'pending_sampler', samplerActionToken(random 32),
    storeActionToken(null until propose), createdAt, source }
- Sends TWO emails:
  1. Store contact: "Request received — confirmation within ~2 days."
  2. Sampler: full packet + 3 action buttons.
- Cadence entry `sampling_requested` on the account. CRM badge increments via
  listener.

## 5. Sampler decision — one-time action links
- Sampler email is written like a text message. Subject: "New demo request:
  <Store>". Giant stacked mobile buttons:
  **YES — <Date 1>** / **YES — <Date 2>** / **NO — pick a different day**.
- Buttons hit NEW onRequest CF `samplingAction`
  (`?r=<requestId>&k=<samplerActionToken>&a=confirm1|confirm2|propose`).
- Pay-link trust model: per-request random key, single-use (action recorded,
  key cleared; revisits show current state idempotently).
- **Confirm path**: status→'confirmed', confirmedDate set. Sends:
  - store contact: confirmation + .ics attachment (sendEmail already supports
    attachments)
  - sampler: confirmation + .ics with full logistics packet
  - Graham: one-line FYI email
  Landing page after a YES is ONE sentence: "Booked. <Store>, <Date>.
  It's on your calendar." — plus a "🖨 Print demo sheet" button (below).
  Double-booking interstitial BEFORE confirm if she already has a confirmed
  demo that date — plain question, two buttons: "You already have <store>
  that day. Book this one anyway?" YES / GO BACK.
- **Propose path**: ONE date picker + ONE Send button (shows her existing
  bookings, enforces lead time) → status→'proposed_alt', altDate set, storeActionToken
  minted → store contact gets "how about <alt>?" with ✓ Works / ✗ Doesn't
  buttons (own one-time key). Works → confirm path. Doesn't →
  status 'needs_reschedule', Graham + sampler notified (human takes over).
- Sampler silent 3 days → daily sweep re-nudges her; CRM card flags
  "waiting on sampler 3+ days".

## 6. CRM surfaces
- Dashboard card + nav badge (portal-orders listener pattern) on
  pending/proposed requests.
- Sampling section: request cards with state chips
  (Waiting on sampler / Proposed <date> / Confirmed <date> / Completed /
  Cancelled / Needs reschedule) and actions: Cancel (emails both sides),
  Resend to sampler, Mark completed, View details.
- Month grid of confirmed demos (pure CSS grid, no library).
- Account detail modal: sampling history + "Invite to sampling" button.
- Cadence entries in the account timeline.

## 6b. Printable demo sheet (sampler)
- One-page print-friendly sheet (warehouse print-copy pattern: server-rendered
  HTML + window.print button, big type, black on white):
  store + address, date + time window, day-of contact name + cell, table
  location, power, parking/load-in, busy hours, all notes, what-to-bring list.
- Reachable from her confirmation email, the T-2 reminder, AND the action-link
  state page ("🖨 Print demo sheet" button) — same one-time-key trust model,
  read-only render, nothing to log into.
- Graham can print the identical sheet from the CRM card (reprint if she
  loses hers).

## 7. Reminders
- Daily sweep extension: T-2 days before confirmedDate → email store contact
  ("see you <day> — sampler cell: …") and sampler. Her reminder REPEATS
  EVERYTHING (address, day-of contact name + cell, arrival window, what to
  bring) so she never digs for the original email — the reminder alone is
  enough to run the day. Once-only, stamped on the record.

## 8. Post-demo
- Day after confirmedDate: card → 'awaiting outcome', dashboard nudge.
- Mark Completed with outcome: cases sold, restock taken?, worth repeating?,
  free notes → cadence entry. Feeds manual reorder follow-up (v1);
  auto thank-you/reorder email (v2).

## 9. Changes / cancellations
- Graham cancels from card → both sides emailed.
- Store reschedule: v1 reply-to-email (human); v2 reschedule link reusing the
  propose flow.
- Sampler cancels: texts Graham → CRM cancel (v1 human).

## 10. Security & data
- No public Firestore writes; all through CFs (callable submit + onRequest
  actions with per-request keys).
- sampling_requests: staff-only rules; CFs use admin SDK.
- Dates are ET date + window strings; no timezone math.
- Cadence stages added: sampling_invite, sampling_requested,
  sampling_scheduled (confirm), sampling_completed.
- `sampling_requests` is a TOP-LEVEL collection (portal_orders pattern),
  NOT in COLLECTION_KEYS' workspace set — CRM reads via listener.

## Emails inventory (all new palette, existing builders)
1. sampling-invite (template, manual/mass)
2. request-received (store)
3. request packet + action buttons (sampler)
4. confirmation + .ics (store)
5. confirmation + .ics + logistics + print-sheet button (sampler)
6. FYI (Graham)
7. propose-alt with accept/decline buttons (store)
Plus: T-2 reminders (store + sampler), 3-day sampler nudge.

## Build order (each phase: backtests + adversarial verifier gate → deploy)
- **Phase A (working loop)**: settings block; sampling.html; submitSamplingRequest;
  emails 2+3; samplingAction confirm path (+ interstitial guard); emails 4+5+6
  with .ics; printable demo sheet (sampler link + CRM card); CRM list +
  badge + cancel; cadence logging.
- **Phase B (polish)**: propose-alt round trip (email 7 + store action);
  T-2 reminders + sampler nudge; month grid; completed/outcome flow.
- **Phase C (later/optional)**: store reschedule link; auto thank-you/reorder
  email; sampling link inside the order portal.

## Edge cases (design answers)
- Invalid/missing token → refusal screen, no anonymous path.
- Duplicate open request → server returns existing; page shows status.
- Action link forwarded/reused → single-use key; revisits show plain current
  state ("This one's already booked for <date>").
- Sampler taps the wrong date → Graham cancels from the card; system re-sends
  her a fresh button email. Nothing is unrecoverable, and none of the
  recovery is on her.
- Both requested dates in the past when she finally clicks → page rejects,
  routes to propose flow.
- Store no-show / closed on the day → Graham marks Cancelled with note.
- Account with no email → invite gate skips (send-gate pattern).
- Sampler double-booked → interstitial warning, her call.
