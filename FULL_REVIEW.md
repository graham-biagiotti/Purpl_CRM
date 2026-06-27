# FULL_REVIEW.md — Purpl CRM Deep Review

**Date:** 2026-06-26

---

## Executive Summary

This review covers a deep, adversarially-verified pass over the Purpl CRM codebase (client `public/`, Cloud Functions `functions/`, and `firestore.rules`). Findings that were REFUTED during verification have been dropped; every item below is either **CONFIRMED** (mechanism fully constructible) or **PLAUSIBLE** (verify before fixing).

### Counts by severity

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 7 |
| Medium   | 8 |
| Low      | 16 |
| **Total** | **31** |

(Includes 2 informational "verification — no bug" entries filed at Low, and several PLAUSIBLE items.)

### What actually hurts vs. what is annoyance

**Corrupts data / loses money / exposes info (fix first):** A cluster of durability and consistency defects in the persistence layer (`db.js`) can silently lose or fail to apply writes — `atomicUpdate` permanently jamming snapshot sync on a thrown mutator (HIGH-1), the unload flush dropping the last debounced edit (HIGH-2), write methods reporting false success while the real Firestore write is swallowed (HIGH-3), and the config snapshot listener clobbering unsaved local edits (HIGH-4). On top of that, deleting one half of a combined invoice silently orphans its sibling and erases its dollars from every financial report (HIGH-5), a double-click on the Returns form inflates inventory 2× (HIGH-6), and security gaps let any employee delete financial records via the client SDK (HIGH-7) while two unauthenticated Cloud callables act as a branded open email relay / inquiry-doc tamper primitive (HIGH-8, plus MED phishing/XSS variants). The Medium tier is mostly **wrong-numbers-displayed** in revenue/margin reports (custom-price and distributor-price fallbacks diverging from the canonical pricer, a persisted `2.15` COGS placeholder) and **missed-reminder / stale-rollup** bugs from positional `[length-1]` reads of unsorted arrays.

**Cosmetic / annoyance (lower priority):** in-flight guards that don't reset on validation early-returns (2s retry lockout), dead `stock_transfers` writes, a `lastOrder` vs `lastOrderDate` field-name mismatch that only skews a derived KPI and an edit-modal field, advisory production-recommendation drift that only triggers on already-anomalous ledger state, the portal "View PDF" denial (a functional bug, not a leak), and the hardcoded `purpleherb` email-vs-gate password drift. The portal token-isolation and inventory-deduction-timing reviews came back **clean** (filed as verifications). No issue in this report causes unconditional, deterministic, wholesale data destruction or direct fund movement — hence zero Critical.

---

## Findings

> PLAUSIBLE findings are marked **[PLAUSIBLE — verify before fixing]**. All others are CONFIRMED.

---

## HIGH

### Data-integrity / persistence layer (`public/db.js`)

#### HIGH-1 — `atomicUpdate` has no try/finally; a throw jams snapshot sync for the session
**File:** `public/db.js:491-520`
**Status:** CONFIRMED

**Summary:** `atomicUpdate` sets `_atomicInProgress = true` (line 493) and `= false` (line 518) without a `try/finally`. A throw in the mutator (`fn(this._cache)` at line 496) or in the deferred flush (lines 509-519) permanently leaves `_atomicInProgress = true`, blocking ALL future snapshot syncs and leaving the cache half-mutated.

**Repro:** Call `DB.atomicUpdate(cache => { cache.ac.push(x); throw new Error('boom'); })`. `fn(this._cache)` throws after mutating the cache; `_atomicInProgress` is never reset. From then on every collection snapshot listener at line 176 (`if (this._dirty || this._atomicInProgress || ...)`) treats remote changes as deferred (sets `_pendingRemoteChanges`) and never applies them — multi-user sync is dead for the session. Same outcome if any `_saveCollection`/`_saveConfig` inside the `setTimeout` (lines 516-517) throws synchronously before line 518.

**Root cause:** The flag assignments are not wrapped in `try/finally`; the mutator and the flush body are both unguarded. `atomicUpdate` is invoked from ~30 sites in `app.js` — a high-traffic path.

**Proposed fix:** Wrap the synchronous mutate+write phase in `try` and clear `_atomicInProgress` in `finally`; for the deferred portion, set `_atomicInProgress = false` inside a `try/finally` within the `setTimeout` callback so a throw in `_saveCollection`/`_saveConfig` still releases the lock. Also snapshot/rollback the cache before calling `fn()` so a throwing mutator does not leave a half-mutated cache (items written via `_writeDoc` at line 502 cannot currently be rolled back).

---

#### HIGH-2 — Unload flush fires async `.set()` and returns; last debounced edit can be lost on tab close
**File:** `public/db.js:291-310` (called from `auth.js:158-162`)
**Status:** CONFIRMED

**Summary:** `_flushPendingSave` fires async `.set()` promises via `_writeDoc`/`_saveConfig` and returns immediately. Pending debounced edits can be lost on tab close because the writes are not guaranteed to reach the persistence layer before the page dies.

**Repro:** Edit a `CONFIG_ARRAY_KEYS`/`OBJ_KEYS` value so a 500ms debounce timer is pending (line 288), then close the tab within 500ms. `_flushOnExit` (`auth.js:159`) calls `_flushPendingSave`, which for config calls `_saveConfig()` (line 308) — an async `setDoc().then()` returning a promise. The handler returns synchronously and `_saveDirtyKeys.clear()` runs (line 309); the browser may tear down the page before Firestore enqueues to IndexedDB. The comment at lines 292-294 asserts the `.set()` "survives tab close," but nothing awaits or forces a synchronous write.

**Root cause:** No synchronous durability mechanism. `.set()`/`setDoc` return promises the unload handler cannot await. `_writeDoc` (line 441) is also fire-and-forget. No `navigator.sendBeacon`/keepalive fallback. `_saveDirtyKeys.clear()` (line 309) discards the dirty set even if writes never land. Most reliable loss path is the swallowed memory-only persistence fallback at `auth.js:22-26`.

**Proposed fix:** On unload, persist durably: (a) snapshot the dirty cache to `localStorage` synchronously and re-import next load, or (b) `navigator.sendBeacon` to a write endpoint. Do not clear `_saveDirtyKeys` until a write is confirmed.

---

#### HIGH-3 — Write methods return `true` after caching; the real Firestore write is swallowed
**File:** `public/db.js:439-450, 470-489`
**Status:** CONFIRMED

**Summary:** `DB.push`/`update`/`setObj`/`set` mutate the cache and return `true` immediately, while the actual write goes through `_writeDoc` (line 439), which swallows errors into a `console.warn` + silent requeue. The caller has no way to know the write failed; the only requeue path can itself loop on a permanent error.

**Repro:** `DB.update('ac', id, fn)` (line 475) mutates cache, calls `_writeDoc` (line 483), and returns `true` (line 484). If `_writeDoc`'s `set().catch` fires (line 443) with `permission-denied`, it only `console.warn`s, sets sync UI to `error`, and re-adds to `_saveDirtyKeys` + `_scheduleSave` (lines 447-448). The original `update()` already returned `true`, so calling UI code believes the write succeeded. For a transient error exceeding 3 retries, `_saveDirtyKeys.add(key)` (line 368) leaves the key dirty indefinitely with no further timer scheduled.

**Root cause:** Write methods are fire-and-forget and synchronously return success; error surfacing (a toast inside the async catch) is decoupled from the API return value. After 3 transient retries `_saveCollection` re-adds the key (line 368) without scheduling a new timer.

**Proposed fix:** Make write methods return the `_writeDoc` promise (so callers can await/handle failure), or maintain a per-key failed-write state in the sync UI that does not clear to `synced` until the specific key commits. After exhausting retries at line 368, call `_scheduleSave(key)` / set a backoff / add an `online` listener instead of only `_saveDirtyKeys.add(key)`. (Mitigating: both the permanent path at `db.js:357` and the post-3-retry path at `db.js:369` do raise a toast and flip the indicator to `error`, so the human is not blind — but the return value still lies.)

---

#### HIGH-4 — Config snapshot listener clobbers locally-edited-but-unflushed values
**File:** `public/db.js:194-215`
**Status:** CONFIRMED

**Summary:** The config snapshot listener only guards against clobbering local edits when `this._dirty` is true; it ignores `_saveDirtyKeys` and `_atomicInProgress`. Since `push`/`update`/`setObj` never set `_dirty` (`markDirty` is called from only one site in `app.js`), an inbound remote config snapshot overwrites locally-edited-but-not-yet-flushed `CONFIG_ARRAY_KEYS`/`OBJ_KEYS` values — last-writer-wins clobber of unsaved edits.

**Repro:** `DB.setObj('settings', v)` (line 467) sets `_cache` and schedules a 500ms debounce save but does NOT set `_dirty`. Before the flush, another client's config write arrives. The config `onSnapshot` (line 194) checks only `if (this._dirty)` (line 199); `_dirty` is false, so it overwrites `this._cache[k]` from remote (lines 204-213). The pending debounced save then writes the overwritten cache, permanently losing the edit. The collection listener (line 176) is safe — it also checks `_saveDirtyKeys.has(key)` and `_atomicInProgress` — but the config listener omits both.

**Root cause:** `_dirty` is a manual flag (`markDirty` at line 400) almost never set by the write API, so it is an unreliable proxy for "local has unsaved edits." The config listener (line 199) consults neither `_saveDirtyKeys` (set by every config write via `_scheduleSave` at line 286) nor `_atomicInProgress`.

**Proposed fix:** Change the guard at line 199 to mirror line 176:
`if (this._dirty || this._atomicInProgress || (this._saveDirtyKeys && [...CONFIG_ARRAY_KEYS, ...OBJ_KEYS].some(k => this._saveDirtyKeys.has(k))))`. Better, drive dirty-state automatically from the write methods.

---

### Invoicing (`public/app.js`)

#### HIGH-5 — Deleting a combined-invoice child orphans the surviving sibling; its dollars vanish from all reports
**File:** `public/app.js:87-102` (esp. line 95)
**Status:** CONFIRMED

**Summary:** `deleteInvoiceWithCleanup`, when deleting a child (retail/lf) belonging to a combined invoice, splices the combined parent (line 95: `purplInvoiceId===id || lfInvoiceId===id`) but never clears `combinedInvoiceId` on the SIBLING child. The surviving sibling keeps a dangling `combinedInvoiceId` pointing at a now-deleted parent.

**Repro:** Create a combined invoice (retail child + lf child via `createCombinedInvoice` ~line 11773). Delete just the LF child via `deleteLfInvoice` → `deleteInvoiceWithCleanup`. The `combined_invoices` parent is removed (lines 95-96), but the retail child still has `combinedInvoiceId` set. It is now filtered out of every list/KPI/report using `!x.combinedInvoiceId` — `renderInvUnifiedList` (14964), `renderInvKpis`, `exportYearEnd` (10088), dashboard (1280), account outstanding (3031). Its dollars silently disappear from Total Invoiced, Outstanding, account statements, and the tax export.

**Root cause:** Cleanup removes the parent but does not reset `combinedInvoiceId` on the other child, and there is no un-orphan pass. The exclusion filter `!x.combinedInvoiceId` then hides the orphan.

**Proposed fix:** When a combined parent is found and spliced (lines 95-96), also strip `combinedInvoiceId` from the surviving sibling (the matched rec's other child id, `!== id`) across `cache.retail_invoices`/`cache.iv`/`cache.lf_invoices`. Preferably route any child-of-combined deletion through `deleteCombinedInvoice` so both children + parent go together. **Note:** `deleteCombinedInvoice` (11840-11845) also splices only the parent — check it separately for the same sibling-orphan issue.

---

### Inventory (`public/app.js`)

#### HIGH-6 — `saveReturn()` has no double-execution guard; double-click inflates on-hand 2×
**File:** `public/app.js:8145-8188` (button wired at `public/index.html:619`)
**Status:** CONFIRMED

**Summary:** `saveReturn()` is wired via a bare `onclick="saveReturn()"` (`index.html:619`) with no `_once` wrapper, and the function has no in-flight flag or idempotency key. A double-click creates two `returns` records AND two `type:'return'` `iv` entries (qty added to stock), inflating on-hand by 2× in the user-picked pool.

**Repro:** Open Returns, select account/SKU, enter cans, double-click "Log Return." Two return rows appear and `_onHand(sku, pool)` is inflated by 2× the cans (return entries count as "in" at `app.js:110`).

**Root cause:** No in-flight guard inside `saveReturn` and no `_once` on the handler. Unlike `saveDistShipment`/`saveRepackJob`/`receiveFinishedPacks`/`saveNewCombinedInvoice`/`_saveInvCore` (all of which have an in-flight boolean), returns was never guarded.

**Proposed fix:** Add an in-flight guard at the top of `saveReturn`:
`let _saveReturnInFlight=false; if(_saveReturnInFlight)return; _saveReturnInFlight=true; setTimeout(()=>_saveReturnInFlight=false,2000);` (reset on early validation returns), or wrap the handler with `_once(saveReturn)` like `saveRepackJob`.

---

### Security (`firestore.rules`, `functions/index.js`)

#### HIGH-7 — `workspace/{path=**}` grants any employee write to all financial records and audit_log
**File:** `firestore.rules:114-117` (catch-all) vs `107-110` (audit_log)
**Status:** CONFIRMED

**Summary:** `audit_log` is correctly `write:false` (line 109), but the broad `workspace/{path=**}` match grants read AND write to any staff member (`isStaff`, i.e. employee or admin) over the entire workspace tree (line 116), including invoice deletion and `invoice_settings/config`. Due to Firestore rule unioning, the recursive wildcard also re-grants write to the supposedly `write:false` audit_log. Any employee can delete/alter financial records directly via the client SDK.

**Repro:** As a user with role `employee`, use the client Firestore SDK to delete or mutate any doc under `workspace/main/*` (e.g. an invoice or `workspace/main/config/main`). `isStaff()` passes and the write is allowed.

**Root cause:** `workspace/{path=**}` uses `isStaff()` for write with no per-collection admin gating; sensitive sub-paths (invoice delete, config, invoice_settings) are not carved out as `isAdmin()`. The file's own comment (111-113) acknowledges this.

**Proposed fix:** Add explicit sub-matches under `/workspace/main` for sensitive collections (`config`, `*_invoices` delete, `invoice_settings`, `audit_log`) requiring `isAdmin()`. **Critical caveat:** a more-specific match does NOT shrink the wildcard's grant — the wildcard itself must be tightened (or the sensitive collections must not be reachable by `isStaff()` write). Not Critical only because it requires an authenticated insider, not anonymous access.

---

#### HIGH-8 — `sendOrderConfirmation` is an unauthenticated open email relay
**File:** `functions/index.js:107-252` (no auth at 107-116; send to client-controlled `data.to` at 204-209)
**Status:** CONFIRMED

**Summary:** `sendOrderConfirmation` is an unauthenticated open email relay. `data.to`, `data.accountName`, `contactName`, `items`, `shipAddress`, `portalLink` are all client-controlled, and the function sends a fully branded "Pumpkin Blossom Farm" email from the verified sender `lavender@pbfwholesale.com` to any recipient — no auth, no App Check, no portal-token validation, no rate limit.

**Repro:** Call the callable HTTPS endpoint with `{"data":{"to":"victim@example.com","accountName":"Their Bank","contactName":"Victim","portalLink":"https://attacker.example/phish"}}` from any client (no Firebase auth token). A phishing/spam email is delivered from the farm's verified domain. Repeat at scale to burn sender reputation.

**Root cause:** The callable intentionally omits `request.auth` (comment at line 104) but substitutes no other proof of legitimacy. Recipient and display fields come straight from `request.data`.

**Proposed fix:** Require proof the caller owns the order: validate a portal token (as `lookupPortalToken`/`getPortalOrderHistory` do) or require `data.portalOrderId` to exist AND its stored `billingEmail` to equal `data.to`, and send only to that stored email rather than an arbitrary client-supplied address. Add Firebase App Check (`enforceAppCheck`) and a per-IP/per-order rate limit.

---

## MEDIUM

### Invoicing / mark-paid (`functions/index.js`)

#### MED-1 — Stripe combined-paid path never marks a legacy `iv`-backed purpl child; error swallowed
**File:** `functions/index.js:1095-1100`
**Status:** CONFIRMED

**Summary:** The Stripe webhook combined-paid path marks the purpl child only in `workspace/main/retail_invoices`. A legacy purpl child stored in `workspace/main/iv` (the `createCombinedInvoice` path at 11804-11806 supports purpl children in `iv`) is never marked paid; the `.catch(()=>{})` swallows the missing-doc error.

**Repro:** Combined invoice whose purpl component is a legacy `iv` record (`purplInvoiceId` points into `iv`, not `retail_invoices`). Pay via Stripe checkout. Parent (1059) and lf child (1099) get `paidDate`/`paidAt`, but the `retail_invoices/<purplInvoiceId>` update throws and is swallowed (1096). The legacy purpl child keeps its old unpaid status — shows outstanding forever while the parent reads paid.

**Root cause:** Unlike the client `markCombinedPaid` (`app.js:11822-11827`) which falls back to the `iv` collection, the webhook only tries `retail_invoices` and silently ignores failure.

**Proposed fix:** Mirror `markCombinedPaid`: if the `retail_invoices` update for `comb.purplInvoiceId` fails/absent, retry `doc('workspace/main/iv/<purplInvoiceId>').update(paidData)` before giving up. Don't blanket-swallow — log an orphan-child warning. No money is lost (the charge succeeds and the parent is marked paid); the harm is overstated receivables and risk of a duplicate collection attempt.

---

### Security / portal-email (`functions/index.js`)

#### MED-2 — `sendApplicationConfirmation`: unauthenticated open relay + arbitrary inquiry-doc tamper
**File:** `functions/index.js:258-343` (send at 310-315; doc write at 318-331, 336-339)
**Status:** CONFIRMED

**Summary:** Same unauthenticated open-relay pattern (branded email from `lavender@pbfwholesale.com` to any `data.to`), and additionally writes to an arbitrary `portal_inquiries` doc via `data.inquiryDocId` with no ownership check — letting an attacker append `emailLog` entries or set `confirmationEmailFailed=true` on any inquiry doc whose ID they can guess/enumerate (Admin SDK bypasses Firestore rules).

**Repro:** POST `{"data":{"to":"victim@x.com","businessName":"X","contactName":"Y","inquiryDocId":"<known-or-guessed-id>"}}` unauthenticated. A branded email is sent, and the named `portal_inquiries` doc is mutated regardless of ownership.

**Root cause:** No auth/App Check; `data.to` and `data.inquiryDocId` are trusted client input. The Admin SDK write (318-331) does not verify the caller is associated with that inquiry.

**Proposed fix:** Tie the call to the just-created inquiry: require `inquiryDocId`, load the doc, and send only to its stored email (`snap.data().email`) — never client-supplied `data.to`. Add App Check and rate limiting. Reject if the doc does not exist.

---

#### MED-3 — `portalLink` interpolated into `href` with no URL-scheme allowlist (XSS / phishing primitive)
**File:** `functions/index.js:187` (portalLink href in `sendOrderConfirmation`)
**Status:** CONFIRMED

**Summary:** `data.portalLink` is interpolated into an `href` with only `escHtml` applied (line 187). `escHtml` prevents attribute/quote breakout but does NOT block dangerous URI schemes, so a client can supply `portalLink='javascript:...'` or a `data:` URI. Combined with the open relay (HIGH-8), an attacker fully controls both recipient and link — a convincing trusted-domain phishing primitive.

**Repro:** Call `sendOrderConfirmation` with `portalLink` set to a `javascript:`/`data:` URI or a phishing `https` URL; the rendered anchor points there. (Most mail clients strip `javascript:`, limiting that variant; the `https` phishing case is the real impact.)

**Root cause:** `escHtml` only HTML-entity-encodes `&<>"`; it performs no URL-scheme validation before placing the value in an `href` context.

**Proposed fix:** Enforce `request.auth` on `sendOrderConfirmation` and validate `portalLink` against a scheme allowlist (reject anything not matching `/^https?:\/\//i`) before interpolation; same for any other client-supplied URL used in `href` contexts.

---

### Business-invariants / reporting (`public/app.js`)

#### MED-4 — Revenue/margin reports omit the `pricePerCaseCustom` fallback leg; reports disagree with invoices
**File:** `public/app.js:9759, 9804, 10013` vs `26` (`_calcPricePerCase`)
**Status:** CONFIRMED

**Summary:** `repRevenue`/`repAccounts`/`repProfit` read `ac2?.pricePerCaseDirect` for the direct branch, but the canonical `_calcPricePerCase` (line 26) and `calcOrderValue` use `ac.pricePerCaseDirect || ac.pricePerCaseCustom`. An account priced only via `pricePerCaseCustom` is valued correctly by invoices but silently defaulted to `PURPL_DIRECT_PER_CASE` in the reports — dashboard revenue and per-order/invoice revenue disagree for the same orders.

**Repro:** Set `ac.pricePerCaseCustom` (leave `pricePerCaseDirect` null), `fulfilledBy='direct'`. `calcOrderValue` (1689) returns the custom price; `repRevenue` (9759) returns `0` → `PURPL_DIRECT_PER_CASE`. Compare dashboard pending value (line 2641) vs Reports > Revenue total.

**Root cause:** Reports reimplement the pricing fallback inline and omit the `pricePerCaseCustom` leg present in the shared helper.

**Proposed fix:** Replace the inline `acPrc` computation in the three reports with `_calcPricePerCase(ac2)` so all revenue paths share one fallback chain. (Note: line 11985 has the same inline duplication but correctly includes the custom leg.)

---

#### MED-5 — Persisted `2.15` COGS placeholder fabricates margins
**File:** `public/app.js:16, 9770, 9783, 10024, 10030, 10040, 10722, 10773`
**Status:** CONFIRMED

**Summary:** `_cogs` (16) and every margin computation silently substitute `2.15` when a SKU has no configured cost, producing fictional margins with no UI flag. Worse, `saveSettings` (10722) and `saveInventorySettings` (10773) PERSIST `2.15` as the real COGS for any SKU whose cost input is blank (`parseFloat(...)||2.15`).

**Repro:** Fresh DB where `costs.cogs` is `{}`. Reports > Gross Profit computes COGS = `2.15 × cans` for all 4 SKUs and reports margin as if costs were known. Then save Settings with a blank cost field: line 10722 writes `cogs[sku]=2.15`.

**Root cause:** A placeholder literal (`2.15`) is used as a silent default in both display and persistence instead of representing "unknown cost" and surfacing it.

**Proposed fix:** Replace `||2.15` in report COGS with an explicit "cost not set" state (skip the SKU; badge margins N/A). In save functions, store `null`/omit when blank rather than coercing to `2.15`. Keep `2.15` only behind an explicit, labeled default if needed.

---

#### MED-6 — Distributor shipment writes `lastOrder` but readers read `lastOrderDate`; overdue KPI mis-fires
**File:** `public/app.js:7089` (writer) vs `6191/6192/6248/6463/7125` (readers)
**Status:** CONFIRMED

**Summary:** Logging a distributor shipment writes `d.lastOrder`, but every distributor reader reads `d.lastOrderDate`. The shipment never updates the distributor's displayed "Last Order" date or the reorder-overdue computation.

**Repro:** Log a shipment (`saveDistShipment` ending ~7037-7090). Reopen the distributor edit modal — `#edist-last-order` reads `d.lastOrderDate` (line 7125), unchanged. The overdue-reorder check (lines 6190-6192) reads `d.lastOrderDate` and never fires off the new shipment, so the distributor wrongly counts as overdue.

**Root cause:** Field-name mismatch: the shipment writer (7087-7090) sets `lastOrder: date` while the rest of the distributor subsystem standardized on `lastOrderDate`. Accounts use `lastOrder`; the shipment handler copied the account convention. (Mitigation: the card and detail "Last Order" still update via the `dist_pos` PO fallback `pos[0]?.dateReceived`; the genuinely broken outputs are the edit-modal field and the dashboard "Overdue Reorders" KPI at line 6190.)

**Proposed fix:** Change line 7089 from `lastOrder: date` to `lastOrderDate: date`.

---

### Data-integrity / unsorted-array reads (`public/app.js`)

#### MED-7 — `acLastContacted` reads `[length-1]`; a backdated entry misreports last-contacted
**File:** `public/app.js:2975-2979` (read); `5806/5826-5829` (unsorted append)
**Status:** CONFIRMED

**Summary:** `acLastContacted` assumes `notes[]`/`outreach[]` are chronologically sorted and reads only the last element. `saveLogOutreach` lets the user pick an arbitrary (backdated) date but appends to the END of the array, so a backdated entry becomes the "last" element and is reported as most recent.

**Repro:** Log an outreach dated today (entry A → `outreach[last]=A`). Then log another with `#mlo-date` (line 5806) set a week ago (entry B). `saveLogOutreach` appends B to the end (line 5829), so `outreach[length-1]=B` (older). `acLastContacted` (line 2977) returns B's older date. The card (3005-3013), the needs-attention rollup (3006: `daysAgo(lastContact)>=30`), and the `lastContacted` sort (3131) all misorder it.

**Root cause:** Positional `[length-1]` indexing instead of scanning for max date, while entries are appended unsorted with user-supplied dates. Same pattern at line 1818 and lines 3038-3039.

**Proposed fix:** Compute the max date: `const noteDate = a.notes?.length ? a.notes.reduce((m,n)=> n.date>m?n.date:m, '') : null;` (same for outreach). Apply to lines 1818, 3038-3039 too, or sort on insert in `saveLogOutreach`. **Note:** the parallel top-level `a.lastContacted` field set at 5828 is also overwritten by a backdated entry and is read at 4577-4609 (outreach-queue filtering), compounding the misreport.

---

#### MED-8 — Dashboard reminders inspect only the LAST note; earlier pending follow-ups vanish
**File:** `public/app.js:1817-1822`
**Status:** CONFIRMED

**Summary:** The dashboard upcoming-reminders builder only inspects `a.notes[a.notes.length-1]` for a `nextDate`. A pending follow-up on an earlier note is silently dropped once any later note without a `nextDate` is appended.

**Repro:** On an account with no `nextFollowUp`, add a note with `nextDate` 3 days out (note X) — it appears on the dashboard. Then add a plain quick-note (e.g. line 3439/5750) with no `nextDate` (note Y, appended last). The reminders loop (line 1818) reads `notes[last]=Y`, sees no `nextDate`, the condition (1819) is false, and note X's follow-up vanishes — though still pending.

**Root cause:** The scan assumes the most recent actionable note is always the last element and does not iterate to find any upcoming `nextDate`. Same unsorted/positional-read family as MED-7.

**Proposed fix:** Replace the single `notes[last]` read with a scan over `a.notes` for the entry with the soonest upcoming `nextDate` (filter `n.nextDate && n.nextDate <= in14`, pick min), or track follow-ups in the dedicated `nextFollowUp` field. (Recoverable — the note still renders on account detail at line 3426.)

---

## LOW

### Data-integrity / persistence layer (`public/db.js`)

#### LOW-1 — `_saveConfig` retries forever on permanent errors
**File:** `public/db.js:382-387`
**Status:** CONFIRMED

**Summary:** `_saveConfig` retries every 2s on ANY error, including permanent ones (`permission-denied`, `invalid-argument`). Unlike `_saveCollection`, it does not classify permanent vs transient — infinite retry loop / stuck queue on a permanent rejection.

**Repro:** Trigger a config save under rules that reject the config doc write (`permission-denied`) or with an invalid payload. The catch (382) logs, shows "retrying…", and unconditionally `setTimeout(_saveConfig, 2000)` (386). No error-code check, no retry cap — loops every 2s indefinitely.

**Root cause:** `_saveConfig`'s catch lacks the permanent/transient classification `_saveCollection` has (lines 354-359) and lacks any retry counter cap.

**Proposed fix:** Mirror `_saveCollection`: check `e.code` against the permanent list and stop with a "changes NOT saved" toast; for transient errors add a bounded retry counter (≤3). (In-memory `_cache` retains the data, so this is a retry storm + misleading UX, not data loss.)

---

#### LOW-2 — Stuck dirty key after retry exhaustion; `_saveRetries` never reset
**File:** `public/db.js:364-370`
**Status:** CONFIRMED

**Summary:** After 3 failed transient retries, the key is re-added to `_saveDirtyKeys` (368) but no new timer is scheduled and `_saveRetries[key]` is never reset, so the key stays permanently dirty and any later retry immediately sees `retries>3` and never actually retries — stuck until a full reload.

**Repro:** Force 4 consecutive transient failures (e.g. `unavailable`). Attempts 1-3 reschedule (366). Attempt 4 (`retries=4>3`) runs the give-up branch (367-369): `_saveDirtyKeys.add(key)`, toast, schedules nothing. `_saveRetries[key]` stays 4. Connection restoration alone never triggers a flush. `_saveRetries[key]` is only cleared on a successful save (348), which can no longer be attempted automatically.

**Root cause:** No automatic re-drive (no `online` listener, no periodic flush), and `_saveRetries[key]` is not reset on give-up.

**Proposed fix:** On exhaustion, keep retrying on a longer backoff OR register a window `online` listener that re-flushes `_saveDirtyKeys` and resets `_saveRetries`. At minimum reset `_saveRetries[key]=0` when re-queuing at line 368. (Changes remain in `_cache` and IndexedDB; unload flush bypasses the counter — staleness, not guaranteed loss.)

---

### Inventory (`public/app.js`)

#### LOW-3 — Four inline on-hand computations bypass `_onHand`; one omits the per-SKU clamp
**File:** `public/app.js:2716-2719, 8580-8582, 9891-9892, 9898-9899`
**Status:** CONFIRMED

**Summary:** Four stale on-hand computations re-implement the in/return-minus-out math inline instead of calling `_onHand`. They are pool-agnostic (global total, acceptable), but line 8582 does NOT apply the per-SKU `Math.max(0,...)` clamp that `_onHand:112` applies, so a net-negative SKU drags `totalStock` (8584) below the true clamped sum.

**Repro:** Force one SKU net-negative (delete an "in" entry after deductions). `renderProductionRecommendation` (8572) computes `stockBySku[sku]` negative (8582); `totalStock` (8584) is understated, increasing `needed` (8600) — over-recommendation (safe side).

**Root cause:** On-hand math copy-pasted into dashboard/production cards instead of delegating to `_onHand(sku,null)`. Clamp inconsistent: present at 2719/9892/9899, absent at 8582.

**Proposed fix:** Replace all four inline blocks with `_onHand(sku, null)`. At minimum add `Math.max(0,...)` at 8582. (Advisory UI figure only; error direction is safe over-produce.)

---

#### LOW-4 — `saveDistShipment` multi-write is non-atomic **[PLAUSIBLE — verify before fixing]**
**File:** `public/app.js:7058-7084` (iv push 7062, separate from PO 7058 and stock_transfer 7076)
**Status:** PLAUSIBLE

**Summary:** `saveDistShipment` writes the PO (7058), per-SKU `iv` deductions (7062), and stock_transfer (7076) as three separate `DB.push` calls rather than one batch. Pool stamp is correct (`warehouse`, 7068) and an in-flight guard (7016-7020) blocks double-click. But a failure between writes can leave a PO recorded with no/partial inventory deduction. No overdraft check (acceptable per lenient spec).

**Repro:** Simulate a write failure after `DB.push('dist_pos')` (7058) but before the `iv` loop (7062): PO exists, warehouse pool not deducted; reconciliation shows shipped goods still on-hand.

**Root cause:** Multiple independent `DB.push` calls instead of one atomic batch (contrast delivery invoice 9064 and returns 8174 which use `atomicUpdate`).

**Proposed fix:** Wrap PO + `iv` entries + stock_transfer in one operation. **Caveat:** `DB.atomicUpdate` is NOT truly atomic at the Firestore layer (it does per-doc `setDoc` with no `writeBatch`/transaction); a real fix requires a Firestore batched write/transaction. Low — rare persistence-failure path, retry fallback exists.

---

#### LOW-5 — In-flight flags not reset on validation early-returns (2s retry lockout)
**File:** `public/app.js:15623-15663` (`_saveInvCore`), `12152` (`saveNewCombinedInvoice`), `7032/7844/7904`
**Status:** CONFIRMED

**Summary:** Several in-flight guards set the flag then early-return on validation failures WITHOUT clearing it, relying on the 2000ms `setTimeout` to self-heal. E.g. `_saveInvCore` sets `_saveInvInFlight=true` (15626) but the `!accountId` (15640) and `!lineItems.length` (15663) returns don't reset it; `saveNewCombinedInvoice` resets on the account check (12105) but NOT the lines check (12152). Effect: after a validation failure the user must wait up to 2s before retry.

**Repro:** Open new invoice, submit with no account → toast, flag stays true → fix and resubmit within 2s → second submit silently swallowed.

**Root cause:** Early-return validation paths placed after the guard is set without a matching reset.

**Proposed fix:** Reset the in-flight flag on every early-return validation branch (mirror 15640/12105), or move the guard below all synchronous validation. Cosmetic — returns precede all persistence; self-heals in 2s.

---

#### LOW-6 — `pushToWarehouse` re-tags `fulfillmentSource` but doesn't re-pool deducted `iv` entries **[PLAUSIBLE — verify before fixing]**
**File:** `public/app.js:15035` (`pushToWarehouse`) vs deductions at `15461/12729/15710/9070`
**Status:** PLAUSIBLE

**Summary:** `pushToWarehouse` sets the invoice's `fulfillmentSource` to `warehouse` (15035) but does NOT move already-created `iv` "out" entries, which were stamped from the OLD `fulfillmentSource` (`farm`) at send/save time. If an invoice was sent (deducting farm pool) then pushed to warehouse, the ledger keeps the deduction against farm while the invoice claims warehouse fulfillment — per-pool totals disagree with the invoice's stated source.

**Repro:** Create+send a non-draft purpl invoice with `fulfillmentSource='farm'` (deducts farm at 15461). Click "🏭 Warehouse" (button 15029 → `pushToWarehouse`). Invoice `fulfillmentSource` becomes `warehouse` but the `iv` "out" entry still has `pool:'farm'`.

**Root cause:** `pushToWarehouse` only patches the invoice doc; it does not re-pool the linked `iv` entries.

**Proposed fix:** In `pushToWarehouse`, also re-pool existing `iv` "out" entries for that `invoiceId` from farm→warehouse inside an `atomicUpdate` (only when deductions exist). Cosmetic/reporting only — `_onHand(skuId, null)` is pool-agnostic so total on-hand stays correct; only the farm-vs-warehouse split is skewed.

---

#### LOW-7 — `stock_transfers` is a write-only dead collection
**File:** `public/app.js:7076-7084`
**Status:** CONFIRMED

**Summary:** `stock_transfers` is now write-only dead. The distributor shipment handler still pushes a `stock_transfers` record, but the only reader (`_renderLocationsTable`) was deleted when the two-pool model replaced `stock_locations`/`stock_transfers`.

**Repro:** No definitions of `_renderLocationsTable`/`addStockLocation`/`saveStockTransfer` exist in `app.js` (only in `POOL_DESIGN.md`/`INVENTORY_INVOICING_MAP.md` as historical docs). `stock_transfers` appears exactly once in `public/app.js`: the `DB.push` at line 7076. No code reads it.

**Root cause:** `POOL_DESIGN.md` DECISION 3 retired `stock_locations`/`stock_transfers` for the per-SKU warehouse/farm pool model and removed the location-render code, but left the writer (line 7076).

**Proposed fix:** Delete the `DB.push('stock_transfers', {...})` block (7075-7084) and the `stId` allocation (7040). The `iv` "out" entries (7061-7073) already record the movement. Optionally drop `stock_transfers`/`stock_locations` from `db.js:26`. Pure storage hygiene — zero data/money/info loss.

---

### Business-invariants / pricing (`public/app.js`)

#### LOW-8 — "Distributor = direct × 75%" invariant is not implemented anywhere **[PLAUSIBLE — verify before fixing]**
**File:** `public/app.js:23-28, 2475-2480, 6759-6794, 7279-7290`
**Status:** PLAUSIBLE

**Summary:** The stated invariant "distributor pricing = direct × 75%" is NOT implemented. No code applies a `0.75` (or any) multiplier off `PURPL_DIRECT_PER_CASE`. `_calcPricePerCase` (23) reads `ac.pricePerCaseDist` as a raw manually-entered value; the dist pricing table (`renderDistPricingHTML` 6759 / `saveDistPricing` 7279) stores hand-typed price-per-case with no derivation. A blank dist SKU stores null and falls through to `PURPL_DIRECT_PER_CASE` (full direct price) — the opposite of a discount.

**Repro:** Searching for `0.75`/`0.65`/`direct *` in a pricing context returns nothing tied to PURPL constants. A distributor SKU left blank in the pricing table stores null and falls back to full direct price.

**Root cause:** The "direct×75%" rule was never codified; distributor pricing is free-form manual entry with the direct case price as the only fallback.

**Proposed fix:** Introduce `PURPL_DISTRIBUTOR_PER_CASE = PURPL_DIRECT_PER_CASE * 0.75` and use it as the default. **Note:** the "75% invariant" is not found anywhere in the repo, so the framed failure is not constructible against an actual requirement; the genuine residual issue (blank dist price → full direct price) is guarded by per-account manual entry and visible "Pending" badges (6768-6769). Low, not the originally-claimed High.

---

#### LOW-9 — Distributor revenue fallback uses full direct price **[PLAUSIBLE — verify before fixing]**
**File:** `public/app.js:9759-9762, 9804-9808, 10013-10016`
**Status:** PLAUSIBLE

**Summary:** `repRevenue`/`repAccounts`/`repProfit` compute distributor revenue as `acPrc || PURPL_DIRECT_PER_CASE`. When a distributor-fulfilled account has no `pricePerCaseDist` (`acPrc=0`), the report bills at the FULL direct case price (`$27.60`), even though distributors are supposed to pay less.

**Repro:** Account with `fulfilledBy != 'direct'` and `pricePerCaseDist` unset, add an order, open Reports > Revenue. Line 9759 yields `acPrc=0`; line 9761 uses `PURPL_DIRECT_PER_CASE`.

**Root cause:** The fallback for missing distributor pricing is the direct retail price, not a distributor price; there is no distributor default constant (see LOW-8).

**Proposed fix:** Default the distributor branch to a distributor constant (direct×0.75) or exclude/flag dist accounts with no configured price. **Note:** the fallback is applied consistently across reports AND order entry (line 11994) and the shared helper (line 27), so reports do not diverge from billed amounts — the magnitude depends on an unverifiable contractual assumption. Downgraded to Low: a configuration/UX gap, not a margin-miscalculation bug.

---

### Security / portal-email

#### LOW-10 — `verifyPortalPassword` fails open when config is missing or password empty
**File:** `functions/index.js:411-420` (fail-open at 416, 418)
**Status:** CONFIRMED

**Summary:** `verifyPortalPassword` fails open: if `portal_settings/config` does not exist it returns `{valid:true}` (416), and if the doc exists but `portalPassword` is empty/unset it also returns `{valid:true}` (418). If the config doc is deleted/renamed or the field cleared, the gate silently disappears.

**Repro:** Delete/rename `portal_settings/config` (or clear `portalPassword`), then call `verifyPortalPassword` with any password — returns `valid:true`.

**Root cause:** Absent-config and empty-password are both treated as "no password required" rather than "deny."

**Proposed fix:** Fail closed: return `{valid:false}` when the config doc is missing, or gate open behavior behind an explicit `portalPublic === true` flag. **Scope note:** this gate only protects the wholesale order-intake form (already a public inquiry surface); it is NOT the auth for customer PII/invoices/history (those flow through the independent token-based `lookupPortalToken` at index.js:426, unaffected). Requires operator misconfiguration to trigger — Low.

---

### Portal (`public/order.html`, `functions/index.js`)

#### LOW-11 — Order quantities are not validated for sign/magnitude/integer-ness
**File:** `public/order.html:1190-1196, 1219, 1224-1246` + `firestore.rules:45-60`
**Status:** CONFIRMED

**Summary:** Order quantities aren't validated for sign, magnitude, or integer-ness on client or server. `portal_orders` is written directly via the public client SDK, and `firestore.rules` only constrains array LENGTH (`items/lineItems .size() < 50`) and field COUNT (`doc .size() < 50`) — never the numeric value. A customer (or anyone, since create is public) can submit negative, huge, or fractional quantities.

**Repro:** In the browser console: `db.collection('portal_orders').add({accountName:'X',billingEmail:'a@b.co',status:'new',items:[{sku:'classic',cases:-999999,cansPerCase:12,totalCans:-11999988}]})`. The write succeeds — rules accept it. `parseInt('-5')=-5`, so `updateCans()`/`getLfItems()` preserve negatives via the normal form too.

**Root cause:** `min`/`step` on `<input type=number>` (order.html:312, 628, 652, 676) are client-side hints not re-checked in `submitOrder()`. The server function doesn't look at quantities; persistence is a direct client write gated only by `firestore.rules`, which validates sizes but no numeric bounds.

**Proposed fix:** Add numeric validation in `submitOrder()` (reject `cases<0`, non-integers, cap e.g. `>10000`) AND move order creation behind a callable Cloud Function that validates each line item server-side, or tighten `firestore.rules` to assert each item's `cases` is an int in a sane range. Data-integrity pollution of a public collection (staff review orders at status `new`); no payment/fulfillment automation keys off these numbers — Low.

---

#### LOW-12 — `printPortalOrder` direct read denied for portal users (functional bug, not a leak)
**File:** `public/order.html:1428-1436, 503-507` vs `firestore.rules:57`
**Status:** CONFIRMED

**Summary:** `printPortalOrder()` reads `portal_orders` directly with the client SDK, but `firestore.rules:57` restricts `portal_orders` read to `isStaff()`. For an unauthenticated portal visitor this read is DENIED, so "View PDF" on past orders fails with `permission-denied` — a functional bug, not a data leak. `getPortalOrderHistory` (functions/index.js:491-520) is the correct token-gated path.

**Repro:** As an unauthenticated portal user with a valid `?t=` token, history renders via `getPortalOrderHistory` (server-validated). Clicking "View PDF" calls `printPortalOrder()` → direct Firestore read → rejects (caught at 1537, alerts "Could not load order"). No other account's data is exposed; the read simply fails.

**Root cause:** Inconsistent access pattern: history listing goes through a token-validated callable, but the per-order PDF view reuses a direct client read the rules (correctly) forbid for the public.

**Proposed fix:** `getPortalOrderHistory` already returns the same data the PDF renders — pass the already-fetched order object into `printPortalOrder` instead of re-reading `portal_orders`. No rule change needed; do NOT loosen the staff-only read rule.

---

#### LOW-13 — Email-displayed `purpleherb` password vs Firestore-stored gate can drift
**File:** `public/app.js:341-360, 755, 835, 871` + `functions/index.js:185, 295, 411-419`
**Status:** CONFIRMED

**Summary:** Templates hardcode the literal `purpleherb` (app.js:835, 871) as the portal password to type, but the actual gate (`verifyPortalPassword`) compares against `portal_settings/config.portalPassword` in Firestore (index.js:417). These can DRIFT: if an admin changes `portalPassword`, the emailed `purpleherb` becomes wrong; the literal is duplicated in two templates. (Signatures: present on every template via `_signatureHTML()` (755) plus inline blocks and server sign-offs at index.js:185/295 — verified fine.)

**Repro:** Set `portal_settings/config.portalPassword` to something other than `purpleherb`. Recipients of the approved/preorder-announcement emails are still told to enter `purpleherb` (835, 871), which `verifyPortalPassword` now rejects (419) — customers locked out via Option 2.

**Root cause:** The email-displayed password is a hardcoded literal in `app.js` while the enforced password is a Firestore config value; no single source of truth.

**Proposed fix:** Source the displayed password from `portal_settings/config.portalPassword` (pass into `getCadenceEmailTemplate` via `extra`, as already done for "approved" at app.js:16048) and remove the literals. Operational/UX only — Option 1 (personalized token link, no password — app.js:831/867) still works for every recipient; the gate never exposes the password to the client.

---

### Verifications (no bug found)

#### LOW-14 — Inventory deduction timing: no double or missed deduction (VERIFICATION)
**File:** `public/app.js:12203-12211, 12721-12733, 15453-15464, 7061-7073, 7444-7488`
**Status:** CONFIRMED (no bug)

Retail/combined deduct purpl inventory at send keyed on `invoiceId===purplInvoiceId`; combined send re-checks `alreadyDeducted` (12721) inside the atomic block against the same key, and `markInvoiceSent` (15454) checks the same key — a combined purpl child cannot be double-deducted across paths. Dist deducts only at shipment (7061-7073, `ref=shipId`, no `invoiceId`); `saveDistInvoice` (7444) never deducts. LF inventory is never deducted (managed on Wix). Consistent keying on the purpl child id makes the `alreadyDeducted` guard effective. No change required.

#### LOW-15 — `findInvoice` / `_invoiceCol` collection coverage complete (VERIFICATION)
**File:** `public/app.js:45, 70-83`
**Status:** CONFIRMED (no bug)

`_INV_COLS` (45) = `['retail_invoices','lf_invoices','combined_invoices','dist_invoices','iv']` — all 5 collections including the historically-missed combined and dist. `findInvoice` (70) and `_invoiceCol` (78) both iterate `_INV_COLS`, so lookups span every collection. `_invoiceCol` defaults to `retail_invoices` on miss (benign — only matters for an id absent from all collections, where the subsequent `DB.update` no-ops). No change required.

#### LOW-16 — Portal token flow & cross-account isolation sound (VERIFICATION)
**File:** `public/order.html:838-845, 887-919` + `functions/index.js:426-486, 491-502`
**Status:** CONFIRMED (no bug)

Token comes from URL `?t=`, stored in `sessionStorage` (`pbf_portal_token`), resolved only via the `lookupPortalToken` callable which queries `orderPortalToken` server-side and returns only that token's account. `getPortalOrderHistory` independently re-validates that the supplied token owns the requested `accountId` (`s.docs[0].id === accountId`, index.js:496-502) before returning orders, preventing a forged `accountId` from pulling another account's history. A forged `getPortalOrderHistory({accountId:B, token:tokenA})` returns `{orders:[]}`. No fix required. Minor optional hardening: tokens are bearer credentials in the URL — consider rotation/expiry. Also covers the password-gate-vs-token-link design (order.html:877-924, 1768-1789): personalized links intentionally bypass the gate (token is the credential), which is safe.

#### Bootstrap robustness — `initUserRole` non-transactional users read **[PLAUSIBLE — verify before fixing]**
**File:** `functions/index.js:578-596` (first-admin transaction); `582` (non-transactional users read)
**Status:** PLAUSIBLE (robustness nit, no exploitable vuln)
**Severity:** Low

The first-admin assignment relies on a transaction guarded by the `bootstrapAdminAssigned` flag (read via `tx.get` at 579, set at 593) — the real race guard, and sound. But the `isFirstUser` determination reads `db.collection('users').limit(1).get()` (line 582) OUTSIDE the transaction, so the users-empty check is racy. Correctness ultimately depends on the transactional `bootstrapAdminAssigned` flag. No self-elevation found (users create rule blocks `role` at firestore.rules:23-25; `initUserRole` enforces the allowlist at 565-574). **Proposed fix:** rely solely on `bootstrapAdminAssigned` (read via `tx.get`) for the first-admin decision; the users read at 582 is redundant for correctness. Cosmetic/robustness — no data/money/info loss.

---

## Subsystem coverage

| Subsystem | Findings? | Notes |
|-----------|-----------|-------|
| **data-integrity** | YES | HIGH-1..4 (db.js durability/sync), LOW-1, LOW-2; MED-7, MED-8 (unsorted-array positional reads) |
| **inventory** | YES | HIGH-6 (returns 2× double-submit), LOW-3..7; deduction-timing reviewed **clean** (LOW-14) |
| **invoicing** | YES | HIGH-5 (combined orphan), MED-1 (Stripe legacy-child mark-paid); collection-coverage reviewed **clean** (LOW-15) |
| **security** | YES | HIGH-7 (rules: employee can delete financials + audit_log), HIGH-8 (open relay), MED-2, MED-3, LOW-10; bootstrap reviewed (robustness nit only) |
| **portal-email** | YES | MED-2, MED-3, LOW-10..13; token isolation & password-gate design reviewed **clean** (LOW-16) |
| **business-invariants** | YES | MED-4 (custom-price report divergence), MED-5 (2.15 COGS), MED-6 (lastOrder field mismatch), LOW-8, LOW-9 (distributor pricing — both PLAUSIBLE) |
| **cross-boundary** | YES | HIGH-2 (unload flush across page lifecycle), HIGH-3 (cache-vs-Firestore false success), MED-1 (client markCombinedPaid vs Stripe webhook divergence) |

No subsystem came back entirely empty; the clean results are scoped verifications (inventory deduction timing, invoice collection coverage, portal token isolation) filed as LOW-14/15/16.

---

## Prioritized action list — fix first

**Tier 1 — silent data loss / consistency (do immediately):**
1. **HIGH-1** — wrap `atomicUpdate` in `try/finally` (`db.js:491-520`). One thrown mutator kills multi-user sync for the whole session; ~30 call sites.
2. **HIGH-4** — fix the config snapshot listener guard at `db.js:199` to mirror line 176. Concurrent config write clobbers unsaved settings edits.
3. **HIGH-3** — make write methods return the `_writeDoc` promise and re-drive stuck keys (`db.js:439-450`). API reports false success on failed writes.
4. **HIGH-2** — durable unload flush (`db.js:291-310`); persist dirty keys to `localStorage` before clearing.

**Tier 2 — financial / inventory integrity:**
5. **HIGH-5** — clear `combinedInvoiceId` on the surviving sibling in `deleteInvoiceWithCleanup` (`app.js:95`); also audit `deleteCombinedInvoice` (11840). Orphaned dollars vanish from every report and the tax export.
6. **HIGH-6** — add an in-flight guard to `saveReturn` (`app.js:8145` / `index.html:619`). Double-click inflates on-hand 2×.

**Tier 3 — security:**
7. **HIGH-7** — tighten `firestore.rules` `workspace/{path=**}` (lines 114-117); carve out `config`/invoice-delete/`invoice_settings`/`audit_log` as `isAdmin()`, and remember the wildcard itself must be narrowed.
8. **HIGH-8 + MED-3** — add auth/App Check + recipient binding + `http(s)` allowlist to `sendOrderConfirmation` (`functions/index.js:107-252, 187`).
9. **MED-2** — same treatment for `sendApplicationConfirmation` (open relay + arbitrary inquiry-doc write).

**Tier 4 — reporting correctness & quick wins:**
10. **MED-4** — route the three reports through `_calcPricePerCase(ac2)` (`app.js:9759/9804/10013`).
11. **MED-5** — stop persisting/displaying `2.15` as real COGS (`app.js:10722/10773` + report sites).
12. **MED-1** — add the `iv`-collection fallback to the Stripe combined-paid path (`functions/index.js:1095-1100`).
13. **MED-6** — one-line fix: `lastOrder` → `lastOrderDate` at `app.js:7089`.
14. **MED-7 / MED-8** — replace `[length-1]` reads with max/min-date scans (`app.js:2977, 1818, 3038-3039`).

**Tier 5 — low-risk hardening / cleanup (batch when convenient):**
15. LOW-1/LOW-2 (config retry classification + `online` re-drive), LOW-5 (reset in-flight flags), LOW-10 (fail-closed portal gate), LOW-11 (order-quantity validation), LOW-12 (pass order object into `printPortalOrder`), LOW-3 (use `_onHand`), LOW-7 (delete dead `stock_transfers` write), LOW-13 (single source of truth for portal password).
16. Verify-before-fixing PLAUSIBLE items: LOW-4, LOW-6, LOW-8, LOW-9, and the bootstrap nit — confirm the mechanism in context before changing code.
