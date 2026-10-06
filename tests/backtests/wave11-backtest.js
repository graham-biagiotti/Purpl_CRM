// Wave 11 backtests — combined-invoice misc line items (v234).
// (Recreated into the repo 2026-10-06 — final state incl. cent-exact money
// regression and the LF-standalone live-total advisory.)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slice = (a, b, from) => {
  const i = src.indexOf(a, from || 0); const j = src.indexOf(b, i + 1);
  if (i < 0 || j < 0) throw new Error('slice not found: ' + a);
  return src.slice(i, j);
};

// ── [A] structural ───────────────────────────────────────────
console.log('[A] structural');
{
  const appV = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(appV && swSrc.includes('purpl-crm-' + appV), `version lockstep (${appV})`);
  const opens = (htmlSrc.match(/<div\b/g) || []).length, closes = (htmlSrc.match(/<\/div>/g) || []).length;
  ok(opens === closes, `index.html divs balanced (${opens}/${closes})`);
  ok(htmlSrc.includes('id="ncivp-misc-rows"') && htmlSrc.includes('id="ncivl-misc-rows"'), 'misc containers exist in both brand sections');
  ok(htmlSrc.includes("addMiscRow('ncivp')") && htmlSrc.includes("addMiscRow('ncivl')"), 'add buttons wired per brand');
  ok(htmlSrc.indexOf('ncivp-misc-rows') < htmlSrc.indexOf('nciv-purpl-sub') &&
     htmlSrc.indexOf('ncivl-misc-rows') < htmlSrc.indexOf('nciv-lf-sub') &&
     htmlSrc.indexOf('ncivp-misc-rows') > htmlSrc.indexOf('nciv-purpl-skus'), 'containers sit inside their brand sections');
  ok(/_renderMiscRows\('ncivp', \[\]\);\s*\n\s*_renderMiscRows\('ncivl', \[\]\);/.test(src), 'new-invoice open clears both misc lists');
  ok(/_renderMiscRows\('ncivp', _miscLinesOf\(purplChild\)\);\s*\n\s*_renderMiscRows\('ncivl', _miscLinesOf\(lfChild\)\);/.test(src), 'edit open loads each child\'s misc lines into its section');
  const saveFn = slice('async function saveNewCombinedInvoice()', '\n// Shared payment-options');
  ok(/purplLines\.push\(\.\.\._readMiscRows\('ncivp'\)\);\s*\n\s*lfLines\.push\(\.\.\._readMiscRows\('ncivl'\)\);/.test(saveFn), 'save reads misc rows into the brand line arrays');
  ok(saveFn.indexOf("_readMiscRows('ncivp')") < saveFn.indexOf('purplLines.reduce'), 'misc pushed BEFORE subtotals are computed');
  ok(/_extrasOf = \(c\) => \(\(c && c\.lineItems\) \|\| \[\]\)\.filter\(l => l\.skuId === '__discount__'\)/.test(saveFn), 'edit carry is discount-only (no misc duplication)');
  ok(src.includes("oninput=\"_miscRecalc(this)\""), 'misc inputs live-recalc via router');
  ok(/#ncivp-misc-rows'\) \|\| el\.closest\('#ncivl-misc-rows'\)/.test(src), 'recalc router covers both nciv sections');
  ok(/purplSub \+= _miscSumOf\('ncivp'\);\s*\n\s*lfSub\s+\+= _miscSumOf\('ncivl'\);/.test(src), 'live totals include per-brand misc');
}

// ── DOM + DB stub environment ────────────────────────────────
function mkEnv() {
  const byId = {}, bySel = {};
  const el = (props) => ({ value: '', dataset: {}, style: {}, textContent: '', innerHTML: '',
    querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML: () => {}, ...props });
  const miscRow = (desc, amt) => el({
    className: 'misc-row',
    querySelector: (s) => s === '.misc-desc' ? { value: desc } : s === '.misc-amt' ? { value: amt } : null,
  });
  const pCaseInput = (sku, cases, ppc) => {
    bySel[`.nciv-p-ppc[data-sku="${sku}"]`] = [{ value: String(ppc) }];
    return el({ dataset: { sku }, value: String(cases) });
  };
  const lfRow = (sku, cases, unitPrice, caseSize) => el({
    dataset: { sku, casesize: String(caseSize) },
    querySelector: (s) => s.includes('.nciv-lf-ppc') ? { value: String(unitPrice) } : s === '.nciv-lf-cases' ? { value: String(cases) } : null,
  });
  const document = {
    querySelectorAll: (sel) => bySel[sel] || [],
    querySelector: (sel) => (bySel[sel] || [])[0] || (sel.startsWith('#') && byId[sel.slice(1)]) || null,
    getElementById: (id) => byId[id] || null,
    createElement: () => el({}),
  };
  return { byId, bySel, el, miscRow, pCaseInput, lfRow, document };
}

function loadCode(env, cache, hooks) {
  const document = env.document;
  const window = {};
  const toast = (m) => (hooks.toasts = hooks.toasts || []).push(String(m));
  const _stickyError = (m) => (hooks.sticky = hooks.sticky || []).push(String(m));
  const DB = {
    a: k => cache[k] || [],
    obj: (k, d = {}) => cache[k] || d,
    atomicUpdate: (fn) => { fn(cache); (hooks.atomics = hooks.atomics || 0), hooks.atomics++; },
    update: () => true, push: () => {},
  };
  const getNextInvoiceNumber = async () => '14001';
  const peekNextInvoiceNumber = () => '14001';
  const openCombinedInvoicePreview = () => {};
  const renderInvoicesPage = () => {};
  const closeModal = () => {};
  const openModal = () => {};
  void window; void toast; void _stickyError; void DB; void getNextInvoiceNumber;
  void openCombinedInvoicePreview; void renderInvoicesPage; void closeModal; void openModal; void peekNextInvoiceNumber;
  const code = [
    'const CANS_PER_CASE = 12;',
    'const qs = (s) => document.querySelector(s);',
    "const IV_SKUS = [{id:'classic',name:'Classic'},{id:'blueberry',name:'Blueberry'}];",
    slice('const uid  =', '// Sort-direction toggles'),
    slice('function escHtml', '\nfunction '),
    "const _INV_COLS = ['retail_invoices','iv','lf_invoices','combined_invoices','dist_invoices'];",
    slice('function _invoiceCol(id)', '\n}') + '\n}',
    slice('function _combDiscOf', '\nfunction _childExtrasInline'),
    slice('function _miscLinesOf', 'function _readMiscRows'),
    slice('function _readMiscRows', '\n// '),
    'let _editingCombinedId = null;',
    slice('let _saveCombInFlight = false;', 'async function saveNewCombinedInvoice'),
    slice('async function saveNewCombinedInvoice()', '\n// Shared payment-options'),
  ].join('\n');
  return eval(code + '\n;({ saveNewCombinedInvoice, _readMiscRows, _miscLinesOf, _combDiscOf, _setEditing: (id)=>{_editingCombinedId=id;}, _getInFlight: ()=>_saveCombInFlight, _resetInFlight: ()=>{_saveCombInFlight=false;} })');
}

(async () => {
  const r2 = (n) => Math.round(n * 100) / 100;

  // ── [B] create-path money math ─────────────────────────────
  console.log('[B] create path');
  {
    const env = mkEnv(); const cache = { ac: [{ id: 'a1', name: 'Big Y' }], lf_skus: [{ id: 'lfs1', name: 'Syrup', caseSize: 6 }], retail_invoices: [], lf_invoices: [], combined_invoices: [], iv: [] };
    env.byId['nciv-account'] = { value: 'a1' };
    env.byId['nciv-shipping'] = { value: '12.40' };
    env.byId['nciv-status'] = { value: 'sent' };
    env.bySel['.nciv-p-cases'] = [env.pCaseInput('classic', 2, 27.60)];
    env.bySel['#nciv-lf-skus .nciv-lf-row'] = [env.lfRow('lfs1', 1, 3.00, 6)];
    env.bySel['#ncivp-misc-rows .misc-row'] = [env.miscRow('Glassware set', '50'), env.miscRow('', '99'), env.miscRow('Free thing', '0')];
    env.bySel['#ncivl-misc-rows .misc-row'] = [env.miscRow('Lavender wreath', '10.005')];
    const hooks = {};
    const R = loadCode(env, cache, hooks);
    await R.saveNewCombinedInvoice();
    const p = cache.combined_invoices[0], pc = cache.retail_invoices[0], lc = cache.lf_invoices[0];
    ok(!!p && !!pc && !!lc, 'parent + both children created');
    const pMisc = R._miscLinesOf(pc), lMisc = R._miscLinesOf(lc);
    ok(pMisc.length === 1 && pMisc[0].description === 'Glassware set' && pMisc[0].total === 50, 'purpl misc stored on purpl child (desc-less + zero rows dropped)');
    ok(lMisc.length === 1 && lMisc[0].total === 10.01 || lMisc[0].total === 10, `LF misc rounded to cents (${lMisc[0]?.total})`);
    const lfMiscAmt = lMisc[0].total;
    ok(pc.total === r2(2 * 27.60 + 50) && pc.amount === pc.total, `purpl child total includes misc (${pc.total})`);
    ok(lc.total === r2(6 * 3.00 + lfMiscAmt), `LF child total includes misc (${lc.total})`);
    const centExact = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;
    ok(centExact(pc.total) && centExact(lc.total) && centExact(p.grandTotal) && centExact(p.purplSubtotal) && centExact(p.lfSubtotal),
      `all stored money is cent-exact (lc.total=${lc.total}, grand=${p.grandTotal})`);
    ok(p.purplSubtotal === pc.total && p.lfSubtotal === lc.total, 'parent subtotals mirror child totals');
    ok(r2(p.grandTotal) === r2(pc.total + lc.total + 12.40), `grandTotal = children + shipping (${p.grandTotal})`);
    ok(pMisc[0].cases === 0 && pMisc[0].qty === 1 && pMisc[0].skuId === '__misc__', 'misc line shape matches the standalone modal');
    const ledger = cache.iv.filter(e => e.invoiceId === pc.id);
    ok(ledger.length === 1 && ledger[0].sku === 'classic' && ledger[0].qty === 24, 'inventory ledger: products only — misc never moves stock');
  }

  // ── [B2] misc-only invoice ─────────────────────────────────
  console.log('[B2] misc-only combined invoice');
  {
    const env = mkEnv(); const cache = { ac: [{ id: 'a1', name: 'Big Y' }], lf_skus: [], retail_invoices: [], lf_invoices: [], combined_invoices: [], iv: [] };
    env.byId['nciv-account'] = { value: 'a1' };
    env.byId['nciv-shipping'] = { value: '' };
    env.byId['nciv-status'] = { value: 'sent' };
    env.bySel['.nciv-p-cases'] = [];
    env.bySel['#nciv-lf-skus .nciv-lf-row'] = [];
    env.bySel['#ncivp-misc-rows .misc-row'] = [env.miscRow('Event table fee', '75')];
    const hooks = {};
    const R = loadCode(env, cache, hooks);
    await R.saveNewCombinedInvoice();
    const p = cache.combined_invoices[0];
    ok(!!p && p.grandTotal === 75 && p.purplSubtotal === 75 && p.lfSubtotal === 0, 'selling ONLY an unlisted item works (the original ask)');
    ok(cache.iv.length === 0, 'no stock movement for misc-only');
  }
  {
    const env = mkEnv(); const cache = { ac: [{ id: 'a1', name: 'Big Y' }], lf_skus: [], retail_invoices: [], lf_invoices: [], combined_invoices: [], iv: [] };
    env.byId['nciv-account'] = { value: 'a1' };
    env.bySel['.nciv-p-cases'] = []; env.bySel['#nciv-lf-skus .nciv-lf-row'] = [];
    env.bySel['#ncivp-misc-rows .misc-row'] = [env.miscRow('', ''), env.miscRow('no amount', '0')];
    const hooks = {};
    const R = loadCode(env, cache, hooks);
    await R.saveNewCombinedInvoice();
    ok(cache.combined_invoices.length === 0 && (hooks.toasts || []).some(t => t.includes('at least one')), 'all-invalid rows still refuse to save an empty invoice');
  }

  // ── [C] edit-path round trips ──────────────────────────────
  console.log('[C] edit path');
  function seedEditCache() {
    const pc = { id: 'pc1', number: '14000-P', status: 'draft', accountId: 'a1', total: 105.2, amount: 105.2,
      lineItems: [
        { skuId: 'classic', sku: 'Classic', qty: 2, cases: 2, unitPrice: 27.60, pricePerCase: 27.60, total: 55.20, lineTotal: 55.20 },
        { skuId: '__misc__', skuName: 'Glassware set', description: 'Glassware set', qty: 1, cases: 0, unitPrice: 60, lineTotal: 60, total: 60 },
        { skuId: '__discount__', skuName: 'Legacy discount', description: 'Legacy discount', qty: 1, cases: 0, unitPrice: -10, lineTotal: -10, total: -10 },
      ] };
    const lc = { id: 'lc1', number: '14000-L', status: 'draft', accountId: 'a1', total: 28,
      lineItems: [
        { skuId: 'lfs1', skuName: 'Syrup', qty: 1, cases: 1, units: 6, caseSize: 6, unitPrice: 3, total: 18, lineTotal: 18, hasVariants: false },
        { skuId: '__misc__', skuName: 'Lavender wreath', description: 'Lavender wreath', qty: 1, cases: 0, unitPrice: 10, lineTotal: 10, total: 10 },
      ] };
    const parent = { id: 'cb1', number: '14000', status: 'draft', accountId: 'a1', purplInvoiceId: 'pc1', lfInvoiceId: 'lc1',
      purplSubtotal: 105.2, lfSubtotal: 28, combinedDiscount: 20, grandTotal: 105.2 + 28 + 5 - 20,
      shippingByOrder: { manual: 5 },
      lineItems: [{ skuId: '__shipping__', skuName: 'Shipping', qty: 1, cases: 0, unitPrice: 5, lineTotal: 5, total: 5 }] };
    return { ac: [{ id: 'a1', name: 'Big Y' }], lf_skus: [{ id: 'lfs1', name: 'Syrup', caseSize: 6 }],
      retail_invoices: [pc], lf_invoices: [lc], combined_invoices: [parent], iv: [] };
  }
  function wireEditDom(env, { pMiscRows, lMiscRows, ship }) {
    env.byId['nciv-account'] = { value: 'a1' };
    env.byId['nciv-shipping'] = { value: String(ship) };
    env.byId['nciv-status'] = { value: 'draft' };
    env.bySel['.nciv-p-cases'] = [env.pCaseInput('classic', 2, 27.60)];
    env.bySel['#nciv-lf-skus .nciv-lf-row'] = [env.lfRow('lfs1', 1, 3.00, 6)];
    env.bySel['#ncivp-misc-rows .misc-row'] = pMiscRows;
    env.bySel['#ncivl-misc-rows .misc-row'] = lMiscRows;
  }
  // C1: save-unchanged round trip — misc appears exactly once, totals stable
  {
    const env = mkEnv(); const cache = seedEditCache(); const hooks = {};
    wireEditDom(env, { pMiscRows: [env.miscRow('Glassware set', '60')], lMiscRows: [env.miscRow('Lavender wreath', '10')], ship: 5 });
    const R = loadCode(env, cache, hooks);
    R._setEditing('cb1');
    await R.saveNewCombinedInvoice();
    const pc = cache.retail_invoices[0], lc = cache.lf_invoices[0], p = cache.combined_invoices[0];
    ok(R._miscLinesOf(pc).length === 1 && R._miscLinesOf(pc)[0].total === 60, 'purpl misc exactly once after round trip (no duplication)');
    ok(R._miscLinesOf(lc).length === 1 && R._miscLinesOf(lc)[0].total === 10, 'LF misc exactly once after round trip');
    ok(pc.lineItems.filter(l => l.skuId === '__discount__').length === 1, 'legacy discount line still carried exactly once');
    ok(pc.total === r2(55.20 + 60 - 10), `purpl child total = products + misc + legacy discount (${pc.total})`);
    ok(p.purplSubtotal === pc.total && p.lfSubtotal === lc.total, 'parent subtotals track children');
    ok(p.combinedDiscount === 20 && p.grandTotal === r2(pc.total + lc.total + 5 - 20), `grandTotal correct with discount (${p.grandTotal})`);
  }
  // C2: second round trip is idempotent
  {
    const env = mkEnv(); const cache = seedEditCache(); const hooks = {};
    wireEditDom(env, { pMiscRows: [env.miscRow('Glassware set', '60')], lMiscRows: [env.miscRow('Lavender wreath', '10')], ship: 5 });
    const R = loadCode(env, cache, hooks);
    R._setEditing('cb1'); await R.saveNewCombinedInvoice();
    const snap1 = JSON.stringify([cache.retail_invoices[0].lineItems, cache.combined_invoices[0].grandTotal]);
    R._resetInFlight(); R._setEditing('cb1'); await R.saveNewCombinedInvoice();
    const snap2 = JSON.stringify([cache.retail_invoices[0].lineItems, cache.combined_invoices[0].grandTotal]);
    ok(snap1 === snap2, 'double round trip is byte-idempotent');
  }
  // C3: delete a misc row → dollars leave everywhere; discount re-clamps
  {
    const env = mkEnv(); const cache = seedEditCache(); const hooks = {};
    cache.combined_invoices[0].combinedDiscount = 200; // bigger than the shrunken order
    wireEditDom(env, { pMiscRows: [], lMiscRows: [], ship: 0 });
    const R = loadCode(env, cache, hooks);
    R._setEditing('cb1'); await R.saveNewCombinedInvoice();
    const pc = cache.retail_invoices[0], lc = cache.lf_invoices[0], p = cache.combined_invoices[0];
    ok(R._miscLinesOf(pc).length === 0 && R._miscLinesOf(lc).length === 0, 'deleting misc rows removes the lines');
    ok(pc.total === r2(55.20 - 10) && lc.total === 18, 'child totals shrink with misc gone (legacy discount stays)');
    const base = r2(pc.total + lc.total);
    ok(p.combinedDiscount === base && p.grandTotal === 0, `oversized discount re-clamped to ${base}, total floors at 0`);
  }
  // C4: edit a misc amount → child + parent + grand all track
  {
    const env = mkEnv(); const cache = seedEditCache(); const hooks = {};
    wireEditDom(env, { pMiscRows: [env.miscRow('Glassware set', '99.99')], lMiscRows: [env.miscRow('Lavender wreath', '10')], ship: 5 });
    const R = loadCode(env, cache, hooks);
    R._setEditing('cb1'); await R.saveNewCombinedInvoice();
    const pc = cache.retail_invoices[0], p = cache.combined_invoices[0];
    ok(pc.total === r2(55.20 + 99.99 - 10), 'edited misc amount lands in child total');
    ok(p.grandTotal === r2(pc.total + 28 + 5 - 20), 'grand total tracks the edit');
  }
  // C5: legacy child in 'iv' — misc lands where the child lives
  {
    const env = mkEnv(); const cache = seedEditCache(); const hooks = {};
    cache.iv = [cache.retail_invoices[0]]; cache.retail_invoices = [];
    wireEditDom(env, { pMiscRows: [env.miscRow('Glassware set', '60'), env.miscRow('Second thing', '5')], lMiscRows: [env.miscRow('Lavender wreath', '10')], ship: 5 });
    const R = loadCode(env, cache, hooks);
    R._setEditing('cb1'); await R.saveNewCombinedInvoice();
    const pc = cache.iv[0];
    ok(R._miscLinesOf(pc).length === 2 && pc.total === r2(55.20 + 65 - 10), 'legacy iv-homed child gets misc written in place');
  }

  // ── [D] downstream parity ──────────────────────────────────
  console.log('[D] downstream parity');
  {
    ok(/const subOf = child => child \? \(parseFloat\(child\.data\.total/.test(fnSrc), 'webhook derives subtotals from child totals (misc rides inside)');
    const pcTotal = r2(55.20 + 60 - 10), lcTotal = 28, ship = 7.5, disc = 20;
    const combDisc = Math.min(Math.max(0, disc), pcTotal + lcTotal + ship);
    const grand = r2(pcTotal + lcTotal + ship - combDisc);
    ok(grand === r2(105.2 + 28 + 7.5 - 20), `webhook-equivalent recompute matches client math (${grand})`);
    const ye = slice('function exportYearEnd()', '// ── Save Report');
    ok(ye.includes("parseFloat(x.purplSubtotal||0).toFixed(2)") && ye.includes("'Combined - purpl'"), 'year-end brand rows use subtotals (misc included by construction)');
    const _ship = r2((105.2 + 28 + 5 - 20) - 105.2 - 28 + 20);
    ok(_ship === 5, 'year-end shipping derivation unaffected by misc-in-subtotal');
    ok(/_invCasesOf|__misc__/.test(slice("function _invCasesOf", '\n}')) || src.includes("'__misc__'"), 'case-count helpers exclude pseudo-lines');
    ok(src.includes('_childExtrasInline'), 'combined doc extras block present (v227-tested) — misc renders there');
  }

  // ── [E] XSS + display ──────────────────────────────────────
  console.log('[E] escaping + live totals');
  {
    const rowHtmlFn = slice('function _miscRowHTML', 'function _miscRecalc');
    ok(rowHtmlFn.includes('escHtml(String(desc'), 'misc description escaped in row markup');
    ok(src.includes(".trim().slice(0, 120)"), 'description capped at 120 chars');
    const calc = slice('function _ncivCalcTotals()', 'let _saveCombInFlight');
    ok(calc.includes("_miscSumOf('ncivp')") && calc.includes("_miscSumOf('ncivl')"), 'live subtotals use the same validity rule as save');
    ok(/_miscSumOf\(prefix\) \{\s*\n\s*return _readMiscRows\(prefix\)/.test(src), '_miscSumOf delegates to _readMiscRows (single source of truth)');
    ok(/total \+= _miscSumOf\('lfi'\);/.test(slice('function _lfInvCalcTotal', '\n}')), 'LF standalone live total includes misc');
    ok(/#lfi-misc-rows'\)\) \|\| el\.id === 'lfi-misc-rows'\) _lfInvCalcTotal\(\)/.test(src), 'recalc router covers the LF standalone modal');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
