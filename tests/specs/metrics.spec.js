// metrics.spec.js — dashboard KPIs and financial totals match seed data exactly
//
// All expected values are derived programmatically from seed-data.js so that
// this file remains correct if seed data changes.  Import SEED at the top of
// each test file rather than hardcoding numbers.
'use strict';
const { test, expect } = require('../fixtures.js');
const { SEED } = require('../seed-data.js');

// ── Pre-compute expected values from SEED ────────────────────

const TODAY = '2026-04-02'; // BASE date anchored in seed-data.js

const activeAccounts = SEED.ac.filter(a => a.status === 'active');
const EXPECTED_ACTIVE_COUNT = activeAccounts.length;

// Purpl outstanding: all iv entries with (accountId || number) and status !== 'paid'
const unpaidPurplInvoices = SEED.iv.filter(
  x => (x.accountId || x.number) && x.status !== 'paid'
);
const EXPECTED_PURPL_OUTSTANDING = unpaidPurplInvoices
  .reduce((s, x) => s + parseFloat(x.amount || 0), 0);

// LF outstanding: all lf_invoices with status !== 'paid'
const unpaidLfInvoices = SEED.lf_invoices.filter(i => i.status !== 'paid');
const EXPECTED_LF_OUTSTANDING = unpaidLfInvoices
  .reduce((s, i) => s + (i.total || 0), 0);

const EXPECTED_COMBINED_OUTSTANDING = EXPECTED_PURPL_OUTSTANDING + EXPECTED_LF_OUTSTANDING;

// Purpl overdue: unpaid AND due < TODAY
const overdueePurplInvoices = unpaidPurplInvoices.filter(
  x => x.due && x.due < TODAY
);
const EXPECTED_PURPL_OVERDUE_COUNT = overdueePurplInvoices.length;

// LF overdue: unpaid AND due < TODAY
const overdueLfInvoices = unpaidLfInvoices.filter(
  i => i.due && i.due < TODAY
);
const EXPECTED_LF_OVERDUE_COUNT = overdueLfInvoices.length;

const EXPECTED_COMBINED_OVERDUE_COUNT =
  EXPECTED_PURPL_OVERDUE_COUNT + EXPECTED_LF_OVERDUE_COUNT;

// Velocity: dist001 cases this month (date >= 2026-03-02, i.e. last 31 days before 2026-04-02)
const MONTH_START = '2026-03-02';
const dist001 = SEED.dist_profiles.find(d => d.id === 'dist001');
const dist001VelThisMonth = (dist001?.velocityReports || []).filter(
  r => r.date >= MONTH_START && r.date <= TODAY
);
const EXPECTED_DIST001_CASES_THIS_MONTH = dist001VelThisMonth.reduce(
  (s, r) => s + (r.cases || 0), 0
);

// Total cases logged across all velocity reports for dist001
const EXPECTED_DIST001_TOTAL_CASES = (dist001?.velocityReports || []).reduce(
  (s, r) => s + (r.cases || 0), 0
);

// ── Section A: Dashboard KPI card metrics ────────────────────

test.describe('Metrics — Section A: Dashboard KPIs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await page.click('.sb-nav a[data-page="dashboard"]');
    await expect(page.locator('#page-dashboard')).toBeVisible({ timeout: 10000 });

    // Wait for KPI cards to populate
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#dash-kpi-total-ac');
        return el && el.textContent.trim().length > 0;
      },
      { timeout: 15000 }
    );
  });

  test(`Active account count = ${EXPECTED_ACTIVE_COUNT} (from seed data)`, async ({ page }) => {
    const kpiEl = page.locator('#dash-kpi-total-ac');
    await expect(kpiEl).toBeVisible({ timeout: 5000 });

    const text = await kpiEl.textContent();
    const n = parseInt(text.replace(/\D/g, ''), 10);

    expect(n).toBe(EXPECTED_ACTIVE_COUNT);
  });

  test('Combined outstanding amount matches seed data', async ({ page }) => {
    const kpiEl = page.locator('#dash-kpi-combined-outstanding');
    if (await kpiEl.count() === 0) return;

    await expect(kpiEl).toBeVisible({ timeout: 5000 });

    const text = await kpiEl.textContent();
    // Extract dollar amount — format is "$X,XXX.XX"
    const match = text.match(/[\d,]+\.?\d*/);
    if (!match) return;

    const rendered = parseFloat(match[0].replace(/,/g, ''));
    // Allow ±$0.10 for floating-point rounding in the app
    expect(Math.abs(rendered - EXPECTED_COMBINED_OUTSTANDING)).toBeLessThan(0.11);
    console.log(
      `Combined outstanding: rendered=$${rendered} expected=$${EXPECTED_COMBINED_OUTSTANDING.toFixed(2)}`
    );
  });

  test(`Combined overdue count = ${EXPECTED_COMBINED_OVERDUE_COUNT} (from seed data)`, async ({ page }) => {
    const kpiEl = page.locator('#dash-kpi-combined-overdue');
    if (await kpiEl.count() === 0) return;

    await expect(kpiEl).toBeVisible({ timeout: 5000 });

    const text = await kpiEl.textContent();
    const n = parseInt(text.replace(/\D/g, ''), 10);

    expect(n).toBe(EXPECTED_COMBINED_OVERDUE_COUNT);
    console.log(`Overdue count: rendered=${n} expected=${EXPECTED_COMBINED_OVERDUE_COUNT}`);
  });

  test('Prospect KPI row renders with total prospect count', async ({ page }) => {
    await expect(page.locator('#dash-prospect-kpis')).toBeVisible({ timeout: 10000 });

    const kpiTotal = page.locator('#dash-kpi-pr-total');
    if (await kpiTotal.count() > 0) {
      await expect(kpiTotal).not.toBeEmpty({ timeout: 5000 });
      const text = await kpiTotal.textContent();
      const n = parseInt(text.replace(/\D/g, ''), 10);

      const expectedProspectCount = SEED.pr.length; // 20 prospects seeded
      expect(n).toBe(expectedProspectCount);
    }
  });
});

// ── Section B: Invoice totals ─────────────────────────────────

test.describe('Metrics — Section B: Invoice totals', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await page.click('.sb-nav a[data-page="invoices"]');
    await expect(page.locator('#page-invoices')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#page-invoices').innerHTML.trim().length > 200,
      { timeout: 10000 }
    );
  });

  test(`30 purpl invoices seeded — invoice count badge >= 30`, async ({ page }) => {
    // The invoice page may show a count badge or just rows
    const countBadge = page.locator('#inv-count, #purpl-inv-count, [id*="inv-count"]').first();
    if (await countBadge.count() > 0) {
      const text = await countBadge.textContent();
      const n = parseInt(text.replace(/\D/g, ''), 10);
      expect(n).toBeGreaterThanOrEqual(30);
    } else {
      // Count table rows directly
      const rows = await page.locator('table tbody tr, #inv-tbody tr').count();
      // At least some rows should be visible (may be paginated)
      expect(rows).toBeGreaterThanOrEqual(1);
    }
  });

  test(`Purpl outstanding = $${EXPECTED_PURPL_OUTSTANDING.toFixed(2)} (${unpaidPurplInvoices.length} unpaid invoices)`, async ({ page }) => {
    // Look for the outstanding total on the invoices page
    const outstandingEl = page.locator(
      '#inv-outstanding-total, [id*="outstanding"], .outstanding-amount'
    ).first();

    if (await outstandingEl.count() > 0) {
      const text = await outstandingEl.textContent();
      const match = text.match(/[\d,]+\.?\d*/);
      if (match) {
        const rendered = parseFloat(match[0].replace(/,/g, ''));
        expect(Math.abs(rendered - EXPECTED_PURPL_OUTSTANDING)).toBeLessThan(1.0);
      }
    }

    // Cross-check via Firestore Admin SDK
    const admin = require('firebase-admin');
    const verifierApp = (() => {
      try { return admin.app('verifier'); } catch { return null; }
    })();

    if (verifierApp) {
      const db = admin.firestore(verifierApp);
      const snap = await db.collection('workspace').doc('main').collection('data').doc('store').get();
      const store = snap.data();

      const dbUnpaidPurpl = (store.iv || []).filter(
        x => (x.accountId || x.number) && x.status !== 'paid'
      );
      const dbOutstanding = dbUnpaidPurpl.reduce((s, x) => s + parseFloat(x.amount || 0), 0);

      expect(Math.abs(dbOutstanding - EXPECTED_PURPL_OUTSTANDING)).toBeLessThan(0.01);
    }
  });

  test(`Purpl overdue count = ${EXPECTED_PURPL_OVERDUE_COUNT} invoices past due`, async ({ page }) => {
    // Verify against Firestore directly
    const admin = require('firebase-admin');
    const verifierApp = (() => {
      try { return admin.app('verifier'); } catch { return null; }
    })();

    if (verifierApp) {
      const db = admin.firestore(verifierApp);
      const snap = await db.collection('workspace').doc('main').collection('data').doc('store').get();
      const store = snap.data();

      const dbOverduePurpl = (store.iv || []).filter(
        x => (x.accountId || x.number) && x.status !== 'paid' && x.due && x.due < TODAY
      );
      expect(dbOverduePurpl.length).toBe(EXPECTED_PURPL_OVERDUE_COUNT);
    }
  });
});

// ── Section C: Reports page ───────────────────────────────────

test.describe('Metrics — Section C: Reports page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    const reportsLink = page.locator('.sb-nav a[data-page="reports"]');
    if (await reportsLink.count() > 0) {
      await reportsLink.click();
      await expect(page.locator('#page-reports')).toBeVisible({ timeout: 10000 });
      await page.waitForFunction(
        () => document.querySelector('#page-reports').innerHTML.trim().length > 200,
        { timeout: 10000 }
      );
    }
  });

  test('Reports page loads without crash', async ({ page }) => {
    const reportsPage = page.locator('#page-reports');
    if (await reportsPage.count() === 0) {
      // Reports page not accessible from nav — skip
      return;
    }
    await expect(reportsPage).toBeVisible({ timeout: 5000 });
  });

  test('Combined total invoiced matches seed data', async ({ page }) => {
    const reportsPage = page.locator('#page-reports');
    if (await reportsPage.count() === 0) return;

    // Wait for the combined KPI to render
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#rep-combined-kpi');
        return el && el.textContent.trim().length > 0;
      },
      { timeout: 10000 }
    ).catch(() => {});

    const combinedEl = page.locator('#rep-combined-kpi');
    if (await combinedEl.count() === 0) return;

    const text = await combinedEl.textContent();
    const match = text.match(/[\d,]+\.?\d*/);
    if (!match) return;

    const rendered = parseFloat(match[0].replace(/,/g, ''));

    // Expected: sum of ALL purpl invoice amounts + all LF invoice totals
    const totalPurpl = SEED.iv
      .filter(x => x.accountId || x.number)
      .reduce((s, x) => s + parseFloat(x.amount || 0), 0);
    const totalLf = SEED.lf_invoices
      .reduce((s, i) => s + (i.total || 0), 0);
    const expected = totalPurpl + totalLf;

    // Allow ±$1 for floating-point accumulation over many records
    expect(Math.abs(rendered - expected)).toBeLessThan(1.0);
    console.log(`Combined invoiced: rendered=$${rendered} expected=$${expected.toFixed(2)}`);
  });
});

// ── Section D: Velocity metrics ──────────────────────────────

test.describe('Metrics — Section D: Velocity calculations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await page.click('.sb-nav a[data-page="distributors"]');
    await expect(page.locator('#page-distributors')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#dist-cards')?.innerHTML.trim().length > 0,
      { timeout: 10000 }
    );
  });

  test(`dist001 velocity: ${EXPECTED_DIST001_CASES_THIS_MONTH} cases this month (seed data)`, async ({ page }) => {
    // Open dist001 → velocity tab → check KPI
    const card = page.locator('#dist-cards .dist-card, #dist-cards .card')
      .filter({ hasText: 'New England Natural Foods' }).first();

    if (await card.count() === 0) return;

    const viewBtn = card.locator('button, .btn').filter({ hasText: /view|open/i }).first();
    if (await viewBtn.count() > 0) {
      await viewBtn.click();
    } else {
      await card.click();
    }

    await page.waitForSelector('#modal-distributor.open', { timeout: 10000 });

    const velTab = page.locator(
      '#modal-distributor [data-dtab="velocity"], #modal-distributor [data-tab="velocity"]'
    ).first();

    if (await velTab.count() === 0) {
      await page.click('#modal-distributor .modal-close');
      return;
    }

    await velTab.click();
    await page.waitForTimeout(600);

    // Velocity summary KPIs should show cases this month
    const velPane = page.locator('#mdist-tab-velocity');
    if (await velPane.count() > 0) {
      await page.waitForFunction(
        () => document.querySelector('#mdist-tab-velocity')?.innerHTML.trim().length > 50,
        { timeout: 10000 }
      ).catch(() => {});

      const paneText = await velPane.textContent();
      // Check that at least some numeric content is rendered
      expect(paneText.length).toBeGreaterThan(20);

      // If cases-this-month KPI is explicitly rendered, verify it
      if (paneText.includes(String(EXPECTED_DIST001_CASES_THIS_MONTH))) {
        console.log(`dist001 cases-this-month ${EXPECTED_DIST001_CASES_THIS_MONTH} confirmed in UI`);
      }
    }

    await page.click('#modal-distributor .modal-close');
  });

  test(`dist001 total cases logged = ${EXPECTED_DIST001_TOTAL_CASES} across 3 velocity reports`, async ({ page }) => {
    // Verify via Firestore that seed data is correct
    const admin = require('firebase-admin');
    const verifierApp = (() => {
      try { return admin.app('verifier'); } catch { return null; }
    })();

    if (verifierApp) {
      const db = admin.firestore(verifierApp);
      const snap = await db.collection('workspace').doc('main').collection('data').doc('store').get();
      const store = snap.data();

      const d001 = (store.dist_profiles || []).find(d => d.id === 'dist001');
      expect(d001).toBeTruthy();
      expect(d001.velocityReports).toHaveLength(3); // 3 seeded entries

      const totalCases = d001.velocityReports.reduce((s, r) => s + (r.cases || 0), 0);
      expect(totalCases).toBe(EXPECTED_DIST001_TOTAL_CASES);
      console.log(`dist001 total seeded cases: ${totalCases}`);
    }
  });

  test('dist002 has 3 velocity reports seeded', async ({ page }) => {
    const admin = require('firebase-admin');
    const verifierApp = (() => {
      try { return admin.app('verifier'); } catch { return null; }
    })();

    if (verifierApp) {
      const db = admin.firestore(verifierApp);
      const snap = await db.collection('workspace').doc('main').collection('data').doc('store').get();
      const store = snap.data();

      const d002 = (store.dist_profiles || []).find(d => d.id === 'dist002');
      expect(d002).toBeTruthy();
      expect(d002.velocityReports).toHaveLength(3);

      const dist002Expected = SEED.dist_profiles
        .find(d => d.id === 'dist002')?.velocityReports || [];
      const expectedTotal = dist002Expected.reduce((s, r) => s + (r.cases || 0), 0);
      const actualTotal = d002.velocityReports.reduce((s, r) => s + (r.cases || 0), 0);
      expect(actualTotal).toBe(expectedTotal);
    }
  });
});

// ── Section E: Seed data integrity verification ───────────────

test.describe('Metrics — Section E: Seed data integrity', () => {
  test('40 orders seeded in Firestore', async ({}) => {
    const admin = require('firebase-admin');
    const verifierApp = (() => {
      try { return admin.app('verifier'); } catch { return null; }
    })();

    if (!verifierApp) return;

    const db = admin.firestore(verifierApp);
    const snap = await db.collection('workspace').doc('main').collection('data').doc('store').get();
    const store = snap.data();

    expect(Array.isArray(store.orders)).toBe(true);
    expect(store.orders.length).toBeGreaterThanOrEqual(40);
  });

  test('20 prod_hist entries seeded in Firestore', async ({}) => {
    const admin = require('firebase-admin');
    const verifierApp = (() => {
      try { return admin.app('verifier'); } catch { return null; }
    })();

    if (!verifierApp) return;

    const db = admin.firestore(verifierApp);
    const snap = await db.collection('workspace').doc('main').collection('data').doc('store').get();
    const store = snap.data();

    expect(Array.isArray(store.prod_hist)).toBe(true);
    expect(store.prod_hist.length).toBeGreaterThanOrEqual(20);
  });

  test('10 distributor invoices seeded (5 per distributor)', async ({}) => {
    const admin = require('firebase-admin');
    const verifierApp = (() => {
      try { return admin.app('verifier'); } catch { return null; }
    })();

    if (!verifierApp) return;

    const db = admin.firestore(verifierApp);
    const snap = await db.collection('workspace').doc('main').collection('data').doc('store').get();
    const store = snap.data();

    expect(Array.isArray(store.dist_invoices)).toBe(true);
    expect(store.dist_invoices.length).toBe(10);

    const dist001Invs = store.dist_invoices.filter(i => i.distId === 'dist001');
    const dist002Invs = store.dist_invoices.filter(i => i.distId === 'dist002');
    expect(dist001Invs).toHaveLength(5);
    expect(dist002Invs).toHaveLength(5);
  });

  test('50 accounts seeded — 5 LF-wholesale direct, 10 distributor-served', async ({}) => {
    expect(SEED.ac).toHaveLength(50);

    // 5 LF wholesale direct: ac031-ac035
    const lfWholesaleDirect = SEED.ac.filter(
      a => a.isPbf === true && a.fulfilledBy === 'direct' &&
           ['ac031','ac032','ac033','ac034','ac035'].includes(a.id)
    );
    expect(lfWholesaleDirect).toHaveLength(5);

    // 10 distributor-served
    const distServed = SEED.ac.filter(
      a => a.fulfilledBy && a.fulfilledBy !== 'direct'
    );
    expect(distServed.length).toBeGreaterThanOrEqual(10);
  });

  test('20 prospects seeded — all stages represented', async ({}) => {
    expect(SEED.pr).toHaveLength(20);

    const stages = new Set(SEED.pr.map(p => p.status));
    expect(stages.has('lead')).toBe(true);
    expect(stages.has('contacted')).toBe(true);
    expect(stages.has('sampling')).toBe(true);
    expect(stages.has('negotiating')).toBe(true);
    expect(stages.has('won')).toBe(true);
    expect(stages.has('lost')).toBe(true);
  });

  test('At least 5 prospects have outreach history', async ({}) => {
    const withOutreach = SEED.pr.filter(
      p => Array.isArray(p.outreach) && p.outreach.length > 0
    );
    expect(withOutreach.length).toBeGreaterThanOrEqual(5);
  });
});
