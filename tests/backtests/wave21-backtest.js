// Wave 21 backtests — v247: email branding resilience (blocked/quoted images
// degrade to clean text, Outlook's Word renderer gets a text header), header
// consolidation (7 copies → 3 fix points), the malformed warehouse email body
// fix, and the LF-only portal fulfillmentSource drop (sweep F6, owner-hit).
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] F6 — LF-only portal invoice carries fulfillmentSource');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  // NB: two `else if (hasLf)` blocks exist (number allocation + invoice
  // creation) — anchor on the LF-only invoice's unique orderId line.
  const lfBranch = slc(src, 'orderId: lfOrderId, date: todayStr, dueDate: dueDateStr,', 'linkedPortalOrderId: lfDoc.id');
  ok(/source: 'portal', deliveryMethod, fulfillmentSource,/.test(lfBranch),
    'LF-only branch stores the confirm-modal Fulfilled-by (list 🏭 button needs it)');
}

console.log('[A2] gradient headers — blocked-state resilience (client + server shells)');
{
  const hdr = slc(src, 'const PBF_HEADER_HTML', '`;');
  const shell = slc(fnSrc, 'function _samplingEmailShell', 'return `') + slc(fnSrc, 'function _samplingEmailShell', '</html>`;');
  [['PBF_HEADER_HTML', hdr], ['_samplingEmailShell', shell]].forEach(([name, h]) => {
    ok(h.includes('bgcolor="#4D2A6F"'), `${name}: purple band guaranteed in the Word renderer (bgcolor attr)`);
    ok(h.includes('<!--[if mso]>') && h.includes('<!--[if !mso]><!-->') && h.includes('<!--<![endif]-->'),
      `${name}: classic Outlook gets a TEXT header (and quotes it cleanly in replies)`);
    ok(/purpl-wordmark-white\.png"[^>]*color:#ffffff/.test(h) && /lf-logo-white\.png"[^>]*color:#ffffff/.test(h),
      `${name}: white styled alt — blocked images read as a white wordmark, not dark-on-dark`);
    ok(/width:170px;height:65px/.test(h) && /width:84px;height:78px/.test(h),
      `${name}: px dims in style pin Outlook DPI scaling and box sizes`);
  });
}

console.log('[A3] consolidation ratchet');
{
  ok((fnSrc.match(/purpl-wordmark-white\.png/g) || []).length === 1,
    'functions: the wordmark exists ONCE — every server email goes through the shell');
  ['sendOrderConfirmation', 'sendApplicationConfirmation'].forEach(fn => {
    const body = slc(fnSrc, `exports.${fn}`, 'resend.emails.send');
    ok(body.includes('_samplingEmailShell(`'), `${fn} uses the shell`);
  });
  ok(/sampleHtml = _samplingEmailShell\(`/.test(fnSrc) && fnSrc.includes("footerExtra: ' · 603-748-3038'"),
    'sample-shipped uses the shell with its phone-number footer preserved');
  ok((fnSrc.match(/footerExtra/g) || []).length >= 3, 'shell supports footerExtra (definition + default + use)');
  // Client doc-family: one helper, two consumers.
  ok(src.includes('function _docBrandRowHTML()'), 'doc brand row helper exists');
  ok((src.match(/\$\{_docBrandRowHTML\(\)\}/g) || []).length === 2,
    'reminder header AND invoice-doc header both use it');
  ok((src.match(/purpl-logo-top-sprig\.png/g) || []).length === 2,
    'sprig markup exists exactly twice in app.js (helper + the print-only PO doc)');
}

console.log('[A4] warehouse email body — no more nested document');
{
  const wh = slc(src, 'async function pushToWarehouse', '\nfunction renderInvKpis');
  ok(!/<\/div>`\) \+ docHtml/.test(wh) && !/`\) \+ docHtml;/.test(wh),
    'banner is no longer CONCATENATED in front of the document');
  ok(/docHtml\.replace\(\/<body\(\[\^>\]\*\)>\/i, \(m\) => m \+ bannerHtml\)/.test(wh),
    'banner injected inside <body> via a replacement CALLBACK ($ amounts safe)');
  ok(wh.includes('htmlToPdf: _b64utf8(docHtml)'), 'PDF attachment still renders the raw, banner-free document');
  ok(wh.includes('callSendEmail(whEmail') && wh.includes('subject, emailHtml,'),
    'the email body is the injected document');
}

console.log('[B] dynamic — banner injection + brand row');
{
  // Real injection expression against a $-laden document (the corruption trap).
  const fakeDoc = '<!DOCTYPE html><html><head></head><body style="margin:0"><p>Total: $1,234.56 &amp; $78.90</p></body></html>';
  const bannerHtml = '<table><tr><td>UPDATED $& $\' banner</td></tr></table>';
  const emailHtml = fakeDoc.replace(/<body([^>]*)>/i, (m) => m + bannerHtml);
  ok((emailHtml.match(/<!DOCTYPE/g) || []).length === 1, 'exactly ONE document in the email');
  ok(emailHtml.indexOf(bannerHtml) > emailHtml.indexOf('<body') && emailHtml.indexOf(bannerHtml) < emailHtml.indexOf('<p>'),
    'banner lands just inside <body>, before the content');
  ok(emailHtml.includes('$1,234.56') && emailHtml.includes("UPDATED $& $' banner"),
    'replacement callback preserves $ patterns verbatim (string-replace would corrupt)');
  ok(emailHtml.includes('<body style="margin:0">'), 'body attributes survive the injection');

  // The REAL _docBrandRowHTML output.
  const row = new Function(slc(src, 'function _docBrandRowHTML', '\n}') + '\n}\nreturn _docBrandRowHTML();')();
  ok(row.includes('width="140" height="140"') && row.includes('width:140px;height:140px'),
    'sprig: square box reserved in attrs AND style');
  ok(row.includes('width="52" height="52"'), 'LF circle stays 52×52 (print-contract pixel parity)');
  ok((row.match(/color:#4D2A6F/g) || []).length === 2, 'both logos carry styled dark alt');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
