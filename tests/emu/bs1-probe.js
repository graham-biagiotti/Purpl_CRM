// BS1 verification probe — the two HIGH sweep findings, post-fix, on the
// real db.js + emulator. (Recreated into the repo 2026-10-06.)
'use strict';
const H = require('./harness');
const { doc, setDoc, getDoc } = require('firebase/firestore');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const healWrites = { A: 0, B: 0 };

function healOnce(client, tag) {
  // verbatim FIXED app.js heal: readyToSend:false, never delete
  const hits = client.DB.a('retail_invoices').filter(x => x.readyToSend && ['sent', 'paid', 'void'].includes(x.status));
  hits.forEach(x => {
    healWrites[tag]++;
    client.DB.update('retail_invoices', x.id, r => ({ ...r, readyToSend: false }));
  });
  return hits.length;
}

(async () => {
  // ── Scenario 1: the cross-tab heal loop is dead ──
  console.log('S1: readyToSend heal loop (2 tabs, 12s soak)');
  await H.wipe();
  await H.seed({ _dbVersion: 2 }, {
    retail_invoices: [{ id: 'ri1', number: 'INV-0001', status: 'sent', total: 100, readyToSend: true, _updatedAt: new Date().toISOString() }],
  });
  const A = H.makeClient('bsA'), B = H.makeClient('bsB');
  await A.DB.init('uA', A.compat);
  await B.DB.init('uB', B.compat);
  A.window.refreshCurrentPage = () => healOnce(A, 'A');
  B.window.refreshCurrentPage = () => healOnce(B, 'B');
  await H.sleep(500);
  healOnce(A, 'A');
  await H.sleep(6000);
  const midWrites = healWrites.A + healWrites.B;
  await H.sleep(6000);
  const endWrites = healWrites.A + healWrites.B;
  ok(endWrites <= 4, `bounded heals, not a loop (total ${endWrites}; sweep measured 40 on old code)`);
  ok(endWrites === midWrites, 'zero heal writes in the final 6s — the system is quiet');
  const sv = await H.serverCol('retail_invoices');
  ok(sv.ri1.readyToSend === false, 'server flag is FALSE (merge-visible), not resurrected');
  ok(!A.DB.a('retail_invoices')[0].readyToSend && !B.DB.a('retail_invoices')[0].readyToSend,
    'both tabs converge to cleared');
  A.DB._unsubscribers.forEach(f => f()); B.DB._unsubscribers.forEach(f => f());

  // ── Scenario 2: routine config saves can't clobber the counter ──
  console.log('S2: invoice-number counter survives a stale config save');
  await H.wipe();
  await H.seed({ _dbVersion: 2, invoice_settings: { nextInvoiceNum: 7, terms: 30 } }, {});
  const C = H.makeClient('bsC');
  await C.DB.init('uC', C.compat);
  await H.sleep(400);
  ok(C.DB.obj('invoice_settings').nextInvoiceNum === 7, 'client cached counter 7');
  const W = H.makeClient('bsW');
  await setDoc(doc(W.fs, 'workspace/main/config/main'), { invoice_settings: { nextInvoiceNum: 8 } }, { merge: true });
  await H.sleep(200);
  C.DB.setObj('invoice_settings', { ...C.DB.obj('invoice_settings'), footerNotes: 'thanks!' });
  await H.sleep(1500);
  const cfg = await getDoc(doc(W.fs, 'workspace/main/config/main'));
  const is = cfg.data().invoice_settings;
  ok(is.nextInvoiceNum === 8, `counter SURVIVED the stale save (server=${is.nextInvoiceNum}; old code rolled it to 7)`);
  ok(is.footerNotes === 'thanks!', 'the routine save\'s real change still landed');
  ok(is.terms === 30, 'untouched fields intact');
  await setDoc(doc(C.fs, 'workspace/main/config/main'), { invoice_settings: { nextInvoiceNum: 42 } }, { merge: true });
  await H.sleep(300);
  const cfg2 = await getDoc(doc(W.fs, 'workspace/main/config/main'));
  ok(cfg2.data().invoice_settings.nextInvoiceNum === 42, 'deliberate Settings override path still writes the counter');
  C.DB._unsubscribers.forEach(f => f());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
