const { test } = require('@playwright/test');
const path = require('path');

test('authenticate', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#auth-email', { timeout: 15000 });
  await page.fill('#auth-email', 'test@purpl.local');
  await page.fill('#auth-password', 'testpass123');
  await page.click('#sign-in-btn');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
  await page.context().storageState({ path: path.join(__dirname, '../.auth/user.json') });
});
