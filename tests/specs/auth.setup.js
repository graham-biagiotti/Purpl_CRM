'use strict';
// auth.setup.js — verifies auth injection works before running crm tests
const { test, expect } = require('../fixtures.js');
const path = require('path');

test('auth injection — app shell visible after IndexedDB auth pre-population', async ({ page }) => {
  await page.goto('/');
  // The fixture injects Firebase auth via IndexedDB in addInitScript.
  // If auth is injected correctly, the app shell becomes visible without
  // any login form interaction.
  await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30000 });
  // Confirm we're NOT on the auth screen
  await expect(page.locator('#auth-screen')).toBeHidden();

  // Save storageState (may not capture IndexedDB, but satisfies Playwright's file check)
  await page.context().storageState({ path: path.join(__dirname, '../.auth/user.json') });
});
