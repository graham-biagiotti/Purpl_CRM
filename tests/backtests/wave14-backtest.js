// Wave 14 backtests — follow-up Done/Change on cards + uncapped overdue (v237).
'use strict';
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '../../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(require('path').join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slice = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return src.slice(i, j); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('[A] structural');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const card = slice('// Canonical follow-up (single source; legacy note dates via fallback).', 'return `<div class="ac-card');
  ok(card.includes("acMarkFollowUpDone('${a.id}')") && card.includes("acChangeFollowUp('${a.id}')"),
    'FU-1: Done + Change buttons on the account card panel');
  ok(/function acMarkFollowUpDone\(id\) \{\s*\n\s*dashMarkFollowUpDone\(id, 'account'\);/.test(src),
    'FU-1: card Done reuses the proven dashboard clear (nextFollowUp:null + clearedAt)');
  const chg = slice('async function acChangeFollowUp', '\n}');
  ok(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(chg), 'FU-1: Change validates ISO date (phantom-follow-up guard)');
  ok(chg.includes('initial: cur?.what') && chg.includes('initial: cur?.date'), 'FU-1: dialog prefills current follow-up');
  ok(chg.includes('if (!v) return;'), 'FU-1: cancel changes nothing');
  const fw = slice('function renderFollowUps', 'function acMarkFollowUpDone');
  ok(fw.includes('Math.max(10, nOverdue)'), 'FU-2: overdue items never capped');
  ok(fw.includes('more upcoming'), 'FU-2: truncation is disclosed');
  ok(!fw.includes('items.slice(0,10)'), 'FU-2: raw 10-cap removed');
}

console.log('[B] dynamic');
(async () => {
  // Evaluate acNextFollowUp + acChangeFollowUp + acMarkFollowUpDone + dashMark
  // against stubs, verifying the full lifecycle: legacy surface → change →
  // done → stays silenced.
  const state = { updates: [], toasts: [] };
  const cache = { ac: [{ id: 'a1', name: 'Old Store', status: 'active',
    notes: [{ id: 'n1', date: '2026-03-01', text: 'spring visit', nextAction: 'call back', nextDate: '2026-04-12' }],
    outreach: [] }], pr: [] };
  const DB = {
    _firestoreReady: true,
    a: k => cache[k] || [],
    update: (k, id, fn) => { const arr = cache[k]; const i = arr.findIndex(x => x.id === id); if (i < 0) return false; arr[i] = fn(arr[i]); state.updates.push({ k, id }); return true; },
  };
  const document = { getElementById: () => null, querySelectorAll: () => [] };
  const window = {};
  const toast = m => state.toasts.push(String(m));
  const renderAccounts = () => {}; const renderFollowUps = () => {};
  let formResult = null;
  const formDlg = async () => formResult;
  const qs = () => null;
  void DB; void document; void window; void toast; void renderAccounts; void renderFollowUps; void formDlg; void qs;
  const code = [
    slice('const uid  =', '// Sort-direction toggles'),
    slice('function escHtml', '\nfunction '),
    slice('function acNextFollowUp(a)', '\nlet _acIdxInv'),
    slice('// FU-1: card-level Done/Change', 'function dashMarkFollowUpDone'),
    slice('function dashMarkFollowUpDone(id, type)', '\n}') + '\n}',
  ].join('\n');
  const R = eval(code + '\n;({ acNextFollowUp, acChangeFollowUp, acMarkFollowUpDone })');

  // B1: ancient legacy note date surfaces as the follow-up (the complaint)
  let nf = R.acNextFollowUp(cache.ac[0]);
  ok(nf && nf.date === '2026-04-12', `legacy buried next-step surfaces (${nf?.date}) — the stale-tile source`);

  // B2: Change writes canonical fields and takes over from legacy
  formResult = { next: 'drop samples', nextDate: '2026-10-20' };
  await R.acChangeFollowUp('a1'); await sleep(5);
  nf = R.acNextFollowUp(cache.ac[0]);
  ok(nf?.date === '2026-10-20' && nf?.what === 'drop samples', 'Change overrides the stale legacy date');

  // B3: garbage date refused, nothing written
  const before = JSON.stringify(cache.ac[0]);
  formResult = { next: 'x', nextDate: 'next week' };
  await R.acChangeFollowUp('a1'); await sleep(5);
  ok(JSON.stringify(cache.ac[0]) === before && state.toasts.some(t => t.includes('Pick a date')),
    'non-ISO date refused with guidance, account untouched');

  // B4: cancel changes nothing
  formResult = null;
  await R.acChangeFollowUp('a1'); await sleep(5);
  ok(JSON.stringify(cache.ac[0]) === before, 'cancel = no write');

  // B5: Done clears AND silences the legacy fallback permanently
  R.acMarkFollowUpDone('a1');
  const a = cache.ac[0];
  ok(a.nextFollowUp === null && a.nextFollowUpClearedAt === a.outreach[a.outreach.length - 1].date,
    'Done nulls canonical field + stamps clearedAt + logs outreach');
  nf = R.acNextFollowUp(a);
  ok(nf === null, 'after Done, the ancient legacy date does NOT resurrect');

  // B6: a NEW note after the clear can set a fresh follow-up again
  a.notes.push({ id: 'n2', date: '2099-01-01', text: 'new', nextAction: 'revisit', nextDate: '2099-02-01' });
  nf = R.acNextFollowUp(a);
  ok(nf?.date === '2099-02-01', 'entries logged after the clear still surface (lifecycle intact)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
