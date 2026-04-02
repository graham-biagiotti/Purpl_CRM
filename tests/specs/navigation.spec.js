// navigation.spec.js — verifies every primary page can be navigated to without crashing
const { test, expect } = require('../fixtures.js');

test.describe('Navigation', () => {
  // Wait for the app shell to be ready before all tests in this suite
  test.beforeAll(async ({ browser }) => {
    // Nothing to do here — storageState pre-auth handles login
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
  });

  test('Dashboard loads - page visible and KPI elements exist', async ({ page }) => {
    // Dashboard is the default page; click nav link to be explicit
    await page.click('.sb-nav a[data-page="dashboard"]');
    await expect(page.locator('#page-dashboard')).toBeVisible({ timeout: 10000 });

    // The combined KPI row should be rendered with multiple KPI containers
    await expect(page.locator('#dash-combined-kpis')).toBeVisible();
    // Topbar title should reflect Dashboard
    await expect(page.locator('#topbar-title')).toContainText('Dashboard');
  });

  test('Accounts page - #page-accounts visible and account cards present', async ({ page }) => {
    // 30 accounts are seeded; at least some cards should render
    await page.click('.sb-nav a[data-page="accounts"]');
    await expect(page.locator('#page-accounts')).toBeVisible({ timeout: 10000 });

    // Account cards are rendered into #ac-cards container
    await page.waitForSelector('#ac-cards .ac-card', { timeout: 10000 });
    const cardCount = await page.locator('#ac-cards .ac-card').count();
    expect(cardCount).toBeGreaterThanOrEqual(1);
  });

  test('Prospects page - #page-prospects visible', async ({ page }) => {
    await page.click('.sb-nav a[data-page="prospects"]');
    await expect(page.locator('#page-prospects')).toBeVisible({ timeout: 10000 });
    // pr-cards container should exist
    await expect(page.locator('#pr-cards')).toBeVisible();
  });

  test('Invoices page - #page-invoices visible', async ({ page }) => {
    await page.click('.sb-nav a[data-page="invoices"]');
    await expect(page.locator('#page-invoices')).toBeVisible({ timeout: 10000 });
    // Three invoice columns should render
    await expect(page.locator('#inv-col-purpl')).toBeVisible();
    await expect(page.locator('#inv-col-lf')).toBeVisible();
    await expect(page.locator('#inv-col-combined')).toBeVisible();
  });

  test('Emails page - #page-emails visible and template column rendered', async ({ page }) => {
    await page.click('.sb-nav a[data-page="emails"]');
    await expect(page.locator('#page-emails')).toBeVisible({ timeout: 10000 });
    // Template column should be populated
    await page.waitForSelector('#emails-templates-col .email-template-card', { timeout: 10000 });
    const cards = await page.locator('#emails-templates-col .email-template-card').count();
    expect(cards).toBeGreaterThanOrEqual(4); // at least 4 standard templates + mass email card
  });

  test('Pre-orders (Forms & Submissions) page - #page-pre-orders visible', async ({ page }) => {
    await page.click('.sb-nav a[data-page="pre-orders"]');
    await expect(page.locator('#page-pre-orders')).toBeVisible({ timeout: 10000 });
  });

  test('Settings page - #page-settings visible', async ({ page }) => {
    // Settings is in the sb-more section; click it directly
    await page.click('.sb-nav a[data-page="settings"]');
    await expect(page.locator('#page-settings')).toBeVisible({ timeout: 10000 });
  });
});
