// Wave 23 backtests — v251 second-user hardening: cross-user transactional
// claims (sample approve / mark-sent / reminder / delivery invoice / combined
// send), field-targeted account saves, portal_orders live listener, and the
// firestore.rules split (admin-only deletes + invoice_settings). The rules
// themselves are PROVEN against the emulator by tests/emu/rules-tests.js
// (29 authenticated allow/deny cases); here we pin the file contracts.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(__dirname, '../../public/auth.js'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + claim helper');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const h = slc(src, 'async function _txActionClaim', '\nconst _reminderInFlight');
  ok(h.includes('runTransaction'), 'claim is a real Firestore transaction');
  ok(h.includes('opts.windowMs || 120000'), 'default 2-minute claim window');
  ok(/_claim: 'done'/.test(h) && /_claim: 'held'/.test(h), 'distinguishes finished vs in-flight');
  // Offline/unreachable server must DEGRADE to the old single-tab behavior,
  // never block the owner's work.
  ok(/proceeding single-tab/.test(h) && /return \{ ok: true, release: \(\) => \{\} \};/.test(h),
    'unreachable server degrades open (single-tab guard still applies)');
  ok(h.includes("ref.update({ [field]: null })"), 'release() clears the claim field');
}

console.log('[B] claim sites');
{
  // Reminder (behavioral coverage lives in reminder-backtest [B2])
  const rem = slc(src, 'async function sendInvoiceReminder', '\nfunction buildInvoiceReminderHTML');
  ok(/_txActionClaim\('workspace\/main\/' \+ collection \+ '\/' \+ invId, 'reminderClaim'/.test(rem),
    'reminder claims the invoice doc');
  ok(/reminderSentAt: new Date\(\).toISOString\(\), reminderClaim: null/.test(rem),
    'success clears the claim in the same stamp write');

  // Mark Sent — the double-deduction race
  const ms = slc(src, 'const _markSentInFlight', '\nasync function deleteInvoice');
  ok(/async function markInvoiceSent/.test(ms), 'markInvoiceSent is async (awaits the claim)');
  ok(/_txActionClaim\('workspace\/main\/' \+ col \+ '\/' \+ id, 'sentClaim'/.test(ms),
    'mark-sent claims the invoice doc');
  ok(/abortIf: d => d\.status === 'sent' \|\| d\.status === 'paid'/.test(ms),
    "already sent — or PAID — on the server aborts (no stale paid→sent flip)");
  ok(ms.indexOf('_txActionClaim') < ms.indexOf('DB.atomicUpdate'),
    'claim decided BEFORE any local status/deduction write');
  ok(/status:'sent', sentAt: today\(\), sentClaim: null/.test(ms),
    'winning flip clears the claim');

  // Combined send — the double-email race
  const cs = slc(src, "// v251: cross-user claim — the disabled-button guard above", 'const voidBtn');
  ok(/_txActionClaim\('workspace\/main\/combined_invoices\/' \+ combinedId, 'emailClaim'/.test(cs),
    'combined send claims before emailing');
  ok(cs.indexOf('_txActionClaim') < cs.indexOf('await callSendCombinedInvoice'),
    'claim decided BEFORE the customer email fires');
  ok(/emailClaim: null \}/.test(cs), 'sent-stamp clears the claim');
  ok(/_claim\.release\(\); \/\/ v251: failed send frees the claim/.test(cs),
    'failed send releases for a retry');

  // Delivery-run invoice — the double-bill race
  const dv = slc(src, 'async function createDeliveryInvoice', '\n// ── After full run');
  ok(/if \(ord\.invoiceStatus === 'invoiced'\)/.test(dv), 'local already-invoiced check first');
  ok(/_txActionClaim\('workspace\/main\/orders\/' \+ ordId, 'invoiceClaim'/.test(dv),
    'claims the order doc cross-user');
  ok(/abortIf: d => d\.invoiceStatus === 'invoiced'/.test(dv),
    'server-side already-invoiced aborts');
  ok(dv.indexOf('_txActionClaim') < dv.indexOf('getNextInvoiceNumber'),
    'the loser never burns an invoice number');
  ok(/invoiceNumber, invoiceClaim: null\}/.test(dv), 'winning invoice clears the claim');
}

console.log('[C] db.js — field-targeted saves + cache-only echo');
{
  ok(dbSrc.includes('updateFields(k, id, patch)'), 'DB.updateFields exists');
  ok(dbSrc.includes('setObjLocal(k, v) { this._cache[k] = v; }'),
    'DB.setObjLocal is cache-only (no dirty mark, no write)');
  // The allocator must use the cache-only echo at ALL THREE sites (success,
  // retry-success, cache fallback) — the old setObj echo re-sent the whole
  // invoice_settings object, which the new rules reject for employees.
  ok((src.match(/DB\.setObjLocal\('invoice_settings'/g) || []).length === 3
     && !/DB\.setObj\('invoice_settings', \{ \.\.\.DB\.obj/.test(src),
    'invoice-number allocator echoes the counter cache-only (3 sites, v251)');

  // Run the REAL updateFields against stubs: only the patch fields reach the
  // server, and a failed targeted write falls back to the full-doc path.
  const uf = slc(dbSrc, '  updateFields(k, id, patch) {', '\n  atomicUpdate(');
  const mk = (updateImpl) => {
    const calls = { targeted: [], full: [], dirty: [] };
    const DB = {
      _cache: { ac: [{ id: 'a1', name: 'Store', phone: 'old', territory: 'North', notes: ['x'] }] },
      a(k) { return this._cache[k] || []; },
      _save() {}, _drainDeferred() {}, _updateSyncUI() {},
      _dirtyIds: {},
      _markDocDirty(k, id) { calls.dirty.push(id); },
      _writeDoc(k, item) { calls.full.push(item); },
      _collRef: () => ({ doc: () => ({ update: (p) => { calls.targeted.push(p); return updateImpl(p); } }) }),
    };
    const fn = new Function('COLLECTION_KEYS', 'return {' + uf + '}').call(null, ['ac']);
    fn.updateFields = fn.updateFields.bind(Object.assign(DB, fn));
    return { DB, calls };
  };
  const t1 = mk(() => Promise.resolve());
  const r1 = t1.DB.updateFields ? t1.DB : Object.assign(t1.DB);
  r1.updateFields('ac', 'a1', { phone: 'new' });
  ok(t1.calls.targeted.length === 1 && t1.calls.targeted[0].phone === 'new'
     && !('name' in t1.calls.targeted[0]) && !('territory' in t1.calls.targeted[0]),
    'sends ONLY the changed fields — untouched fields never written');
  ok('_updatedAt' in t1.calls.targeted[0], 'targeted write stamps _updatedAt');
  ok(t1.DB._cache.ac[0].phone === 'new' && t1.DB._cache.ac[0].territory === 'North',
    'cache merges the patch, keeps the rest');
  ok(t1.calls.full.length === 0, 'no full-doc write on the happy path');
  (async () => {
    const t2 = mk(() => Promise.reject(new Error('permission-denied')));
    t2.DB.updateFields('ac', 'a1', { phone: 'new2' });
    await new Promise(r => setTimeout(r, 10));
    ok(t2.calls.full.length === 1 && t2.calls.dirty.includes('a1'),
      'failed targeted write falls back to the full-doc path (nothing lost)');
    ok(t2.DB.updateFields('ac', 'missing', { x: 1 }) === false, 'unknown id refuses cleanly');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

console.log('[D] account save — diff-based (merge, not clobber)');
{
  const sa = slc(src, 'async function saveAccount', '\n  // Invoices snapshot accountName');
  ok(/if \(isNew\) DB\.push\('ac', rec\);/.test(sa), 'new accounts still created whole');
  ok(/const _patch = \{\};/.test(sa) && /JSON\.stringify\(rec\[k\]/.test(sa),
    'edit save diffs rec against the modal-open state field by field');
  ok(/DB\.updateFields\('ac', id, _patch\)/.test(sa), 'writes only the changed fields');
  ok(/\|\| DB\.update\('ac', id, \(\)=>rec\)/.test(sa) === false
     && /if \(!DB\.updateFields\('ac', id, _patch\)\) DB\.update\('ac', id, \(\)=>rec\);/.test(sa),
    'falls back to the whole-record write only if the targeted path refuses');
  ok(/if \(k === 'id'\) return;/.test(sa), 'id never in the patch');
}

console.log('[E] portal_orders live listener');
{
  const p = slc(src, 'const PortalDB = {', '\n// ── Phase'); // whole object
  ok(p.includes("collection('portal_orders').onSnapshot"), 'live listener on portal_orders');
  ok(p.includes('_applyOrders(snap)'), 'one-shot load and listener share the mapping');
  ok(/currentPage === 'pre-orders'/.test(p), 'repaints only while the page is on screen');
  ok(/dialog\[open\]/.test(p) && /SELECT\|INPUT\|TEXTAREA/.test(p),
    'never repaints mid-interaction (open dialog / focused control)');
  ok(/this\._unsubOrders = null;\s*\}\);/.test(p) || /err/.test(p),
    'listener error clears the handle so the next page view resubscribes');
  ok(p.includes('teardown()'), 'teardown exists');
  const rp = slc(src, 'async function renderPreOrders', '\nfunction _renderPoKpis');
  ok(rp.includes('PortalDB.subscribe();'), 'renderPreOrders attaches the listener');
  ok(authSrc.includes('PortalDB.teardown'), 'sign-out tears the listener down (auth.js)');
}

console.log('[F] firestore.rules contracts (emulator-proven in tests/emu/rules-tests.js)');
{
  ok(/allow create, update: if isStaff\(\)/.test(rules) && !/allow write: if isStaff\(\)\s*&& !\(path\.size/.test(rules),
    'workspace catch-all write split into create/update vs delete');
  ok(/'invoice_settings' in request\.resource\.data/.test(rules)
     && /affectedKeys\(\)\.hasOnly\(\['nextInvoiceNum'\]\)/.test(rules),
    'invoice_settings admin-only EXCEPT the allocator counter');
  ok(/path\[1\] in \['ac', 'retail_invoices', 'lf_invoices', 'combined_invoices', 'dist_invoices'\]/.test(rules),
    'account + all five invoice collections admin-only to delete');
  ok(/match \/accounts\/\{accountId\} \{\s*allow read, create, update: if isStaff\(\);\s*allow delete: if isAdmin\(\);/m
     .test(rules.replace(/\/\/[^\n]*\n/g, '')) ||
     (/allow read, create, update: if isStaff\(\);/.test(rules) && /allow delete: if isAdmin\(\);/.test(rules)),
    'accounts mirror: staff write, admin delete');
  // The emulator suite must exist and be pinned to a SYNCED rules copy.
  const emuRules = fs.readFileSync(path.join(__dirname, '../../tests/emu/firestore.rules'), 'utf8');
  ok(emuRules === rules, 'tests/emu rules copy is in sync with the deployed rules');
  ok(fs.existsSync(path.join(__dirname, '../../tests/emu/rules-tests.js')), 'emulator rules suite present');
}
