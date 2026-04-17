// db-race.spec.js — DB._save() race condition protection
'use strict';
const { test, expect } = require('../fixtures.js');

test.describe('DB race condition guard', () => {
  test('DB._firestoreReady is true after app boots and data loads', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    // Wait for _firestoreReady to become true (may take a moment after app-shell is visible)
    const ready = await page.evaluate(() => {
      return new Promise((resolve) => {
        if (typeof DB !== 'undefined' && DB._firestoreReady) return resolve(true);
        // Poll for up to 10 seconds
        let attempts = 0;
        const check = setInterval(() => {
          attempts++;
          if (typeof DB !== 'undefined' && DB._firestoreReady) { clearInterval(check); resolve(true); }
          if (attempts > 50) { clearInterval(check); resolve(false); }
        }, 200);
      });
    });
    expect(ready).toBe(true);
  });

  test('DB._save() is blocked when _firestoreReady is false', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    const result = await page.evaluate(() => {
      if (typeof DB === 'undefined') return { skipped: true };

      const origReady = DB._firestoreReady;
      DB._firestoreReady = false;

      // Clear any pending save timer
      if (DB._saveTimer) { clearTimeout(DB._saveTimer); DB._saveTimer = null; }

      // Track whether _doSave gets scheduled
      let timerSet = false;
      const origSetTimeout = window.setTimeout;
      window.setTimeout = function(fn, ms) {
        if (ms === 500) timerSet = true;
        return origSetTimeout(fn, ms);
      };

      DB._save();

      window.setTimeout = origSetTimeout;
      DB._firestoreReady = origReady;

      return { timerSet, syncStatus: DB._syncStatus };
    });

    if (result.skipped) return;

    // Save should NOT have scheduled a timer (blocked by _firestoreReady check)
    expect(result.timerSet).toBe(false);
  });

  test('DB._save() schedules debounced write when _firestoreReady is true', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    const result = await page.evaluate(() => {
      if (typeof DB === 'undefined') return { skipped: true };

      // Wait for firestoreReady
      if (!DB._firestoreReady) return { skipped: true };

      // Clear any pending save timer
      if (DB._saveTimer) { clearTimeout(DB._saveTimer); DB._saveTimer = null; }

      // Track whether setTimeout is called with 500ms (the debounce)
      let timerSet = false;
      const origSetTimeout = window.setTimeout;
      window.setTimeout = function(fn, ms) {
        if (ms === 500) timerSet = true;
        return origSetTimeout(fn, ms);
      };

      DB._save();

      window.setTimeout = origSetTimeout;

      // Clean up the timer so it doesn't fire during other tests
      if (DB._saveTimer) { clearTimeout(DB._saveTimer); DB._saveTimer = null; }

      return { timerSet, ready: DB._firestoreReady };
    });

    if (result.skipped) return;

    expect(result.ready).toBe(true);
    expect(result.timerSet).toBe(true);
  });
});
