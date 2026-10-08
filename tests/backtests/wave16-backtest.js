// Wave 16 backtests — v239 doors: per-invoice "Deliver to" for multi-location
// accounts. One account (money/Owes whole), one door choice per invoice,
// DENORMALIZED at save; printed DELIVER TO block; ShipStation ships to the door.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] structural — markup + wiring');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  ['iv', 'lfi', 'nciv'].forEach(p => {
    ok(html.includes(`id="${p}-door-row"`) && html.includes(`id="${p}-door"`), `${p}: door row + select in markup`);
  });
  ok(/id="lfi-account" onchange="_doorRowSync\('lfi', this\.value\)"/.test(html),
    'LF account select re-syncs the door row on change');
  // Modal opens prefill from the saved stamp; account-change handlers re-sync.
  ok(/_populateAccountSelect\('iv-account'[\s\S]{0,200}_doorRowSync\('iv', inv\?\.accountId \|\| prefillAccountId \|\| '', inv\?\.deliverTo \|\| null\)/.test(src),
    'purpl modal open syncs door row with the invoice stamp');
  ok(/_populateAccountSelect\('lfi-account'[\s\S]{0,200}_doorRowSync\('lfi', inv\?\.accountId \|\| '', inv\?\.deliverTo \|\| null\)/.test(src),
    'LF modal open syncs door row with the invoice stamp');
  ok(/function ivAccountChange\(\) \{[\s\S]{0,200}_doorRowSync\('iv', acId\)/.test(src),
    'purpl account change re-syncs (stamp dropped — new account)');
  ok(/function ncivAccountChanged\(\) \{[\s\S]{0,120}_doorRowSync\('nciv'/.test(src),
    'combined account change re-syncs');
  ok(/openNewCombinedModal[\s\S]{0,400}_doorRowSync\('nciv', '', null\)/.test(src),
    'new-combined open resets the door row');
  ok(/qs\('#nciv-account'\)\.value = rec\.accountId \|\| '';\s*_doorRowSync\('nciv', rec\.accountId \|\| '', rec\.deliverTo \|\| null\)/.test(src),
    'combined EDIT prefills the door row from the parent stamp');
}

console.log('[A2] structural — stamps on every save path');
{
  const ivRec = slc(src, 'const _invNum = number || existing?.invoiceNumber', 'if (_isNew) {');
  ok(ivRec.includes("deliverTo:    _doorStamp('iv', accountId)"), 'purpl save stamps deliverTo');
  const lfRec = slc(src, 'const rec = {\n    ...(existing||{}),\n    id: saveId, number, invoiceNumber: number,', 'if (isNew) DB.push');
  ok(lfRec.includes("deliverTo: _doorStamp('lfi', accountId)"), 'LF save stamps deliverTo');
  const combEdit = slc(src, 'if (_editingCombinedId) {', '_editingCombinedId = null;');
  ok(/const shared = \{[\s\S]{0,220}deliverTo: _doorStamp\('nciv', accountId\)/.test(combEdit),
    'combined EDIT writes the stamp into parent AND both children (shared)');
  const combCreate = slc(src, 'const purplNum = combNum + ', 'DB.atomicUpdate(cache => {');
  ok(combCreate.includes("const deliverTo = _doorStamp('nciv', accountId)"), 'combined CREATE reads the stamp once');
  ok((combCreate.match(/trackingNumber, deliverTo,/g) || []).length === 3,
    'combined CREATE carries the stamp on parent + purpl child + LF child');
}

console.log('[A3] structural — print + ShipStation');
{
  const doc = slc(src, '>Billed To</div>', 'Invoice Details</div>');
  ok(doc.includes('Deliver To') && doc.includes('o.deliverTo.label || o.deliverTo.address'),
    'invoice document renders the DELIVER TO block');
  ok(/o\.warehouseCopy && o\.deliverTo\.dropOffRules/.test(doc),
    'drop-off rules print on the WAREHOUSE copy only (not customer-facing)');
  ok((doc.match(/escHtml\(/g) || []).length >= 4, 'deliver-to fields are HTML-escaped');
  // All four wrappers feed deliverTo into the shared template.
  ok(src.includes('deliverTo: rec.deliverTo || purplInv.deliverTo || lfInv.deliverTo || null'),
    'combined print wrapper passes the stamp (parent, child fallback)');
  ok(src.includes('deliverTo: inv.deliverTo || purplChild?.deliverTo || lfChild?.deliverTo || null'),
    'combined email wrapper passes the stamp');
  ok((src.match(/deliverTo: inv\.deliverTo \|\| null,/g) || []).length === 2,
    'purpl + LF wrappers pass the stamp');
  const push = slc(src, 'async function pushInvoiceToShipStation', 'const d = result.data');
  ok(/const door = \(inv\.deliverTo && inv\.deliverTo\.address\) \? inv\.deliverTo : null/.test(push),
    'push resolves the door (address required)');
  ok(/door\s*\? _shipAddrFor\(\{ addrParts: door\.addrParts, address: door\.address \}\)/.test(push),
    'door address becomes the structured ship-to (autocomplete parts preferred)');
  ok(/door\.label \? ' — ' \+ door\.label : ''/.test(push), 'ship-to name carries "Account — Store"');
  ok(/\(door && door\.phone\) \|\| ac\.phone/.test(push), 'door phone preferred for the ship-to');
  ok(/if \(!door && !ac\.address && !ac\.shipAddress\)/.test(push),
    'no-address guard lets a door-stamped invoice through');
}

console.log('[B] dynamic — helpers against stub DOM/DB');
{
  // Extract the three door helpers and run them with stubs.
  const helpers = slc(src, '// ── Doors (v239):', 'function _renderAccountSelectOptions');
  const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const mkSel = () => {
    const s = {
      value: '', _doorStamped: null, _html: '', _opts: [],
      style: {},
      get options() { return this._opts.map(v => ({ value: v })); },
    };
    Object.defineProperty(s, 'innerHTML', {
      get() { return this._html; },
      set(h) {
        this._html = h;
        this._opts = [...h.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
        if (!this._opts.includes(this.value)) this.value = '';
      },
    });
    return s;
  };
  const makeEnv = (locs) => {
    const row = { style: { display: 'none' } };
    const sel = mkSel();
    const DB = { a: (k) => k === 'ac' ? [{ id: 'A1', name: 'BuyerCo', locs }] : [] };
    const document = { getElementById: (id) => id.endsWith('-door-row') ? row : id.endsWith('-door') ? sel : null };
    const fns = new Function('DB', 'document', 'escHtml', helpers + '\nreturn { _acDoors, _doorRowSync, _doorStamp };')(DB, document, escHtml);
    return { row, sel, ...fns };
  };
  const twoDoors = [
    { id: 'L1', label: 'Village Market', address: '1 Main St, Keene, NH', addrParts: { street1: '1 Main St', city: 'Keene', state: 'NH', zip: '03431' }, contact: 'Sue', phone: '603-1', dropOffRules: 'Back door before 10am' },
    { id: 'L2', label: 'Hillside Store', address: '9 Hill Rd, Dublin, NH', addrParts: null, contact: '', phone: '', dropOffRules: '' },
  ];

  // D1: single-location account → hidden, stamp null
  {
    const e = makeEnv([twoDoors[0]]);
    e._doorRowSync('iv', 'A1', null);
    ok(e.row.style.display === 'none' && e.sel.innerHTML === '', 'D1: one location → picker hidden');
    ok(e._doorStamp('iv', 'A1') === null, 'D1: hidden picker stamps null (account address)');
  }
  // D2: two doors → blank + both; choosing one freezes the full stamp
  {
    const e = makeEnv(twoDoors);
    e._doorRowSync('iv', 'A1', null);
    ok(e.row.style.display === '' && e.sel.options.length === 3, 'D2: two doors → blank + 2 options');
    ok(e.sel.innerHTML.includes('Village Market') && e.sel.innerHTML.includes('Hillside Store'), 'D2: labels shown');
    e.sel.value = 'L1';
    const st = e._doorStamp('iv', 'A1');
    ok(st && st.locId === 'L1' && st.address === '1 Main St, Keene, NH' && st.addrParts.city === 'Keene'
      && st.contact === 'Sue' && st.phone === '603-1' && st.dropOffRules === 'Back door before 10am',
      'D2: stamp freezes label/address/parts/contact/phone/rules');
    e.sel.value = '';
    ok(e._doorStamp('iv', 'A1') === null, 'D2: blank choice stamps null');
  }
  // D3: edit mode with a since-deleted door → synthetic option keeps the stamp
  {
    const e = makeEnv(twoDoors);
    const old = { locId: 'GONE', label: 'Closed Door', address: '5 Old Rd', addrParts: null, contact: '', phone: '', dropOffRules: '' };
    e._doorRowSync('iv', 'A1', old);
    ok(e.sel.options.some(o => o.value === 'GONE') && e.sel.innerHTML.includes('(saved on invoice)'),
      'D3: removed door appears as "(saved on invoice)"');
    ok(e.sel.value === 'GONE', 'D3: the saved door stays selected');
    const st = e._doorStamp('iv', 'A1');
    ok(st && st.locId === 'GONE' && st.label === 'Closed Door', 'D3: routine edit re-saves the stamp VERBATIM');
  }
  // D4: stamped door still live → selected from the live list, restamped fresh
  {
    const e = makeEnv(twoDoors);
    e._doorRowSync('iv', 'A1', { locId: 'L2', label: 'Hillside Store', address: 'old addr' });
    ok(e.sel.value === 'L2' && !e.sel.innerHTML.includes('(saved on invoice)'),
      'D4: live stamped door selected without a synthetic option');
    ok(e._doorStamp('iv', 'A1').address === '9 Hill Rd, Dublin, NH',
      'D4: re-save refreshes the stamp from the CURRENT account door');
  }
  // D5: account switch (no stamped arg) → old stamp cannot leak
  {
    const e = makeEnv(twoDoors);
    e._doorRowSync('iv', 'A1', { locId: 'GONE', label: 'Closed Door', address: '5 Old Rd' });
    e._doorRowSync('iv', 'A1'); // user re-picked an account — change handler form
    ok(!e.sel.options.some(o => o.value === 'GONE'), 'D5: account change drops the synthetic stamp option');
    ok(e._doorStamp('iv', 'A1') === null, 'D5: nothing selected after the switch');
  }
  // D6: hostile label is escaped in the option markup
  {
    const e = makeEnv([
      { id: 'X1', label: '<img src=x onerror=1>"&', address: 'a' },
      { id: 'X2', label: 'Plain', address: 'b' },
    ]);
    e._doorRowSync('iv', 'A1', null);
    ok(!e.sel.innerHTML.includes('<img') && e.sel.innerHTML.includes('&lt;img'), 'D6: door labels HTML-escaped');
  }
  // D7: _acDoors ignores malformed rows
  {
    const e = makeEnv([null, { id: '', address: 'no id' }, { id: 'OK1', label: 'Real', address: 'x' }, { id: 'OK2', label: '', address: 'y' }]);
    ok(e._acDoors('A1').length === 2, 'D7: locs without ids are not offered as doors');
    ok(e._acDoors('missing').length === 0 && e._acDoors('').length === 0, 'D7: unknown/blank account → no doors');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
// NOTE: wave11's combined-save harness stubs _doorStamp (v239 added the call
// inside saveNewCombinedInvoice); the real helper is dynamically tested HERE.
