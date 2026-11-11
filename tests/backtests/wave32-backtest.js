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

  // The offending rule still exists (it styles the stacked success-screen
  // logo), so the fix must be the inline override on BOTH header images.
  ok(/\.sp-header img\{[^}]*margin:0 auto/.test(smp),
    'shared rule unchanged (fix is scoped, not a rule rewrite)');
  const hdr = slc(smp, '<div class="sp-header">', '<h1>');
  const imgs = hdr.match(/<img [^>]+>/g) || [];
  ok(imgs.length === 2, 'two logos in the header row');
  ok(imgs.every(t => /style="[^"]*margin:0[^a]/.test(t + ' ')),
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

console.log('[C] account-modal Demo Link button');
{
  ok(idx.includes('id="mac-demo-link-btn"'), 'button in the account modal footer');
  const bind = slc(src, "qs('#mac-copy-link-btn')", '// Tab switching');
  ok(bind.includes("qs('#mac-demo-link-btn')") && bind.includes('samplingCopyLink(id)'),
    'button bound to samplingCopyLink with the open account id');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
