// invoice-math.spec.js — verify invoice KPIs match computed values
// Phase 3: Invoice math correctness tests
'use strict';
const { test, expect } = require('../fixtures.js');

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
}

// ── Test 1: Dashboard combined outstanding KPI within $0.01 of sum of unpaid ─
test('Dashboard outstanding KPI within $0.01 of sum of all unpaid purpl invoices', async ({ page }) => {
  await waitForApp(page);

  const { expected, displayed } = await page.evaluate(() => {
    const todayStr = today();
    // app calculates: purplOutstanding = iv where accountId exists and status != 'paid', sum amount
    const purplOutstanding = DB.a('iv')
      .filter(x => (x.accountId || x.number) && x.status !== 'paid')
      .reduce((s, x) => s + parseFloat(x.amount || 0), 0);
    const lfOutstanding = DB.a('lf_invoices')
      .filter(i => i.status !== 'paid')
      .reduce((s, i) => s + (i.total || 0), 0);
    const expected = purplOutstanding + lfOutstanding;
    const el = document.querySelector('#dash-kpi-combined-outstanding .num');
    const raw = el ? el.textContent.trim() : null;
    // parse $1,234.56 → 1234.56
    const displayed = raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : null;
    return { expected, displayed };
  });

  console.log(`[inv-math] Outstanding: expected=${expected.toFixed(2)}, displayed=${displayed}`);
  expect(displayed).not.toBeNull();
  expect(Math.abs(displayed - expected)).toBeLessThanOrEqual(0.01);
});

// ── Test 2: Overdue count matches invoices where due < today and status != paid ─
test('Dashboard overdue count matches unpaid invoices with due < today', async ({ page }) => {
  await waitForApp(page);

  const { expected, displayed } = await page.evaluate(() => {
    const todayStr = today();
    const purplOverdue = DB.a('iv').filter(x =>
      (x.accountId || x.number) && x.status !== 'paid' && x.due && x.due < todayStr
    ).length;
    const lfOverdue = DB.a('lf_invoices').filter(i =>
      i.status !== 'paid' && i.due && i.due < todayStr
    ).length;
    const expected = purplOverdue + lfOverdue;
    const el = document.querySelector('#dash-kpi-combined-overdue .num');
    const displayed = el ? parseInt(el.textContent.trim().replace(/,/g, ''), 10) : null;
    return { expected, displayed };
  });

  console.log(`[inv-math] Overdue count: expected=${expected}, displayed=${displayed}`);
  expect(displayed).not.toBeNull();
  expect(displayed).toBe(expected);
});

// ── Test 3: Mark invoice paid → outstanding decreases by exactly that amount ─
test('Marking a purpl invoice paid decreases outstanding by exactly that amount', async ({ page }) => {
  await waitForApp(page);

  const { invoiceId, amount, outstandingBefore } = await page.evaluate(() => {
    const todayStr = today();
    const unpaid = DB.a('iv').filter(x =>
      (x.accountId || x.number) && x.status !== 'paid' && parseFloat(x.amount || 0) > 0
    );
    if (!unpaid.length) return { invoiceId: null };
    const inv = unpaid[0];
    const purplOutstanding = DB.a('iv')
      .filter(x => (x.accountId || x.number) && x.status !== 'paid')
      .reduce((s, x) => s + parseFloat(x.amount || 0), 0);
    const lfOutstanding = DB.a('lf_invoices')
      .filter(i => i.status !== 'paid')
      .reduce((s, i) => s + (i.total || 0), 0);
    return {
      invoiceId: inv.id,
      amount: parseFloat(inv.amount || 0),
      outstandingBefore: purplOutstanding + lfOutstanding,
    };
  });

  if (!invoiceId) {
    console.log('[inv-math] No unpaid invoices found — skipping mark-paid test');
    return;
  }

  // Mark invoice paid via app function
  await page.evaluate((id) => {
    markPaid(id);
  }, invoiceId);
  await page.waitForTimeout(300);

  const outstandingAfter = await page.evaluate(() => {
    const purplOutstanding = DB.a('iv')
      .filter(x => (x.accountId || x.number) && x.status !== 'paid')
      .reduce((s, x) => s + parseFloat(x.amount || 0), 0);
    const lfOutstanding = DB.a('lf_invoices')
      .filter(i => i.status !== 'paid')
      .reduce((s, i) => s + (i.total || 0), 0);
    return purplOutstanding + lfOutstanding;
  });

  const delta = outstandingBefore - outstandingAfter;
  console.log(`[inv-math] Mark paid: amount=${amount.toFixed(2)}, delta=${delta.toFixed(2)}`);
  expect(Math.abs(delta - amount)).toBeLessThanOrEqual(0.01);
});

// ── Test 4: Delete account → linked invoices removed from DB cache ───────────
test('Delete account removes linked purpl invoices from DB cache', async ({ page }) => {
  await waitForApp(page);

  // Create a test account and two invoices for it
  const testId = 'test-inv-cascade-' + Date.now();
  await page.evaluate((id) => {
    DB.push('ac', { id, name: 'Invoice Cascade Test', status: 'active', isPbf: false });
    DB.push('iv', { id: id + '-inv1', accountId: id, amount: '50.00', status: 'unpaid', due: '2026-01-01' });
    DB.push('iv', { id: id + '-inv2', accountId: id, amount: '75.00', status: 'unpaid', due: '2026-02-01' });
  }, testId);

  // Confirm invoices exist
  const before = await page.evaluate((id) =>
    DB.a('iv').filter(x => x.accountId === id).length
  , testId);
  expect(before).toBe(2);

  // Delete account (bypass confirm dialog)
  await page.evaluate((id) => {
    const orig = window.confirm2;
    window.confirm2 = () => true;
    deleteAccount(id);
    if (orig) window.confirm2 = orig;
  }, testId);
  await page.waitForTimeout(300);

  // Invoices should be gone
  const after = await page.evaluate((id) =>
    DB.a('iv').filter(x => x.accountId === id).length
  , testId);
  expect(after).toBe(0);
  console.log('[inv-math] Delete account cascade: ✓ invoices removed');
});

// ── Test 5: All invoices have required fields ────────────────────────────────
test('All purpl invoices have id, accountId or number, amount and status', async ({ page }) => {
  await waitForApp(page);

  const malformed = await page.evaluate(() =>
    DB.a('iv').filter(x => {
      const hasRef = x.accountId || x.number || x.invoiceNumber;
      const hasAmt = x.amount !== undefined && x.amount !== null;
      return !x.id || !hasRef || !hasAmt || !x.status;
    }).map(x => x.id || '(no-id)')
  );

  if (malformed.length) console.warn('[inv-math] Malformed invoices:', malformed.slice(0, 5));
  expect(malformed).toHaveLength(0);
});
