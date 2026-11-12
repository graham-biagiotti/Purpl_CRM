// Wave 35 backtests — v263 LF inventory cases view:
// (1) a Cases column next to Units (full cases + loose), computed from the
//     product's case size — a VIEW of the unit ledger, never a second pile;
// (2) entry by the case on stock in / take out, converted to units on save;
// (3) stock take counts by-the-case products as full cases + loose units.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] conversion helpers — run the REAL functions');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const helpers = slc(src, 'function _lfCasesSplit(', '\nfunction _lfLeafLabel');
  const H = new Function(helpers + '\nreturn { _lfCasesSplit, _lfCasesText, _lfToUnits };')();
  ok(JSON.stringify(H._lfCasesSplit(52, 12)) === '{"cases":4,"loose":4}', '52 units of a 12-case = 4 cases + 4');
  ok(JSON.stringify(H._lfCasesSplit(24, 12)) === '{"cases":2,"loose":0}', 'exact multiple has no loose units');
  ok(JSON.stringify(H._lfCasesSplit(-5, 12)) === '{"cases":0,"loose":-5}', 'negative on-hand is never split into fake cases');
  ok(JSON.stringify(H._lfCasesSplit(7, 1)) === '{"cases":0,"loose":7}' && JSON.stringify(H._lfCasesSplit(7, 0)) === '{"cases":0,"loose":7}',
    'case size 0/1 = not sold by the case');
  ok(H._lfCasesText(52, 12) === '4 + 4' && H._lfCasesText(24, 12) === '2' && H._lfCasesText(5, 12) === '0 + 5',
    'cases text shows full cases plus loose');
  ok(H._lfCasesText(0, 12) === '0' && H._lfCasesText(-3, 12) === '0' && H._lfCasesText(9, 1) === '—',
    'empty/negative reads 0; no case size reads —');
  ok(H._lfToUnits(3, 'cases', 12) === 36 && H._lfToUnits(3, 'units', 12) === 3 && H._lfToUnits('2', 'cases', '6') === 12,
    'entry by the case converts to units; units pass through');
  ok(H._lfToUnits(3, 'cases', 1) === 0 && H._lfToUnits(3, 'cases', 0) === 0,
    'case entry with no case size converts to nothing (caller rejects it)');
}

console.log('[B] ledger stays in units');
{
  const man = slc(src, 'function _lfManualEntry(', '\nfunction lfInvReceive');
  ok(man.includes('const q = _lfToUnits(qty, unit, r.caseSize);') && man.includes('type, qty: q, reason'),
    'manual entries store converted UNITS (no case field ever reaches the ledger)');
  ok(man.includes("unit === 'cases' && !(r.caseSize > 1)") && man.includes('enter units instead'),
    'case entry on a product with no case size is refused with a clear message');
  ok(src.includes("qs('#lf-in-unit')?.value") && src.includes("qs('#lf-out-unit')?.value"),
    'both forms pass the chosen unit');
  ok(slc(src, 'function _lfLeafRows()', '\n// v263: cases are a VIEW').includes('caseSize'),
    'every leaf row carries its product case size');
  ok(!/lf_iv'[^\n]*cases:/.test(src), 'no ledger write carries a cases field');
}

console.log('[C] table + stock take');
{
  const pane = slc(src, 'function _invLf()', '\n// Dashboard quick-action');
  ok(pane.includes("'Cases (+ loose)'") && pane.includes('_lfCasesText(v, r.caseSize)') && pane.includes('_lfCasesText(tot, group[0].caseSize)'),
    'Cases column on variety rows and product totals');
  ok(pane.includes('colspan="4"') && pane.includes('Alert at ≤ (units)'), 'four columns; thresholds labelled as units');
  ok(pane.includes('class="lf-st-cases"') && pane.includes('data-case-size="${r.caseSize}"'),
    'stock take offers a full-cases input for by-the-case products');
  const st = slc(src, 'function lfInvStockTakeSave()', '\nasync function lfInvSaveAlertEmail');
  ok(st.includes("const counted = _loose + (ci ? _cases * (parseInt(ci.dataset.caseSize, 10) || 0) : 0);"),
    'counted = full cases × case size + loose units');
  ok(st.includes('(!ci || ci.value === ci.dataset.baseline)'), 'a row is untouched only if BOTH inputs are untouched');
  ok(st.includes('isNaN(_cases) || _cases < 0'), 'blank/negative case counts are ignored, not written');
  ok(st.includes('const delta = counted - cur;'), 'delta still diffs against live on-hand');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
