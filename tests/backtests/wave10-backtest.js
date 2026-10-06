// Wave 10 backtests — multiuser data layer (M1-M4 + gate fixes + fuzz fixes),
// db.js. Static structural scans + dynamic tests against a stubbed compat db
// with controllable failures. (Recreated into the repo 2026-10-06 after a
// scratchpad wipe — final state including G1-G6 gate/fuzz regressions.)
'use strict';
const fs = require('fs');
const path = require('path');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── [A] version lockstep ─────────────────────────────────────
console.log('[A] version lockstep');
{
  const appV = appSrc.match(/APP_VERSION = '(v\d+)'/)?.[1];
  const swV = swSrc.match(/purpl-crm-(v\d+)/)?.[1];
  ok(appV && swV && appV === swV, `APP_VERSION (${appV}) matches sw.js CACHE (${swV})`);
}

// ── [B] structural scans on db.js ────────────────────────────
console.log('[B] db.js structural guarantees');
{
  const sc = dbSrc.slice(dbSrc.indexOf('_saveCollection(key) {'), dbSrc.indexOf('_saveConfig(keys) {'));
  ok(sc.includes('_dirtyIds[key]'), 'M1: _saveCollection reads the per-doc dirty set');
  ok(!/const items = this\._cache\[key\]/.test(sc), 'M1: _saveCollection no longer iterates the whole cache');
  ok(sc.includes('batch.delete('), 'M1: _saveCollection can retry queued deletes');
  ok(sc.includes('i += 400'), 'M1: batches chunked under the 500-op cap');

  const au = dbSrc.slice(dbSrc.indexOf('atomicUpdate(fn) {'), dbSrc.indexOf('async importFromLocalStorage'));
  ok(au.includes('JSON.stringify(x)'), 'M2: atomicUpdate snapshots pre-state for change detection');
  ok(/prevJson === undefined \|\| prevJson !== JSON\.stringify\(item\)/.test(au), 'M2: only changed/new docs are stamped+marked');
  ok(!/COLLECTION_KEYS\.forEach\(k => this\._saveCollection\(k\)\)/.test(au), 'M2: no all-collections flush remains');
  ok(/changedCols\.forEach\(k => this\._saveCollection\(k\)\)/.test(au), 'M2: flush covers only changed collections');
  ok(/this\._saveConfig\(changedCfg\)/.test(au), 'M2: config flush passes only changed keys');
  ok(/\[\.\.\.changedCols, \.\.\.changedCfg\]\.forEach\(k => this\._saveDirtyKeys\.add\(k\)\)/.test(au), 'M2: changed keys marked dirty for the unload window');
  ok(au.includes('this._drainDeferred(); // M4'), 'M4: atomicUpdate drains after completion');

  const scf = dbSrc.slice(dbSrc.indexOf('_saveConfig(keys) {'), dbSrc.indexOf('_updateSyncUI(status) {'));
  ok(scf.includes('list.forEach(k => {'), 'M3: _saveConfig builds payload from the named keys only');
  ok(/setTimeout\(\(\) => this\._saveConfig\(list\)/.test(scf), 'M3: retry re-passes the same key list');
  ok(/list\.forEach\(k => this\._saveDirtyKeys\.add\(k\)\)/.test(scf), 'M3: exhausted retries re-queue only carried keys');

  const mc = dbSrc.slice(dbSrc.indexOf('markClean() {'), dbSrc.indexOf('applyPendingRemote() {'));
  const mcCode = mc.replace(/\/\/[^\n]*/g, ''); // comment-aware: prose may name the forbidden call
  ok(mcCode.includes('this._drainDeferred()'), 'M4: markClean drains instead of dropping');
  ok(!mcCode.includes('_loadFromCollections'), 'M4: markClean still never does a whole-cache reload');
  ok(!/this\._pendingRemoteChanges = false;/.test(mcCode), 'M4: markClean no longer silently clears the pending flag');

  ok((dbSrc.match(/this\._deferredRemote\.add\(/g) || []).length >= 2, 'M4: both listeners queue deferred keys');
  const dd = dbSrc.slice(dbSrc.indexOf('_drainDeferred() {'), dbSrc.indexOf('// ── Migration from single-doc'));
  ok(dd.includes("if (this._dirty || this._atomicInProgress) return;"), 'M4: drain refuses to run while blocked');
  ok(dd.indexOf('_deferredSnaps[key]') > 0 && dd.indexOf('_deferredSnaps[key]') < dd.indexOf('.get()'),
    'M4: drain prefers the latest DELIVERED snapshot (ordered, no fetch race); fetch is fallback only');
  ok((dbSrc.match(/this\._deferredSnaps\[/g) || []).length >= 4,
    'M4: listeners store the latest snapshot on EVERY event (incl. local echoes)');
  ok((dd.match(/_saveDirtyKeys\.has\(key\)/g) || []).length >= 2, 'M4: drain skips keys mid-save (pre- and post-fetch)');

  const wd = dbSrc.slice(dbSrc.indexOf('_writeDoc(key, item) {'), dbSrc.indexOf('// ── Public API ──'));
  ok(wd.includes('this._markDocDirty(key, item.id)'), 'M1: failed immediate write re-queues that doc');
  ok(wd.includes('this._markDocDeleted(key, id)'), 'M1: failed immediate delete queues the DELETE for retry');

  const fp = dbSrc.slice(dbSrc.indexOf('_flushPendingSave() {'), dbSrc.indexOf('_replayRecovery() {'));
  ok(fp.includes('_ids.has(it.id)'), 'M1: recovery blob captures only unconfirmed (dirty) docs');
  ok(fp.includes('ids.has(item.id)'), 'M1: unload flush fires only unconfirmed docs');
  ok(fp.includes('this._saveConfig(cfgDirty)'), 'M3: unload flush writes only dirty config keys');

  const rr = dbSrc.slice(dbSrc.indexOf('_replayRecovery() {'), dbSrc.indexOf('_doSave(key) {'));
  ok(rr.includes('this._saveConfig(restoredCfgKeys)'), 'M3: recovery replay writes only restored config keys');

  const ds = dbSrc.slice(dbSrc.indexOf('_doSave(key) {'), dbSrc.indexOf('_saveCollection(key) {'));
  ok(ds.includes('this._saveConfig(cfgKeys)'), 'M3: debounced config saves coalesce and pass keys');
}

// ── [C] dynamic tests with a stubbed compat db (failure injection) ──
console.log('[C] dynamic failure-injection tests');

function makeStub() {
  const log = { sets: [], deletes: [], commits: 0, configSets: [] };
  const behavior = { failNextCommits: 0, failCode: 'unavailable', failNextDocSets: 0, failNextDocDeletes: 0 };
  const mkDocRef = (p, id) => ({
    id,
    set: (data, opts) => {
      if (behavior.failNextDocSets > 0) { behavior.failNextDocSets--; return Promise.reject({ code: behavior.failCode, message: 'stub' }); }
      log.sets.push({ path: p, id, data: JSON.parse(JSON.stringify(data)), opts });
      return Promise.resolve();
    },
    delete: () => {
      if (behavior.failNextDocDeletes > 0) { behavior.failNextDocDeletes--; return Promise.reject({ code: behavior.failCode, message: 'stub' }); }
      log.deletes.push({ path: p, id });
      return Promise.resolve();
    },
    get: () => Promise.resolve({ exists: false, data: () => null, id }),
    onSnapshot: () => () => {},
  });
  const db = {
    collection: (p) => ({
      doc: (id) => mkDocRef(p, id),
      get: () => Promise.resolve({ docs: [], docChanges: () => [], metadata: {} }),
      onSnapshot: () => () => {},
    }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push({ type: 'set', id: ref.id, data: JSON.parse(JSON.stringify(data)), opts }),
        delete: (ref) => ops.push({ type: 'delete', id: ref.id }),
        commit: () => {
          if (behavior.failNextCommits > 0) { behavior.failNextCommits--; return Promise.reject({ code: behavior.failCode, message: 'stub' }); }
          log.commits++;
          ops.forEach(op => op.type === 'set' ? log.sets.push({ batch: true, id: op.id, data: op.data }) : log.deletes.push({ batch: true, id: op.id }));
          return Promise.resolve();
        },
      };
    },
  };
  return { db, log, behavior };
}

function makeDB(stub) {
  const window = {
    FirestoreAPI: {
      doc: () => ({ set: (d, o) => { stub.log.configSets.push(JSON.parse(JSON.stringify(d))); return Promise.resolve(); }, get: () => Promise.resolve({ exists: false }), onSnapshot: () => () => {} }),
      getDoc: (ref) => ref.get(),
      setDoc: (ref, d, o) => ref.set(d, o),
      onSnapshot: (ref, ...a) => ref.onSnapshot(...a),
    },
    addEventListener: () => {}, toast: undefined, refreshCurrentPage: undefined,
  };
  const document = { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  void window; void document; void localStorage;
  const DB = eval(dbSrc + '\n;DB');
  DB._db = stub.db;
  DB._firestoreReady = true;
  return DB;
}

(async () => {
  // C1: transient batch failure re-marks ids; retry writes them
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.ac = [{ id: 'X', v: 1 }, { id: 'Y', v: 1 }];
    DB._markDocDirty('ac', 'X');
    stub.behavior.failNextCommits = 1;
    DB._saveCollection('ac');
    await sleep(50);
    ok(DB._dirtyIds.ac.has('X'), 'transient commit failure re-marks the attempted id');
    await sleep(2100); // retry fires via _doSave after 2s
    ok(stub.log.sets.some(s => s.id === 'X') && !stub.log.sets.some(s => s.id === 'Y'),
      'retry writes ONLY the dirty doc, never the neighbor');
  }
  // C2: permanent failure does NOT re-mark (changes-not-saved parity)
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.ac = [{ id: 'X', v: 1 }];
    DB._markDocDirty('ac', 'X');
    stub.behavior.failNextCommits = 1; stub.behavior.failCode = 'permission-denied';
    DB._saveCollection('ac');
    await sleep(50);
    ok(!DB._dirtyIds.ac?.has('X'), 'permanent failure drops the id (no endless retry)');
  }
  // C3: failed immediate delete queues the delete; batch retries it
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.ac = [{ id: 'X' }];
    stub.behavior.failNextDocDeletes = 1;
    DB.remove('ac', 'X');
    await sleep(30);
    ok(DB._dirtyDeletes.ac?.has('X'), 'failed delete lands in _dirtyDeletes');
    DB._saveCollection('ac');
    await sleep(30);
    ok(stub.log.deletes.some(d => d.batch && d.id === 'X'), 'batch retry actually DELETES (old code lost it)');
    ok(!DB._dirtyDeletes.ac.has('X'), 'confirmed delete clears the queue');
  }
  // C4: unmarked cache docs are never written
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.iv = [{ id: 'I1' }, { id: 'I2' }, { id: 'I3' }];
    DB._markDocDirty('iv', 'I2');
    DB._saveCollection('iv');
    await sleep(30);
    const ids = stub.log.sets.map(s => s.id);
    ok(ids.length === 1 && ids[0] === 'I2', `only the marked doc is written (saw ${JSON.stringify(ids)})`);
  }
  // C5: _saveConfig(['settings']) payload carries only that key
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.settings = { company: 'purpl' };
    DB._cache.invoice_settings = { nextInvoiceNum: 99 };
    DB._cache.lf_skus = [{ id: 's1' }];
    DB._saveConfig(['settings']);
    await sleep(30);
    const p = stub.log.configSets[0];
    ok(p && p.settings && !('invoice_settings' in p) && !('lf_skus' in p) && p._dbVersion === 2,
      'config payload = _dbVersion + named key only');
  }
  // C6: atomicUpdate throw clears the in-progress flag
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.ac = [{ id: 'X', v: 1 }];
    let threw = false;
    try { DB.atomicUpdate(() => { throw new Error('boom'); }); } catch (_) { threw = true; }
    ok(threw && !DB._atomicInProgress, 'throwing mutator clears _atomicInProgress');
  }
  // C7: atomicUpdate on 600 changed docs chunks into 2+ commits
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.pr = Array.from({ length: 600 }, (_, i) => ({ id: 'P' + i, v: 1 }));
    DB.atomicUpdate(c => c.pr.forEach(p => { p.v = 2; }));
    await sleep(150);
    ok(stub.log.commits >= 2 && stub.log.sets.filter(s => s.batch).length === 600,
      `600 changed docs → ${stub.log.commits} chunked commits, all written`);
  }
  // C8: drain refuses while dirty, runs after markClean (fallback-fetch path)
  {
    const stub = makeStub(); const DB = makeDB(stub);
    let fetched = 0;
    stub.db.collection = (p) => ({
      doc: () => ({ set: () => Promise.resolve(), delete: () => Promise.resolve(), onSnapshot: () => () => {} }),
      get: () => { fetched++; return Promise.resolve({ docs: [{ id: 'A9', data: () => ({ name: 'remote' }) }] }); },
      onSnapshot: () => () => {},
    });
    DB._deferredRemote.add('ac');
    DB.markDirty();
    DB._drainDeferred();
    ok(fetched === 0 && DB._deferredRemote.has('ac'), 'drain is a no-op while a modal is open');
    DB.markClean();
    await sleep(30);
    ok(fetched === 1, 'markClean triggers the fallback fetch (no stored snap)');
    ok(DB._cache.ac?.[0]?.name === 'remote' && DB._cache.ac[0].id === 'A9', 'fetched state replaces the cache');
    ok(!DB._deferredRemote.has('ac'), 'drained key leaves the queue');
  }
  // C9: drain fetch failure re-queues the key
  {
    const stub = makeStub(); const DB = makeDB(stub);
    stub.db.collection = () => ({
      doc: () => ({ set: () => Promise.resolve(), delete: () => Promise.resolve(), onSnapshot: () => () => {} }),
      get: () => Promise.reject(new Error('offline')),
      onSnapshot: () => () => {},
    });
    DB._deferredRemote.add('ac');
    DB._drainDeferred();
    await sleep(30);
    ok(DB._deferredRemote.has('ac'), 'failed drain fetch re-queues the key for the next drain');
  }
  // C10: drain skips a key that is mid-save
  {
    const stub = makeStub(); const DB = makeDB(stub);
    let fetched = 0;
    stub.db.collection = () => ({
      doc: () => ({ set: () => Promise.resolve(), delete: () => Promise.resolve(), onSnapshot: () => () => {} }),
      get: () => { fetched++; return Promise.resolve({ docs: [] }); },
      onSnapshot: () => () => {},
    });
    DB._deferredRemote.add('ac');
    DB._saveDirtyKeys.add('ac');
    DB._drainDeferred();
    await sleep(20);
    ok(fetched === 0 && DB._deferredRemote.has('ac'), 'mid-save key is skipped, stays queued');
    DB._saveDirtyKeys.delete('ac');
  }
  // C11: set() on a collection (seed path) marks every id
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB.set('ac', [{ id: 'N1' }, { id: 'N2' }]);
    ok(DB._dirtyIds.ac?.has('N1') && DB._dirtyIds.ac?.has('N2'), 'whole-array set marks all items dirty');
  }
  // C12: append-only collections never delete and never re-set existing docs
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.audit_log = [{ id: 'L1' }, { id: 'L2' }];
    stub.db.collection = (p) => ({
      doc: (id) => ({ id, set: () => Promise.resolve(), delete: () => Promise.resolve(), onSnapshot: () => () => {} }),
      get: () => Promise.resolve({ docs: [{ id: 'L1' }] }), // L1 already on server
      onSnapshot: () => () => {},
    });
    DB._markDocDirty('audit_log', 'L1');
    DB._markDocDirty('audit_log', 'L2');
    DB._markDocDeleted('audit_log', 'L1'); // hostile: try to queue a delete
    DB._markDocDirty('audit_log', 'L2');
    DB._saveCollection('audit_log');
    await sleep(30);
    ok(!stub.log.deletes.length, 'append-only: no deletes issued');
    const setIds = stub.log.sets.filter(s => s.batch).map(s => s.id);
    ok(!setIds.includes('L1'), 'append-only: existing doc not re-set');
  }
  // C13: atomicUpdate leaves unchanged rows unstamped and unmarked
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.ac = [{ id: 'K1', v: 1, _updatedAt: 'T0' }, { id: 'K2', v: 1, _updatedAt: 'T0' }];
    DB.atomicUpdate(c => { c.ac.find(x => x.id === 'K1').v = 2; });
    ok(DB._cache.ac[1]._updatedAt === 'T0', 'untouched row keeps its _updatedAt');
    await sleep(150);
    const ids = stub.log.sets.filter(s => s.batch).map(s => s.id);
    ok(ids.length === 1 && ids[0] === 'K1', 'atomic flush writes only the changed row');
  }
  // C14: update() on a doc deleted remotely returns false, writes nothing
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.ac = [];
    const r = DB.update('ac', 'GONE', x => x);
    await sleep(20);
    ok(r === false && stub.log.sets.length === 0, 'update on missing doc is a safe no-op');
  }

  // ── [G] gate-fix regressions ─────────────────────────────
  console.log('[G] gate-fix regressions');
  // G1: toggleStop shape — live config object mutated BEFORE atomicUpdate must
  // still be detected and saved (the _cfgPersisted shadow diff).
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.today_run = { date: 'D', stops: [{ id: 's1', done: false }] };
    DB._snapshotCfgPersisted();
    const run = DB.obj('today_run', {});   // live reference
    run.stops[0].done = true;              // pre-atomicUpdate mutation
    run.stops[0].ordId = 'ord1';
    DB.atomicUpdate(cache => { cache['today_run'] = run; cache['orders'] = [{ id: 'ord1' }]; });
    await sleep(150);
    const cfgWrite = stub.log.configSets.find(p => 'today_run' in p);
    ok(!!cfgWrite && cfgWrite.today_run.stops[0].done === true && cfgWrite.today_run.stops[0].ordId === 'ord1',
      'G1: pre-mutated live config object is still persisted by atomicUpdate');
  }
  // G1b: app.js toggleStop belt — both atomicUpdate branches now setObj the run
  {
    const ts = appSrc.slice(appSrc.indexOf('function toggleStop(i) {'), appSrc.indexOf('function offerDeliveryInvoice'));
    const setObjCount = (ts.match(/DB\.setObj\('today_run', run\)/g) || []).length;
    ok(setObjCount >= 3, `G1b: toggleStop persists today_run explicitly in all branches (${setObjCount} setObj calls)`);
  }
  // G2: config shadow advances on save success and on remote apply
  {
    const stub = makeStub(); const DB = makeDB(stub);
    DB._cache.settings = { a: 1 };
    DB._saveConfig(['settings']);
    await sleep(30);
    ok(DB._cfgPersisted.settings === JSON.stringify({ a: 1 }), 'G2: shadow advances on config save success');
    DB._applyConfigData({ settings: { a: 2 } });
    ok(DB._cache.settings.a === 2 && DB._cfgPersisted.settings === JSON.stringify({ a: 2 }),
      'G2: shadow advances on remote config apply');
  }
  // G3: snapshot deferred while docs dirty-but-unscheduled (backoff window)
  {
    const dbCode = dbSrc.replace(/\/\/[^\n]*/g, '');
    ok(/this\._dirtyIds\[key\] && this\._dirtyIds\[key\]\.size/.test(dbCode.slice(dbCode.indexOf('_subscribeAll'), dbCode.indexOf('_scheduleRefresh() {'))),
      'G3: collection listener defers while _dirtyIds non-empty');
    const dd = dbCode.slice(dbCode.indexOf('_drainDeferred() {'), dbCode.indexOf('async _migrateFromSingleDoc'));
    ok((dd.match(/_dirtyIds\[key\] && this\._dirtyIds\[key\]\.size/g) || []).length >= 2,
      'G3: drain skips keys with unconfirmed docs (pre- and post-fetch)');
  }
  // G4: remote change bundled with local echo is deferred, not dropped
  {
    // The listener bodies CALL _scheduleRefresh(), so slice to its DEFINITION.
    const sub = dbSrc.slice(dbSrc.indexOf('_subscribeAll'), dbSrc.indexOf('_scheduleRefresh() {'));
    ok(/hasLocalChanges\) \{[\s\S]{0,400}?_deferredRemote\.add\(key\)/.test(sub),
      'G4: collection listener defers bundled remote changes on local-echo events');
    ok(/hasPendingWrites\) \{[\s\S]{0,400}?_deferredRemote\.add\('__config__'\)/.test(sub),
      'G4: config listener defers on pending-write echoes');
  }
  // G4b: drain also waits for pending deletes (no transient row resurrection)
  {
    const stub = makeStub(); const DB = makeDB(stub);
    let fetched = 0;
    stub.db.collection = () => ({
      doc: () => ({ set: () => Promise.resolve(), delete: () => Promise.resolve(), onSnapshot: () => () => {} }),
      get: () => { fetched++; return Promise.resolve({ docs: [] }); },
      onSnapshot: () => () => {},
    });
    DB._deferredRemote.add('ac');
    DB._markDocDeleted('ac', 'DEAD');
    DB._drainDeferred();
    await sleep(20);
    ok(fetched === 0 && DB._deferredRemote.has('ac'), 'G4b: drain skips while a delete is queued');
    DB._dirtyDeletes.ac.delete('DEAD');
  }
  // G6 (fuzz): in-flight guards — a key stays blocked from mark to CONFIRM
  {
    const code = dbSrc.replace(/\/\/[^\n]*/g, '');
    ok((code.match(/_inflightCols\[key\] > 0/g) || []).length >= 2,
      'G6: listener AND drain both honor the collection in-flight counter');
    ok((code.match(/_inflightCfg > 0/g) || []).length >= 2,
      'G6: config listener AND drain both honor the config in-flight counter');
    const stub = makeStub(); const DB = makeDB(stub);
    let resolveCommit;
    stub.db.batch = () => ({ set: () => {}, delete: () => {},
      commit: () => new Promise(res => { resolveCommit = res; }) });
    DB._cache.ac = [{ id: 'X', v: 2 }];
    DB._markDocDirty('ac', 'X');
    DB._deferredSnaps.ac = { docs: [{ id: 'X', data: () => ({ v: 1 }) }] }; // stale stored snap
    DB._saveCollection('ac');            // issues batch; dirty ids drained
    DB._deferredRemote.add('ac');
    DB._drainDeferred();
    await sleep(20);
    ok(DB._cache.ac[0].v === 2 && DB._deferredRemote.has('ac'),
      'G6: drain does NOT apply a stale snapshot while the batch is unconfirmed');
    DB._deferredSnaps.ac = { docs: [{ id: 'X', data: () => ({ v: 2 }) }] }; // echo arrived
    resolveCommit();
    await sleep(20);
    ok(DB._cache.ac[0].v === 2 && !DB._deferredRemote.has('ac') && !(DB._inflightCols.ac > 0),
      'G6: confirm settles the counter and the drain applies the post-write view');
  }
  // G5: append-only batch captures item refs before the awaited guard
  {
    const sc2 = dbSrc.slice(dbSrc.indexOf('_saveCollection(key) {'), dbSrc.indexOf('_saveConfig(keys) {'));
    ok(sc2.indexOf('const byId = new Map') < sc2.indexOf('const guard = appendOnly'),
      'G5: byId captured before the append-only network guard');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
