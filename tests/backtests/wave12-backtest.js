// Wave 12 backtests — invoice date-range filters + audit fixes 2/3/4 (v235).
// (Recreated into the repo 2026-10-06 — final state incl. gate regressions
// G1-G7: brand-native LF readers, paid-family inference, range corners, and
// the unified-list due-chain parity fix.)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slice = (a, b) => {
  const i = src.indexOf(a); const j = src.indexOf(b, i + 1);
  if (i < 0 || j < 0) throw new Error('slice not found: ' + a);
  return src.slice(i, j);
};
const iso = (deltaDays) => {
  const d = new Date(); d.setDate(d.getDate() + deltaDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// ── [A] structural ──
console.log('[A] structural');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const o = (htmlSrc.match(/<div\b/g) || []).length, c = (htmlSrc.match(/<\/div>/g) || []).length;
  ok(o === c, `index.html divs balanced (${o}/${c})`);
  ['all', '30', '60', '90', 'month', 'year', 'custom'].forEach(m =>
    ok(htmlSrc.includes(`data-range="${m}"`), `range chip: ${m}`));
  ok(htmlSrc.includes('id="inv-range-from"') && htmlSrc.includes('id="inv-range-to"'), 'custom date inputs present');
  ok(/if \(_rf \|\| _rt\) list = list\.filter\(r => r\.issued/.test(src), 'unified list filters by issue date in window');
  ok(src.includes("const paid = _lfRepPaid(cutoff);") &&
     (src.match(/const paid = _lfRepPaid\(cutoff\);/g) || []).length === 2,
     'LF report AND its CSV export share the same paid bucket');
}

// ── shared eval environment ──
const kpiCalls = [];
function mkEnv(cache) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, value: '', style: {}, innerHTML: '', textContent: '', classList: { toggle(){}, add(){}, remove(){} } });
  const document = { querySelectorAll: () => [], querySelector: (s) => el('q:' + s), getElementById: (id) => el(id) };
  const window = {};
  const qs = (s) => el('q:' + s);
  const DB = { a: k => cache[k] || [], obj: (k, d = {}) => cache[k] || d };
  const kpiHtml = (label, value, color) => { kpiCalls.push({ label, value, color }); return `[${label}=${value}]`; };
  const daysAgo = (s) => { if (!s) return 999; const d = s.includes('T') ? new Date(s) : new Date(s + 'T12:00:00'); return Math.floor((Date.now() - d) / 864e5); };
  void document; void window; void qs; void DB; void kpiHtml; void daysAgo;
  const code = [
    slice('const uid  =', '// Sort-direction toggles'),
    slice('function escHtml', '\nfunction '),
    slice('function _allPurplInvoices()', 'function findInvoice'),
    'const _invAmt = ' + (src.match(/const _invAmt\s*=\s*([^;]+);/) || [,"inv => parseFloat(inv.grandTotal || inv.amount || inv.total || 0)"])[1] + ';',
    slice('function _invEventDate(inv)', '\n}') + '\n}',
    slice('let _invRange = ', 'function setInvRange'),
    'function _invRangeChipsSync(){}',
    slice('function renderInvKpis()', '\nfunction renderInvColPurpl'),
    slice('function _lfRepPaid(cutoff)', '\nfunction renderLfReports'),
    slice('function renderLfInvoicesPage()', '\n  // Overdue list') + '\n}',
  ].join('\n');
  return { els, run: () => eval(code + '\n;({ renderInvKpis, renderLfInvoicesPage, _lfRepPaid, _invRangeBounds, _setRange: (m,f,t)=>{_invRange={mode:m,from:f||"",to:t||""};} })') };
}

(async () => {
  const r2 = n => Math.round(n * 100) / 100;

  // ── [B] _invRangeBounds ──
  console.log('[B] range bounds');
  {
    const env = mkEnv({}); const R = env.run();
    R._setRange('all');
    let b = R._invRangeBounds();
    ok(b.from === null && b.to === null, 'all time → no bounds');
    R._setRange('30'); b = R._invRangeBounds();
    ok(b.from === iso(-30) && b.to === null, `last 30d → from ${b.from} (local-date math)`);
    R._setRange('month'); b = R._invRangeBounds();
    ok(b.from === iso(0).slice(0, 8) + '01', 'this month → 1st of month');
    R._setRange('year'); b = R._invRangeBounds();
    ok(b.from === iso(0).slice(0, 4) + '-01-01', 'this year → Jan 1');
    R._setRange('custom', '2026-01-01', '2026-02-01'); b = R._invRangeBounds();
    ok(b.from === '2026-01-01' && b.to === '2026-02-01', 'custom passthrough');
  }

  // ── [C] KPI harmonization (finding 2) + windowing ──
  console.log('[C] invoice-page KPIs');
  const CACHE = {
    ac: [],
    retail_invoices: [
      { id: 'p1', number: '1', accountId: 'a', status: 'sent', amount: 100, date: iso(-10), dueDate: iso(20) },
      { id: 'p2', number: '2', accountId: 'a', status: 'void', amount: 999, date: iso(-5), dueDate: iso(-1) },
      { id: 'p3', number: '3', accountId: 'a', status: 'draft', amount: 40, date: iso(-3) },
      { id: 'pc', number: '9-P', accountId: 'a', status: 'sent', amount: 60, date: iso(-8), combinedInvoiceId: 'cb' },
      { id: 'pold', number: '4', accountId: 'a', status: 'paid', amount: 70, date: iso(-90), paidDate: iso(-2) },
    ],
    iv: [],
    lf_invoices: [
      { id: 'l1', number: 'L1', accountId: 'a', status: 'paid', total: 50, issued: iso(-6), paidDate: iso(-1) },
      { id: 'lc', number: '9-L', accountId: 'a', status: 'sent', total: 70, issued: iso(-8), combinedInvoiceId: 'cb' },
    ],
    combined_invoices: [
      { id: 'cb', number: '9', accountId: 'a', status: 'sent', purplInvoiceId: 'pc', lfInvoiceId: 'lc',
        purplSubtotal: 60, lfSubtotal: 70, combinedDiscount: 5, grandTotal: 137.4, date: iso(-8), dueDate: iso(-2),
        shippingByOrder: { manual: 12.4 } },
    ],
    dist_invoices: [
      { id: 'd1', number: 'D1', status: 'sent', total: 80, dateIssued: iso(-40), dueDate: iso(-3) },
    ],
  };
  {
    kpiCalls.length = 0;
    const env = mkEnv(CACHE); const R = env.run();
    R._setRange('all');
    R.renderInvKpis();
    const kv = Object.fromEntries(kpiCalls.map(k => [k.label, k.value]));
    ok(kv['Total Invoiced'] === '$477.40', `Total Invoiced incl. combined ship−disc once (${kv['Total Invoiced']})`);
    ok(kv['Outstanding'] === '$317.40', `Outstanding (${kv['Outstanding']})`);
    ok(kv['Overdue'] === '$217.40', `Overdue — combined parent + dist counted, void ignored (${kv['Overdue']})`);
    const expMTD = [iso(-1), iso(-2)].filter(d => d >= iso(0).slice(0, 8) + '01').length === 2 ? '$120.00' : '$50.00';
    ok(kv['Collected This Month'] === expMTD, `Collected MTD by paid date (${kv['Collected This Month']})`);
    const reportsTotal = r2([...CACHE.retail_invoices, ...CACHE.lf_invoices, ...CACHE.combined_invoices, ...CACHE.dist_invoices]
      .filter(x => !x.combinedInvoiceId && (x.status || 'draft') !== 'void')
      .reduce((s, x) => s + parseFloat(x.grandTotal || x.amount || x.total || 0), 0));
    ok('$' + reportsTotal.toFixed(2) === kv['Total Invoiced'], 'MATCHES Reports "Total Invoiced (All Brands)" by construction');
  }
  {
    kpiCalls.length = 0;
    const env = mkEnv(CACHE); const R = env.run();
    R._setRange('30');
    R.renderInvKpis();
    const kv = Object.fromEntries(kpiCalls.map(k => [k.label, k.value]));
    ok(kv['Invoiced (last 30 days)'] === '$327.40', `windowed Invoiced excludes old + keeps window (${kv['Invoiced (last 30 days)']})`);
    ok(kv['Outstanding (last 30 days)'] === '$237.40', `windowed Outstanding (${kv['Outstanding (last 30 days)']})`);
    ok(kv['Collected (last 30 days)'] === '$120.00', `windowed Collected counts old invoice paid recently (${kv['Collected (last 30 days)']})`);
  }

  // ── [D] LF invoices page (finding 3) ──
  console.log('[D] LF page KPIs');
  {
    kpiCalls.length = 0;
    const env = mkEnv({
      lf_invoices: [
        { id: 'v', status: 'void', total: 100, due: iso(-5) },
        { id: 'd', status: 'draft', total: 50 },
        { id: 's', status: 'sent', total: 75, due: iso(5) },
        { id: 'o', status: 'sent', total: 25, dueDate: iso(-3) },   // portal-style: dueDate only
        { id: 'p', status: 'paid', total: 500, due: iso(-30) },
      ],
      lf_wix_deductions: [{ id: 'w', confirmed: false }],
    });
    const R = env.run();
    R.renderLfInvoicesPage();
    const kv = Object.fromEntries(kpiCalls.map(k => [k.label, k.value]));
    ok(kv['Outstanding'] === '$100.00', `LF Outstanding excludes void+draft (${kv['Outstanding']}) — was $250 under the old rule`);
    ok(kv['Overdue'] === '$25.00', `portal LF invoice (dueDate-only) now shows overdue (${kv['Overdue']})`);
    ok(kv['Pending LF Deductions'] === 1, 'Wix pending count intact');
  }

  // ── [E] LF report Collected (finding 4) ──
  console.log('[E] LF report paid bucket');
  {
    const env = mkEnv({
      lf_invoices: [
        { id: 'a', status: 'paid', total: 10, issued: iso(-60), paidDate: iso(-5) },
        { id: 'b', status: 'paid', total: 20, issued: iso(-5), paidDate: iso(-60) },
        { id: 'c', status: 'paid', total: 40, issued: iso(-10) },
        { id: 'd', status: 'sent', total: 80, issued: iso(-5) },
      ],
    });
    const R = env.run();
    const cutoff = iso(-30);
    const bucket = R._lfRepPaid(cutoff);
    const ids = bucket.map(x => x.id).sort().join(',');
    ok(ids === 'a,c', `paid bucket by PAID date w/ legacy fallback (got ${ids})`);
    ok(R._lfRepPaid(null).length === 3, 'all-time bucket keeps every paid invoice');
  }

  // ── [G] gate-fix regressions (v235 REFUTED findings) ──
  console.log('[G] gate-fix regressions');
  // G1: stale LF twins — KPI must prefer modal-native fields
  {
    kpiCalls.length = 0;
    const env = mkEnv({
      ac: [], retail_invoices: [], iv: [], combined_invoices: [], dist_invoices: [],
      lf_invoices: [
        { id: 'x', status: 'sent', amount: 100, total: 250, date: iso(-90), issued: iso(-5), dueDate: iso(-40), due: iso(20) },
      ],
    });
    const R = env.run();
    R._setRange('all'); R.renderInvKpis();
    let kv = Object.fromEntries(kpiCalls.map(k => [k.label, k.value]));
    ok(kv['Total Invoiced'] === '$250.00', `G1 finding 1: KPI reads fresh total, not stale amount (${kv['Total Invoiced']})`);
    ok(kv['Overdue'] === '$0.00', `G1 finding 2: fresh due date wins — no false overdue (${kv['Overdue']})`);
    kpiCalls.length = 0;
    R._setRange('30'); R.renderInvKpis();
    kv = Object.fromEntries(kpiCalls.map(k => [k.label, k.value]));
    ok(kv['Invoiced (last 30 days)'] === '$250.00', 'G1 finding 3: windowing uses fresh issued date (KPI agrees with the list)');
  }
  // G2: save path writes both field pairs
  {
    const core = slice('function _saveLfInvoiceCore', '\nasync function deleteLfInvoice');
    ok(core.includes('date: issued, dueDate: due, amount: total'), 'G2: LF save keeps legacy twins in step');
  }
  // G3: LF overdue card uses due→dueDate for display
  {
    const card = slice('// Overdue list', 'markLfInvPaid');
    ok(card.includes('inv.due || inv.dueDate') && !card.includes("daysAgo(inv.due||'')"), 'G3 finding 4: overdue card dates dueDate-only rows correctly');
  }
  // G4 (advisory A): legacy combined parent with both children paid reads as paid
  {
    kpiCalls.length = 0;
    const env = mkEnv({
      ac: [], iv: [], dist_invoices: [],
      retail_invoices: [{ id: 'pc', status: 'paid', amount: 60, date: iso(-10), combinedInvoiceId: 'cb' }],
      lf_invoices: [{ id: 'lc', status: 'paid', total: 40, issued: iso(-10), combinedInvoiceId: 'cb' }],
      combined_invoices: [{ id: 'cb', status: 'sent', purplInvoiceId: 'pc', lfInvoiceId: 'lc', grandTotal: 100, date: iso(-10), dueDate: iso(-2) }],
    });
    const R = env.run();
    R._setRange('all'); R.renderInvKpis();
    const kv = Object.fromEntries(kpiCalls.map(k => [k.label, k.value]));
    ok(kv['Outstanding'] === '$0.00' && kv['Overdue'] === '$0.00',
      `G4 advisory A: pre-sync paid family never shows Outstanding/Overdue (out=${kv['Outstanding']})`);
  }
  // G5 (advisory C): custom TO-only range collects through that date
  {
    kpiCalls.length = 0;
    const env = mkEnv({
      ac: [], iv: [], dist_invoices: [], combined_invoices: [], lf_invoices: [],
      retail_invoices: [{ id: 'p', status: 'paid', amount: 30, date: iso(-200), paidDate: iso(-190) }],
    });
    const R = env.run();
    R._setRange('custom', '', iso(-100)); R.renderInvKpis();
    const kv = kpiCalls.map(k => k.value);
    ok(kv[3] === '$30.00', `G5 advisory C: TO-only custom range counts old collections (${kv[3]})`);
  }
  // G6 (advisory F): _lfRepPaid fallback includes created
  {
    const env = mkEnv({ lf_invoices: [{ id: 'c', status: 'paid', total: 5, created: iso(-3) }] });
    const R = env.run();
    ok(R._lfRepPaid(iso(-30)).length === 1, 'G6 advisory F: created-only legacy paid row stays collectable in window');
  }
  // G7 (gate verify residual): the unified list badge classifies with the
  // same per-brand due chain the row displays — no red Overdue next to a
  // future due date on drifted LF rows.
  {
    const listFn = slice('function renderInvUnifiedList()', '\n// 🏭 Push to Warehouse');
    ok(/const effStatus = \(x, due\) =>/.test(listFn) && listFn.includes('st: effStatus(x, opts.due || \'\')'),
      'G7: list badge uses the displayed due chain (LF due→dueDate)');
    ok(!/const due = x\.dueDate \|\| x\.due/.test(listFn), 'G7: no dueDate-first chain left in the list classifier');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
