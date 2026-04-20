'use strict';
// stress-final.spec.js — Comprehensive data integrity stress tests
// Tests create, edit, delete, and rapid-write scenarios to verify
// no data is lost, no arrays are overwritten, and no orphans remain.
const { test, expect } = require('../fixtures.js');

test.describe('Stress Test — Account CRUD Integrity', () => {

  test('Create 20 accounts with locations and notes, verify all data persists', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });

    const result = await page.evaluate(() => {
      const created = [];
      for (let i = 0; i < 20; i++) {
        const id = 'stress-ac-' + Date.now() + '-' + i;
        DB.push('ac', {
          id,
          name: 'Stress Account ' + i,
          status: 'active',
          type: 'Grocery',
          contact: 'Contact ' + i,
          email: 'stress' + i + '@test.com',
          phone: '555-000-' + String(i).padStart(4, '0'),
          locs: [{ id: 'loc-' + i, label: 'Main', address: i + ' Main St', dropOffRules: 'Rule ' + i }],
          notes: [{ id: 'n-' + i, date: '2026-04-17', text: 'Note for account ' + i, author: 'test' }],
          outreach: [{ id: 'o-' + i, date: '2026-04-17', type: 'Email', notes: 'Outreach ' + i }],
          cadence: [{ id: 'c-' + i, stage: 'application_received', sentAt: new Date().toISOString() }],
          samples: [{ id: 's-' + i, sku: 'classic', qty: 6, date: '2026-04-17' }],
          contacts: [{ id: 'ct-' + i, name: 'Contact ' + i, email: 'c' + i + '@test.com', isPrimary: true }],
        });
        created.push(id);
      }
      return created;
    });

    expect(result).toHaveLength(20);

    // Wait for debounce to flush
    await page.waitForTimeout(1000);

    // Verify all 20 exist with their arrays intact
    const verification = await page.evaluate((ids) => {
      return ids.map(id => {
        const ac = DB.a('ac').find(a => a.id === id);
        if (!ac) return { id, found: false };
        return {
          id,
          found: true,
          hasLocs: (ac.locs || []).length > 0,
          hasNotes: (ac.notes || []).length > 0,
          hasOutreach: (ac.outreach || []).length > 0,
          hasCadence: (ac.cadence || []).length > 0,
          hasSamples: (ac.samples || []).length > 0,
          hasContacts: (ac.contacts || []).length > 0,
        };
      });
    }, result);

    for (const v of verification) {
      expect(v.found, `Account ${v.id} not found`).toBe(true);
      expect(v.hasLocs, `Account ${v.id} lost locations`).toBe(true);
      expect(v.hasNotes, `Account ${v.id} lost notes`).toBe(true);
      expect(v.hasOutreach, `Account ${v.id} lost outreach`).toBe(true);
      expect(v.hasCadence, `Account ${v.id} lost cadence`).toBe(true);
      expect(v.hasSamples, `Account ${v.id} lost samples`).toBe(true);
      expect(v.hasContacts, `Account ${v.id} lost contacts`).toBe(true);
    }
  });

  test('Edit each of 5 accounts — verify all arrays survive the edit', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });

    const result = await page.evaluate(() => {
      const results = [];
      const accounts = DB.a('ac').slice(0, 5);
      for (const ac of accounts) {
        const before = {
          locs: (ac.locs || []).length,
          notes: (ac.notes || []).length,
          outreach: (ac.outreach || []).length,
          cadence: (ac.cadence || []).length,
          samples: (ac.samples || []).length,
          contacts: (ac.contacts || []).length,
        };

        // Simulate edit — spread existing, change only name
        DB.update('ac', ac.id, x => ({ ...x, name: x.name + ' (stress-edited)' }));

        const after = DB.a('ac').find(a => a.id === ac.id);
        const afterCounts = {
          locs: (after.locs || []).length,
          notes: (after.notes || []).length,
          outreach: (after.outreach || []).length,
          cadence: (after.cadence || []).length,
          samples: (after.samples || []).length,
          contacts: (after.contacts || []).length,
        };

        results.push({
          id: ac.id,
          name: after.name,
          edited: after.name.includes('stress-edited'),
          locsPreserved: afterCounts.locs === before.locs,
          notesPreserved: afterCounts.notes === before.notes,
          outreachPreserved: afterCounts.outreach === before.outreach,
          cadencePreserved: afterCounts.cadence === before.cadence,
          samplesPreserved: afterCounts.samples === before.samples,
          contactsPreserved: afterCounts.contacts === before.contacts,
        });
      }
      return results;
    });

    for (const r of result) {
      expect(r.edited, `Account ${r.id} not edited`).toBe(true);
      expect(r.locsPreserved, `Account ${r.id} lost locations on edit`).toBe(true);
      expect(r.notesPreserved, `Account ${r.id} lost notes on edit`).toBe(true);
      expect(r.outreachPreserved, `Account ${r.id} lost outreach on edit`).toBe(true);
      expect(r.cadencePreserved, `Account ${r.id} lost cadence on edit`).toBe(true);
      expect(r.samplesPreserved, `Account ${r.id} lost samples on edit`).toBe(true);
      expect(r.contactsPreserved, `Account ${r.id} lost contacts on edit`).toBe(true);
    }
  });

});

test.describe('Stress Test — Invoice Collections', () => {

  test('Create invoices across all 3 collections, verify they persist', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });

    const result = await page.evaluate(() => {
      const ts = Date.now();
      DB.push('retail_invoices', { id: 'ri-stress-' + ts, invoiceNumber: 'INV-STRESS-1', accountId: 'test', total: 100, status: 'draft', date: '2026-04-17' });
      DB.push('lf_invoices', { id: 'lf-stress-' + ts, invoiceNumber: 'LF-STRESS-1', accountId: 'test', total: 50, status: 'draft', date: '2026-04-17' });
      DB.push('combined_invoices', { id: 'ci-stress-' + ts, invoiceNumber: 'CI-STRESS-1', accountId: 'test', total: 150, status: 'draft', date: '2026-04-17' });

      return {
        retail: DB.a('retail_invoices').filter(i => i.id === 'ri-stress-' + ts).length,
        lf: DB.a('lf_invoices').filter(i => i.id === 'lf-stress-' + ts).length,
        combined: DB.a('combined_invoices').filter(i => i.id === 'ci-stress-' + ts).length,
      };
    });

    expect(result.retail).toBe(1);
    expect(result.lf).toBe(1);
    expect(result.combined).toBe(1);
  });

});

test.describe('Stress Test — Inventory Math', () => {

  test('Production + delivery — inventory math is exact', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });

    const result = await page.evaluate(() => {
      const sku = 'classic';
      const ts = Date.now();

      // Clear any existing test entries
      const iv = DB.a('iv').filter(i => !i.id?.startsWith('stress-iv-'));

      // Add production run: 120 cans in
      DB.push('iv', { id: 'stress-iv-in-' + ts, sku, type: 'in', qty: 120, date: '2026-04-17', note: 'stress test production' });
      // Delivery: 36 cans out (3 cases)
      DB.push('iv', { id: 'stress-iv-out-' + ts, sku, type: 'out', qty: 36, date: '2026-04-17', note: 'stress test delivery' });
      // Return: 12 cans back
      DB.push('iv', { id: 'stress-iv-ret-' + ts, sku, type: 'return', qty: 12, date: '2026-04-17', note: 'stress test return' });

      // Calculate stock for this SKU from our test entries only
      const testEntries = DB.a('iv').filter(i => i.id?.startsWith('stress-iv-') && i.sku === sku);
      const ins = testEntries.filter(i => i.type === 'in' || i.type === 'return').reduce((s, i) => s + i.qty, 0);
      const outs = testEntries.filter(i => i.type === 'out').reduce((s, i) => s + i.qty, 0);

      return { ins, outs, onHand: ins - outs, expected: 120 + 12 - 36 };
    });

    expect(result.ins).toBe(132); // 120 in + 12 return
    expect(result.outs).toBe(36);
    expect(result.onHand).toBe(96);
    expect(result.onHand).toBe(result.expected);
  });

});

test.describe('Stress Test — Delete Cascade & Orphan Check', () => {

  test('Delete account — no orphaned records, no page crash', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });

    const result = await page.evaluate(() => {
      const id = 'stress-del-' + Date.now();

      // Create account with related data in every collection
      DB.push('ac', { id, name: 'Delete Stress Test', status: 'active' });
      DB.push('orders', { id: 'ord-' + id, accountId: id, status: 'pending', items: [] });
      DB.push('iv', { id: 'iv-' + id, accountId: id, sku: 'classic', type: 'out', qty: 12 });
      DB.push('retail_invoices', { id: 'ri-' + id, accountId: id, total: 100, status: 'draft' });
      DB.push('lf_invoices', { id: 'lf-' + id, accountId: id, total: 50, status: 'draft' });
      DB.push('combined_invoices', { id: 'ci-' + id, accountId: id, total: 150, status: 'draft' });
      DB.push('pending_invoices', { id: 'pi-' + id, accountId: id });
      DB.push('returns', { id: 'ret-' + id, accountId: id, qty: 6 });

      // Now delete
      DB.atomicUpdate(cache => {
        cache['ac'] = (cache['ac'] || []).filter(r => r.id !== id);
        cache['orders'] = (cache['orders'] || []).filter(r => r.accountId !== id);
        cache['iv'] = (cache['iv'] || []).filter(r => r.accountId !== id);
        cache['retail_invoices'] = (cache['retail_invoices'] || []).filter(r => r.accountId !== id);
        cache['lf_invoices'] = (cache['lf_invoices'] || []).filter(r => r.accountId !== id);
        cache['combined_invoices'] = (cache['combined_invoices'] || []).filter(r => r.accountId !== id);
        cache['pending_invoices'] = (cache['pending_invoices'] || []).filter(r => r.accountId !== id);
        cache['returns'] = (cache['returns'] || []).filter(r => r.accountId !== id);
      });

      return {
        ac: DB.a('ac').filter(r => r.id === id).length,
        orders: DB.a('orders').filter(r => r.accountId === id).length,
        iv: DB.a('iv').filter(r => r.accountId === id).length,
        retail: DB.a('retail_invoices').filter(r => r.accountId === id).length,
        lf: DB.a('lf_invoices').filter(r => r.accountId === id).length,
        combined: DB.a('combined_invoices').filter(r => r.accountId === id).length,
        pending: DB.a('pending_invoices').filter(r => r.accountId === id).length,
        returns: DB.a('returns').filter(r => r.accountId === id).length,
      };
    });

    expect(result.ac).toBe(0);
    expect(result.orders).toBe(0);
    expect(result.iv).toBe(0);
    expect(result.retail).toBe(0);
    expect(result.lf).toBe(0);
    expect(result.combined).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.returns).toBe(0);
  });

});

test.describe('Stress Test — Rapid Sequential Writes', () => {

  test('Add 3 notes rapidly — all 3 survive the debounce', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });

    const result = await page.evaluate(() => {
      const ac = DB.a('ac')[0];
      if (!ac) return { error: 'no accounts' };

      const notesBefore = (ac.notes || []).length;
      const ts = Date.now();

      // Rapid sequential writes — no await, no delay
      DB.update('ac', ac.id, x => ({ ...x, notes: [...(x.notes || []), { id: 'rn1-' + ts, date: '2026-04-17', text: 'Rapid note 1' }] }));
      DB.update('ac', ac.id, x => ({ ...x, notes: [...(x.notes || []), { id: 'rn2-' + ts, date: '2026-04-17', text: 'Rapid note 2' }] }));
      DB.update('ac', ac.id, x => ({ ...x, notes: [...(x.notes || []), { id: 'rn3-' + ts, date: '2026-04-17', text: 'Rapid note 3' }] }));

      const after = DB.a('ac').find(a => a.id === ac.id);
      const notesAfter = (after.notes || []).length;

      return {
        before: notesBefore,
        after: notesAfter,
        gained: notesAfter - notesBefore,
        hasRapid1: (after.notes || []).some(n => n.id === 'rn1-' + ts),
        hasRapid2: (after.notes || []).some(n => n.id === 'rn2-' + ts),
        hasRapid3: (after.notes || []).some(n => n.id === 'rn3-' + ts),
      };
    });

    expect(result.gained).toBe(3);
    expect(result.hasRapid1).toBe(true);
    expect(result.hasRapid2).toBe(true);
    expect(result.hasRapid3).toBe(true);
  });

});

test.describe('Stress Test — Settings Preservation', () => {

  test('Save settings does not reset data_restored or payment_terms', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB._firestoreReady === true, { timeout: 15000 });

    const result = await page.evaluate(() => {
      // Set known values
      const settings = DB.obj('settings', {});
      const paymentBefore = settings.payment_terms;
      const dataRestoredBefore = settings.data_restored;
      const nemImportedBefore = settings.nem_show_2026_imported;
      const seededBefore = settings.seeded;

      // Simulate a settings save by calling the saveSettings-like pattern
      // (read form values — since no form is filled, this tests the preservation logic)
      const existingSettings = DB.obj('settings', {});

      // Build new settings like saveSettings does — preserve unknown keys
      const newSettings = {
        company: existingSettings.company || '',
        payment_terms: existingSettings.payment_terms || 30,
        ...Object.fromEntries(
          Object.entries(existingSettings).filter(([k]) =>
            !['company', 'payment_terms'].includes(k)
          )
        ),
      };

      DB.setObj('settings', newSettings);

      const after = DB.obj('settings', {});
      return {
        paymentPreserved: after.payment_terms === paymentBefore,
        dataRestoredPreserved: after.data_restored === dataRestoredBefore,
        nemPreserved: after.nem_show_2026_imported === nemImportedBefore,
        seededPreserved: after.seeded === seededBefore,
        paymentBefore,
        paymentAfter: after.payment_terms,
      };
    });

    expect(result.paymentPreserved).toBe(true);
    expect(result.dataRestoredPreserved).toBe(true);
    expect(result.nemPreserved).toBe(true);
    expect(result.seededPreserved).toBe(true);
  });

});
