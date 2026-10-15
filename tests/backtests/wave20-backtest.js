// Wave 20 backtests — v246: portal orders gain a "handled" terminal state.
// The queue's only exit used to be Confirm (which creates an invoice), so an
// order redone manually — or re-opened by voiding its invoice — sat as "not
// reviewed" forever. Void/delete now ASK re-open vs handled.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] handled is a real terminal state');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  ok(/handled:'Handled ✓'/.test(src) && /handled:'green'/.test(src), 'status vocabulary includes Handled');
}
{
  const mh = slc(src, 'async function markPortalOrderHandled(orderId)', '\n}\n');
  ok(mh.includes("formDlg('Mark handled — no invoice will be created'"), 'one-dialog confirm + optional note');
  ok(mh.includes('if (ans === null) return;'), 'cancel aborts cleanly');
  ok(/handledAt|handledBy|handledNote/.test(mh) && mh.includes("status: 'handled'"), 'stamps who/when/note');
  ok(/_samePortalSubmission\(o, p\)/.test(mh) && /!\['confirmed', 'declined', 'handled'\]\.includes\(twin\.status\)/.test(mh),
    'dual-brand twin marked too, unless already terminal');
  ok(mh.includes("auditLog('portal_handled'"), 'audit-logged');
}

console.log('[A2] queue affordances + guards');
{
  const all = slc(src, 'function _renderPoAll', '\nfunction _renderPoUnmatched');
  ok(all.includes("markPortalOrderHandled('${o.id}')") && all.includes('✓ Handled'),
    'All-pane rows offer ✓ Handled');
  ok((all.match(/o\.status!=='handled'/g) || []).length >= 2,
    'Confirm/Decline hidden once handled');
  // Stale-tab Confirm cannot invoice a handled order.
  const cpo = slc(src, 'async function confirmPortalOrder()', 'if (!d) {');
  ok(cpo.includes("data.status === 'confirmed' || data.status === 'handled'"),
    'confirm transaction treats handled as terminal');
  ok(src.includes("toast('This order was already confirmed or marked handled')"), 'honest refusal toast');
  // A handled twin can never be claimed into a combined confirm.
  ok(src.includes("p.status !== 'confirmed' && p.status !== 'handled' && _samePortalSubmission(d, p)"),
    'paired-claim skips handled twins');
  // Nav badge ignores handled.
  ok(src.includes("d.status !== 'declined' && d.status !== 'handled' && !sampleHandled"),
    'waiting-badge excludes handled');
}

console.log('[A3] void/delete ask instead of silently re-opening (gate F1/F2/F7)');
{
  // Gate F1: ONE shared question, and CANCEL (= Esc, backdrop, navigation)
  // maps to the RECOVERABLE outcome (re-open) — dismissal must never write
  // the irreversible 'handled' state.
  const ask = slc(src, 'async function _askPortalOutcome', '\n}');
  ok(ask.includes("okLabel: 'Mark handled (done manually)', cancelLabel: 'Re-open portal order'"),
    'handled is the DELIBERATE (OK) choice; cancel re-opens (gate F1)');
  ok(/return handled\s*\? \{ status: 'handled'/.test(ask) && ask.includes("{ status: 'new', confirmedAt: null, convertedOrderId: null }"),
    'dismissal restores the old recoverable reset');
  ok(/'Invoice ' \+ \(invNumber \|\| ''\) \+ ' ' \+ verb/.test(ask), 'handled note self-documents (voided/deleted)');
  // Gate F2: one helper applies the outcome to primary + same-submission twin,
  // used by BOTH flows.
  const helper = slc(src, 'function _applyPortalOutcome', '\n}\n');
  ok(helper.includes('d.ref.update(patch)') && helper.includes("where('status', '==', 'confirmed')"),
    'shared helper covers the paired twin');
  ok((src.match(/_askPortalOutcome\(rec\.number \|\| rec\.invoiceNumber/g) || []).length === 2,
    'void AND delete both ask');
  ok((src.match(/_applyPortalOutcome\(portalOrderId, rec\.accountId/g) || []).length === 2,
    'void AND delete both apply through the helper (void used to skip the twin)');
  // Gate F7: toasts say what actually happened.
  ok(!src.includes("toast('Combined invoice deleted · portal order reset')"), 'false delete toast removed');
  ok((src.match(/portal order marked handled' : ' · portal order re-opened'/g) || []).length === 2,
    'void + delete toasts reflect the chosen outcome');
}

console.log('[A4] stale-row guards (gate F3–F6)');
{
  const mh = slc(src, 'async function markPortalOrderHandled(orderId)', '\n}\n');
  ok(/runTransaction/.test(mh) && /\['confirmed', 'declined', 'handled'\]\.includes\(st\)/.test(mh),
    'F3: ✓ Handled is transactional — cannot blind-overwrite a just-confirmed order');
  ok(mh.includes('This order is already '), 'F3: blocked click explains itself');
  ok(src.includes("['confirmed', 'handled', 'declined'].includes(ps.data().status)) return false"),
    'F4: pair-claim transaction rejects ALL terminal states');
  const dec = slc(src, 'async function declinePortalOrder', '\n}\n');
  ok(/\['confirmed', 'handled', 'declined'\]\.includes\(o\.status\)/.test(dec),
    'F5: Decline refuses terminal orders');
  ok(dec.includes("!['confirmed','declined','handled'].includes(p.status)"),
    'F5: declined twin-sweep skips handled');
  const pr = slc(src, 'async function createProspectFromPortalOrder', '\n}\n');
  ok(/if \(!o\.status \|\| o\.status === 'new'\) \{/.test(pr),
    'F6: → Prospect no longer reverts a terminal order to reviewed');
}

console.log('[B] dynamic — badge rendering');
{
  const labels = new Function(slc(src, 'const PO_STATUS_LABELS', ';') + '; return PO_STATUS_LABELS;')();
  const cls = new Function(slc(src, 'const PO_STATUS_CLS', ';') + '; return PO_STATUS_CLS;')();
  const badge = new Function('PO_STATUS_CLS', 'PO_STATUS_LABELS',
    slc(src, 'function _poStatusBadge', '\n}') + '\n}\nreturn _poStatusBadge;')(cls, labels);
  ok(badge('handled') === '<span class="badge green">Handled ✓</span>', 'handled badge renders green');
  ok(badge('new').includes('amber') && badge('confirmed').includes('green'), 'existing badges untouched');
  ok(badge('weird') === '<span class="badge gray">weird</span>', 'unknown statuses degrade as before');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
