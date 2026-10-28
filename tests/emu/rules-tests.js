// v251 rules verification — runs the REAL firestore.rules (synced copy in
// this dir) against the emulator with authenticated employee/admin contexts.
// Proves the second-user hardening: admin-only deletes on accounts + invoice
// collections, admin-only invoice_settings (except the allocator's
// nextInvoiceNum), and that every routine EMPLOYEE workflow still works.
'use strict';
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT = 'demo-purpl-rules';
let pass = 0, fail = 0;
const ok = async (p, m, wantFail) => {
  try {
    if (wantFail) await assertFails(p); else await assertSucceeds(p);
    pass++; console.log('  ✓ ' + m);
  } catch (e) {
    fail++; console.log('  ✗ FAIL: ' + m + ' — ' + (e?.message || e).split('\n')[0]);
  }
};
const allow = (p, m) => ok(p, m, false);
const deny = (p, m) => ok(p, m, true);

(async () => {
  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, 'firestore.rules'), 'utf8'),
      host: '127.0.0.1', port: 8686,
    },
  });

  // Seed: role docs + a workspace world, bypassing rules.
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.doc('users/admin1').set({ role: 'admin', email: 'g@x.com' });
    await db.doc('users/emp1').set({ role: 'employee', email: 'a@x.com' });
    await db.doc('workspace/main/ac/acc1').set({ id: 'acc1', name: 'Store One' });
    await db.doc('workspace/main/retail_invoices/inv1').set({ id: 'inv1', status: 'draft', total: 100 });
    await db.doc('workspace/main/lf_invoices/lfi1').set({ id: 'lfi1', status: 'sent' });
    await db.doc('workspace/main/combined_invoices/ci1').set({ id: 'ci1', status: 'draft' });
    await db.doc('workspace/main/dist_invoices/di1').set({ id: 'di1', status: 'draft' });
    await db.doc('workspace/main/iv/ledger1').set({ id: 'ledger1', type: 'out', qty: 24 });
    await db.doc('workspace/main/orders/ord1').set({ id: 'ord1', invoiceStatus: null });
    await db.doc('workspace/main/config/main').set({
      _dbVersion: 2,
      settings: { warehouseEmail: 'w@x.com' },
      invoice_settings: { fromName: 'PBF', achRouting: '', nextInvoiceNum: 100 },
    });
    await db.doc('workspace/main/audit_log/a1').set({ action: 'update', changedBy: 'Graham' });
    await db.doc('accounts/acc1').set({ name: 'Store One', email: 'a@b.c' });
  });

  const emp = env.authenticatedContext('emp1').firestore();
  const adm = env.authenticatedContext('admin1').firestore();

  console.log('[A] employee routine work still succeeds');
  await allow(emp.doc('workspace/main/ac/acc1').update({ phone: '555' }), 'edit an account');
  await allow(emp.doc('workspace/main/retail_invoices/inv2').set({ id: 'inv2', status: 'draft' }), 'create an invoice');
  await allow(emp.doc('workspace/main/retail_invoices/inv1').update({ status: 'sent', sentClaim: null }), 'mark an invoice sent (claims write)');
  await allow(emp.doc('workspace/main/iv/ledger2').set({ id: 'ledger2', type: 'out', qty: 24 }), 'append inventory ledger');
  await allow(emp.doc('workspace/main/iv/ledger1').delete(), 'inventory ledger corrections stay staff');
  await allow(emp.doc('workspace/main/orders/ord1').update({ invoiceClaim: { at: 'x', by: 'Ashley' } }), 'delivery-invoice claim');
  await allow(emp.doc('workspace/main/audit_log/a2').set({ action: 'update', changedBy: 'Ashley' }), 'audit entries still append');
  await allow(emp.doc('accounts/acc1').update({ orderPortalToken: 'tok123' }), 'portal-token mint on accounts mirror');
  // The allocator transaction's exact shape: a dot-path update touching ONLY the counter.
  await allow(emp.doc('workspace/main/config/main').update({ 'invoice_settings.nextInvoiceNum': 101 }),
    'invoice-number allocator (nextInvoiceNum only) still works');
  // Routine config saves (other keys) unaffected.
  await allow(emp.doc('workspace/main/config/main').set({ settings: { warehouseEmail: 'new@x.com' } }, { merge: true }),
    'ordinary settings keys stay staff-writable');
  // A config save that carries invoice_settings with IDENTICAL values is a
  // no-op after merge — must stay allowed (the old setObj echo pattern).
  await allow(emp.doc('workspace/main/config/main').set({ invoice_settings: { fromName: 'PBF', achRouting: '' } }, { merge: true }),
    'identical-value invoice_settings echo is a no-op and allowed');

  console.log('[B] employee blocked from admin-only surface');
  await deny(emp.doc('workspace/main/ac/acc1').delete(), 'cannot delete an account');
  await deny(emp.doc('workspace/main/retail_invoices/inv1').delete(), 'cannot delete a purpl invoice');
  await deny(emp.doc('workspace/main/lf_invoices/lfi1').delete(), 'cannot delete an LF invoice');
  await deny(emp.doc('workspace/main/combined_invoices/ci1').delete(), 'cannot delete a combined invoice');
  await deny(emp.doc('workspace/main/dist_invoices/di1').delete(), 'cannot delete a distributor invoice');
  await deny(emp.doc('accounts/acc1').delete(), 'cannot delete the accounts mirror doc');
  await deny(emp.doc('workspace/main/config/main').set({ invoice_settings: { achRouting: '99999', achAccount: '1' } }, { merge: true }),
    'cannot change remit bank details');
  await deny(emp.doc('workspace/main/config/main').update({ 'invoice_settings.stripeLink': 'https://evil' }),
    'cannot change the Stripe link');
  await deny(emp.doc('workspace/main/config/main').update({ 'invoice_settings.fromEmail': 'evil@x.com' }),
    'cannot change the invoice from-address');
  await deny(emp.doc('workspace/main/audit_log/a1').update({ changedBy: 'Nobody' }), 'audit log immutable (update)');
  await deny(emp.doc('workspace/main/audit_log/a1').delete(), 'audit log immutable (delete)');
  await deny(emp.doc('users/emp1').update({ role: 'admin' }), 'cannot self-elevate');
  await deny(emp.doc('users/admin1').get(), 'cannot read other users');
  await deny(emp.doc('app_config/access_control').set({ allowedEmails: ['x@y.z'] }, { merge: true }),
    'cannot touch the sign-in allowlist');

  console.log('[C] admin unaffected');
  await allow(adm.doc('workspace/main/config/main').set({ invoice_settings: { achRouting: '011000015' } }, { merge: true }),
    'admin edits invoice settings');
  await allow(adm.doc('workspace/main/retail_invoices/inv2').delete(), 'admin deletes an invoice');
  await allow(adm.doc('workspace/main/ac/acc1').delete(), 'admin deletes an account');
  await allow(adm.doc('users/emp1').update({ role: 'employee' }), 'admin manages roles');

  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
