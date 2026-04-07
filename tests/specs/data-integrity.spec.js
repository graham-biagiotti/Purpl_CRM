// data-integrity.spec.js — verify CRUD operations don't leave orphaned records
//
// Phase 4: Data integrity edge cases
// Tests that deleting a parent record cascades correctly to child records,
// and checks for known orphan risks in the current implementation.
'use strict';
const { test, expect } = require('../fixtures.js');

// ── helpers ───────────────────────────────────────────────────

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
}

// Read current DB cache state via page.evaluate
async function getDbSnapshot(page) {
  return page.evaluate(() => {
    if (typeof DB === 'undefined') return null;
    return {
      ac:       [...(DB._cache.ac || [])],
      iv:       [...(DB._cache.iv || [])],
      orders:   [...(DB._cache.orders || [])],
      dist_profiles: [...(DB._cache.dist_profiles || [])],
      dist_reps:     [...(DB._cache.dist_reps || [])],
      dist_pricing:  [...(DB._cache.dist_pricing || [])],
      dist_pos:      [...(DB._cache.dist_pos || [])],
      dist_invoices: [...(DB._cache.dist_invoices || [])],
      dist_chains:   [...(DB._cache.dist_chains || [])],
    };
  });
}

// ── Section A: deleteDistributor cascade ──────────────────────

test.describe('Data integrity — distributor delete cascade', () => {
  test('deleteDistributor removes all child records atomically', async ({ page }) => {
    await waitForApp(page);

    const before = await getDbSnapshot(page);
    if (!before) { console.log('[data-integrity] DB not accessible — skipping'); return; }

    // Create a test distributor with one rep and one pricing entry
    const distId = 'test-cascade-dist-' + Date.now();
    const repId  = 'test-cascade-rep-'  + Date.now();
    const priceId = 'test-cascade-px-'  + Date.now();

    await page.evaluate(({ distId, repId, priceId }) => {
      DB.push('dist_profiles', { id: distId, name: 'Cascade Test Dist', status: 'active' });
      DB.push('dist_reps',     { id: repId,   distId, name: 'Test Rep' });
      DB.push('dist_pricing',  { id: priceId, distId, sku: 'TEST-SKU', price: 9.99 });
    }, { distId, repId, priceId });

    // Verify records were added
    const afterAdd = await getDbSnapshot(page);
    expect(afterAdd.dist_profiles.some(d => d.id === distId)).toBe(true);
    expect(afterAdd.dist_reps.some(r => r.id === repId)).toBe(true);
    expect(afterAdd.dist_pricing.some(p => p.id === priceId)).toBe(true);

    // Call deleteDistributor — but bypass the confirm2 dialog
    await page.evaluate((distId) => {
      // Monkey-patch confirm2 to auto-confirm for this call
      const orig = window.confirm2;
      window.confirm2 = () => true;
      deleteDistributor(distId);
      if (orig) window.confirm2 = orig;
    }, distId);

    await page.waitForTimeout(300);

    const afterDelete = await getDbSnapshot(page);

    // Distributor profile should be gone
    expect(afterDelete.dist_profiles.some(d => d.id === distId)).toBe(false);
    // Rep should be gone
    expect(afterDelete.dist_reps.some(r => r.id === repId)).toBe(false);
    // Pricing should be gone
    expect(afterDelete.dist_pricing.some(p => p.id === priceId)).toBe(false);

    console.log('[data-integrity] deleteDistributor cascade: ✓ clean');
  });
});

// ── Section B: deleteAccount orphan check ─────────────────────

test.describe('Data integrity — account delete orphan check', () => {
  test('deleteAccount removes account record from ac array', async ({ page }) => {
    await waitForApp(page);

    const acId = 'test-orphan-ac-' + Date.now();
    await page.evaluate((acId) => {
      DB.push('ac', { id: acId, name: 'Orphan Test Account', status: 'active', type: 'direct' });
    }, acId);

    const afterAdd = await getDbSnapshot(page);
    expect(afterAdd.ac.some(a => a.id === acId)).toBe(true);

    await page.evaluate((acId) => {
      const orig = window.confirm2;
      window.confirm2 = () => true;
      deleteAccount(acId);
      if (orig) window.confirm2 = orig;
    }, acId);

    await page.waitForTimeout(300);

    const afterDelete = await getDbSnapshot(page);
    expect(afterDelete.ac.some(a => a.id === acId)).toBe(false);
    console.log('[data-integrity] deleteAccount removes record: ✓');
  });

  test('deleteAccount leaves no orphaned invoices (documents gap if any)', async ({ page }) => {
    await waitForApp(page);

    const acId  = 'test-orphan-ac2-' + Date.now();
    const invId = 'test-orphan-inv-' + Date.now();

    // Create account + linked invoice
    await page.evaluate(({ acId, invId }) => {
      DB.push('ac', { id: acId, name: 'Orphan Invoice Account', status: 'active', type: 'direct' });
      DB.push('iv', { id: invId, accountId: acId, number: 'ORF-001', amount: '100', status: 'sent', date: '2026-01-01' });
    }, { acId, invId });

    const afterAdd = await getDbSnapshot(page);
    expect(afterAdd.ac.some(a => a.id === acId)).toBe(true);
    expect(afterAdd.iv.some(i => i.id === invId)).toBe(true);

    // Delete the account
    await page.evaluate((acId) => {
      const orig = window.confirm2;
      window.confirm2 = () => true;
      deleteAccount(acId);
      if (orig) window.confirm2 = orig;
    }, acId);

    await page.waitForTimeout(300);

    const afterDelete = await getDbSnapshot(page);

    const accountGone = !afterDelete.ac.some(a => a.id === acId);
    const invoiceGone = !afterDelete.iv.some(i => i.id === invId);

    expect(accountGone).toBe(true);
    expect(invoiceGone).toBe(true); // deleteAccount must cascade-delete linked invoices
    console.log('[data-integrity] deleteAccount cascade-deleted invoice: ✓');
  });

  test('deleteAccount leaves no orphaned orders (documents gap if any)', async ({ page }) => {
    await waitForApp(page);

    const acId    = 'test-orphan-ac3-' + Date.now();
    const orderId = 'test-orphan-ord-' + Date.now();

    await page.evaluate(({ acId, orderId }) => {
      DB.push('ac', { id: acId, name: 'Orphan Order Account', status: 'active', type: 'direct' });
      DB.push('orders', {
        id: orderId, accountId: acId,
        date: '2026-01-01', status: 'delivered', items: [], total: 0,
      });
    }, { acId, orderId });

    const afterAdd = await getDbSnapshot(page);
    expect(afterAdd.orders.some(o => o.id === orderId)).toBe(true);

    await page.evaluate((acId) => {
      const orig = window.confirm2;
      window.confirm2 = () => true;
      deleteAccount(acId);
      if (orig) window.confirm2 = orig;
    }, acId);

    await page.waitForTimeout(300);

    const afterDelete = await getDbSnapshot(page);
    const accountGone = !afterDelete.ac.some(a => a.id === acId);
    const orderGone   = !afterDelete.orders.some(o => o.id === orderId);

    expect(accountGone).toBe(true);
    expect(orderGone).toBe(true); // deleteAccount must cascade-delete linked orders
    console.log('[data-integrity] deleteAccount cascade-deleted order: ✓');
  });
});

// ── Section C: Orphan scan on seeded data ─────────────────────

test.describe('Data integrity — orphan scan on seeded data', () => {
  test('No seeded invoices reference a non-existent account', async ({ page }) => {
    await waitForApp(page);
    const snap = await getDbSnapshot(page);
    if (!snap) { console.log('[data-integrity] DB not accessible — skipping'); return; }

    const acIds = new Set(snap.ac.map(a => a.id));
    const orphans = snap.iv.filter(inv => inv.accountId && !acIds.has(inv.accountId));

    if (orphans.length > 0) {
      console.warn('[data-integrity] ⚠️  Orphaned invoices in seeded data:');
      orphans.forEach(i => console.warn(`  invoice ${i.id} (number=${i.number}) accountId=${i.accountId}`));
    } else {
      console.log('[data-integrity] No orphaned invoices in seeded data: ✓');
    }

    expect(orphans).toHaveLength(0);
  });

  test('No seeded orders reference a non-existent account', async ({ page }) => {
    await waitForApp(page);
    const snap = await getDbSnapshot(page);
    if (!snap) { console.log('[data-integrity] DB not accessible — skipping'); return; }

    const acIds = new Set(snap.ac.map(a => a.id));
    const orphans = snap.orders.filter(o => o.accountId && !acIds.has(o.accountId));

    if (orphans.length > 0) {
      console.warn('[data-integrity] ⚠️  Orphaned orders in seeded data:');
      orphans.forEach(o => console.warn(`  order ${o.id} accountId=${o.accountId}`));
    } else {
      console.log('[data-integrity] No orphaned orders in seeded data: ✓');
    }

    expect(orphans).toHaveLength(0);
  });

  test('No seeded dist_reps reference a non-existent distributor', async ({ page }) => {
    await waitForApp(page);
    const snap = await getDbSnapshot(page);
    if (!snap) { console.log('[data-integrity] DB not accessible — skipping'); return; }

    const distIds = new Set(snap.dist_profiles.map(d => d.id));
    const orphans = snap.dist_reps.filter(r => r.distId && !distIds.has(r.distId));

    if (orphans.length > 0) {
      console.warn('[data-integrity] ⚠️  Orphaned dist_reps:');
      orphans.forEach(r => console.warn(`  rep ${r.id} (${r.name}) distId=${r.distId}`));
    } else {
      console.log('[data-integrity] No orphaned dist_reps in seeded data: ✓');
    }

    expect(orphans).toHaveLength(0);
  });

  test('No seeded dist_pricing entries reference a non-existent distributor', async ({ page }) => {
    await waitForApp(page);
    const snap = await getDbSnapshot(page);
    if (!snap) { console.log('[data-integrity] DB not accessible — skipping'); return; }

    const distIds = new Set(snap.dist_profiles.map(d => d.id));
    const orphans = snap.dist_pricing.filter(p => p.distId && !distIds.has(p.distId));

    if (orphans.length > 0) {
      console.warn('[data-integrity] ⚠️  Orphaned dist_pricing entries:');
      orphans.forEach(p => console.warn(`  pricing ${p.id} distId=${p.distId}`));
    } else {
      console.log('[data-integrity] No orphaned dist_pricing in seeded data: ✓');
    }

    expect(orphans).toHaveLength(0);
  });
});
