// Wave 30 backtests — v258 road app wave 2: the Demos tab. fieldDemoList
// serves the sampler's requests as data with PRE-BUILT token URLs into the
// existing hardened sampling-action pages (accept/decline/run-sheet/report/
// calendar) — a better inbox, not a new mutation surface. field.html gains
// the two-tab shell, the demos views, and (gate-F6 closure from v257) her
// entries now show restock/payment/problem outcomes.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const fld = fs.readFileSync(path.join(__dirname, '../../public/field.html'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + fieldDemoList');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const dl = slc(fnSrc, 'exports.fieldDemoList', '\n// ── Road cards');
  ok(dl.includes("['field', 'employee', 'admin'].includes(role)"), 'field role allowed in');
  ok(dl.includes("'pending_sampler', 'proposed_alt', 'needs_reschedule', 'confirmed', 'completed'"),
    'queries the full live lifecycle');
  ok(dl.includes('if (!r.samplerActionToken) return;'), 'tokenless rows never emitted');
  // The action URLs must be the SAME actions the packet email's buttons carry
  // — confirm1/confirm2/no (an earlier draft used the proposed-alt saccept
  // actions, which would have hit the wrong branch).
  ok(dl.includes("link('confirm1')") && dl.includes("link('confirm2')") && dl.includes("link('no')"),
    'needs-answer buttons use the packet-email actions');
  ok(dl.includes("link('sheet')") && dl.includes("link('report')"), 'run-sheet + report links pre-built');
  ok(dl.includes('_samplingWindowText(r)'), 'time windows go through the single source (custom text included)');
  ok(dl.includes('_samplingTodayET()'), 'today/past math uses the ET helper (not server UTC)');
  ok(/reported: !!\(r\.report && r\.report\.reportedAt\)/.test(dl), 'report state derived from the real field');
  ok(dl.includes('30 * 864e5'), 'old reported demos age out of the payload');
  ok(dl.includes('_samplingConfig()') && dl.includes('cfg.samplerKey'), 'availability calendar URL from settings');
  ok((dl.match(/S\(/g) || []).length >= 12, 'fields length-capped');
}

console.log('[B] field app — tab shell + demos views');
{
  ['tab-btn-visits', 'tab-btn-demos', 'tab-visits', 'tab-demos', 'demo-badge',
   'demo-today-card', 'demo-ask-card', 'demo-report-card', 'demo-booked', 'btn-demo-cal']
    .forEach(id => ok(fld.includes(`id="${id}"`), `markup: #${id}`));
  ok(fld.includes("httpsCallable('fieldDemoList')") && fld.includes('pcrm_field_demos_v1'),
    'demo list loaded + cached for dead-zone mornings');
  ok(fld.includes('they need signal') || fld.includes('need signal'),
    'online-required actions say so instead of pretending');
  const rd = slc(fld, 'function renderDemos()', '\n  // ── Store list');
  ok(rd.includes("d.kind === 'booked' && d.isToday"), 'today\'s demo pinned');
  ok(/d\.kind === 'done' && !d\.reported\) \|\| \(d\.kind === 'booked' && d\.isPast && !d\.reported/.test(rd),
    'owe-a-report covers completed AND past-confirmed-unreported');
  ok(rd.includes('asks.length + owe.length'), 'tab badge counts what needs HER');
  const btn = slc(fld, 'const _demoBtn =', ';\n');
  ok(btn.includes('esc(url)') && btn.includes('rel="noopener"'), 'action links escaped + noopener');
  const lg = slc(fld, 'function _demoLogi(d)', '\n  }');
  ok((lg.match(/esc\(/g) || []).length >= 7 && lg.includes('encodeURIComponent'),
    'logistics fields all escaped; maps link URI-encoded');
}

console.log('[B2] v258 gate fixes');
{
  // F1: today/past recomputed at RENDER time (cached payloads age safely)
  ok(/const _today = /.test(fld) && /isToday: d\.date === _today, isPast: \(d\.date \|\| ''\) < _today/.test(fld),
    "yesterday's demo can never wear the TODAY pin off a cached payload (gate F1)");
  // F2: sign-out clears the token-bearing caches
  ok(/localStorage\.removeItem\(DEMO_CACHE_KEY\); localStorage\.removeItem\(STORE_CACHE_KEY\);/.test(fld)
     && fld.includes("demoData = { demos: [], calUrl: '' }; demosLoaded = false;"),
    'sign-out wipes demo/store caches + state (shared phone, gate F2)');
  // F4: unreported past demos never age out of owe-a-report
  const dl2 = slc(fnSrc, 'exports.fieldDemoList', '\n// ── Road cards');
  ok(/cutoff && r\.report && r\.report\.reportedAt\) return;/.test(dl2),
    'confirmed rows age out only once reported (gate F4)');
}

console.log('[C] gate-F6 closure — she sees outcomes');
{
  const det = slc(fld, 'function _entryDetailHTML(l)', '\n  function _entryEditHTML');
  ok(det.includes("l.restockStatus === 'invoiced'") && det.includes('Waiting for Graham'),
    'restock shows invoiced/handled/dismissed/waiting');
  ok(det.includes("l.paymentStatus === 'applied'") && det.includes('keep it safe'),
    'payment shows applied/dismissed/waiting');
  ok(det.includes("l.problemStatus === 'resolved'") && det.includes('l.problemResolution'),
    'problem shows the resolution note');
  ok(det.includes('Array.isArray(l.restock.items)') && det.includes('parseInt(i.cases, 10) || 0'),
    'her own renderer keeps the v257 coercion discipline');
  ok(det.includes("typeof l.problem === 'string'"), 'hostile-shape problem renders empty, not [object Object]');
  ok(fld.includes("${l.restock ? ' 🔁' : ''}${l.payment ? ' 💵' : ''}${l.problem ? ' ⚠️' : ''}"),
    'entry rows carry the extras markers');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
