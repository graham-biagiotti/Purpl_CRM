# Purpl CRM — Exploratory Scan (read-only)

**Date:** 2026-06-29
**Scope:** Blind spots not covered by `FULL_REVIEW.md`, plus verification that the recent fixes (db.js HIGH-1/2/3, HIGH-5 combined-invoice dissolve, firestore.rules HIGH-7, audit_log append-only) did not break or half-solve anything.
**Method:** Traced (not asserted) across `public/db.js`, `public/app.js`, `public/order.html`, `functions/index.js`, `firestore.rules` via 5 parallel deep-trace passes + independent spot-verification of the top findings. Nothing here is a re-report of an already-fixed FULL_REVIEW item.

**No code was changed.** This is a problem inventory, ranked by real-world impact.

---

## RESOLUTION STATUS (updated after fix pass)

Fixed and pushed (one or two findings per commit for traceability):

| Finding | Status | Commit summary |
|---------|--------|----------------|
| C1 — `_saveCollection` deletes other users' records | ✅ FIXED | deletions now explicit via `_deleteDoc`; save paths never delete by cache-absence |
| H1 — recovery resurrects remote deletes | ✅ FIXED | blob holds only recently-modified items; replay won't resurrect old missing rows |
| H2 — recovery clobbers newer remote edit | ✅ MITIGATED | epoch compare + 5s skew margin (true same-doc cross-device conflict still needs server timestamps) |
| H4 — full re-render per remote snapshot | ✅ PARTIAL | re-render debounced (120ms); deeper query-on-demand work still open |
| H5 — O(n²) reports | ✅ FIXED | single `accountById` map in the 3 reports |
| M1 — combined child paid ≠ parent | ✅ FIXED | `_syncCombinedParentForChild` wired into all child paid paths |
| M2 — two "Total Invoiced" disagree | ✅ FIXED | reports total now excludes void to match the invoices KPI |
| M3 — non-atomic invoice + inventory | ✅ FIXED | `_saveInvCore` & `markInvoiceSent` use one `atomicUpdate` |
| M6 — invoice-number collision | ✅ MITIGATED | cache-fallback now warns staff to verify (true fix needs server) |
| M7 — ShipStation slides due dates | ✅ FIXED | financial dates set only on first shipment |
| M8 — `$NaN` KPIs from qty | ✅ FIXED | `parseFloat(i.qty)||0` in reports + velocity |
| M11 — online re-drive wipes all backoff | ✅ FIXED | resets only the re-driven keys |
| M13 — atomicUpdate leaks dirty keys | ✅ FIXED | deferred flush clears the keys it persists |
| M14 — recovery blob quota | ✅ FIXED | windowed blob + audit_log excluded |
| M15 — multi-tab recovery clobber | ✅ FIXED | blob merged, not overwritten |
| M16 — sample-box lost update | ✅ FIXED | account write in a `runTransaction` |
| L5 — atomicUpdate re-stamps audit_log | ✅ FIXED | append-only rows no longer re-stamped |

Deferred — needs a product decision, a dedicated effort, or is the owner's task (NOT fixed here):

| Finding | Why deferred |
|---------|--------------|
| H3 — audit_log fully loaded + listened | Architectural: make it `orderBy('timestamp','desc').limit(N)` query-on-demand and drop it from the loaded/listened collection set. Worth a focused pass; touches the data-layer core. |
| M4 — `lastOrder` not set by invoice paths | Display-only false "stale" flag. Clean fix is reader-side (card considers latest invoice date) but needs the per-account invoice index from the H3/H5 work to avoid O(n²). |
| M5 — portal `workspace/*` reads denied | Customer-facing: portal quotes LF prices from a stale client constant. Fix is a token-validated callable (mirror `getPortalOrderHistory`) returning `lf_skus`. New Cloud Function + deploy — do as its own change. |
| M9 — `$2.15` COGS placeholder | Resolves once real COGS is set in Settings (owner's checklist item). |
| M10 — config recovery guard | Needs per-key config timestamps to do right; current behavior is conservative. Low value. |
| M12 — atomicUpdate no cache rollback | A correct rollback needs a deep cache clone per atomicUpdate (expensive at scale; audit_log is huge). Trigger is UNCONFIRMED (mutator throwing post-mutation). Not worth the cost yet. |
| L1 — invoice-number sequence gaps | Cosmetic; allocator decoupled from write. |
| L2 — Stripe idempotency check-then-write | Mark-paid mutation is idempotent; only a duplicate audit row. |
| L3 — `accountId` spoofing on portal create | Rules can't verify the id exists; staff review `new` orders. |
| L4 — employee can mint portal tokens | Product decision: gate `orderPortalToken` write to admin, or accept it. |
| L7 — emulator test for audit_log rule | Add `@firebase/rules-unit-testing`; testing-infra task. |
| L8 — dead `app_config` rule | Harmless; leave or remove later. |

---

## TL;DR — the three that matter most

1. **`_saveCollection` deletes other users' records (CRITICAL, multi-user data loss).** The whole-collection save reads the server, then deletes any doc not in the *local cache* — but the cache is intentionally stale whenever a save/atomicUpdate is in flight. Two concurrent users ⇒ one silently deletes the other's just-created accounts/orders/invoices.
2. **The HIGH-2 recovery mechanism can resurrect deleted data and overwrite newer remote edits (HIGH).** Its own comment claims it "can never clobber a newer remote edit" — that claim is false. It trusts unsynchronized client clocks and has an unguarded resurrection path.
3. **The app loads every collection in full with a permanent listener (HIGH at scale).** `audit_log` (the one collection that grows without bound) is downloaded in its entirety to show 10 rows, and account/dashboard/report renders are O(n²) over orders×accounts.

The recent fixes themselves: **HIGH-5 (combined-invoice dissolve) verified correct.** HIGH-7 (rules) caused **no lockout**. But HIGH-1/2/3 introduced or left open the items in §A below, and the save layer they live in is the single riskiest part of the app.

---

# CRITICAL

## C1 — `_saveCollection` blind delete-diff silently deletes another user's records
- **File:** `public/db.js:434-438` (delete pass) within `_saveCollection` (db.js:417-466) and `_saveCollectionSync` (db.js:692-706); cache-staleness guard at `db.js:203`.
- **Status:** CONFIRMED (verified the listener guard at db.js:203 and the delete logic directly).
- **Reachable from:** every `atomicUpdate` flush (~30 call sites: invoice delete app.js:87, return log 8201, delivery invoice 9091, portal-order convert 14642, etc.) and every debounced collection save.

**Mechanism:** `_saveCollection` does `colRef.get()` → for every server doc id **not present in `this._cache[key]`**, `batch.delete()` it (db.js:434-438). But the snapshot listener (db.js:203) *skips* applying remote changes to the cache whenever `_dirty || _atomicInProgress || _saveDirtyKeys.has(key)` — it just sets `_pendingRemoteChanges`. So while the local user has any pending/dirty save, their cache does **not** contain docs other users just created.

**Repro (two users / two tabs):**
1. User A creates a new account → `_writeDoc` commits it to Firestore.
2. User B is mid-edit, so the `ac` snapshot is deferred (B's `ac` is dirty, or `_atomicInProgress` is set during any atomicUpdate) → B's cache never receives A's account.
3. User B triggers any `atomicUpdate` (logs a return, deletes an invoice, converts a portal order) → `_saveCollection('ac')` runs. Server `existingIds` includes A's account; B's `cacheIds` doesn't → `batch.delete(A's account)`.
4. A's account is **gone from Firestore** for everyone.

**Why it matters:** This is "diff against my possibly-stale cache and delete the difference" on a multi-writer database. It can delete another user's accounts, orders, invoices, or `iv` inventory-ledger rows — genuine data loss, not stale display. The `_pendingRemoteChanges` reload banner is the only mitigation, and the destructive delete fires on the next atomicUpdate, typically before a human reacts. Given the app is explicitly moving to multi-user, this is the top priority. (Single-user is mostly safe because the user's own cache stays authoritative.)

---

# HIGH

## H1 — Recovery replay resurrects remotely-deleted records
- **File:** `public/db.js:337` (snapshot captures the *entire* dirty collection array), `db.js:385` (`!cur` resurrection branch, no timestamp guard), `db.js:105` (server load precedes replay, so `cur` reflects post-delete state).
- **Status:** CONFIRMED (independently traced + corroborated by the db.js verification pass).

**Mechanism:** On unload, `_flushPendingSave` stores `recovery.collections[key] = this._cache[key]` — the *whole* array for any dirty key, not just the edited row. On next load, `_replayRecovery` re-asserts any recovery item where `!cur || newer(item,cur)`. The `!cur` branch (item missing from the server-loaded cache) re-creates the doc with **no timestamp check at all**.

**Repro:** Tab A edits account X (collection `ac` dirty; cache = [X,Y,Z]); user closes the tab within the ~500ms debounce window → recovery saves [X,Y,Z]. Meanwhile another device deletes account Y. Tab A reopens: `_loadFromCollections` loads `ac`=[X,Z]; replay sees Y has no `cur` → pushes Y back and `_writeDoc`s it → **Y is resurrected for everyone**, for up to 24h after the close.

**Why it matters:** A legitimate deletion is silently undone and re-persisted to the shared server. Every row in a dirty collection is a resurrection candidate, not just the one actually edited.

## H2 — Recovery replay clobbers a *newer* remote edit (client-clock `_updatedAt`)
- **File:** `public/db.js:377` (`newer = (a._updatedAt||'') > (b._updatedAt||'')`), `db.js:591`/`625` (`_updatedAt` is a client `new Date().toISOString()`), `db.js:362-363` (the false "can never clobber a newer remote edit" comment).
- **Status:** CONFIRMED for the clock-skew path; `atomicUpdate` re-stamping confirmed.

**Mechanism:** The replay "newer wins" guard compares two **client-generated** ISO timestamps with no server-time authority. Across devices with even slight clock skew, an *older* local edit can carry a *higher* timestamp than a genuinely newer remote edit and overwrite it. Worse, `atomicUpdate` stamps `_updatedAt` on **every** item in every collection it touches (db.js:625), not just mutated ones — so after any atomicUpdate, an entire dirty collection's rows carry fresh timestamps and win `newer()` against legitimately-newer remote edits to *other* rows.

**Why it matters:** The HIGH-2 fix's core safety claim is false under exactly the multi-device scenario it targets. Newer remote edits are silently lost.

## H3 — Whole `audit_log` (unbounded) loaded into memory with a permanent listener
- **File:** `public/db.js:14-21` (audit_log in COLLECTION_KEYS), `db.js:173-176` (full `.get()`, no limit), `db.js:193-218` (permanent `onSnapshot`). Readers only want newest N: `app.js:1331-1333` (`.slice(0,10)`), `app.js:9607-9610` (`.slice(0,100)`).
- **Status:** CONFIRMED.

**Mechanism:** `audit_log` is written on nearly every mutating action and never pruned, yet it's loaded in full at startup and kept on a realtime listener forever, only to display 10–100 rows.

**Why it matters:** The one strictly-unbounded collection has the worst loading strategy. After months, cold start downloads tens of thousands of docs (slow start, billed reads), they sit in memory permanently, and each new audit write re-maps the whole array + triggers a full page re-render (see H4). Should be an `orderBy('timestamp','desc').limit(100)` query, not a cached, fully-listened collection.

## H4 — Permanent full listeners on every collection → full page re-render per remote change
- **File:** `public/db.js:193-218` (listener per collection) → `db.js:212` `refreshCurrentPage()` → `app.js:13251-13257` (re-runs migrations + `_checkShippedInvoices` + full render).
- **Status:** CONFIRMED.

**Mechanism:** ~18 collections each hold a permanent unfiltered `onSnapshot`. Any remote change re-materializes that collection's full cache array and re-runs a full render cascade. Cost per event scales with collection size and is unbounded.

## H5 — Account / dashboard / report renders are O(n²) over orders × accounts
- **File:** account cards `app.js:3049` (scan all orders per account) + `app.js:3064` (`_allInvoices` *rebuilds the unified array from all 5 collections* per card); reports `app.js:9783-9784`, `9829-9831`, `10043-10044` (per-order `DB.a('ac').find`); dashboard `renderDash` (app.js:1362-1463) recomputes every total via full scans, e.g. `_onHand` does two full `iv` scans per call (app.js:122-127) invoked per-SKU.
- **Status:** CONFIRMED.

**Why it matters:** Works fine at 10 accounts; at 500 accounts × thousands of orders/invoices these are millions of main-thread ops on every render — and every deferred remote snapshot triggers a re-render (H4). Opening Accounts/Reports/Dashboard janks for seconds; the search box (re-renders per keystroke) becomes laggy. Fix shape: build `accountById`, `ordersByAccount`, `invoicesByAccount` indexes once per render (one report, `exportYearEnd` app.js:10119, already does this correctly — the others don't).

---

# MEDIUM

## M1 — Per-child mark-paid / mark-sent / modal-save never sync the combined parent
- **File:** `markRetailInvPaid` app.js:2626-2632, `markLfInvPaid` 11386-11393, `markPaid` 14933-14941, `markInvoiceSent` 15488-15493, `_saveInvCore`→`updateInvoice` 15756. Reverse path (`markCombinedPaid` 11855) correctly syncs parent+children.
- **Status:** CONFIRMED for the modal status-change entry point; UNCONFIRMED whether a list button reaches a child directly (lists filter children out at app.js:15005/15014).

**Mechanism:** These update a single child's `status` and never touch `combinedInvoiceId`/the parent. Mark a combined invoice's purpl child paid (via global search 1232 or the edit modal) and the child becomes `paid` while the `combined_invoices` parent stays `sent`. The child-counting KPIs (`renderInvKpis` 15106) then show it paid while the parent-counting reports (`renderReports` 9312, account statement 12866) show it outstanding — **same money, two answers.**

## M2 — Two "Total Invoiced" KPIs use opposite conventions and disagree on void/draft
- **File:** `renderInvKpis` app.js:15106-15114 (counts children, excludes `void`) vs `renderReports` "Total Invoiced (All Brands)" app.js:9312-9313 (counts the combined parent, **no status filter** — includes void *and* draft).
- **Status:** CONFIRMED.

**Repro:** Void one dist invoice, have one combined invoice; the Invoices-page total and the Reports-page total (both labeled "Total Invoiced") differ by the voided (and any draft) amount. Reconciliation/trust problem, not lost money.

## M3 — `_saveInvCore` / `markInvoiceSent` write invoice + inventory deductions non-atomically
- **File:** `_saveInvCore` app.js:15744-15754 (`DB.push('retail_invoices')` then a separate loop of `DB.push('iv',…)`), `markInvoiceSent` app.js:15493-15504.
- **Status:** CONFIRMED. Same class as the fixed LOW-4 (`saveDistShipment`) but these two writers were never wrapped.

**Mechanism:** The combined/portal/dist-shipment paths use a single `atomicUpdate`; the single-retail-invoice create and mark-sent paths do not. The invoice doc and each per-line `iv` deduction are independent fire-and-forget writes. If the invoice lands but an `iv` deduction fails/stalls, the customer is billed but stock isn't deducted → `_onHand` overstates inventory (oversell risk). Fix: wrap in one `atomicUpdate`.

## M4 — `lastOrder` denormalized field written by order paths, never by invoice paths
- **File:** writers `createOrder` app.js:8448, delivery run 8981, portal confirm 14667; non-writers `_saveInvCore` 15665+, `saveNewCombinedInvoice` 12190+. Readers: account card 3041, needs-attention flag 3039 (`daysAgo(a.lastOrder)>=30`), sort 3163.
- **Status:** CONFIRMED.

**Repro:** Account's last `orders` entry is 90 days old; bill it today via the invoice modal (no order record) → card still shows "Last Order 90d ago (red)" and it lands in the needs-attention rollup despite fresh billing. False "stale account" signal + mis-sort. (Distinct from MED-6's `lastOrder`/`lastOrderDate` field-name bug.)

## M5 — Portal (unauthenticated) reads of `workspace/main/*` are denied → broken outstanding-invoice display + stale LF pricing
- **File:** `firestore.rules:124-125` (`workspace/{path=**}` read requires `isStaff()`) vs `public/order.html:821` (`loadLfSkus` reads `workspace/main/config`) and `order.html:1687` (`loadOutstandingInvoices` reads `workspace/main/{retail,lf,combined}_invoices`).
- **Status:** CONFIRMED (functional); pre-existing from the LAYER-2 read tightening, not the audit_log change.

**Mechanism:** A portal visitor (no Firebase auth) fails `isStaff()`, so both reads reject. `loadOutstandingInvoices` has no fallback → outstanding invoices silently never render for customers. `loadLfSkus` falls back to a hardcoded `LF_SKU_FALLBACK` (order.html:829) → the portal quotes **stale LF prices** from a client constant, so admin price changes in the CRM don't reach the order page. Correct fix is server-side (a token-validated callable like `getPortalOrderHistory`), not loosening the rule. (Different read paths than FULL_REVIEW LOW-12.)

## M6 — Invoice-number fallback after transaction failure can hand two users the same `INV-XXXX`
- **File:** `getNextInvoiceNumber` fallback branch app.js:11988-11994 → `peekNextInvoiceNumber` app.js:11935-11947 (pure local-cache read-modify-write, no transaction).
- **Status:** CONFIRMED (low likelihood, real).

**Mechanism:** The happy path is transaction-guarded and safe. On two consecutive transaction failures it falls back to scanning the cached max and returning `max+1` with no transaction — exactly under the flaky-network conditions where two users are most likely to collide. Both read the same cached max → same number on two invoices. The error is also swallowed (only `console.error`, no toast — app.js:11992), so staff never learn the number may collide.

## M7 — ShipStation webhook (regular-invoice branch) is non-idempotent → due dates slide on every re-delivery
- **File:** `functions/index.js:1475-1532`, esp. `date: shipDate` (1517), `dueDate` recompute (1509/1519), no idempotency key (contrast the Stripe `stripeEventId` check and the sample-box `status==='shipped'` guard).
- **Status:** CONFIRMED.

**Mechanism:** ShipStation re-delivers on any non-2xx and on operator replays. Each redelivery unconditionally rewrites `date`/`issued` to the redelivery date and recomputes `dueDate = now + terms`. A customer's Net-30 clock silently moves later each time the webhook re-fires; aging/collection reports go wrong. Also recomputes `total`, fighting any manual staff edit to `lineItems` between deliveries. No double-charge.

## M8 — `$NaN` KPI poisoning from unguarded `i.qty`
- **File:** `app.js:9791-9792`, `10051-10052`, `2958` (`+ pricePerCase * i.qty` and `+ i.qty` with no numeric coercion). Other sites defensively use `parseInt(i.cases)||parseInt(i.qty)||0` (e.g. 6217).
- **Status:** CONFIRMED.

**Mechanism:** The `||0` guards a missing map key, not a NaN accumulator. One order item with a missing/non-numeric `qty` (legacy or hand-edited doc) makes `pricePerCase * undefined = NaN`, poisoning the whole Revenue/Gross-Profit KPI to `$NaN`.

## M9 — COGS `2.15` placeholder still fabricates margins
- **File:** `_cogs` app.js:16 (`return 2.15` for any unconfigured SKU), reads at 9799/9812/10059/10065.
- **Status:** CONFIRMED (FULL_REVIEW MED-5 only partially addressed — the report-display half persists).

**Mechanism:** SKUs with no configured cost silently report a fictional $2.15 COGS and a fabricated margin, with no "cost not set" flag. Until you set real COGS in Settings (already on your checklist), profit reports are confidently wrong.

## M10 — config recovery guard simultaneously resurrects deleted config items and fails to recover real losses
- **File:** `public/db.js:400-403` (restore only when server value is empty/`[]`/`{}`).
- **Status:** CONFIRMED.

**Mechanism (two-sided):** (a) *Resurrection* — if another device empties a config array (`returns`, `quick_notes`) while you had a stale copy, on reload `curEmpty` is true → your old items are restored and re-persisted (deleted config data comes back). (b) *Non-recovery* — for any config object/array that's already non-empty on the server (the normal case: `settings`, `costs`, `invoice_settings`), an unsaved local edit is **discarded**, never recovered. So HIGH-2's "last edit never lost" does **not** hold for Settings edits.

## M11 — `online` re-drive resets retry counters globally + spawns concurrent `_saveCollection`
- **File:** `public/db.js:155-166` (online listener), resets `this._saveRetries = {}` (global, not per-key), then `_scheduleSave` for stuck keys; no in-flight guard on `_saveCollection`.
- **Status:** Global reset CONFIRMED; concurrent-batch corruption UNCONFIRMED (Firestore batches are individually atomic; the race is between two stale `colRef.get()` snapshots — see C1's delete pass).

**Mechanism:** On reconnect, wiping `_saveRetries={}` also clears the backoff counters of *other* keys mid-retry, enabling a retry storm; and two overlapping `_saveCollection(key)` can each run their own get→delete-diff→commit with no mutual exclusion, compounding C1.

## M12 — `atomicUpdate` has no cache rollback; a throwing mutator leaves corrupt cache that persists later
- **File:** `public/db.js:613-636`. HIGH-1 fixed the stuck `_atomicInProgress` flag (try/catch clears it), but added **no** cache snapshot/restore.
- **Status:** CONFIRMED (no rollback present); real-world trigger UNCONFIRMED (needs a mutator that throws post-mutation).

**Mechanism:** If `fn(this._cache)` mutates the cache then throws, the flag is cleared and the error rethrown, but the cache is left half-mutated with no rollback. `_scheduleSave` (db.js:630) never runs for this op, so the half-mutation isn't saved immediately — but the next unrelated save of that collection will persist the corrupted cache.

## M13 — `atomicUpdate` deferred flush leaks dirty keys; lock cleared before async commits land
- **File:** `public/db.js:639-652` (`setTimeout` flush dispatches async `_saveCollection`/`_saveConfig`, then `finally` clears `_atomicInProgress`); `_saveDirtyKeys` is never cleared on this path (only `_doSave` at db.js:415 clears it, and it's bypassed).
- **Status:** Dirty-key leak CONFIRMED; the early lock-clear is currently masked *by accident* (the leaked `_saveDirtyKeys` entries keep the listener guard at db.js:203/232 deferring).

**Mechanism:** After any `atomicUpdate`, the touched keys stay in `_saveDirtyKeys` forever. Side effects: the config snapshot listener (db.js:232) then **defers all remote config changes indefinitely** (treats config as perpetually dirty), and the `online` re-drive (M11) treats those keys as permanently stuck. To confirm: inspect `DB._saveDirtyKeys` after one `atomicUpdate` — it should still contain the touched keys.

## M14 — Unload recovery blob can exceed the ~5MB localStorage quota and silently no-op
- **File:** `public/db.js:333-343` (serializes whole dirty collection arrays), throw swallowed at db.js:343.
- **Status:** CONFIRMED.

**Mechanism:** Because `audit_log` is frequently dirty (most actions log) and `iv` is large, `JSON.stringify(recovery)` of the full arrays can exceed the per-origin quota → `setItem` throws `QuotaExceededError`, caught and ignored → the HIGH-2 durability snapshot is **silently skipped exactly when the cache is largest.** (Also overlaps H3: the more `audit_log` grows, the worse this gets.)

## M15 — Multi-tab share one recovery key; last-closed tab wins
- **File:** `public/db.js:324` (`_recoveryKey` = `pcrm_recovery_<uid>`), overwrite at db.js:342, single removal at db.js:410.
- **Status:** CONFIRMED.

**Mechanism:** Two tabs of the same user share one localStorage slot. Whichever closes last overwrites the other's recovery blob; the earlier tab's unsaved edits drop out of recovery entirely. The HIGH-2 guarantee silently degrades to "only the last-closed tab is protected."

## M16 — ShipStation sample-box handler: non-transactional whole-array read-modify-write (lost update)
- **File:** `functions/index.js:1361-1381` (load account, mutate `samples` copy, `update({samples})`).
- **Status:** CONFIRMED.

**Mechanism:** The `status==='shipped'` check (1370) only de-dups re-delivery of the *same* sample, not concurrent writes. A staff edit to the same account's `samples` (or two sample shipments close together) is a classic lost update — last write overwrites the whole array.

---

# LOW

## L1 — Portal-order→invoice consumes invoice numbers before the write (sequence gaps / partial state)
- **File:** `app.js:14622-14638` (three awaited `getNextInvoiceNumber`, each bumps `nextInvoiceNum`) then `atomicUpdate` at 14642.
- **Status:** CONFIRMED. Navigate away or throw between allocation and write → numbers consumed, no invoice → gaps; partial allocation if one of three awaits fails. Cosmetic + shows allocator is decoupled from creation.

## L2 — Stripe webhook idempotency is check-then-write (non-atomic)
- **File:** `functions/index.js:1084-1091` (query) and 1165-1175 (write), no transaction between.
- **Status:** CONFIRMED, low impact — the mark-paid mutation is itself idempotent, so the only effect of a double-delivery slipping through is a duplicate `paid` audit_log row.

## L3 — `accountId` spoofing on public `portal_orders` create
- **File:** `firestore.rules:45-56` (create rule bounds strings/array sizes but never validates `accountId`).
- **Status:** CONFIRMED. A public caller can attach any real `accountId` to a submitted order, mis-attributing spam orders to a legitimate account's history/KPIs (staff code keys off `accountId`, e.g. app.js:5342). Low because `status:'new'` orders are manually reviewed. Extends LOW-11 (different vector).

## L4 — Employee-reachable portal-token minting vs admin-only `portal_tokens`
- **File:** `firestore.rules:87-90` (`portal_tokens` write = admin) vs `app.js:13744` `generateOrderLink` writing `accounts.orderPortalToken` (staff-writable, rules:37).
- **Status:** UNCONFIRMED which path the live UI uses. The intended "admins only issue portal tokens" control is undermined because the token also lives on the staff-writable account doc — any employee can mint a working portal token there. Either gate the `orderPortalToken` field to admin or the `portal_tokens` admin-only rule is moot.

## L5 — `atomicUpdate` re-stamps `_updatedAt` on append-only `audit_log` rows
- **File:** `public/db.js:625` (stamps every COLLECTION_KEYS item, including `audit_log`).
- **Status:** CONFIRMED, harmless for tamper-proofing. Creates cache/server `_updatedAt` divergence on audit rows (the append-only save guard correctly skips re-writing them). Cosmetic; worth excluding `APPEND_ONLY_KEYS` from the stamp loop for cleanliness.

## L6 — Recovery blob not cleared after a successful flush (extends H1's window to 24h)
- **File:** `public/db.js:358` (clears dirty keys) vs db.js:410 (blob removed only at end of a *replay*).
- **Status:** CONFIRMED. Even when the unload's async `.set()` calls fully succeed, the recovery blob lingers up to 24h and remains a resurrection hazard (H1) for any item deleted remotely in that window.

## L7 — `firestore.rules` `path[]` indexing warning — verify audit_log immutability with an emulator test
- **File:** `firestore.rules:124` (`path.size()`/`path[0]`/`path[1]` on the `{path=**}` recursive wildcard; deploy-time type warning).
- **Status:** UNCONFIRMED. Reasoned to work at runtime (normal workspace writes succeed, which proves the predicate evaluates to a boolean rather than error-denying; therefore for audit_log docs it evaluates true → update/delete denied). But there are no rules unit tests in the repo. **Confirming test** (`@firebase/rules-unit-testing`): as an employee, `create` audit_log doc → expect ALLOW; `update`/`delete` it → expect DENY; `update workspace/main/config/main` → expect ALLOW (proves normal writes aren't error-denied). If update/delete ALLOW, the exclusion silently fails open.

## L8 — Dead `app_config` rule
- **File:** `firestore.rules:30-33`. The client never references `app_config` (grep-confirmed). Harmless, but the "admin-only access_control" intent it implies isn't wired to anything — role gating comes solely from `users/{uid}.role`.

---

# Verified and found CLEAN (no new issue)

- **HIGH-5 (combined-invoice dissolve) — CORRECT.** Traced `deleteInvoiceWithCleanup` (app.js:87-118): deleting a combined child splices the parent and sets the surviving sibling's `combinedInvoiceId=null` in one `atomicUpdate`. Parent-counting reports re-include the survivor exactly once; child-counting reports drop the deleted child and keep the survivor once. No double-count, no orphan, inventory consistent. `deleteCombinedInvoice` (app.js:11878) removes parent+both children together — no orphan path.
- **firestore.rules HIGH-7 — no lockout.** Re-derived the full access matrix; the config doc, audit_log creates, portal public creates, and every workspace collection write each have an allowing rule. The audit_log exclusion catches no legitimate write (the app never updates/deletes audit entries — grep-confirmed + `APPEND_ONLY_KEYS` guard).
- **Combined-invoice creation atomicity** — `createCombinedInvoice`/`saveNewCombinedInvoice`/`confirmPortalOrder` each write parent + both children + deductions in a single `atomicUpdate`. No partial-write window.
- **Legacy `iv` double-count** — `_allPurplInvoices`/`_allInvoices` dedupe `iv` rows whose id already exists in `retail_invoices`; no report sums `iv` independently. (A migrated invoice with *different* ids in `iv` vs `retail_invoices` would double-count, but that's a data-migration concern, not a code path.)
- **APPEND_ONLY save guard** — does not fail the batch and does not skip legitimate brand-new audit creates; `_writeDoc` is the real creator and the batch correctly no-ops existing rows.
- **Division-by-zero in margins** — `rev>0 ? gp/rev : 0` guards are present; no NaN *from division* (NaN comes from `qty`, see M8).

---

# Cross-cutting themes (root causes)

1. **The save/recovery layer assumes a single writer.** C1, H1, H2, M10–M15 all stem from `_saveCollection`'s delete-diff and the recovery mechanism treating the local cache as authoritative and client clocks as monotonic. This is the riskiest cluster and the place to invest first. Safer primitives: per-doc writes only (never whole-collection delete-diff), server timestamps, and a recovery format that stores *which doc changed* rather than whole-collection snapshots.
2. **Load-everything + listen-to-everything doesn't survive growth.** H3, H4, H5, M14 are all the same architecture. The fix is query-on-demand for unbounded collections (`audit_log`, eventually invoices/orders) and per-render index maps.
3. **Denormalized status/dates are written on one path and read on another.** M1, M2, M4, M7 — combined-invoice parent/child status, the two "Total Invoiced" KPIs, `lastOrder`, and webhook-set due dates can each silently diverge.
4. **Non-idempotent webhooks on at-least-once channels.** M7, M16, L2 — Stripe is safe-by-luck (idempotent mutation); ShipStation regular + sample paths are not.

**None of these block current single-user operation.** C1 and the M-series webhook/atomicity items are the ones to fix before real multi-user use; H3–H5 are the ones that degrade as the data grows.
