// PROBE 1 — Hypothesis 1: does an offline commit keep _inflightCols>0 and
// defer remote changes, and does it HEAL on reconnect (enableNetwork)?
'use strict';
const { makeClient, loadDB, seed, sleep } = require('./harness-transport');

(async () => {
  const A = makeClient('A');       // runs db.js
  const B = makeClient('B');       // plain second writer
  await seed(B.db, { ac: [{ id: 'a1', name: 'orig-a1' }, { id: 'a2', name: 'orig-a2' }] });

  const DB = loadDB(A.db, { uid: 'userA' });
  await DB.__init();
  console.log('[init] ac cache:', JSON.stringify(DB.a('ac').map(x => x.id + ':' + x.name)));

  // ── go offline mid-save ──
  await A.db.disableNetwork();
  console.log('[t0] network disabled on A');

  let commitSettled = 'pending';
  // Edit through the public API exactly like the CRM does
  DB.update('ac', 'a1', (x) => ({ ...x, name: 'edited-while-offline' }));
  // watch the immediate write + batch state
  await sleep(1200); // > 500ms debounce, so _saveCollection has fired
  console.log('[t+1.2s] _inflightCols.ac =', DB._inflightCols['ac'],
    '| dirtyIds.ac =', DB._dirtyIds['ac'] ? [...DB._dirtyIds['ac']] : null,
    '| _saveDirtyKeys =', [...DB._saveDirtyKeys],
    '| saveTimer.ac =', DB._saveTimers['ac'],
    '| syncStatus =', DB._syncStatus,
    '| toasts =', JSON.stringify(DB.__env.toasts));

  // B writes a DIFFERENT doc while A is offline (remote change A will need)
  await B.db.doc('workspace/main/ac/b-new').set({ id: 'b-new', name: 'written-by-B' });
  await B.db.doc('workspace/main/ac/a2').set({ name: 'a2-changed-by-B' }, { merge: true });
  console.log('[t+1.2s] B wrote ac/b-new and changed ac/a2');

  await sleep(3000);
  console.log('[t+4.2s offline] A cache has b-new?', DB.a('ac').some(x => x.id === 'b-new'),
    '| a2 name =', DB.a('ac').find(x => x.id === 'a2')?.name,
    '| _deferredRemote =', [...DB._deferredRemote],
    '| _inflightCols.ac =', DB._inflightCols['ac']);

  // The 60s redrive's view of the world: can it rescue this key?
  const stuck = [...DB._saveDirtyKeys].filter(k => !DB._saveTimers[k]);
  console.log('[redrive-view] stuck keys the heartbeat would re-drive:', stuck,
    '(inflight-hung key rescued by redrive? ', stuck.includes('ac'), ')');

  // ── reconnect ──
  await A.db.enableNetwork();
  console.log('[t+4.2s] network re-enabled on A');
  await sleep(45000);

  console.log('[t+50s online] _inflightCols.ac =', DB._inflightCols['ac'],
    '| dirtyIds.ac =', DB._dirtyIds['ac'] ? [...DB._dirtyIds['ac']] : null,
    '| _deferredRemote =', [...DB._deferredRemote],
    '| syncStatus =', DB._syncStatus);
  console.log('[final] A cache:', JSON.stringify(DB.a('ac').map(x => x.id + ':' + x.name).sort()));
  const serverA1 = (await B.db.doc('workspace/main/ac/a1').get()).data();
  console.log('[final] server a1 =', JSON.stringify(serverA1));

  const healed = DB._inflightCols['ac'] === 0 &&
    DB.a('ac').some(x => x.id === 'b-new') &&
    DB.a('ac').find(x => x.id === 'a2')?.name === 'a2-changed-by-B' &&
    serverA1.name === 'edited-while-offline' &&
    DB._deferredRemote.size === 0;
  console.log('VERDICT:', healed ? 'HEALS-ON-RECONNECT (conservative freeze, no wedge past reconnect)' : 'WEDGED/LOSSY — inspect above');
  process.exit(0);
})().catch(e => { console.error('PROBE FAILED:', e); process.exit(1); });
