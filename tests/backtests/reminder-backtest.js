// Reminder-email verification — slices the REAL dashboard reminder flow out of
// app.js (queue builder, sender, email HTML, payment block, recipient
// resolution) and exercises it against fixtures across all four ledgers.
// (Recreated into the repo 2026-10-06 — final state with settle ticks.)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slice = (a, b) => {
  const i = src.indexOf(a); const j = src.indexOf(b, i + 1);
  if (i < 0 || j < 0) throw new Error('slice not found: ' + a + ' .. ' + b);
  return src.slice(i, j);
};
const iso = (deltaDays) => {
  const d = new Date(); d.setDate(d.getDate() + deltaDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// ── stub environment ──
const state = {
  updates: [], toasts: [], opened: [],
  sendResult: () => Promise.resolve({ id: 'msg-1' }),
};
const cache = {};
const DB = {
  a: k => cache[k] || [],
  obj: (k, d = {}) => cache[k] || d,
  update: (k, id, fn) => {
    const arr = cache[k] || []; const i = arr.findIndex(x => x.id === id);
    if (i < 0) return false;
    arr[i] = fn(arr[i]);
    state.updates.push({ k, id, doc: arr[i] });
    return true;
  },
};
const els = {};
const mkEl = (id) => els[id] || (els[id] = {
  id, style: {}, innerHTML: '', children: [], remove() { this.removed = true; },
  appendChild() {}, parentNode: { insertBefore() {} },
});
const document = {
  getElementById: (id) => (id in els ? els[id] : null),
  createElement: () => mkEl('created-' + Math.random()),
};
const window = { open: (u) => state.opened.push(u) };
const toast = (m) => state.toasts.push(String(m));
const callSendEmail = (to, from, subject, html) => state.sendResult({ to, from, subject, html });
const _currentUserName = () => 'Graham';
void document; void window; void toast; void callSendEmail; void _currentUserName;

// ── real code slices ──
const code = [
  slice('const uid  =', '// Sort-direction toggles'),
  slice('function escHtml', '\nfunction '),
  "const _INV_COLS = ['retail_invoices','iv','lf_invoices','combined_invoices','dist_invoices'];",
  slice('function _allPurplInvoices()', 'function _allInvoices'),
  slice('function findInvoice(id)', '// Invoice email recipient'),
  slice('function _invRecipient(inv, account)', 'function _parseEmailList'),
  slice('function _pushCadence', 'const uid  ='),
  slice('async function _getStripePayLink', 'async function callSendCombinedInvoice'),
  slice('function _sendWithCadence', 'function buildEmailHTML'),
  slice('const _TRANSACTIONAL_STAGES =', ';') + ';',
  slice('function _buildPaymentHTML', '// ── Invoice legal terms'),
  slice('function renderInvoiceReminders()', 'function setInvStatus'),
].join('\n');
const R = eval(code + '\n;({ renderInvoiceReminders, sendInvoiceReminder, buildInvoiceReminderHTML, _invRecipient, _getStripePayLink })');
const { renderInvoiceReminders, sendInvoiceReminder, buildInvoiceReminderHTML, _getStripePayLink } = R;

(async () => {
  const AC = [
    { id: 'ac1', name: 'Big Y & Sons <script>', email: 'buyer@bigy.com', contacts: [{ name: 'Lisa', isPrimary: true }] },
    { id: 'ac2', name: 'Nourish', billingEmail: 'ap@nourish.com', email: 'buyer@nourish.com' },
    { id: 'ac3', name: 'NoMail Co' },
  ];
  Object.assign(cache, {
    ac: AC,
    invoice_settings: { achRouting: '01110', achAccount: '999', fromName: 'Pumpkin Blossom Farm LLC', fromAddress: '393 Pumpkin Hill Rd, Warner, NH 03278' },
    retail_invoices: [
      { id: 'r-over', number: '13101', accountId: 'ac1', status: 'sent', dueDate: iso(-9), amount: 412.5 },
      { id: 'r-soon', number: '13102', accountId: 'ac1', status: 'sent', dueDate: iso(5), total: 200 },
      { id: 'r-far', number: '13103', accountId: 'ac1', status: 'sent', dueDate: iso(15), amount: 90 },
      { id: 'r-paid', number: '13104', accountId: 'ac1', status: 'paid', dueDate: iso(-3), amount: 50 },
      { id: 'r-draft', number: '13105', accountId: 'ac1', status: 'draft', dueDate: iso(-3), amount: 50 },
      { id: 'r-child', number: '13106-P', accountId: 'ac1', status: 'sent', dueDate: iso(-3), amount: 60, combinedInvoiceId: 'c1' },
      { id: 'r-fresh', number: '13107', accountId: 'ac1', status: 'sent', dueDate: iso(-4), amount: 70, reminderSentAt: new Date(Date.now() - 3 * 864e5).toISOString() },
      { id: 'r-week', number: '13108', accountId: 'ac1', status: 'sent', dueDate: iso(-20), amount: 80, reminderSentAt: new Date(Date.now() - 8 * 864e5).toISOString() },
      { id: 'r-nomail', number: '13109', accountId: 'ac3', status: 'sent', dueDate: iso(-2), amount: 40 },
    ],
    iv: [ { id: 'l-old', number: '9001', accountId: 'ac2', status: 'sent', dueDate: iso(-2), amount: 33 } ],
    lf_invoices: [
      { id: 'lf1', number: 'LF-501', accountId: 'ac2', status: 'sent', dueDate: iso(-1), total: 150 },
    ],
    combined_invoices: [
      { id: 'c1', number: '13106', accountId: 'ac1', status: 'sent', dueDate: iso(-3), grandTotal: 137.4, purplSubtotal: 60, lfSubtotal: 70, shippingByOrder: { o: 12.4 }, combinedDiscount: 5 },
    ],
    dist_invoices: [],
  });

  // ── [A] queue logic ──
  console.log('[A] Reminders card queue');
  mkEl('dash-invoice-reminders'); mkEl('dash-dist-kpis');
  renderInvoiceReminders();
  const html = els['dash-invoice-reminders'].innerHTML;
  ok(els['dash-invoice-reminders'].style.display === '', 'card shows when queue is non-empty');
  ok(html.includes('dir-r-over') && html.includes('13101'), 'overdue retail invoice queued');
  ok(html.includes('dir-r-soon'), 'due-in-5-days invoice queued (heads-up window)');
  ok(!html.includes('dir-r-far'), 'due-in-15-days invoice NOT queued');
  ok(!html.includes('dir-r-paid') && !html.includes('dir-r-draft'), 'paid/draft invoices excluded');
  ok(!html.includes('dir-r-child'), 'combined CHILD excluded (parent is the real bill)');
  ok(html.includes('dir-c1') && html.includes("'c1','combined_invoices'"), 'combined PARENT queued against its collection');
  ok(html.includes('$137.40'), 'combined parent shows grandTotal (discount-aware), not $0');
  // v242 CONTRACT CHANGE (owner: "they all arent showing up on the dashboard"):
  // a sent reminder used to vanish for 7 days — indistinguishable from a
  // failed send, with no way to resend. Reminded invoices now STAY listed.
  ok(html.includes('dir-r-fresh') && /dir-r-fresh[\s\S]{0,500}reminded 3d ago[\s\S]{0,300}>Resend</.test(html),
    'reminded 3 days ago → stays listed as ✓ reminded, with a Resend button (v242)');
  ok(html.indexOf('dir-r-over') < html.indexOf('dir-r-fresh'),
    'freshly-reminded rows sort BELOW needs-action rows (v242)');
  ok(html.includes('dir-r-week') && /dir-r-week[\s\S]{0,500}reminded 8d ago[\s\S]{0,300}btn xs primary"[^>]*>Resend</.test(html),
    'reminded 8+ days ago, still unpaid → urgent (primary) Resend for a re-nudge');
  // v243 (owner: "no point in hiding them ever"): the 8-row cap is gone —
  // every queued invoice renders; the list scrolls instead of truncating.
  ok(!html.includes('more —') && (html.match(/class="attn-item"/g) || []).length === 7,
    'ALL queued invoices render — no row cap, no "+N more" truncation (v243)');
  ok(/dash-inv-reminders-list" style="max-height:[\s\S]{0,40}overflow-y:auto/.test(html),
    'long lists scroll instead of hiding rows');
  ok(!html.includes('dir-r-nomail'), 'account with no email at all excluded');
  ok(html.includes('dir-l-old') && html.includes("'l-old','iv'"), 'legacy-ledger invoice queued against iv collection');
  ok(html.includes('dir-lf1') && html.includes("'lf1','lf_invoices'"), 'portal LF invoice (dueDate-only) queued');
  ok(html.includes('🔴') && html.includes('🟡'), 'overdue and due-soon markers both render');
  ok(!html.includes('<script>'), 'account name is escaped in the card');

  // ── [B] send path ──
  console.log('[B] sendInvoiceReminder');
  const tick = () => new Promise(r => setTimeout(r, 15));
  mkEl('dir-r-over'); mkEl('dash-inv-reminders-list');
  state.updates.length = 0; state.toasts.length = 0;
  await sendInvoiceReminder('r-over', 'retail_invoices'); await tick();
  const stamp = state.updates.find(u => u.k === 'retail_invoices' && u.id === 'r-over');
  ok(!!stamp && !!stamp.doc.reminderSentAt, 'success stamps reminderSentAt on the invoice');
  const cad = state.updates.find(u => u.k === 'ac' && u.id === 'ac1');
  ok(!!cad && cad.doc.cadence?.some(e => e.stage === 'invoice_reminder' && e.invoiceRef === '13101' && e.sentMessageId === 'msg-1'),
    'cadence logs the reminder with invoice ref + message id (Emails tab history)');
  ok(!(cad && cad.doc.lastContacted), 'transactional stage does NOT bump lastContacted');
  ok(state.toasts.some(t => t.includes('Email sent')), 'success toast fires');
  // v242 CONTRACT CHANGE: success re-renders the card in place of removing
  // the row — the invoice flips to "✓ reminded today" with a Resend button.
  const rerendered = els['dash-invoice-reminders'].innerHTML;
  ok(rerendered.includes('dir-r-over') && /dir-r-over[\s\S]{0,500}reminded today/.test(rerendered),
    'sent row stays on the card as ✓ reminded today (v242)');
  ok(els['dir-r-over']?.removed !== true, 'row is no longer deleted from the DOM');

  let captured = null;
  state.sendResult = (args) => { captured = args; return Promise.resolve({ id: 'msg-2' }); };
  await sendInvoiceReminder('r-week', 'retail_invoices'); await tick();
  ok(captured.to === 'buyer@bigy.com', 'recipient falls back to account email');
  ok(/Payment reminder — 13108/.test(captured.subject), 'overdue subject line');
  await sendInvoiceReminder('r-soon', 'retail_invoices'); await tick();
  ok(/Invoice due soon — 13102/.test(captured.subject), 'due-soon subject line');
  await sendInvoiceReminder('lf1', 'lf_invoices'); await tick();
  ok(captured.to === 'ap@nourish.com', 'billing/AP email wins over buyer email');
  ok(captured.html.includes('/pay?inv=lf1&t=lf'), 'LF reminder carries evergreen pay link typed lf');
  await sendInvoiceReminder('c1', 'combined_invoices'); await tick();
  ok(captured.html.includes('/pay?inv=c1&t=combined'), 'combined reminder pay link typed combined');
  ok(captured.html.includes('$137.40'), 'combined email Amount Due = grandTotal');

  state.updates.length = 0; state.toasts.length = 0; state.opened.length = 0;
  state.sendResult = () => Promise.reject(new Error('resend down'));
  cache.retail_invoices.find(x => x.id === 'r-over').reminderSentAt = null;
  await sendInvoiceReminder('r-over', 'retail_invoices'); await tick();
  ok(!state.updates.some(u => u.k === 'retail_invoices'), 'failed send does NOT stamp reminderSentAt (stays on the card)');
  ok(state.opened.some(u => u.startsWith('mailto:buyer%40bigy.com') || u.startsWith('mailto:buyer@bigy.com')), 'failure opens a Gmail/mailto fallback');
  ok(state.updates.some(u => u.k === 'ac' && u.doc.cadence?.some(e => e.method === 'gmail')), 'fallback still logged in cadence as gmail');
  state.sendResult = () => Promise.resolve({ id: 'msg-1' });

  state.toasts.length = 0; captured = null;
  await sendInvoiceReminder('r-nomail', 'retail_invoices'); await tick();
  ok(state.toasts.some(t => t.includes('No email')) && captured === null, 'no-email invoice refuses with a toast, sends nothing');

  // ── [C] the email HTML itself ──
  console.log('[C] reminder email HTML');
  const over = buildInvoiceReminderHTML({ ...cache.retail_invoices[0], _payLink: 'https://purpl-crm.web.app/pay?inv=r-over&t=retail' }, 'retail_invoices', true);
  ok(over.includes('OVERDUE') && !over.includes('DUE SOON'), 'overdue pill');
  ok(over.includes('REMINDER'), 'REMINDER header');
  ok(over.includes('$412.50'), 'amount band shows invoice amount');
  ok(over.includes('Hi Lisa,'), 'greets the primary contact by name');
  ok(over.includes('Pay Online') && over.includes('pay?inv=r-over'), 'Pay Online button uses the evergreen link');
  ok(over.includes('ACH / Wire:') && over.includes('Mail checks to:'), 'full payment block: ACH + mail-a-check');
  ok(over.includes('purpl-logo-top-sprig.png') && over.includes('lf-logo-circle-transparent.png'), 'brand logo row (doc family)');
  ok(over.includes('Big Y &amp; Sons &lt;script&gt;'), 'account name escaped in email body');
  const soon = buildInvoiceReminderHTML(cache.retail_invoices[1], 'retail_invoices', false);
  ok(soon.includes('DUE SOON') && !soon.includes('>OVERDUE<'), 'due-soon pill');
  ok(!soon.includes('Pay Online'), 'no pay link → button omitted, check/ACH instructions remain');
  ok(soon.includes('just a heads up'), 'due-soon copy, not dunning copy');
  const noDue = buildInvoiceReminderHTML({ id: 'x', number: '13999', accountId: 'ac1', amount: 10 }, 'retail_invoices', false);
  ok(noDue.includes('Net 30'), 'missing due date falls back to Net 30 label');
  const lfHtml = buildInvoiceReminderHTML(cache.lf_invoices[0], 'lf_invoices', true);
  ok(lfHtml.includes('$150.00'), 'LF amount uses total');
  ok(await _getStripePayLink({ id: 'z', total: 0 }, 'retail') === null, 'zero-amount invoice → no pay link minted');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
