// Wave 27 backtests — v255 smalls batch: stale purpl due date (B1), portal
// confirm stranding recovery (B2), Collected counting legacy combined
// families (B3), $0 LF invoice repair (B4), field-log contact flat-field
// refresh (B5), legacy iv combined child in send/edit/void (B6), declined
// portal revival guard (B7), sample re-ship warning (B8), post-sign-out save
// hygiene (B9), sampling-sweep stamps gated on real sends + broadcast label
// (v254 nits), and the login form wrap.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(__dirname, '../../public/auth.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version lockstep');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
}

console.log('[B] B1 — purpl due date never stale');
{
  const pb = slc(src, 'function buildPurplInvoiceEmailHTML', 'function buildLfInvoiceEmailHTML');
  ok(pb.includes('dueDate: inv.dueDate || inv.due'),
    'purpl doc builder prefers dueDate (what saves write) over the legacy twin');
  const sv = slc(src, "const _invNum = number || existing?.invoiceNumber", 'async function deleteInvRecord');
  ok(/dueDate:\s+due,\s*\n\s*due,/.test(sv), 'purpl save keeps both twins in step');
  const sh = slc(src, "const _tl = _termsToLabel(rec.paymentTerms) || 'Net 30';", "if (qs('#civ-edit-notes'))");
  ok(sh.includes(".onchange = () =>") && sh.includes('864e5'),
    'picking new terms in the shell recomputes the due date');
}

console.log('[C] B2 — portal confirm stranding recovery');
{
  const cp = slc(src, 'async function confirmPortalOrder()', '\n// ── Phase 5: Portal Settings');
  ok(/let _c_portalRef = null, _c_origStatus = 'new', _c_pairedId = null, _c_invoiceCreated = false;/.test(cp),
    'claim tracking hoisted outside the try');
  ok(cp.includes('_c_portalRef = portalRef; _c_origStatus = d.status'),
    'primary claim recorded with its pre-claim status');
  ok(cp.includes('if (paired) _c_pairedId = paired.id;'), 'twin claim recorded');
  ok(cp.indexOf('_c_invoiceCreated = true;') > cp.indexOf('DB.atomicUpdate(cache => {')
     && cp.indexOf('_c_invoiceCreated = true;') < cp.indexOf('convertedOrderId: purplOrderId || lfOrderId'),
    'invoice-created flag set between the invoice write and the link-back');
  ok(/if \(_c_portalRef && !_c_invoiceCreated\) \{[\s\S]{0,600}status: _c_origStatus, confirmedAt: null/.test(cp),
    'catch reverts the claim when no invoice was created');
  ok(cp.includes('returned to the review queue'), 'failure toast says the order is back');
  ok(/_c_pairedId\)[\s\S]{0,200}status: _c_origStatus/.test(cp), 'twin reverted too');
}

console.log('[D] B3 + B7');
{
  ok(src.includes('const _famPaidD = x =>'), 'legacy family paid-date fallback exists');
  ok(/if \(effStatus\(x\) !== 'paid'\) return false;\s*\n\s*const pd = paidD\(x\) \|\| _famPaidD\(x\);/.test(src),
    'Collected uses effStatus + child paid-date fallback (counts what Outstanding stops counting)');
  ok(src.includes("data.status === 'confirmed' || data.status === 'handled' || data.status === 'declined'"),
    "primary confirm transaction refuses 'declined' too (B7)");
}

console.log('[E] B4 — $0 LF invoice repair (run the REAL migration)');
{
  const mig = slc(src, 'function migrateLfZeroTotals()', '\n\n// ══');
  ok(src.includes('migrateLfZeroTotals(); // v255 (B4)'), 'wired at boot');
  ok(src.includes('migrateLfZeroTotals(); // v255 (B4): retried too'), 'wired at the refresh retry');
  const run = (invs, flags = {}) => {
    const writes = [];
    const DB = {
      _firestoreReady: flags.ready !== false,
      _loadConfirmed: flags.confirmed !== false,
      a: () => invs,
      updateFields: (k, id, patch) => { writes.push({ id, patch }); return true; },
    };
    new Function('DB', 'console', mig + '\nmigrateLfZeroTotals();')(DB, { log: () => {} });
    return writes;
  };
  const w1 = run([
    { id: 'z', total: 0, lineItems: [{ lineTotal: 60 }, { total: 30.5 }] },
    { id: 'good', total: 150, lineItems: [{ lineTotal: 150 }] },
    { id: 'empty', total: 0, lineItems: [] },
    { id: 'zerolines', total: 0, lineItems: [{ lineTotal: 0 }] },
  ]);
  ok(w1.length === 1 && w1[0].id === 'z' && w1[0].patch.total === 90.5 && w1[0].patch.amount === 90.5,
    'repairs ONLY the $0-with-lines row, recomputing total+amount from lines');
  ok(run([{ id: 'z', total: 0, lineItems: [{ lineTotal: 10 }] }], { confirmed: false }).length === 0,
    'never runs on an unconfirmed boot load (v252 seed-guard discipline)');
  ok(run([{ id: 'z', total: 90.5, lineItems: [{ lineTotal: 90.5 }] }]).length === 0,
    'idempotent: a repaired row never matches again');
}

console.log('[F] B5 / B6 / B8');
{
  const fl = slc(src, 'function flSaveContact(id)', '\nfunction flMarkReviewed');
  ok(/const prim = contacts\.find\(c => c\.isPrimary\) \|\| contacts\[0\] \|\| \{\};/.test(fl)
     && /contact: prim\.name \|\| '', phone: prim\.phone \|\| '', email: prim\.email \|\| ''/.test(fl),
    'field-log contact save refreshes the FLAT account fields from the primary (B5)');
  ok((src.match(/v255 \(B6\): legacy purpl child/i) ? true : false)
     && (src.match(/\(cache\.iv\|\|\[\]\)\.findIndex\(x => x\.id === rec\.purplInvoiceId\)/g) || []).length >= 3,
    'send, edit AND void all reach a legacy iv purpl child (B6; markCombinedPaid had it already)');
  ok(src.includes('A sample box already shipped to this account on')
     && src.includes('_manualSamplePushBusy'),
    'manual sample re-ship warns about the previous box and is single-flight (B8)');
}

console.log('[G] B9 — post-sign-out save hygiene');
{
  ok(/_saveCollection\(key\) \{\s*\n\s*if \(!this\._db \|\| !this\._firestoreReady\) return;/.test(dbSrc),
    '_saveCollection refuses after teardown');
  const sc = slc(dbSrc, '_saveConfig(keys) {', 'const { setDoc }');
  ok(sc.includes('if (!this._db || !this._firestoreReady) return;'),
    '_saveConfig refuses after teardown (retry timers + atomic flush path)');
  const td = slc(dbSrc, '_teardownListeners() {', '\n  },');
  ok(td.includes('this._saveTimers = {};') && td.includes('_saveDirtyKeys.clear()')
     && td.includes('clearTimeout(this._applyPendingRetry)'),
    'teardown parks the save machinery (timers + dirty keys)');
  ok(authSrc.includes('DB._flushPendingSave()'),
    'sign-out flushes unsaved edits to the recovery snapshot first');
}

console.log('[H] v254 nits + login form');
{
  const sweep = fnSrc.slice(fnSrc.indexOf('exports.samplingDailySweep'));
  ok((sweep.match(/const _r = await resend\.emails\.send\(\{/g) || []).length === 3,
    'all three sweep sends capture the Resend result');
  ok((sweep.match(/if \(_r\.error\) \{ console\.error\('Sweep send rejected/g) || []).length === 3,
    'all three stamps are gated — a rejected sweep email retries tomorrow');
  ok(src.includes('unsubscribed or already sent this subject'),
    'broadcast summary labels both skip reasons');
  ok(/<form id="auth-form"[\s\S]{0,500}auth-password[\s\S]{0,300}<\/form>/.test(idxSrc)
     && idxSrc.includes('id="sign-in-btn" type="button"'),
    'login credentials live in a real <form> (Chrome nit, Enter-to-sign-in)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
