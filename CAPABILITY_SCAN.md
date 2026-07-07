# CAPABILITY_SCAN.md — What Purpl CRM Can and Can't Do Reliably, As It Runs Live

**Date:** 2026-07-07 · **Code state:** commit `a6e79b1` (app.js 16,773 lines)
**Scope:** single operator, one browser, normal daily use. Multi-user/concurrency excluded.
**Method:** 4 parallel read-only code traces (features / money / inventory / data-loss+dead-UI),
top findings independently re-verified line-by-line in a second pass (14/14 confirmed).
**Not re-reported here:** everything already catalogued in FULL_REVIEW.md, SCAN.md, CRM_SCAN.md,
TODO.md (deduct-on-sent-only gaps, reports-read-orders-only, variety decomposition, COGS
placeholder, warehouse-push-is-a-flag, portal Outstanding section, etc.). This doc is what's NEW.

---

## TL;DR — the 10 most likely to actually bite you

1. **Re-editing a shipped invoice silently deletes its shipping charge** (§2.1)
2. **"🔗 Copy Link" does nothing for accounts with an apostrophe in the name** (§1, F-A2)
3. **The Confirm-order modal's "Cases" and "Notes" fields are decorative** — edits there are ignored (§4.1)
4. **ShipStation settings never persist** — they revert on every reload while toasting "saved ✓" (§4.2)
5. **Un-checking a delivery stop can wipe unrelated inventory entries** and collide with same-account stops (§2.6)
6. **Combined invoices: stored totals never re-sync** after a child edit; manual "Create Combined" can drop the purpl half from the grand total (§2.2, §2.3)
7. **Voided purpl invoices stay in the Outstanding/Overdue KPIs** (§2.4)
8. **A customer can pay a stale Stripe link at the old amount** and the invoice marks fully paid at the new amount (§2.5)
9. **Deleting a distributor shipment-PO orphans its inventory deduction** — delete + re-enter = double-deducted warehouse (§2.7)
10. **Two-tab habit can silently disable offline durability** — an offline editing session ended by closing the browser is lost with zero warning (§3, scenario 5)

---

## 1. WHAT WORKS RELIABLY — feature verdicts

### Sales & CRM
| Feature | Verdict | If not SOLID — the action that exposes it |
|---|---|---|
| Accounts: list, filters, search, star, brand/dist grouping | **SOLID** | |
| Account create/edit/save/delete (full cleanup on delete) | **SOLID** | |
| Account card "🔗 Copy Link" (F-A2) | **FRAGILE** | Click it on "Mac's Market" (any apostrophe name) → silently nothing (app.js:3194; same bug on All-Links tab 14642/14648) |
| Paste-to-add account | **WORKS-WITH-CAVEATS** | Parsed date/notes shown in preview are silently dropped on confirm (13651→13676) |
| Prospects: list/detail/lost/reactivate/samples/CSV import | **SOLID** | |
| Convert prospect → account | **WORKS-WITH-CAVEATS** | If the prospect already had a portal link, the next mass send mints a NEW token — the old emailed link dies (5836-5846 vs 4944) |

### Portal orders (staff side)
| Feature | Verdict | Exposing action |
|---|---|---|
| Review / link-to-account / create-prospect | **SOLID** | |
| Confirm → invoice (all 3 brand paths) | **WORKS-WITH-CAVEATS** | Core logic solid (idempotent, atomic, both halves claimed transactionally). But the modal's Cases + Notes fields no-op (§4.1) |
| Decline | **FRAGILE** | Declining a purpl+LF submission strands the other half as `new` forever — nav badge never clears; only Delete handles pairs (14893 vs 14910) |
| Delete | **SOLID** | |
| Sample requests | **WORKS-WITH-CAVEATS** | Approving a sample-only request never clears the "new portal order" badge (14355 vs 16547) |
| Applications approve/reject/convert | **SOLID** | |
| Portal orders list | **WORKS-WITH-CAVEATS** | Live listener caps at 50 docs and overwrites the cache — beyond 50 total submissions, older unconfirmed ones vanish from the tabs/KPIs (16536-16564) |

### Invoicing (the four types)
| Type | Verdict | One-line reason |
|---|---|---|
| purpl (`retail_invoices`) | **WORKS-WITH-CAVEATS** | Core create/send/paid/KPI math coherent; edges in §2 (shipping-loss, void-in-KPI, due/dueDate drift) |
| Lavender Fields (`lf_invoices`) | **WORKS-WITH-CAVEATS** | Same core soundness; overdue KPI + reminder queue miss portal-created LF invoices (§2.4a) |
| Combined | **FRAGILE** | Parent totals are stored copies that never re-derive; three writers disagree (§2.2, §2.3) |
| Distributor | **WORKS-WITH-CAVEATS** | List/KPI/export consistent, but saving an old invoice silently re-prices every line at today's dist_pricing; unpriced SKUs bill $0 (7635-7643) |

### Inventory & operations
| Area | Verdict | Exposing action |
|---|---|---|
| Inventory ledger + on-hand math | **WORKS-WITH-CAVEATS** | Negatives are clamped per-pool, so pool cards can stop summing to Total with no indicator (§2.8) |
| Pool transfers | **SOLID** | Both sides atomic, availability-checked, guarded |
| Pallets (build/ship/delete) | **SOLID** | Deducts once at ship; delete reverses correctly |
| Production log/delete, repack | **WORKS-WITH-CAVEATS** | Reversals correct; but "receive finished packs" books packs as cans (§2.9) |
| Delivery runs | **FRAGILE** | §2.6 — reversal over-deletes; same-account/same-day stops collide; no double-click guard on the stop checkbox |
| Distributor shipments/POs | **WORKS-WITH-CAVEATS** | Shipment logging is atomic and correct; deleting the PO orphans deductions (§2.7). Note: only "Log Shipment" touches inventory — manual "+PO" and status-cycling to fulfilled never deduct |
| LF Wix deduction flow | **WORKS-WITH-CAVEATS** | Pull modal opened from a delivery run renders blank (record still confirms fine); un-toggling a done stop leaves a phantom "Pending LF Deduction" (9173, 13516) |
| Projections / production planning | **WORKS-WITH-CAVEATS** | Demand only sees the `orders` collection — direct invoices and dist shipments deduct stock but add no demand, so "Stock looks good" overstates coverage (2710-2725, 8798-8816) |

### Email & exports
| Feature | Verdict | Exposing action |
|---|---|---|
| Emails page compose + send | **WORKS-WITH-CAVEATS** | "Custom" template has no edit surface here — sends literal "[Your message here]" (§4.3) |
| Mass broadcast | **SOLID** | Per-account unsubscribe link, opt-out skip, rate limiting |
| Mass template send | **WORKS-WITH-CAVEATS** | Same "Custom" trap; token pre-generation + abort-on-failure verified solid |
| Batch session mode | **FRAGILE** | AI-draft button was never wired (blank fields), and "Next →" stamps lastContacted even when nothing was sent (5037-5150) |
| Invoice reminders card | **WORKS-WITH-CAVEATS** | Never surfaces portal-created LF invoices (`due` vs `dueDate`); can email a customer HALF of a combined invoice (§2.10) |
| Cadence-tab send (account modal) | **WORKS-WITH-CAVEATS** | Skips the opt-out warning and doesn't stamp lastContacted (3693-3737) |
| Report CSV / Year-End export | **SOLID** | Deduped, paid-only, dist included; caveats inherited from combined-parent drift (§2.2) |
| LF/notify CSVs, prospect CSV import | **SOLID** | |
| Local Line CSV import | **WORKS-WITH-CAVEATS** | Unescaped values into innerHTML; embedded newlines break parsing; auto-created accounts get type `retail` which matches no filter vocabulary |

---

## 2. SILENT-WRONG NUMBERS — ranked by likelihood

**2.1 — Re-editing a shipped invoice deletes the shipping charge.** *(HIGH — verified)*
ShipStation's webhook adds a `__shipping__` line and raises the total (functions:1540-1586). The purpl and LF edit modals rebuild lineItems from the SKU quantity rows only and recompute the total (16254-16296, 11910-11954). Open Edit on a shipped invoice to fix a note → Save → total quietly drops by the shipping amount everywhere (doc, Stripe, KPIs). *Looks right because the total matches the rows on screen.*

**2.2 — Manual "Create Combined Invoice" can omit the purpl dollars.** *(HIGH — verified)*
`createCombinedInvoice` reads `purplInv.amount||0` (12030); delivery-run invoices carry only `total` → grand total excludes the purpl half while the document still LISTS the purpl line items. Stripe charge and tax export are short. This parent also never gets a date/dueDate, so it can never show overdue.

**2.3 — Editing a combined child never re-syncs the parent's dollars.** *(HIGH/MED)*
Status syncs; amounts don't (12075-12094). After editing a child's quantities (reachable via global search), the combined preview, emailed Amount Due, Stripe amount, tax export, and Reports total all keep the OLD number while the Invoices-page KPIs show the new one.

**2.4 — Void/overdue KPI drift.** *(MED — verified)*
(a) A voided purpl invoice past its due date still counts in Outstanding AND Overdue (purplStatus early-returns only paid/draft, 15643-15648) — Total Invoiced drops, the other two don't; the cards contradict each other. (b) The Overdue KPI's LF branch reads `x.due` only (15667); portal-created LF invoices store `dueDate` → shown red in the list, missing from the KPI dollars. Dashboard disagrees with the invoice page.

**2.5 — Stale Stripe links pay the old amount.** *(MED)*
Send invoice at $480 → edit to $540 → customer pays the emailed $480 link → webhook marks fully `paid` with no amount comparison (functions:1134-1152). Collected-This-Month and the tax export book $540. Off by the delta, zero signal.

**2.6 — Delivery-run reversal over-deletes and collides.** *(HIGH if you use runs — verified)*
Un-checking a done stop: (a) deletes every ledger "out" whose invoiceId isn't in `retail_invoices` — sweeping deductions belonging to legacy-`iv` invoices (9199-9201); (b) finds the day's order by account+date, so two same-day stops for one account reverse each other's invoices (9189-9197); (c) the checkbox has no double-click guard (9022) — a double-click runs create-then-reverse.

**2.7 — Deleting a distributor shipment-PO orphans its deduction.** *(HIGH if you correct mistakes this way — verified)*
Deductions are keyed to a `shipId` stored nowhere on the PO record; `deleteDistPO` removes only the PO (7547-7554). Delete a mis-entered shipment and re-log it → warehouse short by the first shipment, forever, invisibly.

**2.8 — Hidden negative pools.** *(MED)*
Deductions never check pool availability, and `_onHand` clamps at 0 per pool (122-128). Deduct from an empty Farm pool → Warehouse + Farm cards stop summing to Total Stock with no indicator. Related: delivery-run deductions ALWAYS hit warehouse (`fulfillmentSource` never set on those invoices, 9280).

**2.9 — "Receive finished packs" books packs as cans.** *(MED — verified)*
Receiving 8 six-packs entered as "8" adds 8 cans, not 48 (8017-8028) — the pack-type dropdown only lands in the note text. Same class of issue on repack output and production-run inputs labeled "units" — consistent only if you always type CANS.

**2.10 — Reminder emails can quote half a combined invoice.** *(MED)*
The reminder queue includes combined children (2189-2197); after a combined send flips children to `sent`, the purpl child qualifies → customer gets "Amount Due $X" for only the purpl half. Also `dueDate`-only invoices render a blank due date and always get the soft "due soon" wording even when overdue.

**2.11 — Dist invoice save re-prices.** *(MED)* Editing an old dist invoice (even a note) rewrites every line at TODAY'S dist_pricing; SKUs with no pricing row bill $0 with no warning (7635-7643).

**2.12 — Legacy purpl invoices: "✓ Paid" is a silent no-op.** *(MED — verified)* Old `iv`-collection invoices appear in the unified list, but the Paid button writes to `retail_invoices` — the toast says "Marked as paid," nothing changes; Preview says "Invoice not found." They sit in Outstanding forever unless opened via the Edit modal (which routes correctly).

**2.13 — Smaller leaks.** *(LOW)* Statement of Account counts drafts in "Total Outstanding" (13321). Combined shipping exists only on the parent → never reaches KPIs or the year-end CSV (which emits child subtotals). Stripe-failure fallback emails a GENERIC pay button while warning there'll be none. LF report "Outstanding" includes void+draft; its CSV prints blank due dates for modal-created invoices; tax-export dist rows have blank account names (they carry `distName`).

---

## 3. DATA-LOSS RISK — normal single-user use (post-fix state)

The persistence layer is much stronger than at the last review: edits fire an immediate
per-doc write PLUS a 500ms-debounced save, an unload recovery blob (localStorage, 30-min
window, 24h validity, cross-tab merged) replays unsaved changes with an epoch guard, and
invoice+inventory mutations are single atomic updates. Verified end-to-end.

| # | Scenario | What happens | Loss? | How you'd know | Likelihood |
|---|---|---|---|---|---|
| 1 | Edit a record, close tab instantly | Immediate write already queued + recovery blob replays if needed | **No** | "Recovered N unsaved changes" toast | RARE |
| 2 | Edit **config-backed data** (pallets, loose cans, repack jobs, returns, LF SKUs, Settings) and close within ~500ms | Replay refuses to restore over a non-empty server value — rides solely on the SDK's write queue | **Silent loss possible** | Nothing | POSSIBLE |
| 3 | Offline session (persistence working), browser closed while offline | Writes queued in IndexedDB, flush on next open of that browser | **No** | Offline banner + "Saving…" dot | RARE |
| 4 | **Offline session with persistence silently disabled** — typical cause: the CRM was already open in a second tab when this one loaded | No queue, no retry, no recovery blob for those edits. Closing the browser loses the whole offline session. The "changes cached locally, will sync" toast is FALSE in this mode | **Yes — the worst hole** | **Nothing tells you persistence failed** (auth.js:22-26 swallows it) | POSSIBLE — two tabs is normal behavior |
| 5 | Refresh mid **portal-order confirm** | The one remaining multi-step seam: portal doc flips to `confirmed`, then several network round-trips before the local write (15031-15178). Refresh in that window → order stranded confirmed with no invoice | **Yes** (manual rework) | Order silently moves to Confirmed with no invoice | RARE per event — but this exact flow caused past incidents |
| 6 | Laptop + phone both edit while one is offline | Old queued writes replay over newer edits from the other device on reopen | Cross-device clobber | Nothing | POSSIBLE if you edit on both |

**Signals that lie or lag:** the offline banner is `navigator.onLine`-only (hidden when wifi is
up but internet is down); the sync dot shows global "Saved" if ANY one write succeeded; nothing
ever reports a persistence-init failure.

**Practical rules that eliminate most of this:** keep the CRM open in ONE tab only; after
closing a tab quickly, reopen once and look for the recovery toast; do portal confirms on
solid wifi and don't refresh until the invoice appears.

---

## 4. LOOKS DONE BUT ISN'T WIRED (new finds)

1. **Confirm-order modal: "Cases" and "Notes"** — Cases only applies when the portal doc has NO items (i.e. never for real orders); Notes is populated but never read (14985-14997 vs 15096-15101). Adjust at confirm time and the invoice ignores you.
2. **ShipStation settings** — `shipstation_settings` isn't in db.js's persistence key lists; saves live only in memory. Toasts "saved ✓", reverts on reload, and the sync dot sticks on "Saving…" (app.js:457-462, db.js:39/49). Store ID / From-address are silently absent from every push.
3. **"Custom" email template** — body is literally `[Your message here]`; the Emails page and Mass Template Send have no edit surface, so picking it emails the placeholder (1104-1113). Only the account-modal preview path allows editing first.
4. **Invoice Settings: From name / From address / Footer notes** — saved and loaded back into the form, consumed by nothing; every document hardcodes the Pumpkin Blossom Farm header (16089-16094 vs 2328/12760/13364 + functions). (Stripe link, ACH, check instructions, legal terms, terms, next-number ARE real.)
5. **Email Settings card (signature)** — one field, `emailSignature`, read by nothing; all mail uses the hardcoded signature (11016-11020 vs 357-370).
6. **Business Info fields** `company/phone/website/ein` — saved, never consumed (address + warehouse coords ARE used by map/route).
7. **Inventory settings** `defaultProdRunSize`, `production_lead_time` — zero consumers. Also the **Low-stock threshold** knob only drives the total-cans dashboard alert; the per-SKU Low/Critical badges are hardcoded 48/24 cans (1397, 1765-1768).
8. **Dashboard "ready to invoice" card** — reads `pending_invoices`, which nothing anywhere writes. The notice can never appear (1499-1513).
9. **LF invoice "Fulfilled by" dropdown** — never read on save; manual LF invoices can never get the Warehouse badge/push button (index.html:2296 vs 11893-11967).
10. **Batch session "generate" flow** — the AI-draft function exists but no button calls it; the worker shows blank subject/body. "Next →" logs an outreach + lastContacted even if you sent nothing (5019-5150).
11. **Portal "LF Submissions" pane** + 3 handlers — no tab exists to reach it (LF orders are handled fine via the All tab) (14660-14772).
12. **Recommended-run scheduler** — divides demand across ALL SKUs including variety and prefills the *shipments planner*, which never touches inventory (8834-8845; `saveShipment` writes `shipments` only).
13. **Order delete toast** claims "linked inventory entries removed" but filters on a field (`ordId`) no ledger entry has (8700-8712).
14. **Marketing templates missing unsubscribe links** — only `preorder-announcement` and `approved` carry one; `new-product`, `reorder-reminder`, `thank-you`, `delivery-followup` (all mass-sendable) have none. Broadcast is correct.

**Confirmed NOT problems:** all 259 onclick/onchange handlers resolve; mobile "Today" nav works via redirect; legacy KPI targets are intentionally hidden; quick-notes/velocities/legacy-LF-page/emailsPageMarkSent are unreachable dead code (can't be hit from the UI).

---

## 5. WHAT TO VERIFY BY HAND — practical habits

**Weekly (10 min):**
1. **Physical count vs Inventory page** for your top 2 SKUs, per pool. This catches §2.6-2.9 drift before it compounds. If Warehouse + Farm ≠ Total, a hidden negative exists.
2. **Glance at Outstanding/Overdue KPIs vs the list below them.** If the cards disagree with what you can see (e.g. a voided invoice still counted), you've hit §2.4 — recount from the list, not the cards.

**Every invoice you SEND:**
3. Look at the **Amount Due in the Preview** before sending — especially combined invoices and anything that was shipped (shipping line present? grand total = sum of parts?). This is the single highest-value habit; it catches §2.1-2.3 at the only moment that matters.

**Every time you EDIT an already-sent invoice:**
4. If the amount changed, know the **old Stripe link still charges the old amount** (§2.5). Re-send the invoice so the customer has the current link.

**When confirming portal orders:**
5. Don't adjust quantities in the confirm modal — **edit the invoice after confirming** instead (§4.1). Stay on the page until the invoice appears (§3.5).

**Monthly (5 min):**
6. **Spot-check one invoice end-to-end:** list amount = preview amount = what was paid.
7. **Check the Wix pending-deduction count** matches reality (phantom entries from un-toggled delivery stops linger).
8. If you use ShipStation: re-open Settings and confirm Store ID is still there (it isn't — §4.2 — until fixed, re-enter it each session you need it).

**Operating rules:**
9. **One CRM tab at a time.** Two tabs at boot silently kills offline durability (§3.4).
10. To fix a mis-logged distributor shipment, **edit forward** (log a correcting entry) rather than delete + re-enter (§2.7). Same for delivery stops: avoid un-checking; fix the invoice instead (§2.6).
11. Never pick the **"Custom"** template in mass send (§4.3).
12. For year-end taxes, use the **Year-End Export** but spot-check any combined invoices against their children (§2.2/2.13).

---

## Bottom line

The core daily loop — accounts, prospects, portal review→confirm→invoice, purpl/LF
single-invoice lifecycle, mass email with the recent safety fixes, pallets, transfers,
production, exports — is **genuinely dependable** for one careful operator. The danger zone
is concentrated and consistent: **combined-invoice dollar totals, editing anything after it
shipped or was sent, delivery-run reversals, and distributor-PO deletion** — all places where
a stored copy of a number survives while its source changes. The habits in §5 cover
essentially all of it with ~15 minutes a week.
