# Purpl CRM — Pre-Launch Test Checklist

Run these manually before launch day. Use Gmail plus-addressing for test
accounts (`grahambiagiotti+test1@gmail.com` etc.) — they all land in your inbox
but are distinct addresses, so they exercise the real multi-account paths.

Setup: make 3 test accounts, status **Pending**, emails `+test1/2/3@gmail.com`.

---

## 🔴 CRITICAL — must pass before you send anything

### 1. The pre-order blast
- [ ] Emails → mass email → status filter **Pending** → **Select All** → pick **Pre-Order Announcement**
- [ ] Pre-flight dialog shows a sane count (e.g. "Send to 3… 3 will get a new personalized link")
- [ ] Send. Inbox: **3 separate emails**, each with a **different** link
- [ ] Email looks right: **$2.30/can · $27.60/case**, password **purpleherb**, correct greeting, no broken layout
- [ ] Back in CRM: each test account's **Last Contacted** = today, and **no** false "⚠ Needs Attention"

### 2. Customer orders via link — THE round trip
- [ ] Click test1's **Option 1** link → order form opens, account pre-filled, **no password asked**
- [ ] Place a **purpl-only** order → submit → "thank you"
- [ ] CRM Pre-Orders: the order appears, **matched to test1** (right account)
- [ ] Confirm it → an **order** shows in the Orders page AND a **draft invoice** is created for test1 at **$27.60/case**
- [ ] The draft invoice is **not** sent (it just sits as draft until you send it near launch)

### 3. Dual-brand order (you said this is common)
- [ ] Click test2's link → order **both purpl + LF** → submit
- [ ] Pre-Orders **All** tab: shows as **ONE** row (not two), both brand badges
- [ ] Confirm → **one combined invoice**, totals correct
- [ ] Confirmed tab: **one** row, cases shown per brand (no "0 cases" phantom)

### 4. Copy Link can't break a sent link
- [ ] On any account, click **🔗 Copy Link** twice → the URL is **identical** both times

### 5. Unsubscribe actually works
- [ ] Click **Unsubscribe** in a test email → branded "you're unsubscribed" page
- [ ] That account now shows **✉ Unsubscribed** in the CRM
- [ ] Re-run the mass send → that account is **skipped**

### 6. Account safety
- [ ] Edit a test account (change phone), save → its portal link + history are **still there** (nothing wiped)
- [ ] Two browsers: edit account A in one, do an action (mark invoice paid) in the other → account A is **not** deleted/clobbered
- [ ] Delete a test account (admin) → gone, no leftover orders/invoices for it

---

## 🟡 SHOULD test

- [ ] Manual invoice: create one, mark **Sent** → inventory deducts **once** (check the SKU's on-hand)
- [ ] Mark a combined invoice's child **paid** → the parent shows paid too
- [ ] Reports page (Revenue / Accounts / Profit) loads fast with your ~100 accounts, **no $NaN** anywhere
- [ ] Accounts page: **Pending** status filter works; dashboard "pending" count matches; "Both lines" filter shows only dual-brand accounts
- [ ] An order placed **without** a token (paste `pbfwholesale.com/order`, use password) lands in the **Unmatched** tab, then "Review & Link" attaches it to the right account

---

## 🌐 ENVIRONMENT / EXTERNAL (not code — verify these hold)

- [ ] **Resend daily limit** covers 87 emails (free tier = 100/day; don't burn the day's quota first)
- [ ] **Deliverability**: send yourself a test, "Show original" in Gmail → **SPF / DKIM / DMARC all PASS**, lands in **Inbox** (not Spam/Promotions)
- [ ] **Stripe** (if you'll collect payment): a payment link generates and opens
- [ ] **Launch date** is set in Portal Settings BEFORE you convert pre-orders (the draft invoice dates to it)
- [ ] **COGS** set in Settings (so profit reports aren't using the $2.15 placeholder)

---

## After the blast goes out (day-of monitoring)
- [ ] Watch the send summary: "X sent, Y failed, Z skipped" — if any **failed**, note the count and check which
- [ ] Watch the Pre-Orders **Unmatched** tab — orders land there if a customer's email stripped the `?t=` link
- [ ] Spot-check 2–3 real confirmations attribute to the right account
