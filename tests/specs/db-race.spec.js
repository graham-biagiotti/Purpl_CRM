// db-race.spec.js — DB._save() race condition protection
//
// Verifies that DB._save() is guarded by the _firestoreReady flag so that
// a save triggered before the initial Firestore snapshot loads cannot wipe
// all data in Firestore by overwriting it with an all-empty cache.
//
// Note: DB is declared as `const` at script top-level so it is NOT a property
// of `window`, but it is accessible as a plain global inside page.evaluate().
'use strict';
const { test, expect } = require('../fixtures.js');

test.describe('DB race condition guard', () => {
  test('DB._firestoreReady is true after app boots', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    // After the app is visible DB.init() has resolved — _firestoreReady must be true
    const ready = await page.evaluate(() => {
      // DB is a top-level const — accessible as a plain global, not via window
      return typeof DB !== 'undefined' && DB._firestoreReady;
    });
    expect(ready).toBe(true);
  });

  test('DB._save() is blocked when _firestoreReady is false', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    const result = await page.evaluate(() => {
      if (typeof DB === 'undefined') return { skipped: true };

      const warnMessages = [];
      const origWarn = console.warn;
      console.warn = (...args) => { warnMessages.push(args.join(' ')); origWarn(...args); };

      const origReady = DB._firestoreReady;
      DB._firestoreReady = false;

      // Track whether setDoc was called
      let setDocCalled = false;
      if (typeof FirestoreAPI !== 'undefined' && FirestoreAPI) {
        const origSetDoc = FirestoreAPI.setDoc;
        FirestoreAPI.setDoc = (...args) => {
          setDocCalled = true;
          return origSetDoc(...args);
        };

        DB._save();

        FirestoreAPI.setDoc = origSetDoc;
      } else {
        DB._save();
      }

      DB._firestoreReady = origReady;
      console.warn = origWarn;

      return {
        setDocCalled,
        warnFired: warnMessages.some(m => m.includes('Firestore not yet ready')),
      };
    });

    if (result.skipped) {
      console.log('[db-race] DB not accessible as global — skipping');
      return;
    }

    // The save should have been blocked (setDoc NOT called)
    expect(result.setDocCalled).toBe(false);
    // And the warning should have fired
    expect(result.warnFired).toBe(true);
  });

  test('DB._save() proceeds normally when _firestoreReady is true', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });

    const result = await page.evaluate(() => {
      if (typeof DB === 'undefined') return { skipped: true };
      if (typeof FirestoreAPI === 'undefined' || !FirestoreAPI) return { skipped: true };

      let setDocCalled = false;
      const origSetDoc = FirestoreAPI.setDoc;
      FirestoreAPI.setDoc = (...args) => {
        setDocCalled = true;
        FirestoreAPI.setDoc = origSetDoc;
        return Promise.resolve();
      };

      // _firestoreReady should be true — _save() should proceed to call setDoc
      DB._save();

      return { setDocCalled, ready: DB._firestoreReady };
    });

    if (result.skipped) {
      console.log('[db-race] DB or FirestoreAPI not accessible as global — skipping');
      return;
    }

    expect(result.ready).toBe(true);
    expect(result.setDocCalled).toBe(true);
  });
});
