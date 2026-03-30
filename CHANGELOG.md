# purpl CRM — Changelog

## 2026-03-30 — Wholesale Modernization (6 Sections)

### Section 1 · Order Form: Welcome Banner and Past Orders HTML

**Changes:**
- Added returning-customer welcome banner (`#returning-banner`) above the account info card — shown after account match, confirms details have been pre-filled
- Added `#past-orders-section` and `#past-orders-list` containers below the submit button — hidden by default, populated by JS after load

---

### Section 2 · Order Form: Past Orders JS, Print PDF, Distributor

**Changes:**
- `init()` now reveals the welcome banner and queries `portal_orders` for the last 10 orders by `accountId`, passing results to `renderPastOrders()`
- `renderPastOrders()` renders each past order with date, case/can count, PO number, delivery window, color-coded status badge, and a "View PDF" button
- `printPortalOrder(orderId)` opens a new tab with a fully styled order confirmation PDF including logo, line items, distributor, delivery window, and a print button
- Distributor section replaced with a multi-entry distributor list (add/remove rows), open-to-direct dropdown, and distributor contact opt-in checkbox
- Added `addDistributor()`, `removeDistributor()`, and `getDistributors()` helper functions

---

### Section 3 · Order Form: Delivery, Social, Saved Prefs, Payload

**Changes:**
- Delivery section replaced with a full Delivery & Timing card: delivery guidelines info block, preferred delivery window text input, lead time dropdown, and PO number field
- Social media handle field added before the notes textarea
- `init()` loads saved `portalPrefs` from the account document and pre-fills billing email, distributors, distributor dropdowns, lead time, social handle, and delivery notes
- `submitOrder()` saves all new fields back to `accounts/{accountId}.portalPrefs` in Firestore after successful submission
- Submit payload updated to include `distributors`, `distributorDirectOpen`, `distributorContactOk`, `leadTimeNeeded`, and `socialHandle`
- Thank-you summary now shows distributors and lead time rows when present

---

### Section 4 · Wholesale Landing Page (`public/wholesale.html`)

**Changes:**
- Created new standalone `wholesale.html` — a full-page public-facing wholesale landing site
- Fixed nav with logo, centered nav links (desktop only), and "Wholesale Sign In" link
- Hero section with dark purple gradient, headline, subheading, and two CTA buttons
- Why Carry purpl section: three-column cards (Provenance, Velocity, Partnership)
- Our Story section: two-column layout with farm copy and product image
- The Product section: product image, feature pills, coming soon flavor cards
- Wholesale Terms section: minimum order, territory, and payment blocks — no pricing
- Stockists section: two-column list of 10 current retail accounts
- Application form: 10+ fields, Firestore write to `portal_inquiries`, inline validation, success state with personalized confirmation message
- Footer with contact info, links, and copyright
- Fully responsive — all multi-column sections stack on mobile under 768px

---

### Section 5 · Wholesale Inquiries into CRM Prospects

**Changes:**
- Added `importWholesaleInquiries()` to `app.js` — queries `portal_inquiries` where `status == 'new'`, deduplicates against existing prospects by name, creates prospect records with all available fields, marks imported docs as `status: 'imported'`
- Added "Import Wholesale Inquiries" button to the Prospects page filter bar in `index.html`

---

### Section 6 · Firestore Rules for Wholesale Inquiries

**Changes:**
- Added `portal_inquiries` rule to `firestore.rules`: public `create` allowed (unauthenticated form submissions), `read/update/delete` requires auth

---

## 2026-03-08 — 6-Phase Improvement Release

### Phase 1 · Delivery Rules on Run Sheet

**Problem:** Employees on delivery runs had no visibility into account-specific drop-off instructions (back entrance, call ahead, etc.) stored in `dropOffRules`.

**Changes:**
- Delivery stop cards now show a prominent orange `⚠ Delivery Instructions:` box immediately below the account name, before any other content
- Box is shown only when the stop is not yet marked done (hides after check-off to reduce noise)
- Delivery instructions are preserved and visible when printing the run sheet (`@media print`)
- `addStop()` now stores `accountId` on each stop for reliable account lookup (fallback to name match for existing data)
- `prefillStop()` now auto-populates address and drop-off notes from account record

---

### Phase 2 · Prospect-to-Account Conversion

**Problem:** Converting a prospect to an account lost most of the prospect's data (address, lat/lng, source, all notes, all outreach history, priority, nextAction, nextDate). Two separate DB writes meant a failed sync could leave a "won" prospect with no account created.

**Changes:**
- `convertProspect()` now copies ALL fields to the new account: address, lat/lng, source, priority, nextAction, nextDate, all notes, all outreach history
- Adds `convertedFrom: 'prospect'` and `convertedDate` metadata on the account
- Uses `DB.atomicUpdate()` — prospect status update and account creation happen in a single Firestore document write, eliminating partial-state risk

---

### Phase 3 · Invoice Auto-Generation from Delivery

**Problem:** After completing a delivery stop, users had to manually create an invoice from scratch.

**Changes:**
- After marking any delivery stop done, a non-blocking blue banner appears offering to create an invoice
- Invoice is pre-populated with: account name, auto-incremented number (INV-0001 format), today's date, due date calculated from payment terms, line items from delivery quantities in cases, amounts based on account pricing or default COGS × 2.2 markup × 12 cans
- Invoice is saved to `inv_log_v2` collection; the linked order is marked `invoiceStatus: 'invoiced'`
- After the entire run is complete (all stops checked off), a green banner offers to create invoices for all stops at once via `createBatchDeliveryInvoices()`

---

### Phase 4 · Distributor Dashboard KPIs (List Page)

**Problem:** The distributors list page had no summary metrics — users had to scroll through cards to understand the overall distributor situation.

**Changes:**
- Added 4 KPI cards above the distributor list: **Active Distributors**, **Total Doors**, **Outstanding Invoices**, **Last PO date**
- Added a collapsible **Needs Attention** section showing:
  - Overdue invoices (any distributor invoice past due date, with amount)
  - No PO in 60+ days (active distributors with stale purchasing activity)
- Section is hidden when there are no issues

---

### Phase 5 · Settings Page Expansion

**Problem:** Settings page only had company name, payment terms, and COGS inputs.

**Changes:**

**Company card additions:**
- **Production lead time** (days) — saved as `settings.production_lead_time`, used by production planning projections

**Territory Defaults card** (new):
- Default state / region
- Default account type
- Default payment terms (days)

**Units & Display card** (new, read-only):
- Shows: 1 case = 12 cans, orders in cases, inventory in cans, deliveries in cases

**Variety Pack Recipe card** (new):
- Per-flavor can counts for a variety pack (Classic, Blueberry, Peach, Raspberry)
- Live total counter — must equal exactly 12 cans; save is blocked if total is wrong
- Saved as `settings.variety_recipe` for use by repack jobs

**Team Access card** (new, read-only):
- Lists known signed-in users from `settings.known_users` (email, last seen, provider)
- Instructions for adding new users

---

### Phase 6 · Orders Unit Audit + Cleanup

**Problem:** Order quantities were inconsistently labeled and units (cans vs cases) were mixed throughout the codebase, making inventory math unreliable.

**Core unit rule (now enforced everywhere):**
- **Orders / deliveries** → quantities in **CASES**
- **Inventory (`iv` collection)** → quantities in **CANS**
- Conversion: `CANS_PER_CASE = 12` (defined once at top of `app.js`)

**Changes:**

*`CANS_PER_CASE` constant:*
- Added `const CANS_PER_CASE = 12` at top of `app.js` with clear comment
- Used in every unit conversion; hardcoded `12` eliminated

*`DB.atomicUpdate()` in `db.js`:*
- New method: takes a function that mutates the cache, then calls `_save()` once
- All data lives in one Firestore document, so one write = one atomic operation
- Used by: `convertProspect`, `createOrder`, `toggleStop`

*`createOrder()` — consolidated order creation:*
- All order creation paths now go through one function
- Fields guaranteed: `id`, `accountId`, `dueDate`, `notes`, `items` (qty in cases), `status`, `source`, `canCount`, `created`
- `canCount` = `items.reduce((s,i) => s + i.qty * CANS_PER_CASE, 0)` — total cans, stored for reference
- `source` values: `'manual'` | `'run'` | `'import'` | `'local_line'` | `'distributor'`

*`toggleStop()` — atomic delivery confirmation:*
- Four side-effects now in one Firestore write via `DB.atomicUpdate()`:
  1. `today_run` — done flag updated
  2. `ac` — account `lastOrder` set to today
  3. `iv` — inventory deduction: `qty × CANS_PER_CASE` cans per SKU
  4. `orders` — new delivery order record in cases with `canCount`
- Unchecking a stop (undo) is a simple write with no side-effects

*Delivery form:*
- Quantity inputs changed from `step="6"` (ambiguous) to `step="1"` (cases)
- Label updated: "Quantities (cases — 1 case = 12 cans)"
- `prefillStop()` converts par (stored in cans) → cases: `Math.ceil(parCans / CANS_PER_CASE)`

*New order modal:*
- Account selector starts blank (forces explicit selection)
- Due date pre-fills to today
- Items labeled "cases" with footnote "1 case = 12 cans"
- Par levels shown in cases (converted from stored cans)
- After saving, user offered to mark as invoiced immediately

*Order detail modal:*
- Items shown as "× 4 cs (48 cans)"
- Total canCount displayed if available

*Orders list page:*
- Source badges on every order row: Run / Manual / Import / Local Line / Distributor
- Item quantities shown as "×4cs"

*`calcOrderValue()`:*
- Price is now explicitly **per case**: `COGS_per_can × 2.2_markup × CANS_PER_CASE`
- Or account-specific `pricing[sku]` (expected to be price per case)

*Reports:*
- `repRevenue()` and `repProfit()` use price-per-case; COGS calculated as `cans × cogs_per_can`
- Table header "Units" → "Cases"

---

### Infrastructure

**`DB.atomicUpdate(fn)` in `db.js`:**
Since all CRM data lives in a single Firestore document (`workspace/main/data/store`), calling `_save()` once is inherently atomic. `atomicUpdate` provides a clean API for making multiple cache mutations followed by a single write, replacing the previous pattern of multiple `DB.set()` calls that each triggered a separate Firestore write.
