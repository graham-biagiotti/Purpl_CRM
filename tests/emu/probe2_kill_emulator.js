// PROBE 2 — transport DEATH (emulator process killed) mid-write, then restart.
// Does batch.commit()/setDoc REJECT (triggering db.js retry/park paths) or stay
// pending? Do _inflightCols/_inflightCfg clear and writes flush after restart?
'use strict';
const { execSync, spawn } = require('child_process');
const { makeClient, loadDB, seed, sleep } = require('./harness-transport');

function emuPid() {
  try {
    return execSync("pgrep -f 'cloud-firestore-emulator' | head -1").toString().trim();
  } catch (_) { return ''; }
}

(async () => {
  const A = makeClient('A2');
  const B = makeClient('B2');
  await seed(B.db, { ac: [{ id: 'k1', name: 'orig-k1' }] });

  const DB = loadDB(A.db, { uid: 'userA' });
  await DB.__init();
  console.log('[init] ok; ac =', DB.a('ac').length, 'docs');

  // Kill the emulator (java process) — simulates abrupt transport death.
  const pid = emuPid();
  console.log('[t0] killing emulator pid', pid);
  execSync('kill -9 ' + pid);
  await sleep(500);

  // Writes issued against a dead backend:
  DB.update('ac', 'k1', (x) => ({ ...x, name: 'edited-during-outage' }));
  DB.setObj('settings', { seeded: true, edited: 'during-outage' });
  await sleep(1500); // debounce fired
  console.log('[t+2s dead] inflightCols.ac =', DB._inflightCols['ac'],
    '| inflightCfg =', DB._inflightCfg,
    '| dirtyIds.ac =', DB._dirtyIds['ac'] ? [...DB._dirtyIds['ac']] : null,
    '| saveDirtyKeys =', [...DB._saveDirtyKeys],
    '| sync =', DB._syncStatus, '| toasts =', JSON.stringify(DB.__env.toasts));

  await sleep(8000);
  console.log('[t+10s dead] inflightCols.ac =', DB._inflightCols['ac'],
    '| inflightCfg =', DB._inflightCfg,
    '| saveDirtyKeys =', [...DB._saveDirtyKeys],
    '| sync =', DB._syncStatus, '| toasts =', JSON.stringify(DB.__env.toasts));

  // Restart emulator (fresh/empty data — the flush should recreate docs)
  console.log('[t+10s] restarting emulator...');
  const child = spawn('./node_modules/.bin/firebase',
    ['emulators:start', '--only', 'firestore', '--project', 'demo-purpl'],
    { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  // wait for it to come up
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try { execSync('curl -s -m 1 http://127.0.0.1:8686/ > /dev/null'); break; } catch (_) {}
  }
  console.log('[emulator back up] waiting for SDK to reconnect + flush...');
  await sleep(45000);

  console.log('[t+~60s] inflightCols.ac =', DB._inflightCols['ac'],
    '| inflightCfg =', DB._inflightCfg,
    '| sync =', DB._syncStatus,
    '| toasts =', JSON.stringify(DB.__env.toasts));
  const sv = (await B.db.doc('workspace/main/ac/k1').get()).data();
  const cfg = (await B.db.doc('workspace/main/config/main').get()).data();
  console.log('[server] ac/k1 =', JSON.stringify(sv));
  console.log('[server] config.settings =', JSON.stringify(cfg && cfg.settings));
  const healed = DB._inflightCols['ac'] === 0 && DB._inflightCfg === 0 &&
    sv && sv.name === 'edited-during-outage' && cfg && cfg.settings && cfg.settings.edited === 'during-outage';
  console.log('VERDICT:', healed ? 'COMMITS SURVIVE PROCESS-DEATH AND FLUSH ON RECOVERY (no reject, no wedge)' : 'DID NOT FULLY HEAL — inspect above');
  process.exit(0);
})().catch(e => { console.error('PROBE FAILED:', e); process.exit(1); });
