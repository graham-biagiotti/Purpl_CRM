// PROBE 4 — terminal listener death on a long-lived session.
// HISTORICAL (pre-v238): this probe demonstrated the bug — verdict was
// "LISTENERS PERMANENTLY DEAD". TS1 (v238) added per-stream resubscribe with
// backoff; the permanent regression test is ts1-probe.js (hard pass/fail).
// db.js onSnapshot error handlers only console.warn. If the backend returns a
// NON-retryable error on Listen (permission-denied — e.g. expired/invalid auth
// on a days-old tab), onError fires and the SDK permanently cancels that
// listener. Does db.js ever resubscribe? Does the cache ever update again?
//
// Method: run DB against allow-all rules; restart the emulator with DENY rules
// (listeners reconnect -> permission-denied -> onError); restart again with
// allow rules; have B write; see if A's cache ever hears about it.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { makeClient, loadDB, seed, sleep } = require('./harness-transport');

const ALLOW = fs.readFileSync(path.join(__dirname, 'firestore.rules'), 'utf8');
const DENY = ALLOW.replace('if true', 'if false');

function emuPid() {
  try { return execSync("pgrep -f 'cloud-firestore-emulator' | head -1").toString().trim(); }
  catch (_) { return ''; }
}
async function restartEmu() {
  const pid = emuPid();
  if (pid) { try { execSync('kill -9 ' + pid); } catch (_) {} }
  await sleep(1000);
  const child = spawn('./node_modules/.bin/firebase',
    ['emulators:start', '--only', 'firestore', '--project', 'demo-purpl'],
    { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try { execSync('curl -s -m 1 http://127.0.0.1:8686/ >/dev/null'); return; } catch (_) {}
  }
  throw new Error('emulator did not come back');
}

(async () => {
  const A = makeClient('A4');
  const B = makeClient('B4');
  await seed(B.db, { ac: [{ id: 'd1', name: 'orig' }] });

  const DB = loadDB(A.db, { uid: 'userA' });
  // count snapshot errors db.js would only console.warn about
  let errCount = 0;
  const origWarn = console.warn;
  console.warn = (...a) => { if (String(a[0]).includes('Snapshot error') || String(a[0]).includes('snapshot error')) errCount++; origWarn(...a); };
  await DB.__init();
  console.log('[init] d1 =', DB.a('ac').find(x => x.id === 'd1')?.name);

  // Phase 1: restart with DENY rules — reconnecting listeners get permission-denied
  fs.writeFileSync(path.join(__dirname, 'firestore.rules'), DENY);
  console.log('[phase1] restarting emulator with DENY rules...');
  await restartEmu();
  await sleep(20000); // listeners reconnect and die
  console.log('[phase1] snapshot-error callbacks fired:', errCount);

  // Phase 2: back to ALLOW rules — if listeners were alive they would recover
  fs.writeFileSync(path.join(__dirname, 'firestore.rules'), ALLOW);
  console.log('[phase2] restarting emulator with ALLOW rules...');
  await restartEmu();
  await sleep(5000);
  await seed(B.db, { ac: [{ id: 'd1', name: 'orig' }] }); // reseed (restart wiped data)
  await B.db.doc('workspace/main/ac/d1').set({ id: 'd1', name: 'UPDATED-AFTER-RECOVERY' });
  console.log('[phase2] B wrote d1=UPDATED-AFTER-RECOVERY; waiting 45s for A to notice...');
  await sleep(45000);

  const seen = DB.a('ac').find(x => x.id === 'd1')?.name;
  console.log('[result] A cache d1 =', seen, '| snapshot errors =', errCount,
    '| deferredRemote =', [...DB._deferredRemote]);
  console.log('VERDICT:', seen === 'UPDATED-AFTER-RECOVERY'
    ? 'LISTENERS SURVIVED (error was retried internally)'
    : 'LISTENERS PERMANENTLY DEAD — tab never hears remote changes again, no resubscribe, console-only warning');
  process.exit(0);
})().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
