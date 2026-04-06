// scalability.spec.js — render performance with full business-scale seed data
//
// All timing thresholds are measured as wall-clock time from click/navigation
// to the page becoming fully populated.  The Playwright container is not a
// production server; these tests use generous limits that any correctly-written
// O(n) render should meet even in emulated conditions.
'use strict';
const { test, expect } = require('../fixtures.js');

// ── helpers ───────────────────────────────────────────────────

/**
 * Navigate to a page and return the milliseconds it took for the page
 * container to be non-empty.
 */
async function measureRender(page, navSelector, containerSelector, populatedFn) {
  const t0 = Date.now();
  await page.click(navSelector);
  await expect(page.locator(containerSelector)).toBeVisible({ timeout: 15000 });

  if (populatedFn) {
    await page.waitForFunction(populatedFn, { timeout: 15000 });
  } else {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el && el.innerHTML.trim().length > 200;
      },
      containerSelector,
      { timeout: 15000 }
    );
  }

  return Date.now() - t0;
}

// ── Section A: Page render times ────────────────────────────

test.describe('Scalability — Section A: Render times with full seed data', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    // Ensure we start from dashboard (already rendered)
    await page.click('.sb-nav a[data-page="dashboard"]');
    await expect(page.locator('#page-dashboard')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(200); // brief settle
  });

  test('Accounts page with 50 accounts — renders in under 3 seconds', async ({ page }) => {
    const ms = await measureRender(
      page,
      '.sb-nav a[data-page="accounts"]',
      '#page-accounts',
      () => {
        const el = document.querySelector('#ac-cards');
        return el && el.querySelectorAll('.ac-card, .card').length > 0;
      }
    );

    expect(ms).toBeLessThan(3000);
    console.log(`Accounts render time: ${ms}ms`);

    // Verify all 50 accounts are loaded (some may be filtered by default view)
    const cards = await page.locator('#ac-cards .ac-card, #ac-cards .card').count();
    expect(cards).toBeGreaterThanOrEqual(10); // at minimum 10 visible
  });

  test('Invoice page with 53 invoices — renders in under 3 seconds', async ({ page }) => {
    // 30 purpl + 15 LF + 8 combined = 53 invoice rows in various tables
    const ms = await measureRender(
      page,
      '.sb-nav a[data-page="invoices"]',
      '#page-invoices',
      () => document.querySelector('#page-invoices').innerHTML.trim().length > 200
    );

    expect(ms).toBeLessThan(3000);
    console.log(`Invoices render time: ${ms}ms`);
  });

  test('Distributors page renders in under 3 seconds', async ({ page }) => {
    const ms = await measureRender(
      page,
      '.sb-nav a[data-page="distributors"]',
      '#page-distributors',
      () => {
        const el = document.querySelector('#dist-cards');
        return el && el.innerHTML.trim().length > 100;
      }
    );

    expect(ms).toBeLessThan(3000);
    console.log(`Distributors render time: ${ms}ms`);
  });

  test('Dashboard with 50 accounts KPIs renders in under 3 seconds', async ({ page }) => {
    // Navigate away and back to time the dashboard render
    await page.click('.sb-nav a[data-page="accounts"]');
    await page.waitForTimeout(200);

    const ms = await measureRender(
      page,
      '.sb-nav a[data-page="dashboard"]',
      '#page-dashboard',
      () => {
        const el = document.querySelector('#dash-kpi-total-ac');
        return el && el.textContent.trim().length > 0;
      }
    );

    expect(ms).toBeLessThan(3000);
    console.log(`Dashboard render time: ${ms}ms`);
  });
});

// ── Section B: Search performance ────────────────────────────

test.describe('Scalability — Section B: Search performance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await page.click('.sb-nav a[data-page="accounts"]');
    await expect(page.locator('#page-accounts')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#ac-cards');
        return el && el.querySelectorAll('.ac-card, .card').length > 0;
      },
      { timeout: 10000 }
    );
  });

  test('Search across 50 accounts — results returned in under 1 second', async ({ page }) => {
    const t0 = Date.now();

    await page.fill('#ac-search', 'Harvest');

    // Wait for results to update
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#ac-cards');
        if (!el) return false;
        // Either filtered results visible or empty state shown
        return el.innerHTML.trim().length > 0;
      },
      { timeout: 5000 }
    );

    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
    console.log(`Search (Harvest) response time: ${ms}ms`);

    // Should find at least Harvest Moon Co-op
    const cards = await page.locator('#ac-cards .ac-card, #ac-cards .card').count();
    expect(cards).toBeGreaterThanOrEqual(1);

    // Clear search
    await page.fill('#ac-search', '');
  });

  test('Empty search query — all 50 accounts restore in under 1 second', async ({ page }) => {
    // First search for something specific
    await page.fill('#ac-search', 'Monadnock');
    await page.waitForTimeout(300);

    const t0 = Date.now();
    await page.fill('#ac-search', '');

    await page.waitForFunction(
      () => {
        const el = document.querySelector('#ac-cards');
        return el && el.querySelectorAll('.ac-card, .card').length > 10;
      },
      { timeout: 5000 }
    );

    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
    console.log(`Search clear restore time: ${ms}ms`);
  });

  test('Distributor search across 2 distributors — returns in under 1 second', async ({ page }) => {
    await page.click('.sb-nav a[data-page="distributors"]');
    await expect(page.locator('#page-distributors')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#dist-cards');
        return el && el.innerHTML.trim().length > 0;
      },
      { timeout: 10000 }
    );

    const searchInput = page.locator('#dist-search');
    if (await searchInput.count() === 0) return;

    const t0 = Date.now();
    await searchInput.fill('New England');

    await page.waitForFunction(
      () => document.querySelector('#dist-cards').innerHTML.trim().length > 0,
      { timeout: 3000 }
    );

    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
    console.log(`Distributor search time: ${ms}ms`);

    await searchInput.fill('');
  });
});

// ── Section C: Interactive performance ───────────────────────

test.describe('Scalability — Section C: Interactive elements', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
  });

  test('Distributor detail modal opens and tabs switch smoothly', async ({ page }) => {
    await page.click('.sb-nav a[data-page="distributors"]');
    await expect(page.locator('#page-distributors')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#dist-cards')?.innerHTML.trim().length > 0,
      { timeout: 10000 }
    );

    // Open dist001 detail modal
    const card = page.locator('#dist-cards .dist-card, #dist-cards .card')
      .filter({ hasText: 'New England Natural Foods' }).first();

    if (await card.count() === 0) return;

    const t0 = Date.now();
    const viewBtn = card.locator('button, .btn').filter({ hasText: /view|open/i }).first();
    if (await viewBtn.count() > 0) {
      await viewBtn.click();
    } else {
      await card.click();
    }

    await page.waitForSelector('#modal-distributor.open', { timeout: 5000 });
    const modalOpenTime = Date.now() - t0;

    expect(modalOpenTime).toBeLessThan(1000);
    console.log(`Distributor modal open time: ${modalOpenTime}ms`);

    // Cycle through tabs — each should respond quickly
    const tabs = ['reps', 'pricing', 'invoices', 'velocity'];
    for (const tabName of tabs) {
      const tab = page.locator(
        `#modal-distributor [data-dtab="${tabName}"], #modal-distributor [data-tab="${tabName}"]`
      ).first();
      if (await tab.count() > 0) {
        const t1 = Date.now();
        await tab.click();
        await page.waitForTimeout(200);
        const switchTime = Date.now() - t1;
        expect(switchTime).toBeLessThan(1000);
        console.log(`Tab switch to ${tabName}: ${switchTime}ms`);
      }
    }

    await page.click('#modal-distributor .modal-close');
  });

  test('Accounts page — filter and un-filter with 50 accounts stays under 500ms', async ({ page }) => {
    await page.click('.sb-nav a[data-page="accounts"]');
    await expect(page.locator('#page-accounts')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#ac-cards')?.querySelectorAll('.ac-card, .card').length > 0,
      { timeout: 10000 }
    );

    // Filter to LF
    const t0 = Date.now();
    await page.locator('.ac-brand-btn[data-brand="lf"]').click().catch(() =>
      page.locator('[data-brand="lf"]').click()
    );
    await page.waitForTimeout(100);
    const filterTime = Date.now() - t0;
    expect(filterTime).toBeLessThan(500);

    // Remove filter
    const t1 = Date.now();
    await page.locator('.ac-brand-btn[data-brand=""]').click().catch(() =>
      page.locator('[data-brand=""]').first().click()
    );
    await page.waitForTimeout(100);
    const clearTime = Date.now() - t1;
    expect(clearTime).toBeLessThan(500);

    console.log(`Filter apply: ${filterTime}ms, clear: ${clearTime}ms`);
  });
});
