// Wave 19 backtests — v245 sampling: custom time/event/all-day on the demo
// form (threaded end-to-end incl. all-day ICS) + the F19 sample approve/ship
// fix (approve only what shipped; surface write failures after a ship).
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const formSrc = fs.readFileSync(path.join(__dirname, '../../public/sampling.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] F19 — approve only what shipped');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const push = slc(src, 'async function pushSampleToShipStation', '\nfunction markSampleFollowUpDone');
  ok(push.includes('return true;') && (push.match(/return false;/g) || []).length >= 4,
    'pushSampleToShipStation reports success/failure on every path');
  const appr = slc(src, 'async function _approveSampleRequest', '\nasync function _declineSampleRequest');
  // v251 CONTRACT CHANGE: approve now passes { orderRef: portalOrderId } so the
  // ShipStation orderKey is deterministic per request (duplicate push = update,
  // not a second box). The bail-on-failed-push contract is unchanged.
  ok(/const pushed = await pushSampleToShipStation\(accountId, \{ orderRef: portalOrderId \}\);\s*if \(!pushed\) \{/.test(appr),
    'approve bails (row stays Pending) when the push failed — no ghost approval');
  // v251: cross-user claim — approve claims the request on the SERVER before
  // pushing, and a lost claim exits before any push.
  ok(/_txActionClaim\('portal_orders\/' \+ portalOrderId, 'sampleClaim'/.test(appr),
    'approve claims the request server-side before pushing (v251)');
  ok(appr.indexOf("_txActionClaim('portal_orders/") < appr.indexOf('await pushSampleToShipStation'),
    'claim happens BEFORE the push (v251)');
  ok(/abortIf: d => !!d\.sampleApproved/.test(appr),
    'an already-approved request aborts the claim (v251)');
  ok(/_claim\.release\(\)/.test(appr),
    'a failed push releases the claim for a deliberate retry (v251)');
  const _gi = appr.indexOf('if (!pushed)');
  ok(_gi >= 0 && _gi < appr.indexOf('sampleApproved: true'),
    'the approved stamp is unreachable without a successful ship');
  // Gate F1: one approval per request at a time — double-click shipped twice.
  ok(/_approveSampleInFlight\.has\(portalOrderId\)\) \{ toast/.test(appr) || /_approveSampleInFlight\.has\(portalOrderId\)/.test(appr),
    'approve is single-flight per request (gate F1)');
  ok((appr.match(/_done\(\)/g) || []).length >= 4, 'every exit path releases the in-flight guard');
  // Gate F2: post-acceptance bookkeeping failures warn, never report failure.
  ok(/if \(!d\.ok\) \{\s*_stickyError[\s\S]{0,80}return false;/.test(push),
    'ShipStation rejection checked FIRST (gate F2)');
  ok(push.includes('but logging it on the account failed. Do not push again.'),
    'bookkeeping failure after a real ship warns instead of inviting a re-click (gate F2)');
  // Gate F3: prototype-key bypass closed server-side.
  ok(fnSrc.includes("Object.prototype.hasOwnProperty.call(SAMPLING_WINDOWS, data.timeWindow)"),
    "timeWindow validated as an OWN property (gate F3: '__proto__' wrecked the ICS)");
  ok(/catch\(e\) \{ writeFails\+\+/.test(appr) && appr.includes('Do NOT click Approve again'),
    'write failures AFTER a ship are surfaced loudly (duplicate-box warning)');
  ok(!/\} catch\(e\) \{\}/.test(appr), 'no silently-swallowed writes remain in approve');
}

console.log('[A2] custom time — functions plumbing');
{
  ok(fnSrc.includes('function _samplingWindowText(r)'), 'single window-text source exists (functions)');
  ok((fnSrc.match(/_samplingWindowText\(/g) || []).length >= 8,
    'all label sites route through it (packet, confirm, cal page, action pages, T-2, ICS)');
  ok(!/\(SAMPLING_WINDOWS\[(rec|r|x)\.timeWindow\] \|\| \{\}\)\.label/.test(fnSrc),
    'no stray direct label reads remain');
  const submit = slc(fnSrc, 'exports.submitSamplingRequest', 'exports.samplingAction');
  ok(/data\.timeWindow === 'custom' \? 'custom' : 'morning'/.test(submit), "submit accepts 'custom'");
  ok(/timeWindow === 'custom' && !timeCustom/.test(submit) && submit.includes('Tell us the time or event'),
    'custom without text is rejected server-side');
  ok(submit.includes('timeCustom: timeCustom || null,'), 'timeCustom stored on the request');
  const ics = slc(fnSrc, 'function _samplingIcs', '\nasync function _samplingConfig');
  ok(ics.includes("DTSTART;VALUE=DATE:") && ics.includes("DTEND;VALUE=DATE:"),
    'custom time → ALL-DAY calendar event');
  ok(/r\.timeWindow === 'custom' \? 'Time: ' \+ _samplingWindowText\(r\)/.test(ics),
    "custom wording leads the event description");
}

console.log('[A3] custom time — form + CRM');
{
  ok(formSrc.includes('<option value="custom">Different time / event / all day…</option>'),
    'form offers the custom option');
  ok(formSrc.includes('id="sp-window-custom"') && formSrc.includes('function spWindowChange()'),
    'custom text box revealed next to the time select');
  ok(/sp-window'\)\.value === 'custom' && !document\.getElementById\('sp-window-custom'\)\.value\.trim\(\)/.test(formSrc),
    'client requires the text when custom is picked');
  ok(formSrc.includes("timeCustom: document.getElementById('sp-window-custom').value.trim(),"),
    'payload carries timeCustom');
  ok(/id="sp-notes" maxlength="2000" rows="5"/.test(formSrc), 'notes box got real room');
  ok(!formSrc.includes('within <strong>2 days</strong>'), 'false 2-day promise removed');
  ok(src.includes('function _samplingWindowText(r)'), 'app.js mirror helper exists');
  ok((src.match(/escHtml\(_samplingWindowText\(r\)\)/g) || []).length === 2,
    'CRM cards show the custom wording (escaped) in both status arms');
}

console.log('[B] dynamic — window text + ICS');
{
  // Run the REAL helpers from both files.
  const fnHelper = new Function('SAMPLING_WINDOWS', slc(fnSrc, 'function _samplingWindowText', '\n}') + '\n}\nreturn _samplingWindowText;')(
    { morning: { label: 'Morning (10am–1pm)' } });
  ok(fnHelper({ timeWindow: 'custom', timeCustom: '12–6 fall festival' }) === '12–6 fall festival',
    'B1: custom text wins (functions)');
  ok(fnHelper({ timeWindow: 'custom', timeCustom: '  ' }) === 'Custom time — see notes',
    'B1: blank custom falls back safely');
  ok(fnHelper({ timeWindow: 'morning' }) === 'Morning (10am–1pm)', 'B1: standard window label intact');
  const appHelper = new Function('_SAMPLING_WINDOW_LABELS', slc(src, 'function _samplingWindowText', '\n}') + '\n}\nreturn _samplingWindowText;')(
    { morning: 'Morning (10am–1pm)' });
  ok(appHelper({ timeWindow: 'custom', timeCustom: 'all day — anniversary' }) === 'all day — anniversary',
    'B1: app.js mirror agrees');

  // Real _samplingIcs with both shapes.
  const icsSrc = slc(fnSrc, 'function _samplingIcs', '\nasync function _samplingConfig');
  const WINDOWS = { morning: { label: 'Morning (10am–1pm)', start: '100000', end: '130000' } };
  const mkIcs = new Function('SAMPLING_WINDOWS', '_samplingWindowText',
    icsSrc + '\nreturn _samplingIcs;')(WINDOWS, fnHelper);
  const custom = mkIcs('R1', { timeWindow: 'custom', timeCustom: 'all day — fall festival', confirmedDate: '2026-10-31', accountName: 'Big Y', storeAddress: '1 Main St', contact: {}, logistics: {} });
  ok(custom.includes('DTSTART;VALUE=DATE:20261031') && custom.includes('DTEND;VALUE=DATE:20261101'),
    'B2: custom → all-day event spanning exactly the demo day');
  ok(custom.includes('all day — fall festival'), 'B2: the wording rides in SUMMARY/DESCRIPTION');
  const std = mkIcs('R2', { timeWindow: 'morning', confirmedDate: '2026-10-31', accountName: 'Big Y', contact: {}, logistics: {} });
  ok(std.includes('DTSTART:20261031T100000') && std.includes('DTEND:20261031T130000'),
    'B2: standard windows keep their timed events');
  ok(!std.includes('VALUE=DATE'), 'B2: no all-day leak into standard windows');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
