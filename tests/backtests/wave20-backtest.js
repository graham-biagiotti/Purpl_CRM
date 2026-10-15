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

console.log('[A3] void/delete ask instead of silently re-opening');
{
  // Both flows (combined VOID + combined DELETE) present the same choice.
  ok((src.match(/okLabel: 'Re-open portal order', cancelLabel: 'Mark handled'/g) || []).length === 2,
    'void AND delete ask re-open vs handled');
  // NB: two preview shells carry #civ-btn-void — anchor on the v246 comment,
  // which lives in the combined (portal-born) one.
  const voidBlk = slc(src, 'voiding a portal-born invoice used to SILENTLY', "toast('Invoice voided'");
  ok(/const patch = reopen\s*\? \{ status: 'new', confirmedAt: null, convertedOrderId: null \}/.test(voidBlk),
    'void: re-open restores the old reset behavior');
  ok(voidBlk.includes('voided — handled manually'), 'void: handled path self-documents in the note');
  const delBlk = slc(src, 'async function deleteCombinedInvoice', "closeModal('modal-combined-invoice')");
  ok(delBlk.includes("okLabel: 'Re-open portal order', cancelLabel: 'Mark handled'"),
    'DELETE asks the same choice');
  ok((delBlk.match(/_poPatch/g) || []).length >= 4 && delBlk.includes('d.ref.update(_poPatch)'),
    'delete applies the chosen outcome to primary AND the paired twin');
  ok(!delBlk.includes('reset linked portal orders so you can re-confirm'),
    'stale confirm copy removed');
  ok(delBlk.includes("deleted — handled manually"), 'delete: handled note self-documents');
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
