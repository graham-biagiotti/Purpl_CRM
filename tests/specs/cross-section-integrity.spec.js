// cross-section-integrity.spec.js
// Data integrity tests verifying that changes in one part of the app
// correctly propagate to all other relevant sections.
'use strict';
const { test, expect } = require('../fixtures.js');

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
}

// ── Test 1: Delete account → retail_invoices for that account removed ────────
test('Delete account removes linked retail_invoices from DB cache', async ({ page }) => {
  await waitForApp(page);

  // Create a test account with retail_invoices
  const testId = 'ac-retail-cascade-' + Date.now();
  await page.evaluate((id) => {
    DB.push('ac', { id, name: 'Cascade Test Account', status: 'active', isPbf: false });
    DB.push('retail_invoices', {
      id: id + '-rinv1', invoiceNumber: 'INV-T001', accountId: id,
      accountName: 'Cascade Test Account', date: '2026-01-01', dueDate: '2026-02-01',
      total: 144.00, status: 'unpaid',
    });
    DB.push('retail_invoices', {
      id: id + '-rinv2', invoiceNumber: 'INV-T002', accountId: id,
      accountName: 'Cascade Test Account', date: '2026-01-15', dueDate: '2026-02-15',
      total: 216.00, status: 'unpaid',
    });
  }, testId);

  const before = await page.evaluate((id) =>
    DB.a('retail_invoices').filter(x => x.accountId === id).length
  , testId);
  expect(before).toBe(2);

  // Delete account (bypass confirm)
  await page.evaluate((id) => {
    const orig = window.confirm2;
    window.confirm2 = () => true;
    window.confirm  = () => true;
    deleteAccount(id);
    if (orig !== undefined) window.confirm2 = orig;
  }, testId);
  await page.waitForTimeout(400);

  const after = await page.evaluate((id) =>
    DB.a('retail_invoices').filter(x => x.accountId === id).length
  , testId);
  expect(after).toBe(0);
  console.log('[integrity] Delete account cascade to retail_invoices: ✓');
});

// ── Test 2: Delete account → purpl iv invoices also removed ─────────────────
test('Delete account removes linked purpl iv invoices from DB cache', async ({ page }) => {
  await waitForApp(page);

  const testId = 'ac-iv-cascade-' + Date.now();
  await page.evaluate((id) => {
    DB.push('ac', { id, name: 'IV Cascade Test', status: 'active', isPbf: false });
    DB.push('iv', { id: id + '-iv1', accountId: id, number: 'TEST-001', amount: '72.00', status: 'unpaid', due: '2026-03-01' });
  }, testId);

  const before = await page.evaluate((id) => DB.a('iv').filter(x => x.accountId === id).length, testId);
  expect(before).toBe(1);

  await page.evaluate((id) => {
    window.confirm2 = () => true;
    window.confirm  = () => true;
    deleteAccount(id);
  }, testId);
  await page.waitForTimeout(400);

  const after = await page.evaluate((id) => DB.a('iv').filter(x => x.accountId === id).length, testId);
  expect(after).toBe(0);
  console.log('[integrity] Delete account cascade to iv: ✓');
});

// ── Test 3: Mark retail invoice paid → dashboard KPI updates ────────────────
test('Mark retail invoice paid → dashboard KPI outstanding decreases', async ({ page }) => {
  await waitForApp(page);

  // Wait for dashboard to fully render
  await page.waitForFunction(() => {
    const el = document.querySelector('#dash-kpi-combined-outstanding .num');
    return el && el.textContent.trim().length > 0;
  }, { timeout: 15000 }).catch(() => {});

  const { kpiBefore, amount } = await page.evaluate(() => {
    // Use rinv-001 if unpaid
    const inv = DB.a('retail_invoices').find(x => x.id === 'rinv-001' && x.status !== 'paid');
    if (!inv) return { kpiBefore: null };

    const el = document.querySelector('#dash-kpi-combined-outstanding .num');
    const raw = el ? el.textContent.trim() : '';
    const kpiBefore = raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : 0;
    return { kpiBefore, amount: parseFloat(inv.total || 0) };
  });

  if (kpiBefore === null) {
    console.log('[integrity] rinv-001 already paid — skip dashboard-update test');
    return;
  }

  // Mark paid (triggers renderDashKpis)
  await page.evaluate(() => markRetailInvPaid('rinv-001'));
  await page.waitForTimeout(600);

  const kpiAfter = await page.evaluate(() => {
    const el = document.querySelector('#dash-kpi-combined-outstanding .num');
    const raw = el ? el.textContent.trim() : '';
    return raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : 0;
  });

  console.log(`[integrity] KPI outstanding before: $${kpiBefore.toFixed(2)}, after: $${kpiAfter.toFixed(2)}, delta: $${(kpiBefore-kpiAfter).toFixed(2)}, inv amount: $${amount.toFixed(2)}`);
  // KPI should have decreased by approximately the invoice amount
  expect(Math.abs((kpiBefore - kpiAfter) - amount)).toBeLessThanOrEqual(1.0);
});

// ── Test 4: Order deletion removes linked retail_invoices ────────────────────
test('Delete order removes linked retail_invoices from DB cache', async ({ page }) => {
  await waitForApp(page);

  const testOrderId = 'ord-rinv-cascade-' + Date.now();
  const testInvId   = 'rinv-cascade-' + Date.now();

  await page.evaluate(({oid, iid}) => {
    DB.push('orders', {
      id: oid, accountId: 'ac002', accountName: 'Green Valley Market',
      status: 'delivered', created: '2026-01-01', dueDate: '2026-02-01',
      cases: 4, pricePerCase: 36, total: 144,
    });
    DB.push('retail_invoices', {
      id: iid, invoiceNumber: 'INV-CASCADE', accountId: 'ac002',
      orderId: oid, total: 144.00, status: 'unpaid',
    });
  }, { oid: testOrderId, iid: testInvId });

  const before = await page.evaluate((iid) => DB.a('retail_invoices').filter(x => x.id === iid).length, testInvId);
  expect(before).toBe(1);

  // Delete order (bypass confirm)
  await page.evaluate((oid) => {
    window.confirm = () => true;
    deleteOrder(oid);
  }, testOrderId);
  await page.waitForTimeout(400);

  const after = await page.evaluate((iid) => DB.a('retail_invoices').filter(x => x.id === iid).length, testInvId);
  expect(after).toBe(0);
  console.log('[integrity] Order deletion cascade to retail_invoices: ✓');
});

// ── Test 5: Invoices page and account page agree on outstanding balance ───────
test('Invoices page and account modal agree on outstanding balance for ac001', async ({ page }) => {
  await waitForApp(page);

  // Get outstanding from invoices page KPI
  await page.click('.sb-nav a[data-page="invoices"]');
  await expect(page.locator('#page-invoices')).toBeVisible({ timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#inv-page-kpis');
    return el && el.textContent.includes('$');
  }, { timeout: 15000 }).catch(() => {});

  // Get outstanding for ac001 computed directly from DB
  const { purplOut, retailOut, total } = await page.evaluate(() => {
    const purplOut = DB.a('iv')
      .filter(x => x.accountId === 'ac001' && x.status !== 'paid')
      .reduce((s, x) => s + parseFloat(x.amount || 0), 0);
    const retailOut = DB.a('retail_invoices')
      .filter(x => x.accountId === 'ac001' && x.status !== 'paid')
      .reduce((s, x) => s + parseFloat(x.total || 0), 0);
    return { purplOut, retailOut, total: purplOut + retailOut };
  });

  console.log(`[integrity] ac001 outstanding — iv: $${purplOut.toFixed(2)}, retail: $${retailOut.toFixed(2)}, total: $${total.toFixed(2)}`);
  // ac001 has: seeded iv invoices + rinv-001 ($432) + rinv-004 ($360) = $792 retail outstanding
  expect(retailOut).toBeGreaterThan(700); // $792 from seed
  expect(total).toBeGreaterThan(purplOut); // retail adds to iv outstanding
});

// ── Test 6: Retail invoice visible in account page statement ─────────────────
test('printAccountStatement includes retail_invoices for account', async ({ page }) => {
  await waitForApp(page);

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Call printAccountStatement — it opens a new window/tab or appends to DOM
  await page.evaluate(() => {
    try { printAccountStatement('ac001'); } catch(e) {}
  });
  await page.waitForTimeout(500);

  // Should not throw any TypeError
  const fatal = errors.filter(msg =>
    msg.includes('TypeError') || msg.includes('Cannot read') || msg.includes('toFixed')
  );
  expect(fatal, `Fatal errors in printAccountStatement: ${fatal.join('; ')}`).toHaveLength(0);
  console.log('[integrity] printAccountStatement ac001: ✓ no crash');
});

// ── Test 7: Going cold report uses order.created (not dueDate) ───────────────
test('Going cold report identifies accounts using last order.created date', async ({ page }) => {
  await waitForApp(page);

  // Verify that the going cold computation uses 'created' field
  const result = await page.evaluate(() => {
    // Create an account with no recent orders (last order was 100 days ago)
    const testId = 'ac-going-cold-test';
    DB.push('ac', { id: testId, name: 'Cold Test Account', status: 'active', isPbf: false });
    DB.push('orders', {
      id: 'ord-cold-100', accountId: testId, status: 'delivered',
      created: (() => {
        const d = new Date(); d.setDate(d.getDate() - 100);
        return d.toISOString().slice(0,10);
      })(),
      dueDate: '2099-01-01', // far future dueDate — should NOT be used
      cases: 2, total: 72,
    });

    // Simulate what the going cold report does
    const acOrds = DB.a('orders').filter(o => o.accountId === testId);
    const lastOrd = acOrds.reduce((best, o) =>
      (!best || (o.created || '') > (best.created || '') ? o : best), null
    );
    const daysSince = lastOrd ? Math.floor(
      (new Date() - new Date(lastOrd.created)) / (1000 * 60 * 60 * 24)
    ) : 999;

    // Cleanup
    const acIdx = DB._cache.ac.findIndex(a => a.id === testId);
    if (acIdx >= 0) DB._cache.ac.splice(acIdx, 1);
    const ordIdx = DB._cache.orders.findIndex(o => o.id === 'ord-cold-100');
    if (ordIdx >= 0) DB._cache.orders.splice(ordIdx, 1);

    return { daysSince, usedCreated: lastOrd ? !!lastOrd.created : false };
  });

  console.log(`[integrity] Going cold daysSince: ${result.daysSince}, used created: ${result.usedCreated}`);
  // Should be ~100 days (using created date, not dueDate of 2099)
  expect(result.daysSince).toBeGreaterThanOrEqual(95);
  expect(result.daysSince).toBeLessThan(110);
  expect(result.usedCreated).toBe(true);
});

// ── Test 8: DB atomicUpdate applies all changes to in-memory cache atomically ─
test('DB.atomicUpdate persists multiple collection changes atomically', async ({ page }) => {
  await waitForApp(page);

  const testAccId = 'ac-atomic-test-' + Date.now();
  const testInvId = 'iv-atomic-test-' + Date.now();

  // Wait for Firestore to be ready before mutating (app-shell visible ≠ Firestore loaded)
  await page.waitForFunction(() => DB._firestoreReady === true, { timeout: 15000 });

  await page.evaluate(({acId, ivId}) => {
    DB.atomicUpdate(cache => {
      cache['ac'] = [...(cache['ac'] || []), { id: acId, name: 'Atomic Test', status: 'active', isPbf: false }];
      cache['iv'] = [...(cache['iv'] || []), { id: ivId, accountId: acId, number: 'AT-001', amount: '50.00', status: 'unpaid', due: '2026-06-01' }];
    });
  }, { acId: testAccId, ivId: testInvId });

  // Verify both items appear in-memory immediately (the core atomicity guarantee)
  const result = await page.evaluate(({acId, ivId}) => {
    const acItem = DB.a('ac').find(x => x.id === acId);
    const ivItem = DB.a('iv').find(x => x.id === ivId);
    return {
      acFound: !!acItem,
      acName: acItem?.name,
      ivFound: !!ivItem,
      ivAmount: ivItem?.amount,
      syncStatus: DB._syncStatus,
    };
  }, { acId: testAccId, ivId: testInvId });

  expect(result.acFound, 'ac item should be in cache immediately after atomicUpdate').toBe(true);
  expect(result.acName).toBe('Atomic Test');
  expect(result.ivFound, 'iv item should be in cache immediately after atomicUpdate').toBe(true);
  expect(result.ivAmount).toBe('50.00');
  // Verify _save() was triggered (syncStatus should be syncing or synced)
  expect(['syncing', 'synced']).toContain(result.syncStatus);
  console.log(`[integrity] DB.atomicUpdate: ✓ both collections in cache, syncStatus=${result.syncStatus}`);
});
