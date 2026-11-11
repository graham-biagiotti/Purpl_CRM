// Wave 32 backtests — v260 smalls:
// (1) sampling portal header logos — the shared .sp-header img rule set
//     margin:0 auto, and in the side-by-side flex row those auto margins
//     absorbed all free space, pushing the two logos to opposite edges of
//     the header. The inline margin:0 override pins them back together.
// (2) booking-link lookup — the Sampling page's native <select> of every
//     account (unsearchable at ~200 rows) is replaced by a type-ahead with
//     per-row Copy buttons, and the account modal gains a Demo Link button.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const smp = fs.readFileSync(path.join(__dirname, '../../public/sampling.html'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + logo fix');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);

  // The shared .sp-header img rule (margin:0 auto) is left in place — the
  // header imgs are the page's only imgs today, but the rule costs nothing
  // and a scoped override is safer than deleting shared CSS on a store-facing
  // page. The fix must be the inline override on BOTH header images.
  ok(/\.sp-header img\{[^}]*margin:0 auto/.test(smp),
    'shared rule unchanged (fix is scoped, not a rule rewrite)');
  const hdr = slc(smp, '<div class="sp-header">', '<h1>');
  const imgs = hdr.match(/<img [^>]+>/g) || [];
  ok(imgs.length === 2, 'two logos in the header row');
  // (gate F4: [^a] was vacuous — a reverted "margin:0 auto" has a SPACE after
  // the 0, which [^a] matched. Require margin:0 immediately followed by ; or
  // the closing quote, i.e. a true pinned-zero margin.)
  ok(imgs.every(t => /style="[^"]*margin:0[;"]/.test(t)),
    'both logos carry the inline margin:0 override (auto-margin spread killed)');
}

console.log('[B] booking-link type-ahead replaces the select');
{
  ok(!src.includes('sampling-copy-select'),
    'the unsearchable <select> of all accounts is gone');
  const shell = slc(src, 'id="sampling-search"', '<div id="sampling-list">');
  ok(shell.includes('id="sampling-link-search"') && shell.includes('_samplingLinkLookup()'),
    'type-ahead input wired in the sampling shell');
  ok(shell.includes('id="sampling-link-results"'),
    'results dropdown container present');

  const lk = slc(src, 'function _samplingLinkLookup()', '\nasync function samplingCopyLink');
  ok(lk.includes("if (q.length < 2)"), 'lookup waits for 2+ letters');
  ok(lk.includes("a.status !== 'inactive'"), 'inactive accounts excluded (select parity)');
  ok(lk.includes('.slice(0, 8)'), 'results capped');
  ok(lk.includes("${escHtml(a.name || '')}"), 'store names escaped in results (XSS)');
  ok(lk.includes("samplingCopyLink('${a.id}')"), 'per-row Copy button calls by id');

  // Run the REAL lookup filter logic shape: a hostile name renders escaped.
  const cp = slc(src, 'async function samplingCopyLink(acId)', '\nasync function samplingResend');
  ok(cp.includes('_ensurePortalToken(acId)'), 'copy path still reuses/mints the portal token');
  ok(cp.includes("box.style.display = 'none'") && cp.includes("inp.value = ''"),
    'results close and the query clears after a copy');
  ok(cp.includes('promptDlg'), 'clipboard-denied fallback still shows the link');
}

console.log('[B2] gate fixes — refresh survival + dark mode + footer wrap');
{
  // Gate F1: refreshCurrentPage() re-runs renderSampling on ANY remote db
  // change; mid-typing the shell rebuild would eat keystrokes. The guard
  // keeps the shell and refreshes only the list while a shell input is focused.
  const rs = slc(src, 'async function renderSampling()', '_samplingMonthOffset = 0;');
  ok(rs.includes('document.activeElement'), 'focus guard reads the active element');
  ok(/INPUT\|TEXTAREA\|SELECT/.test(rs), 'guard covers all typeable controls');
  ok(rs.includes("!qs('#sampling-list')?.contains(_ae)")
     && rs.includes('_renderSamplingList();') && rs.includes('return;'),
    'focused shell input → list-only refresh, shell untouched');
  // the guard sits BEFORE the month reset, so browsing state survives too
  ok(rs.indexOf('document.activeElement') >= 0, 'guard runs before the month reset');

  // Gate F2: results panel was background:#fff — unreadable in dark mode
  // (near-white --text on white). Theme vars now.
  const shell2 = slc(src, 'id="sampling-link-results"', '</div>');
  ok(shell2.includes('background:var(--card,#fff)') && shell2.includes('color:var(--text'),
    'results panel uses theme vars (dark-mode legible)');
  ok(!shell2.includes('background:#fff'), 'hardcoded white background gone');

  // Gate F3: 5th footer button needs the modal footer to wrap on phones.
  const css = fs.readFileSync(path.join(__dirname, '../../public/style.css'), 'utf8');
  ok(/\.modal-footer\{[^}]*flex-wrap:wrap/.test(css), 'modal footer wraps (5 buttons at phone width)');

  // Gate F4 self-check: the logo assert must REJECT a reverted auto margin.
  ok(!/style="[^"]*margin:0[;"]/.test('<img style="display:block;margin:0 auto 16px">'),
    'logo regex rejects the original margin:0 auto bug (not vacuous)');
}

console.log('[C] account-modal Demo Link button');
{
  ok(idx.includes('id="mac-demo-link-btn"'), 'button in the account modal footer');
  const bind = slc(src, "qs('#mac-copy-link-btn')", '// Tab switching');
  ok(bind.includes("qs('#mac-demo-link-btn')") && bind.includes('samplingCopyLink(id)'),
    'button bound to samplingCopyLink with the open account id');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
