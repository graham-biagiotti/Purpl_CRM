// js-errors.spec.js — navigate every CRM page and assert zero uncaught JS errors
//
// Catches broken render functions, undefined variable references, and silent
// failures that don't surface in feature-specific tests.
'use strict';
const { test, expect } = require('../fixtures.js');

const ALL_PAGES = [
  'dashboard',
  'accounts',
  'prospects',
  'invoices',
  'emails',
  'orders-delivery',
  'distributors',
  'inventory',
  'production',
  'reports',
  'settings',
  'pre-orders',
  'projections',
  'integrations',
  'map',
];

// Errors we allow (emulator noise, service-worker, known non-fatal)
const IGNORED_PATTERNS = [
  /emulator/i,
  /IndexedDB/i,
  /failed-precondition/i,
  /Firebase/i,
  /firestore/i,
  /sw\.js/i,
  /serviceworker/i,
  /ResizeObserver/i,
  /Non-Error promise rejection/i,
];

function isCritical(msg) {
  return !IGNORED_PATTERNS.some(re => re.test(msg));
}

test.describe('JS Error Scan — all CRM pages', () => {
  test('Navigate every page — zero uncaught critical JS errors', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    const errors = [];
    page.on('pageerror', e => {
      if (isCritical(e.message)) errors.push(e.message);
    });

    // Also capture console.error calls (not pageerror but still bad)
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (isCritical(text)) consoleErrors.push(text);
      }
    });

    const pageResults = {};

    for (const pageName of ALL_PAGES) {
      // Reset error lists for this page
      const pageErrors = [];
      const pageConsoleErrors = [];

      const pageListener = e => { if (isCritical(e.message)) pageErrors.push(e.message); };
      const consoleListener = msg => {
        if (msg.type() === 'error') {
          const text = msg.text();
          if (isCritical(text)) pageConsoleErrors.push(text);
        }
      };

      page.on('pageerror', pageListener);
      page.on('console', consoleListener);

      // Navigate to the page
      const navLink = page.locator(`.sb-nav a[data-page="${pageName}"]`);
      if (await navLink.count() === 0) {
        page.off('pageerror', pageListener);
        page.off('console', consoleListener);
        pageResults[pageName] = { skipped: true };
        continue;
      }

      await navLink.click();

      // Wait for the page container to appear
      const pageContainer = page.locator(`#page-${pageName}`);
      if (await pageContainer.count() > 0) {
        await expect(pageContainer).toBeVisible({ timeout: 10000 }).catch(() => {});
      }

      // Give the page time to fully render and fire any async errors
      await page.waitForTimeout(1500);

      page.off('pageerror', pageListener);
      page.off('console', consoleListener);

      pageResults[pageName] = {
        errors: pageErrors,
        consoleErrors: pageConsoleErrors,
      };

      if (pageErrors.length > 0 || pageConsoleErrors.length > 0) {
        console.log(`[js-errors] ${pageName}: ${pageErrors.length} pageerrors, ${pageConsoleErrors.length} console.errors`);
        pageErrors.forEach(e => console.log(`  pageerror: ${e.slice(0, 200)}`));
        pageConsoleErrors.forEach(e => console.log(`  console.error: ${e.slice(0, 200)}`));
      } else {
        console.log(`[js-errors] ${pageName}: ✓ clean`);
      }
    }

    // Collect all critical errors across all pages
    const allCritical = Object.entries(pageResults)
      .filter(([, r]) => !r.skipped)
      .flatMap(([name, r]) => [
        ...(r.errors || []).map(e => `[${name}] pageerror: ${e}`),
        ...(r.consoleErrors || []).map(e => `[${name}] console.error: ${e}`),
      ]);

    if (allCritical.length > 0) {
      console.log('\n=== CRITICAL JS ERRORS FOUND ===');
      allCritical.forEach(e => console.log(e));
    }

    expect(allCritical).toHaveLength(0);
  });

  test('Accounts page — open first account detail, no JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => { if (isCritical(e.message)) errors.push(e.message); });

    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await page.click('.sb-nav a[data-page="accounts"]');
    await page.waitForFunction(
      () => document.querySelector('#ac-cards')?.querySelector('.ac-card') !== null,
      { timeout: 20000 }
    );

    // Open first account detail
    const firstCard = page.locator('#ac-cards .ac-card').first();
    await firstCard.locator('.btn.primary').filter({ hasText: 'View' }).click();
    await expect(page.locator('#modal-account')).toHaveClass(/open/, { timeout: 10000 });

    // Cycle through all tabs
    const tabs = ['overview', 'outreach', 'emails', 'notes', 'invoices', 'orders'];
    for (const tab of tabs) {
      const tabEl = page.locator(`#modal-account .tab[data-tab="${tab}"]`);
      if (await tabEl.count() > 0) {
        await tabEl.click();
        await page.waitForTimeout(600);
      }
    }

    await page.click('#modal-account .modal-close');
    await page.waitForTimeout(500);

    expect(errors).toHaveLength(0);
    if (errors.length === 0) console.log('[js-errors] Account detail tabs: ✓ clean');
  });

  test('Distributor detail — cycle all tabs, no JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => { if (isCritical(e.message)) errors.push(e.message); });

    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await page.click('.sb-nav a[data-page="distributors"]');
    await page.waitForFunction(
      () => document.querySelector('#dist-cards')?.querySelector('.ac-card') !== null,
      { timeout: 20000 }
    );

    const firstCard = page.locator('#dist-cards .ac-card').first();
    const viewBtn = firstCard.locator('button, .btn').filter({ hasText: /view|open/i }).first();
    if (await viewBtn.count() > 0) await viewBtn.click();
    else await firstCard.click();

    await page.waitForSelector('#modal-distributor.open', { timeout: 10000 });

    const tabs = ['overview', 'reps', 'pricing', 'orders', 'invoices', 'velocity'];
    for (const tab of tabs) {
      const tabEl = page.locator(
        `#modal-distributor [data-dtab="${tab}"], #modal-distributor [data-tab="${tab}"]`
      ).first();
      if (await tabEl.count() > 0) {
        await tabEl.click();
        await page.waitForTimeout(600);
      }
    }

    await page.click('#modal-distributor .modal-close');
    expect(errors).toHaveLength(0);
    if (errors.length === 0) console.log('[js-errors] Distributor detail tabs: ✓ clean');
  });

  test('Invoice columns — expand purpl and LF, no JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => { if (isCritical(e.message)) errors.push(e.message); });

    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await page.click('.sb-nav a[data-page="invoices"]');
    await page.waitForFunction(() => {
      const compact = document.querySelector('#inv-col-purpl-compact');
      if (compact && compact.querySelector('.inv-col-compact-row') !== null) return true;
      const summary = document.querySelector('#inv-col-purpl-summary');
      return summary && /[1-9]/.test(summary.textContent);
    }, { timeout: 20000 }).catch(() => {});

    // Expand purpl column
    const purplHeader = page.locator('.inv-col-header.purpl');
    if (await purplHeader.count() > 0) {
      await purplHeader.click();
      await page.waitForTimeout(800);
    }

    // Collapse and expand LF column
    const lfHeader = page.locator('.inv-col-header.lf');
    if (await lfHeader.count() > 0) {
      await lfHeader.click();
      await page.waitForTimeout(800);
    }

    expect(errors).toHaveLength(0);
    if (errors.length === 0) console.log('[js-errors] Invoice columns: ✓ clean');
  });
});
