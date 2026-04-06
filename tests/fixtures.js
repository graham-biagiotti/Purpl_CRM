'use strict';
// ============================================================
//  fixtures.js — Playwright custom fixtures for purpl CRM tests
//
//  The browser cannot reach localhost directly in this container.
//  We use page.route() to serve the app, and pre-inject Firebase
//  auth state into IndexedDB via addInitScript() so the app
//  auto-authenticates without needing a login form interaction.
// ============================================================

const { test: base, expect } = require('@playwright/test');
const { setupAppRoutes } = require('./routing.js');

const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'AIzaSyBbEQ1wV7MwJJjSC9_EalYxHMvTjHklwFY';
const IDB_DB_NAME       = 'firebaseLocalStorageDb';
const IDB_STORE_NAME    = 'firebaseLocalStorage';
const IDB_KEY           = `firebase:authUser:${FIREBASE_API_KEY}:[DEFAULT]`;

/**
 * Sign in via Auth emulator REST API. Returns idToken + refreshToken.
 * The emulator tokens are stable enough for test use.
 */
async function signInViaEmulator(email = 'test@purpl.local', password = 'testpass123') {
  const resp = await fetch(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    }
  );
  if (!resp.ok) throw new Error(`Auth emulator signIn failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

/**
 * Build the Firebase auth state object that gets stored in IndexedDB.
 */
function buildAuthState(token) {
  return {
    uid:           token.localId,
    email:         token.email,
    emailVerified: false,
    displayName:   token.displayName || 'Test User',
    isAnonymous:   false,
    providerData:  [{
      providerId:   'password',
      uid:          token.email,
      displayName:  token.displayName || 'Test User',
      email:        token.email,
      phoneNumber:  null,
      photoURL:     null,
    }],
    stsTokenManager: {
      refreshToken:   token.refreshToken,
      accessToken:    token.idToken,
      expirationTime: Date.now() + (parseInt(token.expiresIn, 10) || 3600) * 1000,
    },
    createdAt:   String(Date.now()),
    lastLoginAt: String(Date.now()),
    apiKey:      FIREBASE_API_KEY,
    appName:     '[DEFAULT]',
  };
}

/**
 * Inject a Firebase auth state into IndexedDB for the given context.
 */
async function injectAuthState(context, authState) {
  await context.addInitScript(([dbName, storeName, idbKey, value]) => {
    function writeAuthState() {
      const openReq = indexedDB.open(dbName, 1);
      openReq.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(storeName, { keyPath: 'fbase_key' });
      };
      openReq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put({ fbase_key: idbKey, value });
      };
    }
    writeAuthState();
  }, [IDB_DB_NAME, IDB_STORE_NAME, IDB_KEY, authState]);
}

const test = base.extend({
  /**
   * Override context to:
   *  1. Set up route interception (serve files + forward emulator calls)
   *  2. Pre-inject Firebase auth state into IndexedDB via addInitScript()
   *     so the app auto-authenticates on every page load.
   */
  context: async ({ context }, use) => {
    // 1. Set up routing (serve app files + forward emulator API calls)
    await setupAppRoutes(context);

    // 2. Get a fresh auth token from the emulator
    const token     = await signInViaEmulator();
    const authState = buildAuthState(token);

    // 3. Inject auth state into IndexedDB before any page loads.
    await injectAuthState(context, authState);

    await use(context);
  },

  /**
   * unauthContext — a browser context with NO auth state injected.
   * Useful for testing portal_orders write access and verifying that
   * unauthenticated users see the auth screen rather than the CRM.
   */
  unauthContext: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await setupAppRoutes(ctx);
    // No auth injection — browser starts with empty IndexedDB
    await use(ctx);
    await ctx.close();
  },

  /**
   * retailerContext — a context authenticated as a retail account user
   * who should NOT have access to the CRM dashboard.
   * Tests that Firebase-authenticated non-CRM users cannot reach index.html.
   */
  retailerContext: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await setupAppRoutes(ctx);
    const token     = await signInViaEmulator('retailer@test.local', 'retailer123');
    const authState = buildAuthState(token);
    await injectAuthState(ctx, authState);
    await use(ctx);
    await ctx.close();
  },

  /**
   * verifyFirestoreWrite(collection, id, fields)
   *
   * Reads directly from the Firestore emulator using the Admin SDK and
   * asserts that the item with the given id has the expected field values.
   * Use this in CRUD tests to independently verify writes reach Firestore —
   * not just that the UI reflects the change.
   *
   * For top-level CRM collections (ac, pr, iv, lf_invoices, etc.):
   *   collection = key in workspace/main/data/store document (e.g. 'ac')
   *
   * For portal collections (portal_orders, portal_notify):
   *   collection = Firestore collection name, id = document id
   */
  verifyFirestoreWrite: [async ({}, use) => {
    // Ensure emulator env is set in this worker process
    process.env.FIRESTORE_EMULATOR_HOST =
      process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';

    const admin = require('firebase-admin');
    let app;
    try {
      app = admin.app('verifier');
    } catch {
      app = admin.initializeApp({ projectId: 'purpl-crm' }, 'verifier');
    }
    const db = admin.firestore(app);

    const helper = async (collection, id, fields) => {
      const PORTAL_COLLECTIONS = ['portal_orders', 'portal_notify'];

      if (PORTAL_COLLECTIONS.includes(collection)) {
        // Direct Firestore collection
        const snap = await db.collection(collection).doc(id).get();
        expect(snap.exists, `Document ${collection}/${id} not found in Firestore`).toBe(true);
        const data = snap.data();
        for (const [key, val] of Object.entries(fields)) {
          expect(data[key], `${collection}/${id}.${key}`).toEqual(val);
        }
      } else {
        // CRM data stored as arrays in workspace/main/data/store
        const snap = await db
          .collection('workspace').doc('main')
          .collection('data').doc('store')
          .get();
        expect(snap.exists, 'Main CRM store document not found').toBe(true);
        const store = snap.data();
        const arr   = store[collection];
        expect(Array.isArray(arr), `Collection '${collection}' not found in store`).toBe(true);
        const item  = arr.find(x => x.id === id);
        expect(item, `Item id='${id}' not found in '${collection}'`).toBeTruthy();
        for (const [key, val] of Object.entries(fields)) {
          expect(item[key], `${collection}[id=${id}].${key}`).toEqual(val);
        }
      }
    };

    await use(helper);
    // Leave admin app alive for the worker lifetime (scope: 'worker')
  }, { scope: 'worker' }],
});

module.exports = { test, expect };
