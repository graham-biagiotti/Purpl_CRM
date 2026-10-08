// Wave 17 backtests — v240: per-location roles.
// Primary location = the account's own billing address (Billed-To block,
// no-door ship-to, map fallback pin). findUs toggle = whether a location
// appears on the public Where to Find Us map (offices stay off). Plus:
// the invoice DELIVER TO block no longer prints the store contact/phone.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] structural — edit-account controls + save derivation');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const rowFn = slc(src, 'function _eacLocRow', '\nfunction _eacAttachPlaces');
  ok(rowFn.includes('name="eac-loc-primary"') && rowFn.includes('class="eac-loc-findus"'),
    'loc row renders the Primary radio + find-us checkbox');
  ok(rowFn.includes("loc.findUs!==false?'checked'"), 'find-us defaults CHECKED (pre-v240 locations keep their pins)');
  const render = slc(src, 'function eacRenderLocs', '\nfunction eacAddLoc');
  ok(/hasPrimary = locs\.some\(l => l && l\.primary\)/.test(render) &&
     /loc\.primary \|\| \(!hasPrimary && i === 0\)/.test(render),
    'explicit primary wins, else the first row (the pre-v240 implicit primary)');
  const saveLoop = slc(src, '// Collect & geocode all location rows', '// Collect contacts');
  ok(/primary: !!row\.querySelector\('\.eac-loc-primary'\)\?\.checked/.test(saveLoop) &&
     /findUs:  !!row\.querySelector\('\.eac-loc-findus'\)\?\.checked/.test(saveLoop),
    'save reads both roles per row');
  ok(/if \(locs\.length && !locs\.some\(l => l\.primary\)\) locs\[0\]\.primary = true/.test(saveLoop),
    'exactly-one-primary enforced (removed/legacy radio falls back to row 1)');
  ok(saveLoop.includes('const primLoc = locs.find(l => l.primary) || locs[0] || {}'), 'primLoc derived');
  const rec = slc(src, '// Preserve ALL existing fields first', 'notes:     existing?.notes||[]');
  ok(/address:      primLoc\.address\|\|''/.test(rec) && /addrParts:    primLoc\.addrParts\|\|null/.test(rec) &&
     /lat:          primLoc\.lat\|\|null/.test(rec),
    'account top-level address/parts/coords come from the PRIMARY location');
  ok(/geocodeFailed: \(\(primLoc\.address\|\|''\) === \(existing\?\.address\|\|''\)\)/.test(rec),
    'geocode-retry compare uses the primary address');
  ok(rec.includes("dropOffRules: primLoc.dropOffRules||''"), 'top-level drop-off rules follow the primary');
}

console.log('[A2] structural — invoice doc + find-us function');
{
  const doc = slc(src, '>Billed To</div>', 'Invoice Details</div>');
  // v240 owner request: no store-specific contact on the CUSTOMER invoice.
  // Gate finding 2: the driver's warehouse copy keeps the call-ahead
  // contact/phone (same gating as drop-off rules) — contract updated.
  ok(/o\.warehouseCopy && \(o\.deliverTo\.contact \|\| o\.deliverTo\.phone\)/.test(doc),
    'store contact/phone prints on the WAREHOUSE copy only');
  ok(doc.split('\n').filter(l => l.includes('o.deliverTo.contact') || l.includes('o.deliverTo.phone'))
       .every(l => l.includes('o.warehouseCopy')),
    'every contact/phone reference sits behind the warehouseCopy gate');
  ok(doc.includes('o.deliverTo.label || o.deliverTo.address') &&
     /o\.warehouseCopy && o\.deliverTo\.dropOffRules/.test(doc),
    'store name/address + warehouse-only drop-off rules still print');
  // Stamp still CARRIES contact/phone (ShipStation uses the phone).
  const stamp = slc(src, 'function _doorStamp', '\n}');
  ok(stamp.includes('contact: loc.contact') && stamp.includes('phone: loc.phone'),
    'deliverTo stamp still carries contact/phone (data, not print)');
  const fn = slc(fnSrc, 'const acSnap', 'const stSnap');
  ok(/const eligible = locs\.filter\(l => l && l\.findUs !== false\)/.test(fn),
    'find-us filters opted-out locations');
  ok(/if \(!eligible\.length\) return;/.test(fn), 'account with every location opted out gets NO pins');
  ok(/const prim = locs\.find\(l => l && l\.primary\) \|\| locs\[0\]/.test(fn) &&
     /\(!prim \|\| prim\.findUs !== false\)/.test(fn),
    'fallback account pin suppressed when the primary (its source) opted out');
}

console.log('[B] dynamic — find-us filtering (real function body)');
{
  // Run the REAL per-account callback from the stockists function. Test-side
  // rewrite: the outer `skipped` accumulator becomes SK.v so the slice runs
  // standalone (commented per doctrine — logic otherwise untouched).
  const cb = slc(fnSrc, 'acSnap.forEach(d => {', '\n  });')
    .replace('acSnap.forEach(d => {', '')
    .replace('skipped += missedHere;', 'SK.v += missedHere;');
  const runAccount = (account) => {
    const out = []; const SK = { v: 0 };
    const push = (name, address, lat, lng, brands) => {
      if (!name) return false;
      const la = parseFloat(lat), ln = parseFloat(lng);
      if (!la || !ln) return false;
      out.push({ name: String(name), address: String(address || '') });
      return true;
    };
    new Function('d', 'push', 'SK', cb)({ data: () => account }, push, SK);
    return { out, skipped: SK.v };
  };
  const base = { stockistListed: true, status: 'active', name: 'BuyerCo', address: '9 Office Park', lat: 43.1, lng: -71.9, stockistBrands: ['purpl'] };

  // B1: office opted out, stores shown
  {
    const r = runAccount({ ...base, locs: [
      { id: 'o', label: 'Office', address: '9 Office Park', lat: 43.1, lng: -71.9, findUs: false, primary: true },
      { id: 's1', label: 'Village Market', address: '1 Main St', lat: 43.2, lng: -71.8 },
      { id: 's2', label: 'Hillside', address: '9 Hill Rd', lat: 43.3, lng: -71.7, findUs: true },
    ]});
    ok(r.out.length === 2 && !r.out.some(p => p.name.includes('Office')),
      'B1: opted-out office never pinned; both stores are');
    ok(r.out.every(p => p.name.startsWith('BuyerCo — ')), 'B1: pins carry the store label');
  }
  // B2: ALL locations opted out → account absent entirely (no fallback leak)
  {
    const r = runAccount({ ...base, locs: [
      { id: 'o', label: 'Office', address: '9 Office Park', lat: 43.1, lng: -71.9, findUs: false, primary: true },
    ]});
    ok(r.out.length === 0 && r.skipped === 0, 'B2: fully opted-out account has zero pins, zero skips');
  }
  // B3: the back door — primary office opted out, eligible store lacks
  // coords, account top-level coords ARE the office's → fallback must NOT
  // pin the office address under the account name.
  {
    const r = runAccount({ ...base, locs: [
      { id: 'o', label: 'Office', address: '9 Office Park', lat: 43.1, lng: -71.9, findUs: false, primary: true },
      { id: 's1', label: 'New Store', address: '1 Main St', lat: null, lng: null },
    ]});
    ok(r.out.length === 0, 'B3: office cannot sneak onto the map via the account fallback pin');
    ok(r.skipped === 1, 'B3: the coordless store is counted as skipped (geocoder will catch it)');
  }
  // B4: eligible primary keeps the fallback working (pre-v240 behavior)
  {
    const r = runAccount({ ...base, locs: [
      { id: 's1', label: 'Shop', address: '1 Main St', lat: null, lng: null, primary: true },
    ]});
    ok(r.out.length === 1 && r.out[0].name === 'BuyerCo', 'B4: eligible-primary fallback pin survives');
  }
  // B5: legacy account (no locs[]) unchanged
  {
    const r = runAccount({ ...base, locs: undefined });
    ok(r.out.length === 1 && r.out[0].address === '9 Office Park', 'B5: legacy single-address account unchanged');
  }
  // B6: unlisted / inactive accounts still excluded
  {
    ok(runAccount({ ...base, stockistListed: false }).out.length === 0 &&
       runAccount({ ...base, status: 'inactive' }).out.length === 0,
      'B6: unlisted/inactive accounts stay off the map');
  }
}

console.log('[B2] dynamic — loc row rendering');
{
  const rowSrc = slc(src, 'function _eacLocRow', '\nfunction _eacAttachPlaces');
  const _eacLocRow = new Function('loc', 'canRemove', 'isPrimary',
    rowSrc.replace('function _eacLocRow(loc, canRemove, isPrimary) {', '') .replace(/\}\s*$/, ''));
  const officeHtml = _eacLocRow({ id: 'o1', label: 'Office', address: 'x', findUs: false }, true, true);
  ok(/eac-loc-primary" value="o1" checked/.test(officeHtml), 'primary radio pre-checked');
  ok(/eac-loc-findus"\s+style/.test(officeHtml) && !/eac-loc-findus" checked/.test(officeHtml),
    'findUs:false renders unchecked');
  const storeHtml = _eacLocRow({ id: 's1', label: 'Store', address: 'y' }, true, false);
  ok(/eac-loc-findus" checked/.test(storeHtml), 'no findUs field renders CHECKED (default shown)');
  ok(!/value="s1" checked/.test(storeHtml), 'non-primary radio unchecked');
}

console.log('[C] payment-sweep fixes (ride the v240 deploy)');
{
  const ps = fs.readFileSync(path.join(__dirname, '../../public/payment-success.html'), 'utf8');
  const psw = fs.readFileSync(path.join(__dirname, '../../public-wholesale/payment-success.html'), 'utf8');
  [['public', ps], ['public-wholesale', psw]].forEach(([which, html]) => {
    ok(html.includes(".replace(/[^A-Za-z0-9._#\\- ]/g, '').slice(0, 40)"),
      `${which}/payment-success sanitizes the inv param (reflected-XSS closed)`);
    ok(!/var inv = p\.get\('inv'\) \|\| '';/.test(html), `${which}: raw inv read removed`);
  });
  // Draft invoices are not payable: draft→paid skipped markInvoiceSent, the
  // only purpl inventory deduction point.
  const pay = slc(fnSrc, 'exports.payInvoice', 'exports.');
  ok(/\(inv\.status \|\| 'draft'\) === 'draft'\) return page\('Invoice not issued yet'/.test(pay),
    'payInvoice refuses drafts (inventory-skip hole closed)');
  ok(pay.indexOf("=== 'draft'") > pay.indexOf("=== 'void'") && pay.indexOf('stripe.checkout.sessions.create') > pay.indexOf("=== 'draft'"),
    'draft check sits after paid/void, before session mint');
  // Reminder double-send guard.
  const rem = slc(src, 'const _reminderInFlight', '\nfunction buildInvoiceReminderHTML');
  ok(/_reminderInFlight\.has\(invId\)\) return;/.test(rem) && /_reminderInFlight\.add\(invId\)/.test(rem),
    'sendInvoiceReminder is single-flight per invoice');
  ok(/setTimeout\(\(\) => _reminderInFlight\.delete\(invId\), 15000\)/.test(rem),
    'guard self-clears (can never wedge the button)');
  ok(/_btn\.disabled = true/.test(rem) && /_unlock\(\)/.test(rem),
    'button disables while sending and unlocks on failure for a deliberate retry');
  ok((rem.match(/_unlock\(\)/g) || []).length >= 3, 'every early-exit path unlocks');
}

console.log('[D] v241 — invoice lists show the door');
{
  const ul = slc(src, 'function renderInvUnifiedList', '\nfunction ');
  ok(/const _doorLabel = d => d \? \(d\.label \|\| d\.address \|\| ''\) : ''/.test(ul),
    'unified list derives a door label from the stamp');
  ok((ul.match(/door: _doorLabel\(x\.deliverTo\),/g) || []).length === 2,
    'purpl + LF rows carry their door');
  ok(/door: _doorLabel\(x\.deliverTo\) \|\|\s*_doorLabel\(\(x\.purplInvoiceId/.test(ul),
    'combined rows use the parent→children chain (manual combines)');
  ok(ul.includes("r.num + ' ' + r.name + ' ' + r.door"), 'search matches the store name too');
  ok(/escHtml\(r\.name\)\}\$\{r\.door \? `<div[^`]*📍 \$\{escHtml\(r\.door\)\}/.test(ul),
    'door renders as an escaped sub-line under the account');
  ok((src.match(/📍 \$\{escHtml\(inv\.deliverTo\.label \|\| inv\.deliverTo\.address\)\}/g) || []).length >= 2,
    'LF tables show the door sub-line as well');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
