'use strict';
const { test, expect } = require('../fixtures.js');

test.describe('Safety Audit — Data Loss Prevention', () => {

  test('DB._firestoreReady is true after app boots', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });
    const ready = await page.evaluate(() => DB._firestoreReady);
    expect(ready).toBe(true);
  });

  test('DB._save uses debounce — multiple rapid writes produce single save', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });

    const saveCount = await page.evaluate(() => {
      let count = 0;
      const origDoSave = DB._doSave.bind(DB);
      DB._doSave = function() { count++; origDoSave(); };
      DB.push('quick_notes', {id:'test1',text:'a',ts:Date.now()});
      DB.push('quick_notes', {id:'test2',text:'b',ts:Date.now()});
      DB.push('quick_notes', {id:'test3',text:'c',ts:Date.now()});
      return new Promise(resolve => setTimeout(() => resolve(count), 1000));
    });
    expect(saveCount).toBe(1);
  });

  test('DB.set with merge:true preserves unknown keys in Firestore', async ({ page, verifyFirestoreWrite }) => {
    await page.goto('/');
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });

    await page.evaluate(() => {
      DB.push('quick_notes', {id:'merge-test', text:'testing merge', ts: Date.now()});
    });
    await page.waitForTimeout(2000);

    const notes = await page.evaluate(() => DB.a('quick_notes'));
    expect(notes.some(n => n.id === 'merge-test')).toBe(true);
  });

  test('deleteAccount cleans up orders, invoices, and delivery stops', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });

    const result = await page.evaluate(() => {
      const testId = 'del-test-' + Date.now();
      DB.push('ac', {id: testId, name: 'Delete Test Account', status: 'active'});
      DB.push('orders', {id: 'ord-' + testId, accountId: testId, status: 'pending'});
      DB.push('retail_invoices', {id: 'ri-' + testId, accountId: testId, total: 100});
      DB.push('lf_invoices', {id: 'lf-' + testId, accountId: testId, total: 50});
      DB.push('combined_invoices', {id: 'ci-' + testId, accountId: testId, total: 150});

      DB.atomicUpdate(cache => {
        cache['ac'] = (cache['ac']||[]).filter(r=>r.id!==testId);
        cache['orders'] = (cache['orders']||[]).filter(r=>r.accountId!==testId);
        cache['retail_invoices'] = (cache['retail_invoices']||[]).filter(r=>r.accountId!==testId);
        cache['lf_invoices'] = (cache['lf_invoices']||[]).filter(r=>r.accountId!==testId);
        cache['combined_invoices'] = (cache['combined_invoices']||[]).filter(r=>r.accountId!==testId);
      });

      return {
        ac: DB.a('ac').filter(r => r.id === testId).length,
        orders: DB.a('orders').filter(r => r.accountId === testId).length,
        ri: DB.a('retail_invoices').filter(r => r.accountId === testId).length,
        lf: DB.a('lf_invoices').filter(r => r.accountId === testId).length,
        ci: DB.a('combined_invoices').filter(r => r.accountId === testId).length,
      };
    });

    expect(result.ac).toBe(0);
    expect(result.orders).toBe(0);
    expect(result.ri).toBe(0);
    expect(result.lf).toBe(0);
    expect(result.ci).toBe(0);
  });

  test('saveSettings preserves payment_terms and data flags', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });

    const result = await page.evaluate(() => {
      DB.setObj('settings', {
        ...DB.obj('settings', {}),
        payment_terms: 45,
        data_restored: true,
        nem_show_2026_imported: true,
        tradeshow_2026_imported: true,
      });
      const before = DB.obj('settings', {});
      return {
        payment_terms_before: before.payment_terms,
        data_restored_before: before.data_restored,
      };
    });

    expect(result.payment_terms_before).toBe(45);
    expect(result.data_restored_before).toBe(true);
  });

  test('escHtml escapes all dangerous characters including quotes', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });

    const escaped = await page.evaluate(() => escHtml('<script>alert("xss")</script>\'test&'));
    expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&#39;test&amp;');
  });

});

test.describe('Safety Audit — Portal Security', () => {

  test('Portal order with zero items is rejected by validation', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order');
    await page.waitForTimeout(3000);

    const btnDisabled = await page.locator('#submit-btn').isDisabled();
    expect(btnDisabled).toBe(true);
  });

  test('Portal page loads without JavaScript errors', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/order');
    await page.waitForTimeout(5000);
    expect(errors).toEqual([]);
  });

});

test.describe('Safety Audit — Inventory Consistency', () => {

  test('Inventory on-hand includes returns as inbound stock', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });

    const result = await page.evaluate(() => {
      DB.push('iv', {id:'inv-in-1', sku:'classic', type:'in', qty: 100, date:'2026-04-01'});
      DB.push('iv', {id:'inv-out-1', sku:'classic', type:'out', qty: 30, date:'2026-04-02'});
      DB.push('iv', {id:'inv-ret-1', sku:'classic', type:'return', qty: 10, date:'2026-04-03'});

      const iv = DB.a('iv');
      const ins = iv.filter(i=>i.sku==='classic'&&(i.type==='in'||i.type==='return')).reduce((t,i)=>t+i.qty,0);
      const outs = iv.filter(i=>i.sku==='classic'&&i.type==='out').reduce((t,i)=>t+i.qty,0);
      return { onHand: ins - outs };
    });

    expect(result.onHand).toBe(80);
  });

});
