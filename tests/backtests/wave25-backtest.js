// Wave 25 backtests — v253 multi-user Tier 2:
// (1) keyed modal freeze — an open edit form defers only the collections it
//     writes, instead of freezing the whole tab's live updates;
// (2) diff-based saves on all remaining invoice edit paths (purpl modal, LF
//     modal, preview shell, combined edit) — an untouched field never reaches
//     the server, so concurrent changes (webhook paid stamps, the other
//     user's edits) survive a stale form save;
// (3) audit coverage — changedByUid + entries on every money/stock flip, and
//     the single-invoice Void gains the admin gate + audit that combined had.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };
const fnSlice = (name, end) => slc(src, name, end);

console.log('[A] version + keyed freeze (dynamic, real db.js methods)');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);

  // Run the REAL markDirty/_frozen/_frozenCfg against a stub COLLECTION_KEYS.
  const body = slc(dbSrc, '  markDirty(keys) {', '  markClean()');
  const o = new Function('COLLECTION_KEYS',
    'return {_dirty:false,' + body + '}')(['ac', 'retail_invoices', 'lf_invoices']);
  o.markDirty();
  ok(o._frozen('ac') && o._frozen('retail_invoices') && o._frozenCfg(),
    'markDirty() with no keys = legacy freeze-everything');
  o.markDirty(['ac']);
  ok(o._frozen('ac') && !o._frozen('retail_invoices') && !o._frozenCfg(),
    'markDirty([ac]) freezes ONLY ac — invoices and config stay live');
  o.markDirty(['lf_invoices', 'lf_wix_deductions']);
  ok(o._frozen('lf_invoices') && !o._frozen('ac') && o._frozenCfg(),
    'a config-resident key (lf_wix_deductions) freezes the config doc too');
  o._dirty = false;
  ok(!o._frozen('ac') && !o._frozenCfg(), 'clean = nothing frozen');

  // Guard sites actually use the keyed checks.
  ok((dbSrc.match(/this\._frozen\(key\)/g) || []).length >= 4,
    'collection listener/drain/fallback guards are keyed');
  ok((dbSrc.match(/this\._frozenCfg\(\)/g) || []).length >= 3,
    'config listener/drain guards are keyed');
  ok(dbSrc.includes('if (this._dirty === true || this._atomicInProgress) return;'),
    'drain only fully bails on the legacy freeze-everything state');
}

console.log('[B] openModal freeze map');
{
  const map = slc(src, 'const MODAL_FREEZE_KEYS = {', '};');
  ['modal-edit-account', 'modal-add-inv', 'modal-new-combined'].forEach(id =>
    ok(map.includes(`'${id}'`), `${id} mapped`));
  ok(map.includes("'modal-lf-invoice'") && map.includes("'modal-combined-invoice'"),
    'the two NEVER-frozen modals (LF edit + preview shell) are now covered');
  ok(/'modal-edit-account':\s*\['ac'\]/.test(map),
    'account modal freezes only ac — the whole-tab freeze is gone');
  const om = fnSlice('function openModal(id) {', '\nfunction closeModal');
  ok(om.indexOf('DB.markClean()') > -1 && om.indexOf('DB.markClean()') < om.indexOf('markDirty'),
    'opening a modal over another clears the old freeze first (leak fixed)');
  ok(/MODAL_FREEZE_KEYS\[id\]/.test(om) && /DB\.markDirty\(\)/.test(om),
    'mapped modals freeze their keys; unmapped edit modals keep legacy freeze-all');
}

console.log('[C] diff-based saves');
{
  // purpl modal
  const pv = slc(src, "const _invNum = number || existing?.invoiceNumber", 'async function deleteInvRecord');
  ok(/DB\.updateFields\(_invoiceCol\(id\), id, _patch\)/.test(pv),
    'purpl modal edit writes only changed fields');
  ok(pv.indexOf('updateInvoice(id, () => rec)') > pv.indexOf('DB.updateFields'),
    'whole-record write survives only as the fallback');
  // LF modal
  const lf = slc(src, "if (isNew) DB.push('lf_invoices', rec);", '// Generate or refresh Wix pull deduction record');
  ok(/DB\.updateFields\('lf_invoices', id, _patch\)/.test(lf),
    'LF modal edit writes only changed fields');
  // preview shell
  ok(/const _applyEdit = x => \{/.test(src) && /DB\.updateFields\(col, id, _p\)/.test(src),
    'preview-shell edit computes from frozen cache and writes only changes');
  // combined edit + combined paid use the field-level atomic variant
  ok((src.match(/DB\.atomicUpdateFields\(/g) || []).length >= 2,
    'combined edit AND combined mark-paid use atomicUpdateFields');

  // Run the REAL atomicUpdateFields against a stub DB.
  const au = slc(dbSrc, '  atomicUpdateFields(fn) {', '\n  atomicUpdate(fn) {');
  const calls = { fields: [], full: [] };
  const DBst = {
    _cache: {
      ac: [{ id: 'a1', name: 'Store', phone: '111', status: 'active' }],
      iv: [{ id: 'v1', qty: 5 }],
    },
    _atomicInProgress: false,
    _stamp(x) { return x; },
    _markDocDirty() {}, _save() {}, _drainDeferred() {},
    _writeDoc(k, item) { calls.full.push({ k, id: item.id }); },
    updateFields(k, id, patch) { calls.fields.push({ k, id, patch }); return true; },
  };
  const fn = new Function('COLLECTION_KEYS', 'return {' + au + '}')(['ac', 'iv']);
  DBst.atomicUpdateFields = fn.atomicUpdateFields.bind(Object.assign(DBst));
  DBst.atomicUpdateFields(cache => {
    cache.ac[0] = { ...cache.ac[0], phone: '222' };          // change ONE field
    cache.iv.push({ id: 'v2', qty: 3 });                      // add a doc
  });
  ok(calls.fields.length === 1 && calls.fields[0].id === 'a1'
     && Object.keys(calls.fields[0].patch).join() === 'phone',
    'changed doc → ONLY the changed field is written');
  ok(calls.full.length === 1 && calls.full[0].id === 'v2',
    'added doc → written whole; untouched docs → not written at all');
  ok(DBst._atomicInProgress === false, 'atomic flag released');
}

console.log('[D] audit coverage + void gates');
{
  ok(src.includes('changedByUid:'), 'audit entries carry the uid');
  const audited = [
    ['function markPaid(id) {', "auditLog('paid'"],
    ['function markRetailInvPaid(id) {', "auditLog('paid'"],
    ['function markLfInvPaid(id) {', 'auditLog(newStatus'],
    ['function markCombinedPaid(combinedId) {', "auditLog('paid', 'combined_invoice'"],
    ['function markDistInvoicePaid(invId, distId) {', "auditLog('paid', 'dist_invoice'"],
    ['async function markInvoiceSent(id) {', "auditLog('sent', 'invoice'"],
    ['function setInvStatus(id, status) {', "auditLog('status', 'order'"],
    ['function poolTransfer() {', "auditLog('stock_transfer'"],
    ['function receiveLooseCans() {', "auditLog('stock_receive'"],
    ['function receiveFinishedPacks() {', "auditLog('stock_receive'"],
    ['async function poToggleSent(id) {', 'auditLog(toSent'],
    ['async function declinePortalOrder(id) {', "auditLog('portal_declined'"],
    ['async function confirmPortalOrder() {', "auditLog('portal_confirmed'"],
  ];
  audited.forEach(([anchor, call]) => {
    const i = src.indexOf(anchor);
    const seg = src.slice(i, src.indexOf('\nfunction ', i + 10) + 1 || i + 4000);
    ok(i >= 0 && seg.includes(call), anchor.replace(/function |async |\(.*/g, '') + ' audited');
  });
  // combined + lf email sends audited
  ok(src.includes("auditLog('send', 'combined_invoice'"), 'combined email send audited');
  ok(src.includes("type === 'dist' ? 'dist_invoice' : 'lf_invoice'"), 'LF shell send audited');

  // Void gates — anchor on the v253 admin-visibility line (unique to the
  // single-invoice shell; the combined shell has its own pre-existing gate).
  const _vi = src.indexOf("voidBtn.style.display = (st === 'void') ? 'none' : (_isAdmin() ? '' : 'none');");
  const voidBlk = src.slice(_vi, _vi + 900);
  ok(_vi >= 0 && voidBlk.includes("_requireAdmin('void invoices')") && voidBlk.includes("auditLog('void'"),
    'single-invoice Void is admin-gated AND audited (parity with combined)');
  ['function markPaid(id) {', 'function markRetailInvPaid(id) {', 'function markLfInvPaid(id) {', 'function markDistInvoicePaid(invId, distId) {']
    .forEach(anchor => {
      const i = src.indexOf(anchor);
      const seg = src.slice(i, i + 1200);
      ok(seg.includes('voided — recreate'), anchor.replace(/function |\(.*/g, '') + ' refuses to resurrect a voided invoice');
    });
  // Paid flips are field-targeted now
  ok((src.match(/DB\.updateFields\((_col|'lf_invoices'|'dist_invoices'|'orders')/g) || []).length >= 4,
    'money-state flips write only their own fields');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
