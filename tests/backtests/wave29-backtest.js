// Wave 29 backtests — v257 road app wave 1: fieldRoadCards (full customer +
// prospect book, owner's 11/09 reversal of the 8/28 prospects-only rule),
// the field app's visit extras (restock / payment / problem), the rules that
// make their resolution stamps staff-only, and the CRM Field-page queues
// whose approvals stamp them (restock → prefilled invoice with a
// same-day-invoice guard; payment → mark paid; problem → resolve).
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const fld = fs.readFileSync(path.join(__dirname, '../../public/field.html'), 'utf8');
const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + road-cards function');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const rc = slc(fnSrc, 'exports.fieldRoadCards', '\nexports.');
  ok(rc.includes("['field', 'employee', 'admin'].includes(role)"), 'field role allowed in');
  ok(fnSrc.includes('REVERSING the 8/28'), 'the visibility reversal is documented at the code');
  ok(rc.includes("workspace/main/ac") && rc.includes("workspace/main/pr"),
    'reads the REAL account book (not the slim token mirror)');
  ok(/if \(a\.status === 'closed'\) return null;/.test(rc), 'closed accounts excluded');
  ok(rc.includes("p.status === 'won' || p.status === 'lost'"), 'dead prospects excluded');
  ok(rc.includes("openInvoice: !!open[d.id]") && rc.includes('lastOrderSummary'),
    'cards carry open-balance + last-order info');
  ok(/st === 'void'\) return;/.test(rc) && rc.includes("!['paid', 'draft', 'void'].includes(st)"),
    'open-balance maths skip void/draft');
  ok(rc.includes("filter((s) => s && !s.archived && s.name)"), 'LF catalog excludes archived SKUs');
  ok((rc.match(/S\(/g) || []).length >= 15, 'card fields length-capped');
}

console.log('[B] field app — extras UI + submit payload');
{
  ok(fld.includes("pcrm_field_cards_v1") && fld.includes("httpsCallable('fieldRoadCards')"),
    'app loads road cards under a NEW cache key (old prospects-only cache ignored)');
  ok(fld.includes('catalog = (res.data && res.data.catalog)') && /stores, catalog \}\)/.test(fld),
    'catalog cached alongside cards for offline restock picking');
  ['x-restock-btn', 'x-payment-btn', 'x-problem-btn', 'x-restock-rows', 'x-pay-amount', 'x-problem-text']
    .forEach(id => ok(fld.includes(`id="${id}"`), `extras markup: #${id}`));
  ok(fld.includes('Has an open invoice') && fld.includes('tel:') && fld.includes('maps.google.com'),
    'road card shows open-balance marker + tap-to-call + tap-to-navigate');
  // Run the REAL gather/validation shapes statically
  ok(/function _gatherRestock\(\)[\s\S]{0,700}slice\(0, 20\)/.test(fld), 'restock capped at 20 items');
  ok(/Math\.min\(cases, 99\)/.test(fld), 'case counts capped');
  ok(/function _gatherPayment\(\)[\s\S]{0,400}amount > 0/.test(fld), 'payment requires a positive amount');
  ok(fld.includes("if (xOpen.restock && !_rk)") && fld.includes('if (xOpen.payment && !_pm)'),
    'open-but-empty extras block the submit with a clear toast');
  ok(/if \(mode !== 'place'\) \{[\s\S]{0,600}entry\.restock = _rk/.test(fld),
    'extras ride the entry only on real stops');
  ok(!/restockStatus|paymentStatus|problemStatus/.test(slc(fld, 'const entry = {', 'const id = uid();')),
    'statuses are ABSENT at create (approval stamps them, rules enforce)');
  ok(fld.includes('_resetExtras(); // v257'), 'extras reset with the form');
}

console.log('[C] rules — extras shaped at create, stamps staff-only (emulator-proven in rules-tests.js)');
{
  const cr = slc(rules, 'match /field_logs/{logId}', 'allow delete: if isAdmin();');
  ok(cr.includes('request.resource.data.restock.items.size() <= 20'), 'restock shape guard');
  ok(cr.includes('request.resource.data.payment.amount > 0')
     && cr.includes('request.resource.data.payment.amount < 100000'), 'payment shape guard');
  ok(cr.includes('request.resource.data.problem.size() <= 2000'), 'problem length guard');
  ["restockStatus", "paymentStatus", "problemStatus", "restockInvoiceId", "resolvedAt", "resolvedBy"]
    .forEach(k => ok(cr.includes(`!('${k}' in request.resource.data)`), `create cannot forge ${k}`));
  // Gate F3 CONTRACT CHANGE: extras are CREATE-ONLY for the rep — the update
  // tier had no value guards, so create-time shapes were bypassable one write
  // later (and a non-list items crashed the owner's review page).
  ok(!/'restock', 'payment', 'problem'\]\)/.test(cr),
    'extras are NOT in the rep update allowlist (create-only, gate F3)');
  ok(cr.includes("restock.keys().hasOnly(['items', 'note'])")
     && cr.includes("payment.keys().hasOnly(['amount', 'method', 'checkNum'])"),
    'extras maps are key-locked (gate F4)');
  const emuRules = fs.readFileSync(path.join(__dirname, '../../tests/emu/firestore.rules'), 'utf8');
  ok(emuRules === rules, 'emulator rules copy in sync');
}

console.log('[D] CRM queues — run the REAL pending filters');
{
  const qf = slc(src, 'function _flPendingQueues()', '\nfunction _flInvoicedToday');
  const pending = new Function('_flLogs', qf + '\nreturn _flPendingQueues();')([
    { id: '1', restock: { items: [{}] } },
    { id: '2', restock: { items: [{}] }, restockStatus: 'invoiced' },
    { id: '3', payment: { amount: 50 } },
    { id: '4', payment: { amount: 9 }, paymentStatus: 'applied' },
    { id: '5', problem: 'broken cans' },
    { id: '6', problem: 'old', problemStatus: 'resolved' },
    { id: '7', notes: 'plain visit' },
  ]);
  ok(pending.restocks.length === 1 && pending.restocks[0].id === '1', 'restock queue = pending only');
  ok(pending.payments.length === 1 && pending.payments[0].id === '3', 'payment queue = pending only');
  ok(pending.problems.length === 1 && pending.problems[0].id === '5', 'problem queue = pending only');

  const g = slc(src, 'function _flInvoicedToday(accountId)', '\n}') + '\n}';
  const mkDB = rows => ({ a: () => rows });
  const run = (rows, acId) => new Function('DB', 'today', g + "\nreturn _flInvoicedToday(arguments[2]);")(mkDB(rows), () => '2026-11-10', acId);
  ok(run([{ accountId: 'a1', status: 'sent', date: '2026-11-10' }], 'a1') === true,
    'same-day invoice trips the duplicate guard');
  ok(run([{ accountId: 'a1', status: 'void', date: '2026-11-10' }], 'a1') === false, 'voided same-day does not');
  ok(run([{ accountId: 'a1', status: 'sent', date: '2026-11-09' }], 'a1') === false, 'yesterday does not');

  // Approve wiring contracts
  const qr = slc(src, 'function _renderFlQueues()', '\nfunction renderFieldLog()');
  ok(qr.indexOf('openInvModal(null, l.accountId') < qr.indexOf('window._pendingRestockLog ='),
    'approve opens the modal FIRST, then arms the stamp flag (openInvModal clears stale flags)');
  ok(qr.includes(".filter(i => i.brand !== 'lf')"), 'prefill carries only purpl items into the purpl modal');
  // (v259 reshaped again: LF already-paid = no-op success, never un-toggled)
  ok(/markLfInvPaid\(invId\)[\s\S]{0,160}markCombinedPaid\(invId\)[\s\S]{0,120}markRetailInvPaid\(invId\)/.test(qr),
    'payment apply routes to the right mark-paid per collection');
  ok(qr.includes('already invoiced TODAY'), 'duplicate-invoice warning rendered');

  // The stamp hook: only new invoices, matching account, fresh flag
  const hook = slc(src, '// v257: a restock-approve opened this modal', '\n  }');
  ok(hook.includes('_isNew && window._pendingRestockLog'), 'stamp only on a CREATED invoice');
  ok(hook.includes('p.accountId === accountId') && hook.includes("15 * 60000"),
    'stamp requires same account within 15 minutes (no leak onto unrelated invoices)');
  ok(src.includes("window._pendingRestockLog = null;\n  const isNew = !id;"),
    'any other modal open clears a stale approve flag');
  ok(idx.includes('Field <span id="nav-field-log-badge"'), "sidebar label shortened to 'Field'");

  // Gate F1/F2: rep-device data rendered in the OWNER'S session — cases is
  // numeric-coerced at BOTH sinks, items tolerated non-array.
  ok(/parseInt\(i\.cases, 10\) \|\| 0\}× /.test(src), 'queue coerces cases numeric (gate F1)');
  ok(src.includes('Array.isArray(l.restock.items)'), 'queue tolerates a hostile non-list (gate F3 crash-proofing)');
  // (v259: coercion now lives in the aggregation loop — surface F4)
  ok(/_agg\[i\.sku\] = \(_agg\[i\.sku\] \|\| 0\) \+ \(parseInt\(i\.cases, 10\) \|\| 0\);/.test(src), 'invoice prefill coerces cases (gate F2)');
  ok(src.includes("parseInt(existing?.cases, 10) || 0; // gate F2"), 'shared line renderer coerces too');
  ok((src.match(/try \{ _renderFlQueues\(\); \} catch/g) || []).length >= 2,
    'one bad doc can never kill the review page (gate F3)');
  // Gate F5: a refused mark-paid never stamps the payment applied.
  // (v259: tightened to a strict !== true gate with the LF no-op-success path)
  ok(src.includes('if (_ok !== true) return;'),
    'payment stamp gated on the flip actually happening (gate F5)');
  ok((src.match(/return true; \/\/ gate F5/g) || []).length === 3
     && (src.match(/return false; \} \/\/ (v253 \/ )?gate F5/g) || []).length >= 2,
    'mark-paid helpers report success honestly');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
