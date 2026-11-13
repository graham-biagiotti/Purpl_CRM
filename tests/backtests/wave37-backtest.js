// Wave 37 backtests — v265 first-order follow-up: a dashboard section listing
// stores that have placed exactly one order, with a day counter from the date
// that invoice was sent, an alert at day 10, and a preview-and-send of the
// new 'first-order-checkin' email. Existing stores never appear (counting
// starts at go-live); the template is also on the Emails tab.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] who is on the list — run the REAL _firstOrderRows');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const F = new Function(slc(src, 'function _firstOrderRows(', '\nfunction _firstOrderRowsLive') + '\nreturn _firstOrderRows;')();
  const T = '2026-12-01', START = '2026-11-13';
  const ac = (id, extra) => ({ id, name: 'Store ' + id, email: id + '@x.com', status: 'active', ...extra });
  const inv = (accountId, sentAt, extra) => ({ accountId, status: 'sent', sentAt, _brand: 'purpl', number: 'N' + accountId, ...extra });
  const run = (accounts, invoices) => F(accounts, invoices, T, START, 10);

  let r = run([ac('a')], [inv('a', '2026-11-25')]);
  ok(r.length === 1 && r[0].day === 6 && r[0].due === false, 'first invoice sent 6 days ago → listed, Day 6, not yet due');
  r = run([ac('a')], [inv('a', '2026-11-21')]);
  ok(r[0].day === 10 && r[0].due === true, 'day 10 exactly → flagged due');
  r = run([ac('a')], [inv('a', '2026-11-20T15:04:05.000Z')]);
  ok(r[0].day === 11 && r[0].due, 'ISO timestamp sent-dates count the same as plain dates');

  ok(run([ac('a')], [inv('a', '2026-11-20'), inv('a', '2026-11-28')]).length === 0, 'a second invoice = reordered → drops off');
  ok(run([ac('a')], [inv('a', '2026-11-20'), inv('a', '', { status: 'draft', sentAt: null })]).length === 0,
    'even a DRAFT second invoice counts as a reorder');
  ok(run([ac('a')], [inv('a', '2026-11-20', { status: 'void' })]).length === 0, 'voided first invoice → not listed');
  ok(run([ac('a')], [inv('a', '2026-11-20', { status: 'void' }), inv('a', '2026-11-26')]).length === 1,
    'a voided invoice does not count as an order (the real first order still lists)');
  ok(run([ac('a')], [inv('a', null, { status: 'draft' })]).length === 0, 'invoice not sent to the customer yet → clock has not started');
  ok(run([ac('a')], [inv('a', '2026-11-12')]).length === 0, 'first invoice sent BEFORE go-live → never listed (existing stores)');
  ok(run([ac('a')], [inv('a', '2026-11-13')]).length === 1, 'sent on go-live day → listed');
  ok(run([ac('a')], [inv('a', '2026-12-05')]).length === 0, 'a future sent-date is ignored');
  ok(run([ac('a', { cadence: [{ stage: 'first_order_checkin', sentAt: 'x' }] })], [inv('a', '2026-11-20')]).length === 0,
    'already followed up → drops off');
  ok(run([ac('a', { cadence: [{ stage: 'first_order_followup' }, { stage: 'invoice_sent' }] })], [inv('a', '2026-11-20')]).length === 1,
    'the same-day thank-you / invoice emails do NOT count as the follow-up');
  ok(run([ac('a', { foFollowupSkip: '2026-11-22' })], [inv('a', '2026-11-20')]).length === 0, 'skipped → drops off');
  ok(run([ac('a', { status: 'inactive' })], [inv('a', '2026-11-20')]).length === 0, 'inactive account → not listed');
  ok(run([ac('a')], [inv('a', '2026-11-20', { _brand: 'dist' })]).length === 0, 'distributor invoices are not store orders');
  ok(run([ac('a')], []).length === 0, 'no order yet → not listed');

  r = run([ac('a', { email: '', contacts: [] }), ac('b', { emailOptOut: true }), ac('c', { email: '', contacts: [{ email: 'p@x.com', isPrimary: true }] })],
    [inv('a', '2026-11-20'), inv('b', '2026-11-20'), inv('c', '2026-11-20')]);
  const by = Object.fromEntries(r.map(x => [x.accountId, x]));
  ok(by.a.hasEmail === false && by.c.hasEmail === true, 'no-email stores still list (flagged), primary contact email counts');
  ok(by.b.optedOut === true, 'unsubscribed stores still list, flagged');

  r = run([ac('a'), ac('b'), ac('c')], [inv('a', '2026-11-28'), inv('b', '2026-11-15', { _brand: 'combined' }), inv('c', '2026-11-20', { _brand: 'lf' })]);
  ok(r.map(x => x.accountId).join('') === 'bca', 'longest-waiting first');
  ok(r[0].brand === 'both' && r[1].brand === 'lf' && r[2].brand === 'purpl', 'brand read from the first invoice');
}

console.log('[B] dashboard section + alert card');
{
  ok(idx.indexOf('id="dash-first-orders"') > idx.indexOf('id="dash-quick-actions"')
     && idx.indexOf('id="dash-first-orders"') < idx.indexOf('id="dash-combined-kpis"'),
    'section sits near the top: right under the alert cards, above the KPIs');
  const rd = slc(src, 'function renderDash() {', 'renderDashPayments();');
  ok(rd.includes('renderDashFirstOrders();'), 'rendered with the dashboard');
  ok(src.includes("const FIRST_ORDER_FOLLOWUP_DAY = 10;") && /const FIRST_ORDER_FOLLOWUP_START = '\d{4}-\d{2}-\d{2}';/.test(src),
    'alert day is 10; counting starts at a fixed go-live date');
  const qa = slc(src, 'function renderDashQuickActions()', '\n// ════');
  ok(qa.includes('_firstOrderRowsLive().filter(r => r.due).length') && qa.includes('First-order follow-up'),
    'alert card counts only stores at day 10+');
  const sec = slc(src, 'function renderDashFirstOrders()', '\n// Opens the standard email preview');
  ok(sec.includes("if (!rows.length) { el.style.display = 'none'"), 'section hides when empty');
  ok(sec.includes('escHtml(r.name') && sec.includes('escHtml(r.invoiceNumber)'), 'store name + invoice number escaped');
  ok(sec.includes('Day ${r.day}') && sec.includes('⚠ Send follow-up'), 'day counter + day-10 flag shown');
  ok(sec.includes("r.optedOut ? ") && sec.includes('No email on file') && sec.includes('foPreview('),
    'send button only where an email can go; otherwise the reason is shown');
  ok(!/_isAdmin\(|_requireAdmin\(/.test(sec + slc(src, 'async function foPreview(', '\nfunction _timeAgo')), 'visible to everyone (no admin gate)');
}

console.log('[C] the email + send path');
{
  const tpl = slc(src, "'first-order-checkin': {", "'delivery-followup': {");
  ok(tpl.includes('How is it selling so far?') && tpl.includes('Place a Reorder') && tpl.includes('Pick a Demo Day'),
    'check-in + reorder link + demo link');
  ok(tpl.includes('${portalLink}') && tpl.includes('pbfwholesale.com/sampling?t=${account.orderPortalToken}'),
    'links are the store\'s personal reorder + booking links');
  ok(tpl.includes('`, account.id)'), 'carries the unsubscribe footer');
  ok(tpl.includes('escHtml(extra.brandPhrase || _foBrandPhrase(account.id))'), 'wording names what they actually ordered');
  ok(src.includes("first_order_checkin:   'first-order-checkin'"), 'stage id maps to the template (history + dedupe)');
  ok(src.includes("{id:'first-order-checkin',  name:'First Order Check-In (10 days)'"), 'template available on the Emails tab');
  ok(src.includes("'first_order_checkin':  'First Order Check-In'"), 'email history shows a readable name');
  const pv = slc(src, 'async function foPreview(', '\nasync function foSkip');
  ok(pv.includes('await _ensurePortalToken(accountId)') && pv.includes("openEmailPreview('first-order-checkin', accountId)"),
    'preview mints the personal link first, then opens the editable preview');
  const sk = slc(src, 'async function foSkip(', '\nfunction _timeAgo');
  ok(sk.includes("DB.updateFields('ac', accountId, { foFollowupSkip: today() })") && sk.includes('confirmDlg'),
    'skip is confirmed and written as one field (no whole-account overwrite)');
  ok(slc(src, 'function markCadenceEmailSent(', '\n// ════').includes('renderDashFirstOrders();'),
    'after sending from the dashboard the row drops off immediately');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
