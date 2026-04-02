// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/specs',
  globalSetup: './tests/global-setup.js',
  fullyParallel: false,        // serial — all tests share one emulator DB
  workers: 1,
  retries: 1,
  timeout: 30000,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: 'http://localhost:5000',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH
        ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1194/chrome-linux/chrome`
        : undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
    },
    {
      name: 'crm',
      dependencies: ['setup'],
      use: { storageState: 'tests/.auth/user.json' },
    },
  ],
});
