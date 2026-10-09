// Wave 18 backtests — v244: portal order notes reach the invoices.
// The customer's "Order Notes" (merged with staff confirm-modal notes) were
// stored on the internal order records but every invoice-creation site in
// confirmPortalOrder hardcoded notes to the bare provenance line — so the
// note never reached the invoice Notes section or the ShipStation packing
// slip (the auto-push sends inv.notes).
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] structural — confirmPortalOrder notes plumbing');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const fn = slc(src, 'async function confirmPortalOrder()', '\nasync function ');
  ok(/const _invNotes = d\.notes\s*\?\s*d\.notes \+ '\\n— Auto-drafted from portal order\.'\s*:\s*'Auto-drafted from portal order\.'/.test(fn),
    'invoice notes = customer+staff notes first, provenance line kept');
  ok((fn.match(/notes: _invNotes,/g) || []).length === 5,
    'ALL FIVE invoice sites use it (combined parent, both children, single purpl, single LF)');
  ok(!fn.includes("notes: 'Auto-drafted from portal order.',"),
    'no invoice site still hardcodes the bare provenance line');
  // The staff confirm-modal merge (pre-existing) still feeds d.notes BEFORE
  // _invNotes is derived, and the order records still carry the raw notes.
  ok(fn.indexOf('d.notes = [d.notes, _staffNotes]') < fn.indexOf('const _invNotes'),
    'staff-note merge happens before the invoice notes are derived');
  ok((fn.match(/notes: d\.notes \|\| '',/g) || []).length === 2,
    'internal order records still carry the raw notes (unchanged)');
  // Nothing anywhere matches on the exact provenance string (safe to prefix).
  const refs = (src.match(/Auto-drafted from portal order/g) || []).length;
  ok(refs === 2, `provenance string exists only at its two definition points (${refs})`);
}

console.log('[B] dynamic — the notes expression itself');
{
  const expr = (notes) => { const d = { notes }; return d.notes ? d.notes + '\n— Auto-drafted from portal order.' : 'Auto-drafted from portal order.'; };
  ok(expr('Deliver to back door, ask for Sue') === 'Deliver to back door, ask for Sue\n— Auto-drafted from portal order.',
    'customer note leads, provenance follows');
  ok(expr('') === 'Auto-drafted from portal order.', 'empty note → provenance line only (pre-v244 look)');
  ok(expr(undefined) === 'Auto-drafted from portal order.', 'missing note → provenance line only');
  // The merged staff-note shape (pre-existing " — " join) passes through intact.
  ok(expr('customer text — staff addition').startsWith('customer text — staff addition\n'),
    'merged customer+staff notes pass through intact');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
