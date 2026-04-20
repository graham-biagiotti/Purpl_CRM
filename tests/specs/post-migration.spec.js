'use strict';
// post-migration.spec.js — Verify multi-collection architecture
// Tests data round-trips, cross-collection operations, and no contamination
const { test, expect } = require('../fixtures.js');

async function waitForDB(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });
}

// ═══════════════════════════════════════════
//  1. DATA SURVIVAL — verify migration intact
// ═══════════════════════════════════════════

test.describe('Post-Migration — Data Survival', () => {

  test('All COLLECTION_KEYS have data in cache', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => ({
      ac: DB.a('ac').length,
      pr: DB.a('pr').length,
      dist_profiles: DB.a('dist_profiles').length,
      audit_log: DB.a('audit_log').length,
    }));
    expect(result.ac).toBeGreaterThan(0);
    expect(result.pr).toBeGreaterThan(0);
    expect(result.dist_profiles).toBeGreaterThan(0);
    expect(result.audit_log).toBeGreaterThan(0);
  });

  test('OBJ_KEYS loaded correctly', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => ({
      settings: typeof DB.obj('settings', null),
      costs: typeof DB.obj('costs', null),
      hasSeeded: DB.obj('settings', {}).seeded,
    }));
    expect(result.settings).toBe('object');
    expect(result.costs).toBe('object');
    expect(result.hasSeeded).toBe(true);
  });

  test('Every account has an id field', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() =>
      DB.a('ac').every(a => typeof a.id === 'string' && a.id.length > 0)
    );
    expect(result).toBe(true);
  });

  test('Every prospect has an id field', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() =>
      DB.a('pr').every(p => typeof p.id === 'string' && p.id.length > 0)
    );
    expect(result).toBe(true);
  });

});

// ═══════════════════════════════════════════
//  2. CRUD — push, update, remove per collection
// ═══════════════════════════════════════════

test.describe('Post-Migration — CRUD Round-Trips', () => {

  test('Push to ac, read back, update, read, remove, verify gone', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const id = 'pm-test-ac-' + Date.now();
      DB.push('ac', { id, name: 'Post-Migration Test', status: 'active', notes: [{ id: 'n1', text: 'test note' }] });
      const afterPush = DB.a('ac').find(a => a.id === id);
      if (!afterPush) return { step: 'push', error: 'not found after push' };

      DB.update('ac', id, a => ({ ...a, name: 'Updated Name', phone: '555-1234' }));
      const afterUpdate = DB.a('ac').find(a => a.id === id);
      if (afterUpdate.name !== 'Updated Name') return { step: 'update', error: 'name not updated' };
      if (afterUpdate.phone !== '555-1234') return { step: 'update', error: 'phone not set' };
      if (!afterUpdate.notes || afterUpdate.notes.length !== 1) return { step: 'update', error: 'notes lost on update' };

      DB.remove('ac', id);
      const afterRemove = DB.a('ac').find(a => a.id === id);
      if (afterRemove) return { step: 'remove', error: 'still found after remove' };

      return { success: true };
    });
    expect(result.success).toBe(true);
  });

  test('Push to orders, read back, remove', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const id = 'pm-test-ord-' + Date.now();
      DB.push('orders', { id, accountId: 'test', status: 'pending', items: [{ sku: 'classic', qty: 2 }] });
      const found = DB.a('orders').find(o => o.id === id);
      DB.remove('orders', id);
      const gone = DB.a('orders').find(o => o.id === id);
      return { found: !!found, items: found?.items?.length, gone: !gone };
    });
    expect(result.found).toBe(true);
    expect(result.items).toBe(1);
    expect(result.gone).toBe(true);
  });

  test('Push to retail_invoices, read back, remove', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const id = 'pm-test-ri-' + Date.now();
      DB.push('retail_invoices', { id, invoiceNumber: 'TEST-001', total: 99.99, status: 'draft' });
      const found = DB.a('retail_invoices').find(i => i.id === id);
      DB.remove('retail_invoices', id);
      return { found: !!found, total: found?.total, gone: !DB.a('retail_invoices').find(i => i.id === id) };
    });
    expect(result.found).toBe(true);
    expect(result.total).toBe(99.99);
    expect(result.gone).toBe(true);
  });

  test('Push to iv (inventory), read back, remove', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const id = 'pm-test-iv-' + Date.now();
      DB.push('iv', { id, sku: 'classic', type: 'in', qty: 100, date: '2026-04-20' });
      const found = DB.a('iv').find(i => i.id === id);
      DB.remove('iv', id);
      return { found: !!found, qty: found?.qty, gone: !DB.a('iv').find(i => i.id === id) };
    });
    expect(result.found).toBe(true);
    expect(result.qty).toBe(100);
    expect(result.gone).toBe(true);
  });

  test('setObj / obj round-trip for config data', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const orig = DB.obj('settings', {});
      const testVal = 'pm-test-' + Date.now();
      DB.setObj('settings', { ...orig, _pmTest: testVal });
      const after = DB.obj('settings', {});
      // Restore
      DB.setObj('settings', { ...after, _pmTest: undefined });
      return { set: after._pmTest === testVal, seededPreserved: after.seeded === orig.seeded };
    });
    expect(result.set).toBe(true);
    expect(result.seededPreserved).toBe(true);
  });

});

// ═══════════════════════════════════════════
//  3. CROSS-COLLECTION OPERATIONS
// ═══════════════════════════════════════════

test.describe('Post-Migration — Cross-Collection atomicUpdate', () => {

  test('deleteAccount removes from ac AND cleans orders, invoices, iv', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const id = 'pm-del-' + Date.now();
      DB.push('ac', { id, name: 'Delete Target', status: 'active' });
      DB.push('orders', { id: 'ord-' + id, accountId: id, status: 'pending' });
      DB.push('retail_invoices', { id: 'ri-' + id, accountId: id, total: 50 });
      DB.push('iv', { id: 'iv-' + id, accountId: id, sku: 'classic', type: 'out', qty: 12 });
      DB.push('lf_invoices', { id: 'lf-' + id, accountId: id, total: 30 });
      DB.push('combined_invoices', { id: 'ci-' + id, accountId: id, total: 80 });

      DB.atomicUpdate(cache => {
        cache['ac'] = (cache['ac'] || []).filter(r => r.id !== id);
        cache['orders'] = (cache['orders'] || []).filter(r => r.accountId !== id);
        cache['retail_invoices'] = (cache['retail_invoices'] || []).filter(r => r.accountId !== id);
        cache['iv'] = (cache['iv'] || []).filter(r => r.accountId !== id);
        cache['lf_invoices'] = (cache['lf_invoices'] || []).filter(r => r.accountId !== id);
        cache['combined_invoices'] = (cache['combined_invoices'] || []).filter(r => r.accountId !== id);
      });

      return {
        ac: DB.a('ac').filter(r => r.id === id).length,
        orders: DB.a('orders').filter(r => r.accountId === id).length,
        ri: DB.a('retail_invoices').filter(r => r.accountId === id).length,
        iv: DB.a('iv').filter(r => r.accountId === id).length,
        lf: DB.a('lf_invoices').filter(r => r.accountId === id).length,
        ci: DB.a('combined_invoices').filter(r => r.accountId === id).length,
      };
    });
    expect(result.ac).toBe(0);
    expect(result.orders).toBe(0);
    expect(result.ri).toBe(0);
    expect(result.iv).toBe(0);
    expect(result.lf).toBe(0);
    expect(result.ci).toBe(0);
  });

  test('convertProspect: removes from pr, adds to ac', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const prId = 'pm-pr-' + Date.now();
      DB.push('pr', { id: prId, name: 'Convert Target', status: 'lead', notes: [{ id: 'n1', text: 'test' }] });

      const acId = 'pm-ac-conv-' + Date.now();
      DB.atomicUpdate(cache => {
        cache['pr'] = (cache['pr'] || []).filter(x => x.id !== prId);
        cache['ac'] = [...(cache['ac'] || []), { id: acId, name: 'Convert Target', status: 'active', convertedFrom: 'prospect' }];
      });

      return {
        prGone: !DB.a('pr').find(p => p.id === prId),
        acExists: !!DB.a('ac').find(a => a.id === acId),
        acName: DB.a('ac').find(a => a.id === acId)?.name,
      };
    });
    expect(result.prGone).toBe(true);
    expect(result.acExists).toBe(true);
    expect(result.acName).toBe('Convert Target');
  });

  test('Delivery run: creates order + updates account lastOrder', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const acId = 'pm-run-ac-' + Date.now();
      const ordId = 'pm-run-ord-' + Date.now();
      DB.push('ac', { id: acId, name: 'Run Target', status: 'active', lastOrder: null });

      DB.atomicUpdate(cache => {
        cache['orders'] = [...(cache['orders'] || []), { id: ordId, accountId: acId, status: 'delivered', source: 'run' }];
        cache['ac'] = (cache['ac'] || []).map(a => a.id === acId ? { ...a, lastOrder: '2026-04-20' } : a);
      });

      const ac = DB.a('ac').find(a => a.id === acId);
      const ord = DB.a('orders').find(o => o.id === ordId);

      // Cleanup
      DB.remove('ac', acId);
      DB.remove('orders', ordId);

      return {
        lastOrder: ac?.lastOrder,
        orderExists: !!ord,
        orderAccountId: ord?.accountId,
      };
    });
    expect(result.lastOrder).toBe('2026-04-20');
    expect(result.orderExists).toBe(true);
    expect(result.orderAccountId).toContain('pm-run-ac-');
  });

});

// ═══════════════════════════════════════════
//  4. NO CROSS-CONTAMINATION
// ═══════════════════════════════════════════

test.describe('Post-Migration — No Cross-Contamination', () => {

  test('Writing to ac does not affect pr', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const prBefore = DB.a('pr').length;
      const id = 'pm-contam-' + Date.now();
      DB.push('ac', { id, name: 'Contamination Test' });
      const prAfter = DB.a('pr').length;
      DB.remove('ac', id);
      return { prBefore, prAfter, same: prBefore === prAfter };
    });
    expect(result.same).toBe(true);
  });

  test('Writing to orders does not affect retail_invoices', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const riBefore = DB.a('retail_invoices').length;
      const id = 'pm-contam-ord-' + Date.now();
      DB.push('orders', { id, accountId: 'test', status: 'pending' });
      const riAfter = DB.a('retail_invoices').length;
      DB.remove('orders', id);
      return { same: riBefore === riAfter };
    });
    expect(result.same).toBe(true);
  });

  test('Writing to config keys does not affect collection keys', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const acBefore = DB.a('ac').length;
      DB.push('quick_notes', { id: 'pm-qn-' + Date.now(), text: 'test', ts: Date.now() });
      const acAfter = DB.a('ac').length;
      return { same: acBefore === acAfter };
    });
    expect(result.same).toBe(true);
  });

  test('Rapid writes to different collections do not interfere', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const ts = Date.now();
      // Write to 5 different collections rapidly
      DB.push('ac', { id: 'pm-rapid-ac-' + ts, name: 'Rapid AC' });
      DB.push('pr', { id: 'pm-rapid-pr-' + ts, name: 'Rapid PR' });
      DB.push('orders', { id: 'pm-rapid-ord-' + ts, accountId: 'test' });
      DB.push('iv', { id: 'pm-rapid-iv-' + ts, sku: 'classic', type: 'in', qty: 10 });
      DB.push('retail_invoices', { id: 'pm-rapid-ri-' + ts, total: 25 });

      const ac = DB.a('ac').find(a => a.id === 'pm-rapid-ac-' + ts);
      const pr = DB.a('pr').find(p => p.id === 'pm-rapid-pr-' + ts);
      const ord = DB.a('orders').find(o => o.id === 'pm-rapid-ord-' + ts);
      const iv = DB.a('iv').find(i => i.id === 'pm-rapid-iv-' + ts);
      const ri = DB.a('retail_invoices').find(i => i.id === 'pm-rapid-ri-' + ts);

      // Cleanup
      DB.remove('ac', 'pm-rapid-ac-' + ts);
      DB.remove('pr', 'pm-rapid-pr-' + ts);
      DB.remove('orders', 'pm-rapid-ord-' + ts);
      DB.remove('iv', 'pm-rapid-iv-' + ts);
      DB.remove('retail_invoices', 'pm-rapid-ri-' + ts);

      return {
        allFound: !!ac && !!pr && !!ord && !!iv && !!ri,
        acName: ac?.name,
        prName: pr?.name,
        ivQty: iv?.qty,
        riTotal: ri?.total,
      };
    });
    expect(result.allFound).toBe(true);
    expect(result.acName).toBe('Rapid AC');
    expect(result.prName).toBe('Rapid PR');
    expect(result.ivQty).toBe(10);
    expect(result.riTotal).toBe(25);
  });

});

// ═══════════════════════════════════════════
//  5. EDGE CASES
// ═══════════════════════════════════════════

test.describe('Post-Migration — Edge Cases', () => {

  test('Update preserves all fields (no data loss on edit)', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const id = 'pm-preserve-' + Date.now();
      DB.push('ac', {
        id, name: 'Preserve Test', status: 'active',
        notes: [{ id: 'n1', text: 'keep me' }],
        outreach: [{ id: 'o1', type: 'email' }],
        cadence: [{ id: 'c1', stage: 'welcome' }],
        contacts: [{ id: 'ct1', name: 'John' }],
        locs: [{ id: 'l1', address: '123 Main St' }],
        samples: [{ id: 's1', sku: 'classic' }],
      });

      // Update only the name
      DB.update('ac', id, a => ({ ...a, name: 'Preserve Updated' }));
      const after = DB.a('ac').find(a => a.id === id);

      DB.remove('ac', id);

      return {
        name: after?.name,
        notes: after?.notes?.length,
        outreach: after?.outreach?.length,
        cadence: after?.cadence?.length,
        contacts: after?.contacts?.length,
        locs: after?.locs?.length,
        samples: after?.samples?.length,
      };
    });
    expect(result.name).toBe('Preserve Updated');
    expect(result.notes).toBe(1);
    expect(result.outreach).toBe(1);
    expect(result.cadence).toBe(1);
    expect(result.contacts).toBe(1);
    expect(result.locs).toBe(1);
    expect(result.samples).toBe(1);
  });

  test('atomicUpdate across 3 collections — all changes visible', async ({ page }) => {
    await waitForDB(page);
    const result = await page.evaluate(() => {
      const ts = Date.now();
      const acId = 'pm-atomic-ac-' + ts;
      const ordId = 'pm-atomic-ord-' + ts;
      const ivId = 'pm-atomic-iv-' + ts;

      DB.atomicUpdate(cache => {
        cache['ac'] = [...(cache['ac'] || []), { id: acId, name: 'Atomic Test', lastOrder: '2026-04-20' }];
        cache['orders'] = [...(cache['orders'] || []), { id: ordId, accountId: acId, status: 'delivered' }];
        cache['iv'] = [...(cache['iv'] || []), { id: ivId, sku: 'classic', type: 'out', qty: 24, ordId }];
      });

      const ac = DB.a('ac').find(a => a.id === acId);
      const ord = DB.a('orders').find(o => o.id === ordId);
      const iv = DB.a('iv').find(i => i.id === ivId);

      // Cleanup
      DB.remove('ac', acId);
      DB.remove('orders', ordId);
      DB.remove('iv', ivId);

      return { ac: !!ac, ord: !!ord, iv: !!iv, ivQty: iv?.qty };
    });
    expect(result.ac).toBe(true);
    expect(result.ord).toBe(true);
    expect(result.iv).toBe(true);
    expect(result.ivQty).toBe(24);
  });

});
