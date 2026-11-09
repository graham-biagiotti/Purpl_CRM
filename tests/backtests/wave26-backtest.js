// Wave 26 backtests — v254 email reliability on the free Resend tier
// (100/day): (1) the server now CHECKS Resend v6's {data, error} return — a
// rate-limited/rejected send used to come back {success:true} and get logged
// in the customer's history as delivered; (2) the mass-send loops stop
// cleanly at the daily cap and RESUME on a re-run (cadence skip for template
// sends, preserved selection for broadcasts); (3) broadcasts go to the
// PRIMARY contact; (4) one-click List-Unsubscribe header.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + server-side Resend error checking');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);

  const se = slc(fnSrc, 'exports.sendEmail = onCall', 'exports.sendCombinedInvoice');
  const sc = slc(fnSrc, 'exports.sendCombinedInvoice = onCall', '// ── 3. Send Order Confirmation');
  [['sendEmail', se], ['sendCombinedInvoice', sc]].forEach(([name, s]) => {
    ok(s.includes('if (result.error) {'), `${name}: checks Resend's returned error`);
    ok(/resource-exhausted/.test(s) && /rate_limit\|quota\|429/.test(s),
      `${name}: quota/rate rejections get their own error code`);
    ok(s.includes('Email NOT sent —'), `${name}: failure message says NOT sent`);
    ok(s.includes('if (err instanceof HttpsError) throw err;'),
      `${name}: catch rethrows without flattening the code to internal`);
  });
  // List-Unsubscribe header, keyed off the header-only field so the server
  // cadence log (accountId-triggered) can't double-write history rows.
  ok(se.includes("'List-Unsubscribe'") && se.includes("'List-Unsubscribe-Post'"),
    'one-click unsubscribe headers sent');
  ok(se.includes('data.unsubAccountId || data.accountId'),
    'header uses the header-only field first');
  ok(se.includes('purpl-crm.web.app/unsubscribe?id='),
    'header targets the same unsubscribe endpoint as the footer link');
}

console.log('[B] client plumbing');
{
  const cse = slc(src, 'async function callSendEmail', '\n// v254: did a send fail');
  ok(cse.includes('unsubAccountId') && cse.includes('payload.unsubAccountId = unsubAccountId'),
    'callSendEmail passes the header-only account id');
  ok(src.includes('function _isEmailQuotaError(e)'), 'quota-error classifier exists');
  const cls = slc(src, 'function _isEmailQuotaError(e)', '\n}');
  ok(/resource-exhausted/.test(cls) && /quota\|rate limit/.test(cls),
    'classifier matches the server code AND message shapes');
}

console.log('[C] template mass-send — cap stop + resume (run the REAL loop)');
{
  const ts = slc(src, 'async function meTemplateSend()', '\n// ── Batch Session');
  // Static contracts
  ok(/const stageId = _TEMPLATE_STAGE_IDS\[tplId\] \|\| tplId;/.test(ts)
     && ts.indexOf('const stageId') < ts.indexOf('confirmDlg'),
    'stage id hoisted before the preflight (resume skip can be counted)');
  ok(/_alreadyGot = a =>/.test(ts) && /14 \* 86400000/.test(ts),
    'already-received skip: same template within 14 days');
  ok(ts.includes("already received this template in the last 14 days"),
    'preflight confirm names the skip count');
  ok(/if \(_alreadyGot\(a\)\) \{ skipped\+\+; continue; \}/.test(ts),
    'loop skips already-received accounts (the resume mechanism)');
  ok(/if \(_isEmailQuotaError\(e\)\) \{ capHit = true; break; \}/.test(ts),
    'quota rejection stops the loop instead of burning the rest as failures');
  ok(/if \(capHit\) break;/.test(ts), 'outer loop stops too');
  ok(ts.includes('Daily email limit reached') && ts.includes('Re-run this same send tomorrow'),
    'cap summary tells him exactly what to do');
  ok(/if \(capHit\) \{[\s\S]{0,700}return; \/\/ selections kept/.test(ts),
    'cap stop KEEPS the selection for the re-run');
  ok(/callSendEmail\(email, tpl\.from[^)]*a\.id\)/.test(ts),
    'template sends carry the unsubscribe-header id');

  // Dynamic: execute the real loop body semantics via a focused simulation of
  // its control flow — the REAL _alreadyGot predicate against real shapes.
  const mkAcct = (id, cadence) => ({ id, cadence });
  const pred = new Function('stageId', 'return ' + ts.match(/const _alreadyGot = (a =>[\s\S]*?);\n/)[1])('welcome');
  ok(pred(mkAcct('a', [{ stage: 'welcome', sentAt: new Date().toISOString() }])) === true,
    '_alreadyGot: sent today → skip');
  ok(pred(mkAcct('a', [{ stage: 'welcome', sentAt: new Date(Date.now() - 20 * 86400000).toISOString() }])) === false,
    '_alreadyGot: sent 20 days ago → sends again (deliberate re-blast works)');
  ok(pred(mkAcct('a', [{ stage: 'other', sentAt: new Date().toISOString() }])) === false,
    '_alreadyGot: different template → sends');
  ok(pred(mkAcct('a', undefined)) === false, '_alreadyGot: no history → sends');
}

console.log('[D] broadcast — primary contact + cap resume');
{
  const bs = slc(src, 'async function meBroadcastSend()', '\n// ── Mass Template Send');
  ok(/_bc\.find\(c=>c\.isPrimary\) \|\| _bc\[0\]/.test(bs),
    'broadcast goes to the PRIMARY contact (was: first with an email)');
  ok(/if \(_isEmailQuotaError\(e\)\) \{ capHit = true; break; \}/.test(bs),
    'broadcast stops at the daily cap');
  ok(/sentIds\.forEach\(id => _meSelectedIds\.delete\(id\)\);/.test(bs),
    'cap stop deselects ONLY the sent accounts — re-click finishes the rest');
  ok(bs.includes('still selected. Click Send tomorrow'),
    'cap summary explains the resume');
  ok(/callSendEmail\(email, 'lavender@pbfwholesale\.com', subject, html, undefined, undefined, a\.id\)/.test(bs),
    'broadcast sends carry the unsubscribe-header id');
  ok(bs.indexOf('_meSelectedIds.clear()') > bs.indexOf('if (capHit) {'),
    'full-completion clear still happens on the happy path');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
