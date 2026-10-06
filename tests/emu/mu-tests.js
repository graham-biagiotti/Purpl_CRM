// Multiuser emulator suite — runs the REAL db.js as two independent Firestore
// clients (A and B) against the emulator and proves the M1-M4 guarantees.
// (Recreated into the repo 2026-10-06 after a scratchpad wipe — includes the
// S11 gate regression and the BS1 marker-field update.)
'use strict';
const H = require('./harness');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}

const BASE_CONFIG = {
  _dbVersion: 2,
  settings: { company: 'purpl' },
  invoice_settings: { nextInvoiceNum: 100 },
  lf_skus: [{ id: 's1', name: 'Syrup 16oz' }],
  saved_reports: [],
};
const BASE_COLS = {
  ac: [
    { id: 'A1', name: 'Big Y', note: 'old', _updatedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'A2', name: 'Nourish Gardens', note: 'old', _updatedAt: '2026-09-01T00:00:00.000Z' },
  ],
  pr: [{ id: 'P1', name: 'Green Earth', _updatedAt: '2026-09-01T00:00:00.000Z' }],
  iv: [
    { id: 'I1', num: '13001', amount: 100, status: 'sent', _updatedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'I2', num: '13002', amount: 200, status: 'paid', _updatedAt: '2026-09-01T00:00:00.000Z' },
  ],
};

let clientN = 0;
async function freshPair() {
  await H.wipe();
  await H.seed(JSON.parse(JSON.stringify(BASE_CONFIG)), JSON.parse(JSON.stringify(BASE_COLS)));
  const A = H.makeClient('A' + (++clientN));
  const B = H.makeClient('B' + clientN);
  await A.DB.init('userA', A.compat);
  await B.DB.init('userB', B.compat);
  return { A, B };
}
function teardown(...clients) {
  clients.forEach(c => { try { c.DB._unsubscribers.forEach(fn => fn()); } catch (_) {} });
}

async function main() {
  // ── S1+S2: stale-cache clobber + deferred-drop, the core kill chain ──
  console.log('S1/S2: B edits A2 while A has a modal open; A then edits A1');
  {
    const { A, B } = await freshPair();
    A.DB.markDirty();                                  // A opens an edit modal
    B.DB.update('ac', 'A2', x => ({ ...x, note: 'B-edit' }));
    ok(await H.until(async () => (await H.serverCol('ac')).A2?.note === 'B-edit'),
      'B\'s edit to A2 reaches the server');
    await H.sleep(700);
    ok(A.DB.a('ac').find(x => x.id === 'A2').note === 'old',
      'A\'s cache is (correctly) still stale while its modal is open');
    ok(A.DB._deferredRemote.has('ac'), 'A queued the deferred remote change');
    A.DB.update('ac', 'A1', x => ({ ...x, name: 'Big Y — renamed' }));
    ok(await H.until(async () => (await H.serverCol('ac')).A1?.name === 'Big Y — renamed'),
      'A\'s edit to A1 reaches the server');
    await H.sleep(1200); // let A's debounced batch fire too
    ok((await H.serverCol('ac')).A2.note === 'B-edit',
      'M1: A\'s save did NOT clobber B\'s edit to A2');
    A.DB.markClean();
    ok(await H.until(() => A.DB.a('ac').find(x => x.id === 'A2')?.note === 'B-edit'),
      'M4: closing the modal drains the deferred change into A\'s cache');
    ok(A.DB.a('ac').find(x => x.id === 'A1').name === 'Big Y — renamed',
      'M4: the drain did not roll back A\'s own edit (latency compensation)');
    teardown(A, B);
  }

  // ── S3: per-key config writes ──
  console.log('S3: A saves settings while B saves invoice_settings');
  {
    const { A, B } = await freshPair();
    B.DB.markDirty(); // B stops receiving remote config → its cache goes stale
    A.DB.setObj('settings', { company: 'A-co' });
    ok(await H.until(async () => (await H.serverConfig())?.settings?.company === 'A-co'),
      'A\'s settings change reaches the server');
    await H.sleep(300);
    // BS1 (v236): nextInvoiceNum is stripped from routine config saves by
    // design (the allocation transaction owns it) — marker moved to terms.
    B.DB.setObj('invoice_settings', { nextInvoiceNum: 200, terms: 200 });
    ok(await H.until(async () => (await H.serverConfig())?.invoice_settings?.terms === 200),
      'B\'s invoice_settings change reaches the server');
    await H.sleep(1000);
    const cfg = await H.serverConfig();
    ok(cfg.settings.company === 'A-co',
      'M3: B\'s config save did NOT revert A\'s settings key (no whole-blob write)');
    ok(cfg.lf_skus?.[0]?.name === 'Syrup 16oz', 'M3: untouched config keys intact');
    B.DB.markClean();
    ok(await H.until(() => B.DB.obj('settings').company === 'A-co'),
      'M4: B\'s modal close drains the deferred config change');
    teardown(A, B);
  }

  // ── S4: write-audit — one edit produces exactly one changed doc ──
  console.log('S4: write-audit on a single update');
  {
    const { A, B } = await freshPair();
    await H.sleep(800);
    const w = H.watchChanges('ac');
    await H.sleep(600); w.events.length = 0; // drop baseline 'added' events
    A.DB.update('ac', 'A1', x => ({ ...x, note: 'audited' }));
    await H.sleep(1800);
    const ids = [...new Set(w.events.map(e => e.id))];
    ok(ids.length === 1 && ids[0] === 'A1',
      `M1 write-audit: exactly one doc changed (saw: ${JSON.stringify(ids)})`);
    w.unsub();
    teardown(A, B);
  }

  // ── S5: atomicUpdate writes only what the mutator changed ──
  console.log('S5: atomicUpdate touching 1 invoice + deleting 1 prospect');
  {
    const { A, B } = await freshPair();
    await H.sleep(800);
    const wIv = H.watchChanges('iv'), wAc = H.watchChanges('ac'), wPr = H.watchChanges('pr');
    const wCfg = H.watchConfig();
    await H.sleep(600);
    wIv.events.length = 0; wAc.events.length = 0; wPr.events.length = 0; wCfg.events.length = 0;
    const before = await H.serverCol('iv');
    A.DB.atomicUpdate(c => {
      const inv = c.iv.find(x => x.id === 'I1');
      inv.status = 'paid';
      c.pr = c.pr.filter(x => x.id !== 'P1');
    });
    await H.sleep(2000);
    const ivIds = [...new Set(wIv.events.map(e => e.id))];
    ok(ivIds.length === 1 && ivIds[0] === 'I1',
      `M2: only the touched invoice was written (saw: ${JSON.stringify(ivIds)})`);
    ok(wPr.events.some(e => e.type === 'removed' && e.id === 'P1'), 'M2: the deletion propagated');
    ok(wAc.events.length === 0, 'M2: untouched collection (ac) saw zero writes');
    ok(wCfg.events.length === 0, 'M2: config saw zero writes');
    const after = await H.serverCol('iv');
    ok(after.I2._updatedAt === before.I2._updatedAt,
      'M2: untouched invoice I2 was not re-stamped');
    ok(after.I1.status === 'paid', 'M2: the touched invoice did change');
    wIv.unsub(); wAc.unsub(); wPr.unsub(); wCfg.unsub();
    teardown(A, B);
  }

  // ── S8: simultaneous atomicUpdates from both users ──
  console.log('S8: A and B run atomicUpdates in the same instant');
  {
    const { A, B } = await freshPair();
    await H.sleep(800);
    A.DB.atomicUpdate(c => { c.iv.find(x => x.id === 'I1').amount = 111; });
    B.DB.atomicUpdate(c => { c.ac.find(x => x.id === 'A1').note = 'B-atomic'; });
    ok(await H.until(async () => (await H.serverCol('iv')).I1?.amount === 111), 'A\'s atomic landed');
    ok(await H.until(async () => (await H.serverCol('ac')).A1?.note === 'B-atomic'), 'B\'s atomic landed');
    await H.sleep(1200);
    ok((await H.serverCol('iv')).I1.amount === 111 && (await H.serverCol('ac')).A1.note === 'B-atomic',
      'M2: neither atomic clobbered the other');
    ok(await H.until(() => B.DB.a('iv').find(x => x.id === 'I1')?.amount === 111), 'B sees A\'s change');
    ok(await H.until(() => A.DB.a('ac').find(x => x.id === 'A1')?.note === 'B-atomic'), 'A sees B\'s change');
    teardown(A, B);
  }

  // ── S10: delete + concurrent edit elsewhere ──
  console.log('S10: A deletes an account while B edits another');
  {
    const { A, B } = await freshPair();
    await H.sleep(500);
    A.DB.remove('ac', 'A2');
    B.DB.update('ac', 'A1', x => ({ ...x, note: 'B-during-delete' }));
    ok(await H.until(async () => !(await H.serverCol('ac')).A2), 'A\'s delete landed');
    ok(await H.until(async () => (await H.serverCol('ac')).A1?.note === 'B-during-delete'), 'B\'s edit landed');
    await H.sleep(1200);
    const col = await H.serverCol('ac');
    ok(!col.A2 && col.A1.note === 'B-during-delete', 'delete and edit both survive the debounced batches');
    ok(await H.until(() => !B.DB.a('ac').some(x => x.id === 'A2')), 'B\'s cache drops the deleted account');
    teardown(A, B);
  }

  // ── S11 (gate regression): toggleStop shape — pre-mutated live config ──
  console.log('S11: config object mutated before atomicUpdate still persists');
  {
    const { A, B } = await freshPair();
    await H.sleep(500);
    A.DB.setObj('today_run', { date: 'D1', stops: [{ id: 's1', name: 'Store X', done: false }] });
    await H.until(async () => (await H.serverConfig())?.today_run?.stops?.length === 1);
    await H.sleep(700);
    const run = A.DB.obj('today_run', {});     // LIVE cache reference
    run.stops[0].done = true;                  // mutated BEFORE atomicUpdate
    run.stops[0].ordId = 'ordZ';
    A.DB.atomicUpdate(cache => {
      cache['today_run'] = run;                // same reference — invisible to an entry snapshot
      cache['orders'] = [...(cache['orders'] || []), { id: 'ordZ', status: 'delivered' }];
    });
    ok(await H.until(async () => {
      const c = await H.serverConfig();
      return c?.today_run?.stops?.[0]?.done === true && c.today_run.stops[0].ordId === 'ordZ';
    }), 'gate G1: the pre-mutated today_run reaches the server');
    ok(await H.until(async () => Object.keys(await H.serverCol('orders')).includes('ordZ')),
      'gate G1: the order from the same action persists too');
    teardown(A, B);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
