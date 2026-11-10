// Wave 31 backtests — v259: the pre-invite review patch set. Two independent
// deep reviews (data layer + field surface) ran before opening multi-user;
// this wave closes their findings: second-order XSS sinks (repName via
// review actions), pay-apply honesty (no stamp without a real flip, no LF
// un-toggle), field-log listener death recovery, not-found fallback
// resurrection, sign-out with queued entries, initUserRole re-mint
// escalation, and rules type guards on identity/metadata fields.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(__dirname, '../../public/auth.js'), 'utf8');
const fld = fs.readFileSync(path.join(__dirname, '../../public/field.html'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + second-order XSS sinks (surface F1)');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  ok(src.includes('${escHtml(c.method||\'—\')}</td><td>${escHtml(c.sentBy||\'—\')}'),
    'Email History escapes sentBy/method (rep-originated via Add-to-history)');
  ok(src.includes("${escHtml(n.author||'you')}"), 'account notes escape the author (rep via create-prospect→convert)');
  ok(src.includes('${escHtml(n.nextAction)}'), 'note nextAction escaped (depth)');
  ok(src.includes("String(l.createdAt || '').slice(0, 10)")
     && !src.includes("(l.createdAt || '').slice(0, 10)`"),
    'createdAt coerced before slice — a numeric value no longer blanks the queues (surface F3)');
}

console.log('[B] pay-apply honesty (data F1)');
{
  const q = slc(src, "if (col === 'lf_invoices') {", "if (_ok !== true) return;");
  ok(/_cur && _cur\.status === 'paid'\) \? true : markLfInvPaid\(invId\);/.test(q),
    'an already-paid LF invoice is a no-op success — never un-toggled from pay-apply');
  ok(src.includes('if (_ok !== true) return;'), 'stamp requires a REAL true (undefined early-exits no longer pass)');
  ok(src.includes("if (!DB._firestoreReady) return false; // v259")
     && src.includes("if (!inv) return false; // v259")
     && src.includes("if (!rec) return false; // v259"),
    'all three mark-paid early exits return false');
}

console.log('[C] field-log listener recovery (data F2) + fallback honesty');
{
  ok(src.includes('window._flUnsub = firebase.firestore()') && authSrc.includes('window._flUnsub()'),
    'listener handle window-scoped; sign-out tears it down');
  ok(/Field log listener error — resubscribing in 15s/.test(src)
     && /window\._flResub = setTimeout\(\(\) => \{ if \(firebase\.auth\(\)\.currentUser\) _listenFieldLogs\(\); \}, 15000\);/.test(src),
    'a dead stream resubscribes instead of freezing the approval queues forever');
  ok(src.includes('This invoice no longer exists (deleted on another device?)'),
    '_saveInvCore refuses honestly instead of the dead same-cache fallback (data F7)');
  // db.js: not-found drops instead of resurrecting from a frozen stale cache
  const uf = slc(dbSrc, '  updateFields(k, id, patch) {', '\n  atomicUpdateFields(');
  ok(/e\?\.code === 'not-found'/.test(uf) && uf.includes('write dropped'),
    'updateFields not-found → dropped + toast, never a stale full-doc resurrection (data F3)');
  ok(uf.includes('if (!this._db || !this._firestoreReady) return true;')
     && dbSrc.includes("atomicUpdateFields(fn) {\n    if (!this._db || !this._firestoreReady) return; // v259"),
    'both field-targeted writers carry the post-sign-out guard (data F6)');
  // Run the REAL updateFields: not-found must NOT trigger the full write
  const calls = { full: [], targeted: [] };
  const DBst = {
    _cache: { ac: [{ id: 'a1', name: 'S', phone: 'old' }] },
    _db: {}, _firestoreReady: true,
    a(k) { return this._cache[k] || []; },
    _save() {}, _drainDeferred() {}, _updateSyncUI() {}, _dirtyIds: {},
    _markDocDirty() {}, _writeDoc(k, item) { calls.full.push(item.id); },
    _collRef: () => ({ doc: () => ({ update: (p) => { calls.targeted.push(p); return Promise.reject({ code: 'not-found' }); } }) }),
  };
  const fn2 = new Function('COLLECTION_KEYS', 'return {' + uf + '\n}').call(null, ['ac']); // newline: uf ends in a comment line
  Object.assign(DBst, fn2);
  DBst.updateFields('ac', 'a1', { phone: 'new' });
  setTimeout(() => {
    ok(calls.targeted.length === 1 && calls.full.length === 0,
      'DYNAMIC: not-found rejection drops the write — zero full-doc resurrection');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }, 20);
}

console.log('[D] field app + provisioning + rules');
{
  ok(/HAVEN'T SYNCED yet\. Signing out now will LOSE them/.test(fld)
     && /myLogs\.filter\(\(l\) => l\._pending\)\.length/.test(fld),
    'sign-out warns loudly when offline entries are still queued (data F4)');
  ok(fnSrc.includes("(isFirstUser || isFallbackAdmin) ? 'admin' : 'field';"),
    "initUserRole re-mint defaults to 'field' — a deleted doc + lingering allowlist entry can no longer escalate to employee (surface F2)");
  const cr = slc(rules, 'match /field_logs/{logId}', 'allow delete: if isAdmin();');
  ok(cr.includes('request.resource.data.createdAt is string'), 'rules: createdAt must be a string');
  ok(cr.includes('repName is string') && cr.includes('repEmail is string')
     && (cr.match(/\.type is string|data\.type is string/) ? true : cr.includes('request.resource.data.type is string')),
    'rules: repName/repEmail/type guarded at create (emulator-proven, 45/45)');
  const emuRules = fs.readFileSync(path.join(__dirname, '../../tests/emu/firestore.rules'), 'utf8');
  ok(emuRules === rules, 'emulator rules copy in sync');
  // Surface F4: duplicate SKU rows aggregate on the invoice prefill
  ok(/_agg\[i\.sku\] = \(_agg\[i\.sku\] \|\| 0\) \+ \(parseInt\(i\.cases, 10\) \|\| 0\);/.test(src),
    'restock prefill aggregates duplicate SKUs (2+3 = 5, surface F4)');
}
