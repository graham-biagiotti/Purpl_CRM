// Randomized two-client fuzz against the REAL db.js on the Firestore emulator.
// Ownership model makes loss detectable: each client only writes docs/keys it
// owns, so the final server value of every owned doc must equal the owner's
// last write — any deviation is a lost update or a stale clobber. A third
// direct writer simulates a Cloud Function (ShipStation webhook) writing docs
// straight to Firestore; those must propagate to both clients despite the
// constant dirty/modal churn. Run: node fuzz-tests.js [seed]  (TRACE=1 for
// deterministic-seed diagnostics.) Recreated into the repo 2026-10-06.
'use strict';
const H = require('./harness');
const { doc, setDoc } = require('firebase/firestore');

const SEED = parseInt(process.argv[2] || '42', 10);
let rng = SEED;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rand() * a.length)];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };

async function main() {
  await H.wipe();
  const cols = { ac: [], iv: [] };
  for (let i = 0; i < 10; i++) {
    cols.ac.push({ id: 'A_ac' + i, name: 'A acct ' + i, v: 0, _updatedAt: '2026-09-01T00:00:00.000Z' });
    cols.ac.push({ id: 'B_ac' + i, name: 'B acct ' + i, v: 0, _updatedAt: '2026-09-01T00:00:00.000Z' });
    cols.iv.push({ id: 'A_iv' + i, amount: 100, v: 0, _updatedAt: '2026-09-01T00:00:00.000Z' });
    cols.iv.push({ id: 'B_iv' + i, amount: 100, v: 0, _updatedAt: '2026-09-01T00:00:00.000Z' });
  }
  await H.seed({
    _dbVersion: 2,
    settings: { seq: 0 },            // owned by A
    invoice_settings: { seq: 0 },    // owned by B
    quick_notes: [],                 // owned by A
    saved_reports: [],               // owned by B
  }, cols);

  const A = H.makeClient('fzA' + SEED), B = H.makeClient('fzB' + SEED);
  const W = H.makeClient('fzW' + SEED); // raw third writer (Cloud Function stand-in) — DB never inited
  await A.DB.init('userA', A.compat);
  await B.DB.init('userB', B.compat);
  await H.sleep(500);

  // Expected final state per owned doc/key (the owner's last write wins by
  // construction — nobody else ever writes it).
  const exp = { ac: new Map(), iv: new Map(), cfg: { settings: 0, invoice_settings: 0, quick_notes: 0, saved_reports: 0 } };
  cols.ac.forEach(d => exp.ac.set(d.id, 0));
  cols.iv.forEach(d => exp.iv.set(d.id, 0));
  const created = { A: [], B: [] };
  const webhookDocs = [];

  // ── optional trace instrumentation (TRACE=1, deterministic seeds) ──
  const T0 = Date.now(); const trace = [];
  const TR = process.env.TRACE ? (m) => trace.push(`${String(Date.now() - T0).padStart(6)} ${m}`) : () => {};
  if (process.env.TRACE) {
    const { collection: mcol, onSnapshot: msnap } = require('firebase/firestore');
    msnap(mcol(B.fs, 'workspace/main/iv'), s => {
      const d = s.docs.find(x => x.id === 'B_iv7');
      const chg = s.docChanges().map(c => `${c.doc.id}:${c.type}${c.doc.metadata.hasPendingWrites ? '*' : ''}`).join(',');
      TR(`B-listener iv event B_iv7=${d ? d.data().v : '-'} pend=${s.metadata.hasPendingWrites} changes=[${chg}]`);
    });
    let lastV = null, lastCfg = null;
    setInterval(() => { try {
      const c = B.DB.a('iv').find(x => x.id === 'B_iv7');
      const v = c ? c.v : '-';
      if (v !== lastV) { TR(`B-cache B_iv7 ${lastV} -> ${v} (exp=${exp?.iv?.get('B_iv7')})`); lastV = v; }
      const cf = (B.DB.get('saved_reports')[0] || {}).seq ?? '-';
      if (cf !== lastCfg) { TR(`B-cache saved_reports ${lastCfg} -> ${cf} (exp=${exp?.cfg?.saved_reports})`); lastCfg = cf; }
    } catch (_) {} }, 4).unref();
    for (const [nm, C] of [['A', A.DB], ['B', B.DB]]) {
      const orig = C._drainDeferred.bind(C);
      C._drainDeferred = function () {
        if (this._deferredRemote && this._deferredRemote.size) TR(`${nm}-drain keys=[${[...this._deferredRemote]}]`);
        return orig();
      };
    }
  }

  function step(client, who) {
    const DB = client.DB;
    const own = id => id.startsWith(who + '_');
    const r = rand();
    if (r < 0.28) {                                    // bump an owned account
      const ids = [...exp.ac.keys()].filter(id => own(id) && exp.ac.get(id) !== 'deleted');
      if (!ids.length) return;
      const id = pick(ids); const nv = exp.ac.get(id) + 1;
      if (DB.update('ac', id, x => ({ ...x, v: nv }))) exp.ac.set(id, nv);
    } else if (r < 0.42) {                             // atomicUpdate an owned invoice
      const ids = [...exp.iv.keys()].filter(id => own(id) && exp.iv.get(id) !== 'deleted');
      if (!ids.length) return;
      const id = pick(ids); const nv = exp.iv.get(id) + 1;
      DB.atomicUpdate(c => { const d = (c.iv || []).find(x => x.id === id); if (d) d.v = nv; });
      if ((DB.a('iv').find(x => x.id === id) || {}).v === nv) exp.iv.set(id, nv);
      if (id === 'B_iv7') TR(`B-op atomic B_iv7 -> ${nv} (applied=${(DB.a('iv').find(x => x.id === id) || {}).v === nv})`);
    } else if (r < 0.52) {                             // create a new owned account
      const id = who + '_new' + created[who].length;
      DB.push('ac', { id, name: 'new ' + id, v: 1 });
      exp.ac.set(id, 1); created[who].push(id);
    } else if (r < 0.60) {                             // delete one of our fuzz-created accounts
      const live = created[who].filter(id => exp.ac.get(id) !== 'deleted');
      if (!live.length) return;
      const id = pick(live);
      DB.remove('ac', id); exp.ac.set(id, 'deleted');
    } else if (r < 0.72) {                             // owned config object write
      const key = who === 'A' ? 'settings' : 'invoice_settings';
      const nv = exp.cfg[key] + 1;
      DB.setObj(key, { seq: nv }); exp.cfg[key] = nv;
    } else if (r < 0.82) {                             // owned config array write
      const key = who === 'A' ? 'quick_notes' : 'saved_reports';
      const nv = exp.cfg[key] + 1;
      DB.set(key, [{ id: 'n', seq: nv }]); exp.cfg[key] = nv;
    } else if (r < 0.92) {                             // modal churn
      if (DB._dirty) DB.markClean(); else DB.markDirty();
    } else {                                           // no-op atomicUpdate (must write nothing)
      DB.atomicUpdate(() => {});
    }
  }

  const ROUNDS = 400;
  console.log(`fuzzing ${ROUNDS} rounds (seed ${SEED})…`);
  for (let i = 0; i < ROUNDS; i++) {
    if (rand() < 0.5) { step(A, 'A'); step(B, 'B'); } else { step(B, 'B'); step(A, 'A'); }
    if (i % 25 === 24) {                               // direct "Cloud Function" write
      const id = 'W_iv' + webhookDocs.length;
      await setDoc(doc(W.fs, 'workspace/main/iv/' + id), { id, amount: 999, source: 'webhook', v: 1 });
      webhookDocs.push(id);
      exp.iv.set(id, 1);
    }
    if (rand() < 0.6) await H.sleep(Math.floor(rand() * 20));
  }

  // settle: close modals, let debounces/drains finish
  A.DB.markClean(); B.DB.markClean();
  await H.sleep(1500);
  A.DB.markClean(); B.DB.markClean();
  await H.sleep(4000);

  // ── verify server truth against the ownership oracle ──
  const svAc = await H.serverCol('ac');
  const svIv = await H.serverCol('iv');
  let acLost = [], ivLost = [];
  exp.ac.forEach((v, id) => {
    if (v === 'deleted') { if (svAc[id]) acLost.push(id + ':undead'); }
    else if ((svAc[id] || {}).v !== v) acLost.push(`${id}: server=${svAc[id]?.v} expected=${v}`);
  });
  exp.iv.forEach((v, id) => {
    if ((svIv[id] || {}).v !== v) ivLost.push(`${id}: server=${svIv[id]?.v} expected=${v}`);
  });
  ok(acLost.length === 0, `accounts: zero lost updates across ${exp.ac.size} docs ${acLost.length ? JSON.stringify(acLost.slice(0, 5)) : ''}`);
  ok(ivLost.length === 0, `invoices: zero lost atomic updates across ${exp.iv.size} docs ${ivLost.length ? JSON.stringify(ivLost.slice(0, 5)) : ''}`);

  const svCfg = await H.serverConfig();
  ok(svCfg.settings?.seq === exp.cfg.settings, `config settings seq ${svCfg.settings?.seq} == ${exp.cfg.settings}`);
  ok(svCfg.invoice_settings?.seq === exp.cfg.invoice_settings, `config invoice_settings seq ${svCfg.invoice_settings?.seq} == ${exp.cfg.invoice_settings}`);
  ok((svCfg.quick_notes?.[0]?.seq || 0) === exp.cfg.quick_notes, `config quick_notes seq == ${exp.cfg.quick_notes}`);
  ok((svCfg.saved_reports?.[0]?.seq || 0) === exp.cfg.saved_reports, `config saved_reports seq == ${exp.cfg.saved_reports}`);

  // ── convergence: both caches match the server ──
  const converged = await H.until(() => {
    const chk = (DB) => {
      for (const [id, v] of exp.ac) {
        const c = DB.a('ac').find(x => x.id === id);
        if (v === 'deleted') { if (c) return false; }
        else if (!c || c.v !== v) return false;
      }
      for (const [id, v] of exp.iv) {
        const c = DB.a('iv').find(x => x.id === id);
        if (!c || c.v !== v) return false;
      }
      return true;
    };
    A.DB.markClean(); B.DB.markClean();
    return chk(A.DB) && chk(B.DB);
  }, 15000, 500);
  ok(converged, 'both clients converge to the server state');
  if (!converged) {
    for (const [nm, DB] of [['A', A.DB], ['B', B.DB]]) {
      const bad = [];
      for (const [id, v] of exp.ac) {
        const c = DB.a('ac').find(x => x.id === id);
        if (v === 'deleted' ? !!c : (!c || c.v !== v)) bad.push(`ac/${id} cache=${c ? c.v : 'missing'} exp=${v}`);
      }
      for (const [id, v] of exp.iv) {
        const c = DB.a('iv').find(x => x.id === id);
        if (!c || c.v !== v) bad.push(`iv/${id} cache=${c ? c.v : 'missing'} exp=${v}`);
      }
      console.log(`  [diag ${nm}] stale=${JSON.stringify(bad.slice(0, 8))}`);
      console.log(`  [diag ${nm}] deferred=${JSON.stringify([...DB._deferredRemote])} dirtyKeys=${JSON.stringify([...DB._saveDirtyKeys])} dirtyIds=${JSON.stringify(Object.fromEntries(Object.entries(DB._dirtyIds).map(([k, s]) => [k, [...s]])))} dirtyDel=${JSON.stringify(Object.fromEntries(Object.entries(DB._dirtyDeletes).map(([k, s]) => [k, [...s]])))} dirty=${DB._dirty} atomic=${!!DB._atomicInProgress}`);
    }
  }
  if (process.env.TRACE && fail) {
    console.log('--- trace (last 80) ---');
    trace.slice(-80).forEach(l => console.log('  ' + l));
  }
  A.DB._unsubscribers.forEach(fn => fn());
  B.DB._unsubscribers.forEach(fn => fn());
  console.log(`\n${pass} passed, ${fail} failed (seed ${SEED})`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
