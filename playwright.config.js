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
    baseURL: 'http://127.0.0.1:5000',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    launchOptions: {
      executablePath: (() => {
        if (!process.env.PLAYWRIGHT_BROWSERS_PATH) return undefined;
        if (process.platform === 'win32') {
          return `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1194/chrome-win/chrome.exe`;
        }
        return `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1194/chrome-linux/chrome`;
      })(),
      args: [
        // --no-sandbox is required on Linux/CI but breaks Chrome on Windows
        ...(process.platform === 'win32' ? [] : ['--no-sandbox']),
        '--disable-dev-shm-usage',
        '--proxy-server=direct://',
      ],
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
