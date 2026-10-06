// Wave 13 backtests — BS1 sweep fixes (v236).
// (Recreated into the repo 2026-10-06 — final state incl. verify-fixes:
// fired-timer self-null and the prefill-gated counter override.)
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('[A] structural');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const heal = slc(src, 'function _clearReadyToSend', '\n}');
  ok(heal.includes('readyToSend: false') && !heal.replace(/\/\/[^\n]*/g, '').includes('delete '),
    'heal sets readyToSend:false (merge-visible), no field delete');
  ok(dbSrc.includes('_cfgValue(k)'), '_cfgValue normalizer exists');
  const uses = (dbSrc.match(/this\._cfgValue\(k\)/g) || []).length;
  ok(uses >= 6, `normalizer used across save/sync/shadow/apply/diff (${uses} sites)`);
  ok(/delete c\.nextInvoiceNum/.test(dbSrc), 'normalizer strips nextInvoiceNum');
  const sis = slc(src, 'function saveInvoiceSettings', '\nfunction loadInvoiceSettings');
  ok(sis.includes("set({ invoice_settings: { nextInvoiceNum: _typedNum } }, { merge: true })"),
    'deliberate Settings override uses a field-targeted direct write');
  // (gate verify-fix: gate now compares vs prefill — asserted below)
  const wire = slc(dbSrc, 'if (!this._onlineWired)', '\n    }\n');
  ok(wire.includes("visibilitychange"), 're-drive wired to tab re-focus');
  ok(wire.includes('setInterval(() => redrive(false), 60000)'), 're-drive heartbeat every 60s');
  ok(wire.includes('filter(k => !this._saveTimers[k])'), 'only truly-stuck keys re-driven (timers respected)');
  // Verify-fix: a FIRED debounce timer must null its own entry, or the filter
  // above excludes exactly the parked keys redrive exists to rescue.
  ok(/setTimeout\(\(\) => \{ this\._saveTimers\[key\] = null; this\._doSave\(key\); \}, 500\)/.test(dbSrc),
    'fired debounce timers null their own _saveTimers entry');
  // Verify-fix residual: the Settings counter override compares against the
  // page-load PREFILL, not live cache.
  const sis2 = slc(src, 'function saveInvoiceSettings', '\nfunction loadInvoiceSettings');
  ok(sis2.includes('_typedNum !== _prefillNum'), 'override gate compares typed vs prefill');
  ok(slc(src, 'function loadInvoiceSettings', '\n}').includes('dataset.prefill'), 'prefill stamped at page load');
  ok(wire.includes('this._configRetries = 0'), 'config retry counter reset on re-drive');
  const rmp = slc(src, 'function retryMissingPins', '\n}');
  ok(rmp.includes('geocodeFailed: false') && !/copy = \{ \.\.\.copy \}; delete copy\.geocodeFailed/.test(rmp),
    'map-pin unpark writes false at top level (nested locs[] deletes stay — arrays replace wholesale)');
  ok(src.includes('delete copy.id; delete copy.number;'), 'pre-insert clone deletes untouched (safe class)');
}

console.log('[B] dynamic — config layer never carries the counter');
function makeDB(configSets) {
  const window = {
    FirestoreAPI: {
      doc: () => ({ set: (d) => { configSets.push(JSON.parse(JSON.stringify(d))); return Promise.resolve(); }, get: () => Promise.resolve({ exists: false }), onSnapshot: () => () => {} }),
      getDoc: r => r.get(), setDoc: (r, d, o) => r.set(d, o), onSnapshot: (r, ...a) => r.onSnapshot(...a),
    },
    addEventListener: () => {}, toast: undefined, refreshCurrentPage: undefined,
  };
  const document = { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  void window; void document; void localStorage;
  const DB = eval(dbSrc + '\n;DB');
  DB._db = { collection: () => ({ doc: () => ({ set: () => Promise.resolve(), delete: () => Promise.resolve(), onSnapshot: () => () => {} }), get: () => Promise.resolve({ docs: [] }), onSnapshot: () => () => {} }), batch: () => ({ set(){}, delete(){}, commit: () => Promise.resolve() }) };
  DB._firestoreReady = true;
  return DB;
}
(async () => {
  // B1: routine save strips the counter, keeps everything else
  {
    const sets = []; const DB = makeDB(sets);
    DB._cache.invoice_settings = { nextInvoiceNum: 99, terms: 30, footerNotes: 'x' };
    DB._saveConfig(['invoice_settings']);
    await sleep(20);
    const p = sets[0].invoice_settings;
    ok(p && !('nextInvoiceNum' in p) && p.terms === 30 && p.footerNotes === 'x',
      'routine config save payload has NO counter, all other fields intact');
  }
  // B2: a counter-only change never marks invoice_settings dirty in atomicUpdate
  {
    const sets = []; const DB = makeDB(sets);
    DB._cache.invoice_settings = { nextInvoiceNum: 5, terms: 30 };
    DB._snapshotCfgPersisted();
    DB.atomicUpdate(c => { c.invoice_settings = { ...c.invoice_settings, nextInvoiceNum: 6 }; });
    await sleep(120);
    ok(sets.length === 0, 'counter-only change produces ZERO config writes (diff normalized)');
  }
  // B3: a real settings change still writes (without the counter)
  {
    const sets = []; const DB = makeDB(sets);
    DB._cache.invoice_settings = { nextInvoiceNum: 5, terms: 30 };
    DB._snapshotCfgPersisted();
    DB.atomicUpdate(c => { c.invoice_settings = { ...c.invoice_settings, nextInvoiceNum: 6, terms: 45 }; });
    await sleep(120);
    ok(sets.length === 1 && sets[0].invoice_settings.terms === 45 && !('nextInvoiceNum' in sets[0].invoice_settings),
      'real change writes once, stripped');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
