// Wave 40 backtests — v273 address + billing-email flow:
// (1) the wholesale application asks for a full address and approval saves
//     it where the CRM reads it (addrParts + locs, not the dead `locations`);
// (2) confirming a portal order ships to the address the store typed, offers
//     to update the account (automatic only when the account had none), and
//     saves a differing billing email as the account's Billing / AP email;
// (3) the order page's remembered preferences go through a token-checked
//     server function instead of a client write the rules refuse.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const ws = fs.readFileSync(path.join(root, 'public/wholesale.html'), 'utf8');
const ord = fs.readFileSync(path.join(root, 'public/order.html'), 'utf8');
const fnSrc = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] address comparison — run the REAL helpers');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const code = slc(src, 'function _parseAddress(', '\nasync function pushInvoiceToShipStation')
    + '\n' + slc(src, 'function _saComplete(', '\nfunction _applyOrderAddressToAccount');
  const H = new Function(code + '\nreturn { _saComplete, _saParts, _saLine, _acAddrUsable, _acAddrStreetless, _orderAddrLoc, _orderAddrState, _orderDoorStamp, _shipAddrFor };')();
  const SA = { street1: ' 12 Main St ', street2: '', city: 'Warner', state: 'nh', zip: '03278' };

  ok(H._saComplete(SA) && !H._saComplete({ street1: '12 Main St', city: 'Warner', state: 'NH' }) && !H._saComplete(null),
    'an order address is complete only with street, city, state and zip');
  ok(H._saLine(SA) === '12 Main St, Warner, NH 03278', 'address line is trimmed, state upper-cased');
  ok(JSON.stringify(H._saParts(SA)) === JSON.stringify({ street1: '12 Main St', street2: '', city: 'Warner', state: 'NH', zip: '03278' }), 'parts are normalised');

  ok(H._acAddrUsable({ address: 'Warner, NH' }) === false, '"City, State" (the old application answer) is NOT a usable address');
  ok(H._acAddrUsable({ addrParts: { street1: '12 Main St', city: 'Warner', state: 'NH', zip: '03278' } }) === true, 'a structured address is usable');
  ok(H._acAddrUsable({}) === false && H._acAddrUsable(null) === false, 'no address → not usable, no crash');

  ok(H._orderAddrState({ address: 'Warner, NH' }, SA) === 'fill', 'account with no usable address → fill it from the order');
  const acct = { addrParts: { street1: '12 Main St', city: 'Warner', state: 'NH', zip: '03278' }, address: '12 Main St, Warner, NH 03278' };
  ok(H._orderAddrState(acct, SA) === 'same', 'same address → nothing to ask');
  ok(H._orderAddrState(acct, { ...SA, street1: '12 MAIN ST.', zip: '03278-1234' }) === 'same', 'case, punctuation and zip+4 do not count as a difference');
  ok(H._orderAddrState(acct, { ...SA, street1: '99 Depot Rd' }) === 'differs', 'a different street → ask the owner');
  ok(H._orderAddrState(acct, { ...SA, street2: 'Unit 4' }) === 'differs', 'a suite the account lacks → ask the owner');
  ok(H._orderAddrState(acct, { street1: '12 Main St', city: 'Warner' }) === 'none', 'an incomplete order address is never offered');
  // Gate F2: only a truly street-less account is filled automatically.
  ok(H._orderAddrState({ address: 'Warner, NH 03278' }, SA) === 'fill' && H._orderAddrState({ address: '' }, SA) === 'fill',
    'blank or "City, State zip" → filled automatically');
  ['45 N Broadway Salem NH 03079', '1 Depot Sq Peterborough NH 03458', 'PO Box 12 Warner NH 03278', '12 Main St, Warner NH', 'RR 2 Box 15, Warner, NH']
    .forEach(a => ok(H._orderAddrState({ address: a }, { ...SA, street1: '500 Warehouse Way' }) === 'differs', `a real address the parser cannot split is never auto-replaced: "${a}"`));
  // Gate F6: an order to one of the account's other locations.
  const multi = { ...acct, locs: [
    { id: 'L1', label: 'Main St', primary: true, address: acct.address, addrParts: acct.addrParts },
    { id: 'L2', label: 'Depot store', address: '99 Depot Rd, Concord, NH 03301', addrParts: { street1: '99 Depot Rd', city: 'Concord', state: 'NH', zip: '03301' }, contact: 'Sam' } ] };
  const toL2 = { street1: '99 Depot Rd', city: 'Concord', state: 'NH', zip: '03301' };
  ok(H._orderAddrState(multi, toL2) === 'same' && H._orderAddrLoc(multi, toL2).id === 'L2', 'an order to another of the account\'s locations matches that location');
  ok(H._orderAddrLoc(multi, { ...toL2, street1: '1 Nowhere Ln' }) === null, 'an unknown address matches no location');

  const d = H._orderDoorStamp('ORD1', SA);
  ok(d.locId === 'order-ship-ORD1' && d.address === '12 Main St, Warner, NH 03278' && d.addrParts.zip === '03278' && d.label === '',
    'invoice ship-to stamp carries the structured address; empty label keeps the store name clean on the label');
  const viaDoor = H._shipAddrFor({ addrParts: d.addrParts, address: d.address });
  ok(viaDoor.street1 === '12 Main St' && viaDoor.city === 'Warner' && viaDoor.zip === '03278', 'the label path can ship from that stamp');
}

console.log('[B] confirm flow');
{
  const cf = slc(src, 'async function confirmPortalOrder()', '\nfunction togglePortalDeadline()');
  ok(cf.includes("const _updAddrChecked = !!qs('#mcpo-update-addr')?.checked;"), 'the owner\'s tick is read before the window closes');
  ok(cf.includes("(_poAddrState !== 'same') ? _orderDoorStamp(_portalOrderId, _poSa)") && cf.includes('{ locId: _poLoc.id, label: _poLoc.label'),
    'invoices get the order ship-to unless it matches the account; a matching non-primary location is stamped as itself (gate F6)');
  ok((cf.match(/\.\.\.\(_poDoor \? \{ deliverTo: \{ \.\.\._poDoor \} \} : \{\}\),/g) || []).length === 5,
    'all five invoice records created by a confirm carry it (each its own copy)');
  ok(cf.includes("_poAddrState === 'fill' || (_poAddrState === 'differs' && _updAddrChecked)"),
    'account address changes only when it had none, or the owner ticked the box');
  ok(cf.includes("DB.updateFields('ac', acct.id, { billingEmail: _oe });") && !/updateFields\('ac', acct\.id, \{[^}]*\bemail:/.test(cf),
    'a differing order email is saved as the Billing / AP email — the main email is never written');
  ok(cf.includes("const _updBillChecked = !!qs('#mcpo-update-bill')?.checked;") && cf.includes('if (_updBillChecked && _oe && _oe.length < 200'),
    'the billing email is saved only when its box is ticked (gate F1)');
  ok(cf.includes('_oe.toLowerCase() !== _onFile.toLowerCase()'), 'same email in different case is not a change');
  ok(cf.includes('if (_poIsAcct) {') && cf.includes('const _poIsAcct = !!acct.id && !d.isProspect;'), 'prospects and unmatched orders never touch an account');
  ok(cf.indexOf('// v273: carry the order') > cf.indexOf("auditLog('portal_confirmed'"), 'account updates happen only after the invoice exists');
  const ap = slc(src, 'function _applyOrderAddressToAccount(', '\n// The order\'s own address');
  ok(ap.includes("DB.updateFields('ac', acId, patch);") && ap.includes('patch.locs = ac.locs.map(') && !/lat: *null/.test(ap),
    'address update is field-targeted, updates the primary location, and keeps the old map pin until re-located');
  ok(ap.includes("auditLog('update', 'account', acId"), 'address changes are audited');
  const md = slc(src, 'function _mcpoRenderAddr()', '\nlet _portalOrderId = null;');
  ok(md.includes('id="mcpo-update-addr"') && !/id="mcpo-update-addr"[^>]*checked/.test(md), 'the update box starts UNticked (owner approves)');
  ok(md.includes("id=\"mcpo-update-bill\" ${_viaLink ? 'checked' : ''}") && md.includes('const _viaLink = !!o.accountId;'),
    'billing-email box: ticked for orders on the store\'s own link, UNticked when the owner matched the account by hand');
  ok(md.includes('escHtml(_saLine(sa))') && md.includes("escHtml(ac.address || '—')") && md.includes('escHtml(oe)') && md.includes("escHtml(onFile || '—')"),
    'order address, on-file address and both emails are escaped in the confirm window');
}

console.log('[C] application → account');
{
  ok(!ws.includes('placeholder="City, State is fine"') && ['ws-address', 'ws-address2', 'ws-city', 'ws-state', 'ws-zip'].every(id => ws.includes(`id="${id}"`)),
    'application form has street / suite / city / state / zip');
  ok(ws.includes("if (!wsAddr.street1 || !wsAddr.city || !_stOk || !_zipOk) hasError = true;"), 'street, city, state and zip are required');
  ok(ws.includes('addrParts:       wsAddr,') && ws.includes('address:         wsAddressLine(wsAddr),'), 'application carries both the line and the parts');
  const W = new Function(slc(ws, 'function wsAddressLine(a)', '\n// Picking a suggestion') + '\nreturn wsAddressLine;')();
  ok(W({ street1: '12 Main St', street2: 'Unit 4', city: 'Warner', state: 'NH', zip: '03278' }) === '12 Main St, Unit 4, Warner, NH 03278', 'application address line reads naturally');
  // rules: the application doc is capped at <20 fields — count what the form sends
  const payload = slc(ws, "collection('portal_inquiries').add({", '});');
  const keys = (payload.match(/^\s+([a-zA-Z]+):/gm) || []).length;
  ok(keys < 20 && rules.includes('request.resource.data.size() < 20'), `application sends ${keys} fields (rules allow fewer than 20)`);
  const ap = slc(src, 'async function approveApplication(', '\n  DB.push(\'ac\', rec);');
  ok(ap.includes('addrParts:  _appAddrParts,') && ap.includes('locs:       app.address ?') && !/\blocations:/.test(ap),
    'approval writes addrParts + locs (the dead `locations` field is gone)');
  ok(ap.includes('primary: true') && ap.includes('const _appAddrParts = (_ap && _saComplete(_ap)) ? _saParts(_ap) : null;'),
    'the location is the primary one; malformed parts are dropped, not trusted');

  ok(ws.includes("el.value = parts.street1 || '';"), 'a town-level dropdown pick leaves the street box empty, not "Warner, NH, USA" (gate F4)');
  ok(ws.includes("delete st.dataset.lat; delete st.dataset.lng; delete st.dataset.addrParts;"), 'hand-editing city/state/zip drops the picked map location (gate F5)');
}

console.log('[D] order page + server');
{
  ok(ord.includes("httpsCallable('savePortalPrefs')") && !ord.includes(".collection('accounts')"),
    'order page no longer writes account records directly (the rules refuse it)');
  ok(ord.includes("data.billingEmail || accountEmail"), 'returning store sees its billing email');
  const sp = slc(fnSrc, 'exports.savePortalPrefs', '\nexports.lookupPortalToken');
  ok(sp.includes("where('orderPortalToken', '==', token)") && sp.includes("LEAD.includes(request.data?.leadTimeNeeded)") && sp.includes('.slice(0, 300)'),
    'prefs save is token-checked, accepts only a known lead-time value and a short note');
  ok(sp.includes("db.collection('workspace/main/ac').where('orderPortalToken', '==', token)"), 'prefs save has the same workspace fallback as the token lookup (gate F7)');
  ok((sp.match(/'portalPrefs\.[a-zA-Z]+'/g) || []).length === 3 && !/\bemail\b|address|name:/.test(sp.replace(/\/\/.*$/gm, '')),
    'it writes exactly three preference fields — nothing else on the account');
  ok((fnSrc.match(/address: \(d\.addrParts && d\.addrParts\.street1\) \? d\.addrParts : \(d\.address \|\| d\.shipAddress \|\| ''\),/g) || []).length === 2
     && (fnSrc.match(/billingEmail: d\.billingEmail \|\| '',/g) || []).length === 2,
    'token lookup returns the structured address and billing email');
  ok(rules.includes('match /accounts/{accountId}') && /match \/accounts\/\{accountId\} \{\s*allow read, create, update: if isStaff\(\);/.test(rules),
    'account records stay staff-only (rules unchanged)');
}

console.log('[E] review list');
{
  const rv = slc(src, 'function _addrReviewRows()', '\nfunction renderAccounts()');
  ok(rv.includes("a.status !== 'inactive' && !_acAddrUsable(a)"), 'lists active accounts with no usable address');
  ok(rv.includes('o.isProspect || !_saComplete(o.shipAddress)'), 'only complete order addresses are offered');
  ok(rv.includes("_applyOrderAddressToAccount(acId, row.sa, 'address_review')"), 'one click applies it through the same audited path');
  ok((rv.match(/escHtml\(/g) || []).length >= 3, 'names and addresses escaped');
  ok(src.includes('try { renderAddrReviewBanner(); } catch (e)'), 'a banner error can never break the Accounts page');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
