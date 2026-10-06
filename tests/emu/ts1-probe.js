// TS1 regression probe — listener terminal-death auto-resubscribe (v238).
// Probe4 proved the bug: a non-retryable Listen error (permission-denied on a
// days-old tab) permanently cancelled the stream and db.js only console.warn'd
// — the tab never heard a remote change again. TS1 adds per-stream resubscribe
// with capped backoff + the focus/heartbeat rescue. This probe is probe4
// inverted into a HARD assertion: after the deny→allow cycle, client A's cache
// MUST converge on B's post-recovery write. Exit 1 if it stays stale.
//
// NOTE: restarts the shared emulator (twice) and rewrites firestore.rules in
// place (restored at the end) — run it alone, then restart the emulator before
// other suites.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { makeClient, loadDB, seed, sleep } = require('./harness-transport');

const RULES = path.join(__dirname, 'firestore.rules');
const ALLOW = fs.readFileSync(RULES, 'utf8');
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
  let failed = false;
  try {
    const A = makeClient('A-ts1');
    const B = makeClient('B-ts1');
    await seed(B.db, { ac: [{ id: 'd1', name: 'orig' }] });

    const DB = loadDB(A.db, { uid: 'userA' });
    await DB.__init();
    console.log('[init] d1 =', DB.a('ac').find(x => x.id === 'd1')?.name);

    // Phase 1: DENY rules — reconnecting listeners die with permission-denied.
    fs.writeFileSync(RULES, DENY);
    console.log('[phase1] restarting emulator with DENY rules…');
    await restartEmu();
    await sleep(20000);
    const deadMid = DB._deadListeners.size;
    console.log('[phase1] dead streams tracked:', deadMid, [...DB._deadListeners].slice(0, 5).join(','), '…');

    // Phase 2: ALLOW again — resubscribes must land and the cache must hear B.
    fs.writeFileSync(RULES, ALLOW);
    console.log('[phase2] restarting emulator with ALLOW rules…');
    await restartEmu();
    await sleep(3000);
    await seed(B.db, { ac: [{ id: 'd1', name: 'orig' }] }); // restart wiped data
    await B.db.doc('workspace/main/ac/d1').set({ id: 'd1', name: 'UPDATED-AFTER-RECOVERY' });
    console.log('[phase2] B wrote d1=UPDATED-AFTER-RECOVERY; polling A up to 120s…');

    let seen = '', recoveredAt = -1;
    for (let t = 0; t < 120; t += 5) {
      await sleep(5000);
      seen = DB.a('ac').find(x => x.id === 'd1')?.name;
      if (seen === 'UPDATED-AFTER-RECOVERY') { recoveredAt = t + 5; break; }
    }
    const allClear = DB._deadListeners.size === 0;

    console.log('[result] A cache d1 =', seen,
      '| recovered after ~' + (recoveredAt > 0 ? recoveredAt + 's' : 'NEVER'),
      '| dead streams remaining =', DB._deadListeners.size,
      '| restored toast =', DB.__env.toasts.some(t => String(t).includes('Live sync restored')));

    if (deadMid === 0) { console.log('✗ FAIL: deny phase never marked a stream dead (death tracking broken or phase too short)'); failed = true; }
    if (seen !== 'UPDATED-AFTER-RECOVERY') { console.log('✗ FAIL: cache never converged — listeners still permanently dead'); failed = true; }
    if (!allClear) { console.log('✗ FAIL: _deadListeners not fully cleared after recovery'); failed = true; }
    if (!failed) console.log('✓ TS1 PROVEN: terminally-dead listeners resubscribed and the cache converged');
  } finally {
    fs.writeFileSync(RULES, ALLOW); // never leave DENY rules behind
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('PROBE FAILED:', e); try { fs.writeFileSync(RULES, ALLOW); } catch (_) {} process.exit(2); });
