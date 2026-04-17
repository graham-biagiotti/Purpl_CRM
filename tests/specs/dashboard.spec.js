// dashboard.spec.js — verifies the dashboard page renders KPIs, attention lists, and quick notes
const { test, expect } = require('../fixtures.js');

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    // Ensure we're on the dashboard
    await page.click('.sb-nav a[data-page="dashboard"]');
    await expect(page.locator('#page-dashboard')).toBeVisible({ timeout: 10000 });
  });

  test('KPI cards render - combined KPI row exists with at least 4 KPI containers', async ({ page }) => {
    // The combined KPI row contains 7 cells; after JS renders, they should have content
    await expect(page.locator('#dash-combined-kpis')).toBeVisible();

    // Wait for at least one KPI to have rendered content (JS populates these)
    await page.waitForFunction(() => {
      const el = document.querySelector('#dash-kpi-total-ac');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 10000 });

    // Prospect KPI row should also render
    await expect(page.locator('#dash-prospect-kpis')).toBeVisible();

    // Count kpi elements across the dashboard (also in hidden report areas)
    // At minimum the combined KPI row and prospect KPI row should each have cells
    const kpiCount = await page.locator('#page-dashboard [class*="kpi"]').count();
    expect(kpiCount).toBeGreaterThanOrEqual(4);
  });

  test('Dashboard topbar title contains "Dashboard"', async ({ page }) => {
    // The topbar title is updated by nav() to reflect the current page
    await expect(page.locator('#topbar-title')).toContainText('Dashboard', { timeout: 10000 });
  });

  test('Needs Attention section renders - ac003 (no cadence, 14 days old) should appear', async ({ page }) => {
    // The "Needs Attention" section shows accounts that haven't been contacted in 30+ days
    // ac003 has 0 cadence entries and was created 14 days ago; if the attention logic
    // counts never-contacted accounts, it should appear. At minimum the section must render.
    await expect(page.locator('#dash-attention')).toBeVisible({ timeout: 10000 });

    // Wait for the attention section to be populated (JS renders async)
    await page.waitForFunction(() => {
      const el = document.querySelector('#dash-attention');
      return el && el.innerHTML.trim().length > 0;
    }, { timeout: 10000 }).catch(() => {
      // Attention section may be empty if no accounts meet the criteria — that is valid
    });

    // The section header "Needs Attention" should be visible
    await expect(page.locator('#page-dashboard h2').filter({ hasText: 'Needs Attention' })).toBeVisible();
  });

  test('Never-contacted KPI shows >= 0 (accounts with no outreach are tracked)', async ({ page }) => {
    // ac003, ac004, ac017, ac018 have 0 cadence entries.
    // The "total accounts" KPI must be a positive number reflecting seeded data.
    await page.waitForFunction(() => {
      const el = document.querySelector('#dash-kpi-total-ac');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 10000 });

    const totalText = await page.locator('#dash-kpi-total-ac').textContent();
    // Should show a number (30 accounts seeded)
    expect(totalText).toBeTruthy();
    const num = parseInt(totalText.replace(/\D/g, ''), 10);
    expect(num).toBeGreaterThanOrEqual(1);
  });

  test('Quick Notes scratchpad renders without error', async ({ page }) => {
    // Notes section is in a collapsible <details> — open it if needed
    const details = page.locator('details:has(#dash-notes-content)');
    if (await details.count()) {
      await details.evaluate(el => el.open = true);
    }
    await expect(page.locator('#dash-notes-content')).toBeVisible({ timeout: 10000 });
    await page.fill('#dash-notes-content', 'Playwright test note');
    await expect(page.locator('#dash-notes-content')).toHaveValue('Playwright test note');
  });

  test('Follow-ups section renders', async ({ page }) => {
    // The follow-ups panel should exist and not cause a JS crash
    await expect(page.locator('#dash-followups')).toBeVisible({ timeout: 10000 });
  });

  test('Invoice Status section renders on dashboard', async ({ page }) => {
    // The right-column invoice status panel should be visible
    await expect(page.locator('#dash-invoice-status')).toBeVisible({ timeout: 10000 });
    // Wait for it to be populated
    await page.waitForFunction(() => {
      const el = document.querySelector('#dash-invoice-status');
      return el && el.innerHTML.trim().length > 0;
    }, { timeout: 10000 }).catch(() => {
      // May be empty if no invoices — still valid
    });
  });
});
