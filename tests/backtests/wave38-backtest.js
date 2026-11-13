// Wave 38 backtests — v268 Emails page, part 1 (less scrolling, same flows):
// preview pane sized to the window + a full-screen read; templates grouped
// by purpose and searchable, launch-era ones under a collapsed "Older";
// mass-send store list taller with a name search. No send path changed.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../public/style.css'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] template groups — run the REAL data + filter');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const code = slc(src, 'const EMAIL_TEMPLATE_GROUPS = [', '\nfunction _renderEmailsTemplatesCol');
  const { G, vis } = new Function(code + '\nreturn { G: EMAIL_TEMPLATE_GROUPS, vis: _emailsTplVisible };')();
  const ids = G.flatMap(g => g.items.map(t => t.id));
  // Every template that existed before the regroup must still be offered.
  const REQUIRED = ['preorder-announcement', 'launch-announcement', 'application-received', 'approved', 'rejected',
    'order-confirmation', 'invoice-sent', 'invoice-reminder', 'payment-overdue', 'first-order', 'first-order-checkin',
    'reorder-reminder', 'delivery-followup', 'new-product', 'lf-whats-new', 'sampling-invite', 'thank-you', 'custom'];
  ok(REQUIRED.every(id => ids.includes(id)), 'no template was dropped by the regroup (all 18 still listed)');
  ok(new Set(ids).size === ids.length, 'no template listed twice');
  // ...and each one is a template the builder actually knows.
  const body = src.slice(src.indexOf('function getCadenceEmailTemplate('), src.indexOf("function getCadenceEmailTemplate(") + 60000);
  ok(ids.filter(id => id !== 'custom').every(id => body.includes(`'${id}': {`)), 'every listed id has a real template behind it');

  let r = vis(G, '', false, null);
  ok(r.find(g => g.older).collapsed === true && r.filter(g => !g.older).every(g => !g.collapsed), '"Older" starts collapsed; everything else open');
  ok(vis(G, '', true, null).find(g => g.older).collapsed === false, 'clicking "Older" opens it');
  ok(vis(G, '', false, 'launch-announcement').find(g => g.older).collapsed === false, 'a selected Older template keeps its group open');
  r = vis(G, 'restock', false, null);
  ok(r.length === 1 && r[0].items.map(t => t.id).join() === 'reorder-reminder', 'search narrows to exactly the matching template');
  ok(vis(G, 'reorder', false, null).flatMap(g => g.items).map(t => t.id).sort().join() === 'first-order-checkin,reorder-reminder',
    'a word in two templates returns both, across groups');
  r = vis(G, 'LAUNCH', false, null);
  ok(r.some(g => g.older && !g.collapsed && g.items.some(t => t.id === 'launch-announcement')), 'search is case-insensitive and reaches into "Older"');
  ok(vis(G, 'zzzz', false, null).length === 0, 'no match → no groups (empty-state message shows)');
  ok(vis(G, 'demo links', false, null).flatMap(g => g.items).some(t => t.id === 'first-order-checkin'), 'search also matches the description');
}

console.log('[B] less scrolling');
{
  ok(/\.emails-preview-frame\{[^}]*height:calc\(100vh - 330px\);min-height:480px/.test(css), 'preview pane grows with the window (never smaller than before)');
  // (gate F1: the app topbar is sticky at top:0 and 56px tall — pin BELOW it)
  ok(/\.emails-templates-col\{[^}]*position:sticky;top:68px;max-height:calc\(100vh - 84px\);overflow-y:auto/.test(css)
     && /\.topbar\{[^}]*height:56px/.test(css),
    'template list stays in view while the preview scrolls, clear of the 56px top bar');
  ok(css.includes('.emails-templates-col{position:static;max-height:none}'), 'on narrow screens the template list stacks normally');
  ok(idx.includes('onclick="emailsPreviewFullscreen()"'), 'full-screen preview button on the Compose tab');
  const fs_ = slc(src, 'function emailsPreviewFullscreen()', '\nfunction selectEmailTemplate');
  ok(fs_.includes("big.srcdoc = frame.srcdoc") && fs_.includes("e.key === 'Escape'") && fs_.includes('Pick an email and a store first'),
    'full screen shows the same email, closes on Esc, and explains itself when nothing is selected');
  ok(!/innerHTML\s*=/.test(fs_), 'the overlay is built with DOM nodes — the email HTML only ever goes into an iframe');
  // (gate F2: only as tall as leaves the Send button on screen — never below the old 420px)
  ok(idx.includes('id="email-preview-frame" style="width:100%;height:max(420px, min(60vh, calc(90vh - 330px)))'),
    'send-preview window is taller only when the window has room for the Send button');
  ok(idx.includes('id="me-account-list" style="max-height:max(340px, calc(100vh - 470px))')
     && idx.includes('id="me-batch-list" style="max-height:max(300px, calc(100vh - 430px))'), 'mass-send store lists use the window height');
  const tl = slc(src, 'function _renderEmailsTplList()', '\n// Full-screen read');
  ok(tl.includes('escHtml(t.name)') && tl.includes('escHtml(t.desc)') && tl.includes('escHtml(g.label)'), 'template list text escaped');
  ok(slc(src, 'function _renderEmailsTemplatesCol()', '\n// The list renders separately').includes('oninput="_emailsTplQ = this.value; _renderEmailsTplList()"'),
    'typing in the template search refreshes only the list');
}

console.log('[C] mass-send search can never widen a send');
{
  const fl = slc(src, 'function _meMainFilteredList(', '\nfunction renderMeAccountList');
  ok(fl.includes("qs('#me-search')") && fl.includes('.toLowerCase().includes(nameQ)'), 'name search lives inside the one shared filtered list');
  ok(idx.includes('id="me-search"') && idx.includes('oninput="renderMeAccountList()"'), 'search box wired above the store list');
  const sa = slc(src, 'function meSelectAll()', '\nfunction meBatchSelectAll');
  ok((sa.match(/_meMainFilteredList\(_meBuildInvoiceIndex\(\)\)/g) || []).length === 2,
    'Select All / Deselect All still use that same list — so they act only on the stores on screen');
  const uc = slc(src, 'function _updateMeCount()', '\nfunction _updateMeBatchCount');
  ok(uc.includes('NOT shown by the current search/filters (they will still be sent to)') && uc.includes("countEl.style.color = hidden ? 'var(--red)' : ''"),
    'the count line warns in red when selected stores are hidden by the search/filters');
  const HC = new Function(slc(src, 'function _meHiddenCount(', '\nfunction meClearAllSelected') + '\nreturn _meHiddenCount;')();
  ok(HC(new Set(['a', 'b', 'c']), ['a']) === 2 && HC(new Set(['a']), ['a', 'z']) === 0 && HC(new Set(), []) === 0,
    'hidden-selection count is right (run for real)');
  const ca = slc(src, 'function meClearAllSelected()', '\nfunction _updateMeBatchCount');
  ok(ca.includes('_meSelectedIds.clear();') && idx.includes('onclick="meClearAllSelected();return false"'),
    '"Clear all N" empties the whole selection, hidden stores included (gate F3)');
  ok(slc(src, 'function emailsPreviewFullscreen()', '\nfunction selectEmailTemplate').includes('btn.focus();'),
    'full-screen overlay takes focus so the button behind it cannot re-open it');
  // Send paths untouched: they still read the selection set, not the visible list.
  ok(src.includes("const accounts = DB.a('ac').filter(a=>_meSelectedIds.has(a.id));")
     && src.includes("let accounts = DB.a('ac').filter(a => _meSelectedIds.has(a.id));"), 'both mass-send paths unchanged');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
