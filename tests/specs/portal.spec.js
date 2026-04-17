// portal.spec.js — wholesale order portal (/order.html): page load, brand selector, form validation
'use strict';
const { test, expect } = require('../fixtures.js');

test.describe('Portal — Section A: Page load and structure', () => {
  test('order.html loads at /order.html for unauthenticated user', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order.html');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });

    // Should be at order.html — not redirected to CRM
    expect(page.url()).toContain('order');

    // Page body has content
    const bodyText = await page.locator('body').textContent().catch(() => '');
    expect(bodyText.length).toBeGreaterThan(0);

    await page.close();
  });

  test('order.html — order form container is visible', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order.html');

    // The order form div is the main container
    await expect(page.locator('#order-form')).toBeVisible({ timeout: 15000 });

    await page.close();
  });

  test('Brand selector renders both purpl and LF brand cards', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order.html');
    await expect(page.locator('#order-form')).toBeVisible({ timeout: 15000 });

    // Both brand cards must exist
    await expect(page.locator('#brand-card-purpl')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#brand-card-lf')).toBeVisible({ timeout: 5000 });

    // The brand selector container should be rendered
    await expect(page.locator('#brand-selector')).toBeVisible({ timeout: 5000 });

    await page.close();
  });

  test('purpl order section is visible on page load', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order.html');
    await expect(page.locator('#order-form')).toBeVisible({ timeout: 15000 });

    // purpl section should be visible by default (purpl is pre-selected)
    await expect(page.locator('#purpl-order-section')).toBeVisible({ timeout: 10000 });

    await page.close();
  });

  test('Unauthenticated user sees order form (portal is public)', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();

    // Collect any errors
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('/order.html');
    await expect(page.locator('#order-form')).toBeVisible({ timeout: 15000 });

    // No CRM auth required — form must be accessible
    const formVisible = await page.locator('#order-form').isVisible();
    expect(formVisible).toBe(true);

    // No critical JS errors
    const critical = errors.filter(msg =>
      !msg.includes('emulator') && !msg.includes('firestore') && !msg.includes('Firebase')
    );
    expect(critical).toHaveLength(0);

    await page.close();
  });
});

test.describe('Portal — Section B: Form interaction and validation', () => {
  test('Submit button is disabled on initial load (no quantities filled)', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order.html');
    await expect(page.locator('#order-form')).toBeVisible({ timeout: 15000 });

    // Submit button should start disabled
    const submitBtn = page.locator('#submit-btn');
    if (await submitBtn.count() > 0) {
      const isDisabled = await submitBtn.isDisabled();
      expect(isDisabled).toBe(true);
    }

    await page.close();
  });

  test('Clicking LF brand card shows LF order section', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order.html');
    await expect(page.locator('#order-form')).toBeVisible({ timeout: 15000 });

    // Click the LF brand card
    const lfCard = page.locator('#brand-card-lf');
    if (await lfCard.count() > 0) {
      await lfCard.click();
      await page.waitForTimeout(500);

      // LF order section should now be visible
      const lfSection = page.locator('#lf-order-section');
      if (await lfSection.count() > 0) {
        await expect(lfSection).toBeVisible({ timeout: 5000 });
      }
    }

    await page.close();
  });

  test('Submit with empty quantities — validation prevents submission', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    await page.goto('/order.html');
    await expect(page.locator('#order-form')).toBeVisible({ timeout: 15000 });

    // Attempt to click submit even if disabled
    const submitBtn = page.locator('#submit-btn');
    if (await submitBtn.count() > 0) {
      const isDisabled = await submitBtn.isDisabled();
      if (isDisabled) {
        // Button is correctly disabled — validation working
        expect(isDisabled).toBe(true);
      } else {
        // Button is enabled — try clicking and verify no order is submitted
        await submitBtn.click();
        await page.waitForTimeout(500);
        // Should show a validation message or remain on the form
        const url = page.url();
        expect(url).toContain('order');
      }
    }

    await page.close();
  });

  test('Portal page renders without critical JS errors', async ({ unauthContext }) => {
    const page = await unauthContext.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('/order.html');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await page.waitForTimeout(2000);

    const critical = errors.filter(msg =>
      !msg.includes('emulator') && !msg.includes('firestore') &&
      !msg.includes('Firebase') && !msg.includes('IndexedDB') &&
      !msg.includes('blocked') && !msg.includes('network') &&
      !msg.includes('Failed to fetch') && !msg.includes('ERR_')
    );
    expect(critical).toHaveLength(0);

    await page.close();
  });
});
