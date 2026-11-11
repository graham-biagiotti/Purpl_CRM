// Wave 33 backtests — v261 LF inventory:
// (1) lf_iv ledger — per-variety on-hand sums, invoice deduction rows, and
//     the low-stock crossing semantics, all run DYNAMICALLY on the real code;
// (2) hooks — all four LF invoice creation paths deduct, all four void/delete
//     paths reverse, edits warn instead of silently re-mathing stock;
// (3) Wix retirement — no new pull records, no reminder modal, badges
//     repurposed, legacy data kept read-only (fresh-start doctrine: nothing
//     retroactive, no invoice/money field touched).
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + collection wiring');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const keys = slc(dbSrc, 'const COLLECTION_KEYS = [', '];');
  ok(keys.includes("'lf_iv'"), 'lf_iv is a real collection (grows like iv), not a config array');
  ok(!slc(dbSrc, 'const CONFIG_ARRAY_KEYS = [', '];').includes("'lf_iv'"), 'and NOT doubled into the config doc');
  ok(slc(dbSrc, 'const CONFIG_ARRAY_KEYS = [', '];').includes("'lf_wix_deductions'"),
    'legacy wix records stay readable (reports/history)');
}

console.log('[B] ledger math — run the REAL functions');
{
  // on-hand sums per variety
  const helpers = slc(src, 'function _lfKey(', '\n// Leaf = ');
  const onHand = new Function('DB', helpers + '\nreturn _lfOnHandMap();')({
    a: () => [
      { skuId: 's1', variantId: 'v1', type: 'in', qty: 10 },
      { skuId: 's1', variantId: 'v1', type: 'out', qty: 3 },
      { skuId: 's1', variantId: 'v2', type: 'in', qty: 5 },
      { skuId: 's2', variantId: '', type: 'in', qty: '7' },   // string qty tolerated
      { skuId: 's2', variantId: '', type: 'out', qty: 9 },    // over-deduction shows negative
    ],
  });
  ok(onHand['s1|v1'] === 7 && onHand['s1|v2'] === 5, 'per-variety sums are independent');
  ok(onHand['s2|'] === -2, 'over-deduction is visible as a negative, never clamped silently');

  // invoice → ledger rows
  const entFn = slc(src, 'function _lfIvEntriesForInvoice(', '\n// Deduct a freshly-created');
  const entries = new Function('uid', 'today', '_currentUserName',
    entFn + "\nreturn _lfIvEntriesForInvoice('INV1', 'LF-9', arguments[3]);")(
    () => 'id', () => '2026-11-11', () => 'Graham', [
      { skuId: 'scr', skuName: 'Scrunchie', hasVariants: true, variantLines: [
        { variantId: 'va', variantName: 'Blossom Satin', units: 6 },
        { variantId: 'vb', variantName: 'Sage Velvet', units: 0 },     // zero → no row
      ]},
      { skuId: 'syr', skuName: 'Syrup', units: 3.6 },                   // fractional → rounded
      { skuId: '__shipping__', skuName: 'Shipping', units: 1 },         // never stock
      { skuId: '__misc__', skuName: 'Fee', units: 1 },
    ]);
  ok(entries.length === 2, 'shipping/misc/zero lines never become stock rows');
  ok(entries[0].variantId === 'va' && entries[0].qty === 6 && entries[0].type === 'out'
     && entries[0].reason === 'wholesale' && entries[0].invoiceId === 'INV1',
    'variant line → per-variety wholesale deduction tied to the invoice');
  ok(entries[1].qty === 4 && entries[1].variantId === '', 'plain line rounds units, no phantom variant');

  // low-stock crossing: fires only when dropping from above TO at-or-below
  const chkFn = slc(src, 'function _lfLowStockCheck(', '\n// "Deducted" badge');
  const calls = [];
  const runChk = (before, after, th) => {
    calls.length = 0;
    new Function('_lfOnHandMap', '_lfLeafRows', '_lfKey', '_lfLeafLabel', 'firebase', 'console',
      chkFn + '\n_lfLowStockCheck(arguments[6]);')(
      () => after,
      () => [{ skuId: 's1', skuName: 'Candle', variantId: '', variantName: '', threshold: th }],
      (a, b) => (a || '') + '|' + (b || ''),
      (r) => r.skuName,
      { functions: () => ({ httpsCallable: () => (p) => { calls.push(p); return { catch: () => {} }; } }) },
      console, before);
    return calls.length;
  };
  ok(runChk({ 's1|': 10 }, { 's1|': 4 }, 5) === 1, 'drop across the threshold → one alert call');
  ok(runChk({ 's1|': 4 }, { 's1|': 3 }, 5) === 0, 'already below → NO repeat alert (server dedupe is backup, not the only guard)');
  ok(runChk({ 's1|': 10 }, { 's1|': 4 }, 0) === 0, 'threshold 0/unset → never alerts');
}

console.log('[C] creation hooks + reversals + edit warning');
{
  const core = slc(src, 'function _saveLfInvoiceCore(', '\nasync function deleteLfInvoice');
  ok(core.includes('if (isNew) _lfDeductForInvoice(rec);'), 'LF modal: new invoice deducts');
  ok(core.includes('_lfIvEditWarn(saveId, existing?.lineItems, rec.lineItems)'),
    'LF modal: edit warns instead of re-mathing');
  ok(!core.includes('lf_wix_deductions') && core.includes('return { rec };'),
    'LF modal: Wix record generation gone, return contract updated');
  ok((src.match(/showWixPullModal/g) || []).length === 0, 'no caller still pops the retired reminder modal');

  ok((src.match(/_lfIvEntriesForInvoice\((lfInvId|singleInvId)/g) || []).length === 2,
    'both portal-confirm paths deduct inside their atomic write');
  ok(src.includes('window._lfPortalBefore = _lfOnHandMap();')
     && src.includes('_lfLowStockCheck(window._lfPortalBefore)'),
    'portal deduction checks thresholds against a pre-write snapshot');
  ok(src.includes('_lfIvEntriesForInvoice(lfId, lfNum, lfLines)')
     && src.includes('_lfLowStockCheck(_lfBeforeComb)'),
    'manual combined builder deducts (closed the legacy no-deduction gap)');
  ok(src.includes('_lfIvEditWarn(rec.lfInvoiceId, _lfOldLines, lfLines)'),
    'combined edit warns on changed LF quantities');

  ok((src.match(/cache\.lf_iv = \(cache\.lf_iv ?\|\| ?\[\]\)\.filter\(/g) || []).length >= 4,
    'all four void/delete paths reverse the deduction (delete, single void, combined void, combined delete)');
  ok(src.includes("if (type === 'lf') cache.lf_iv = (cache.lf_iv || []).filter(x => !(x.type === 'out' && x.invoiceId === id));"),
    'single-invoice shell void returns LF stock');

  // Fresh-start doctrine: a pre-v261 invoice (no ledger rows) never warns.
  const warn = slc(src, 'function _lfIvEditWarn(', '\n// After any stock-lowering');
  ok(warn.includes("if (!DB.a('lf_iv').some(e => e.invoiceId === invoiceId)) return;"),
    'edit warning only fires for invoices that actually deducted (nothing retroactive)');
}

console.log('[D] Wix retirement — UI gone, legacy kept read-only');
{
  ok(!idx.includes('modal-wix-pull') || idx.includes('the Wix pull modal is retired'),
    'reminder modal markup removed from index.html');
  ok(!src.includes('_lfWixDeductionFor') && !src.includes('confirmWixPull'),
    'generator + confirm flow deleted');
  ok(!/DB\.push\('lf_wix_deductions'/.test(src) && !/cache(\.|\[')lf_wix_deductions('\])? ?= ?\[\.\.\./.test(src),
    'nothing creates new Wix pull records anywhere');
  ok((src.match(/lf_wix_deductions/g) || []).length >= 6,
    'legacy cleanup filters + historical report still read the old data');
  ok(src.includes("label:'LF item'") && src.includes('low on stock'),
    'dashboard card now surfaces low stock instead of pending pulls');
  ok(src.includes("kpiHtml('LF Low Stock'"), 'invoices-page KPI repurposed');
  ok(src.includes('_lfDeductedBadge(inv, _dedSet)') && src.includes('_lfDeductedBadge(inv, _dedSet2)'),
    'Deducted column reads the ledger (legacy wixPulled still shows ✓)');
  ok(idx.includes('Wix pull reminders were retired in v261'),
    'historical report labeled as history');
}

console.log('[E] LF inventory pane');
{
  ok(idx.includes('data-inv-tab="lf"') && idx.includes('id="inv-pane-lf"'), 'tab + pane wired in HTML');
  ok(src.includes('lf:        _invLf'), 'pane handler registered');
  const pane = slc(src, 'function _invLf()', '\nfunction _lfLeafByKey');
  ok(pane.includes('document.activeElement') && pane.includes('return;'),
    'background refresh never rebuilds the pane mid-typing (v260 doctrine)');
  ok((pane.match(/escHtml\(/g) || []).length >= 8, 'names/notes/authors escaped throughout');
  ok(pane.includes("onchange=\"lfInvSaveThreshold('"), 'inline per-variety threshold inputs');
  ok(pane.includes('lf-st-count') && src.includes('function lfInvStockTakeSave()'),
    'stock-take mode present for the day-one baseline');
  const st = slc(src, 'function lfInvStockTakeSave()', '\nasync function lfInvSaveAlertEmail');
  ok(st.includes('const delta = counted - cur;') && st.includes("delta > 0 ? 'in' : 'out'")
     && st.includes("reason: 'adjust'"),
    'stock take writes signed count adjustments, untouched rows skipped');
  ok(st.includes('_lfLowStockCheck(before)'), 'a stock take that counts something low also alerts');
  const man = slc(src, 'function _lfManualEntry(', '\nfunction lfInvReceive');
  ok(man.includes("if (type === 'out') _lfLowStockCheck(before);"), 'manual take-outs check thresholds');
  ok(src.includes("'modal-lf-invoice':       ['lf_invoices', 'lf_iv']"),
    'freeze map covers the ledger the LF modal now writes');
}

console.log('[F] functions — instant alert + Monday digest');
{
  const al = slc(fnSrc, 'exports.lfLowStockAlert', '\nexports.lfWeeklyDigest');
  ok(al.includes("['employee', 'admin'].includes(role)"), 'alert callable is staff-only');
  ok(al.includes("cfg.lastAlert[i.key] !== todayET"), 'server dedupes to one email per item per day');
  ok(al.includes("if (_r.error)") && al.includes("throw new HttpsError('internal'"),
    'Resend failure is reported honestly (v254 doctrine)');
  ok(al.includes('lastAlert: stamp }, { merge: true })') && !al.includes(".update(stamp)"),
    "dedupe stamp goes through merged set — item keys contain '|' which update() field paths reject");
  ok(fnSrc.includes("LF_INV_FALLBACK_EMAIL = 'alina@pumpkinblossomfarm.com'")
     && fnSrc.includes('cfg.alertEmail || LF_INV_FALLBACK_EMAIL') && al.includes('_lfInvConfig(db)'),
    'alerts work before the settings doc ever exists (fallback recipient)');

  const dg = slc(fnSrc, 'exports.lfWeeklyDigest', '\n);');
  ok(dg.includes("schedule: '23 7 * * 1'") && dg.includes("timeZone: 'America/New_York'"),
    'digest runs Monday morning ET (off the :00 rush)');
  ok(dg.includes("e.reason !== 'adjust'") && dg.includes('monthOut'),
    'run-out pace excludes count corrections');
  ok(dg.includes('if (!weekRows && !ahead.length)'), 'nothing to report → no email at all');
  ok(dg.includes('oh / rate <= 14'), 'week-ahead flags items on pace to run out');
  ok(dg.includes("if (_r.error) console.error"), 'digest send failure logged');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
