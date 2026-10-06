// PROBE 3 — runTransaction behavior under (a) disableNetwork and (b) dead
// backend (emulator killed). Does it reject fast, retry forever, or hang?
// This decides whether confirmPortalOrder's _confirmPortalInFlight and
// getNextInvoiceNumber's awaits wedge the UI.
'use strict';
const { execSync, spawn } = require('child_process');
const { makeClient, sleep } = require('./harness-transport');

function emuPid() {
  try { return execSync("pgrep -f 'cloud-firestore-emulator' | head -1").toString().trim(); }
  catch (_) { return ''; }
}

(async () => {
  const A = makeClient('A3');
  const ref = A.db.doc('workspace/main/config/main');
  await ref.set({ invoice_settings: { nextInvoiceNum: 100 } }, { merge: true });

  // (a) disableNetwork — explicit known-offline
  await A.db.disableNetwork();
  let t = Date.now(), outcome = 'HUNG>20s';
  const p1 = A.db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    tx.update(ref, { 'invoice_settings.nextInvoiceNum': (s.data().invoice_settings.nextInvoiceNum || 0) + 1 });
    return 'ok';
  }).then((r) => { outcome = 'RESOLVED:' + r; }, (e) => { outcome = 'REJECTED:' + (e.code || e.message); });
  await Promise.race([p1, sleep(20000)]);
  console.log('[disableNetwork] runTransaction after', ((Date.now() - t) / 1000).toFixed(1) + 's:', outcome);
  await A.db.enableNetwork();
  await sleep(2000);

  // (b) dead backend — kill the emulator, then run a transaction
  const pid = emuPid();
  console.log('[killing emulator pid', pid + ']');
  execSync('kill -9 ' + pid);
  await sleep(500);
  t = Date.now(); outcome = 'HUNG>45s';
  const p2 = A.db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    tx.update(ref, { 'invoice_settings.nextInvoiceNum': (s.data().invoice_settings.nextInvoiceNum || 0) + 1 });
    return 'ok';
  }).then((r) => { outcome = 'RESOLVED:' + r; }, (e) => { outcome = 'REJECTED:' + (e.code || e.message); });
  await Promise.race([p2, sleep(45000)]);
  console.log('[dead backend] runTransaction after', ((Date.now() - t) / 1000).toFixed(1) + 's:', outcome);

  // restart emulator for later probes
  const child = spawn('./node_modules/.bin/firebase',
    ['emulators:start', '--only', 'firestore', '--project', 'demo-purpl'],
    { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) { await sleep(1000); try { execSync('curl -s -m 1 http://127.0.0.1:8686/ >/dev/null'); break; } catch (_) {} }
  console.log('[emulator restarted]');
  // if p2 was still pending, see if it settles after recovery
  await Promise.race([p2, sleep(30000)]);
  console.log('[after recovery] transaction outcome:', outcome);
  process.exit(0);
})().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
