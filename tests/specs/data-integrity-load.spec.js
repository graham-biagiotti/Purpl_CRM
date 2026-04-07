// data-integrity-load.spec.js — verify edit/delete/create integrity
// Phase 5: Data integrity under load tests
'use strict';
const { test, expect } = require('../fixtures.js');

const EMULATOR_HOST = 'http://127.0.0.1:8080';
const PROJECT_ID    = 'purpl-crm';

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
}

// ── Test 1: Edit account name only → all arrays intact ───────────────────────
test('Edit account name preserves outreach, noteLog, samples, and orders arrays', async ({ page }) => {
  await waitForApp(page);

  // Pick an account that has some data
  const { acId, before } = await page.evaluate(() => {
    const accounts = DB.a('ac');
    // Find first account with outreach or notes
    const ac = accounts.find(a => (a.outreach?.length || a.noteLog?.length)) || accounts[0];
    const orders = DB.a('orders').filter(o => o.accountId === ac.id).length;
    return {
      acId: ac.id,
      before: {
        outreachLen: (ac.outreach || []).length,
        noteLogLen:  (ac.noteLog  || []).length,
        samplesLen:  (ac.samples  || []).length,
        locsLen:     (ac.locs     || []).length,
        orders,
      },
    };
  });

  // Use DB.update directly (simulates what saveAccount does — spreads existing)
  await page.evaluate((id) => {
    const existing = DB.a('ac').find(a => a.id === id);
    if (!existing) return;
    DB.update('ac', id, x => ({ ...x, name: x.name + ' (edited)' }));
  }, acId);
  await page.waitForTimeout(300);

  const after = await page.evaluate((id) => {
    const ac = DB.a('ac').find(a => a.id === id);
    const orders = DB.a('orders').filter(o => o.accountId === id).length;
    return {
      outreachLen: (ac?.outreach || []).length,
      noteLogLen:  (ac?.noteLog  || []).length,
      samplesLen:  (ac?.samples  || []).length,
      locsLen:     (ac?.locs     || []).length,
      orders,
    };
  }, acId);

  console.log(`[integrity] Edit account: before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
  expect(after.outreachLen).toBe(before.outreachLen);
  expect(after.noteLogLen).toBe(before.noteLogLen);
  expect(after.samplesLen).toBe(before.samplesLen);
  expect(after.locsLen).toBe(before.locsLen);
  expect(after.orders).toBe(before.orders);
});

// ── Test 2: Create 5 invoices for same account → all 5 persist ───────────────
test('Creating 5 invoices for same account — all 5 persist in DB cache', async ({ page }) => {
  await waitForApp(page);

  const testAcId = 'ac001'; // Known account from seed data
  const testIds  = Array.from({ length: 5 }, (_, i) => `test-bulk-inv-${Date.now()}-${i}`);

  await page.evaluate(({ acId, ids }) => {
    ids.forEach((id, i) => {
      DB.push('iv', {
        id,
        accountId: acId,
        amount:    String((i + 1) * 10),
        status:    'unpaid',
        due:       '2026-06-01',
        number:    `TEST-BULK-${i + 1}`,
      });
    });
  }, { acId: testAcId, ids: testIds });

  await page.waitForTimeout(300);

  const found = await page.evaluate(({ acId, ids }) =>
    DB.a('iv').filter(x => ids.includes(x.id)).length
  , { acId: testAcId, ids: testIds });

  console.log(`[integrity] Bulk invoices: found=${found}/5`);
  expect(found).toBe(5);
});

// ── Test 3: Delete account with invoices → cascade removes all invoices ───────
test('Delete account cascades to remove all linked invoices and orders', async ({ page }) => {
  await waitForApp(page);

  const testId = 'test-cascade-load-' + Date.now();

  await page.evaluate((id) => {
    DB.push('ac',     { id, name: 'Load Cascade Test', status: 'active', isPbf: false });
    DB.push('iv',     { id: id + '-inv1', accountId: id, amount: '100', status: 'unpaid' });
    DB.push('iv',     { id: id + '-inv2', accountId: id, amount: '200', status: 'unpaid' });
    DB.push('orders', { id: id + '-ord1', accountId: id, status: 'pending' });
  }, testId);

  const before = await page.evaluate((id) => ({
    ac:     DB.a('ac').filter(x => x.id === id).length,
    iv:     DB.a('iv').filter(x => x.accountId === id).length,
    orders: DB.a('orders').filter(x => x.accountId === id).length,
  }), testId);
  expect(before.ac).toBe(1);
  expect(before.iv).toBe(2);
  expect(before.orders).toBe(1);

  await page.evaluate((id) => {
    const orig = window.confirm2;
    window.confirm2 = () => true;
    deleteAccount(id);
    if (orig) window.confirm2 = orig;
  }, testId);
  await page.waitForTimeout(300);

  const after = await page.evaluate((id) => ({
    ac:     DB.a('ac').filter(x => x.id === id).length,
    iv:     DB.a('iv').filter(x => x.accountId === id).length,
    orders: DB.a('orders').filter(x => x.accountId === id).length,
  }), testId);

  console.log(`[integrity] Cascade delete: after=${JSON.stringify(after)}`);
  expect(after.ac).toBe(0);
  expect(after.iv).toBe(0);
  expect(after.orders).toBe(0);
});

// ── Test 4: Phase 1 seed data loaded — account + order counts correct ─────────
test('Phase 1 seed loaded: 80 accounts and 320+ orders in emulator', async ({ page }) => {
  await waitForApp(page);

  const { acCount, orderCount } = await page.evaluate(() => ({
    acCount:    DB.a('ac').length,
    orderCount: DB.a('orders').length,
  }));

  console.log(`[integrity] Seed check: accounts=${acCount}, orders=${orderCount}`);
  // seed-data.js has 50 + seed-phase1.js adds 30 = 80 total
  expect(acCount).toBeGreaterThanOrEqual(80);
  // seed-data.js has 40 + seed-phase1.js adds 280 = 320 total
  expect(orderCount).toBeGreaterThanOrEqual(320);
});

// ── Test 5: Firestore rules — unauthenticated CAN write portal_orders ─────────
test('Firestore rules: unauthenticated request can create portal_orders doc', async ({ page }) => {
  const testOrderId = 'test-portal-rules-' + Date.now();
  const url = `${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/portal_orders?documentId=${testOrderId}`;
  const resp = await page.request.post(url, {
    data: { fields: { test: { stringValue: 'security-check' } } },
    headers: { 'Content-Type': 'application/json' },
  });
  console.log(`[integrity] Unauth write portal_orders status: ${resp.status()}`);
  expect([200, 201]).toContain(resp.status());
});
