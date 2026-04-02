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
async function signInViaEmulator() {
  const resp = await fetch(
    `${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        email:             'test@purpl.local',
        password:          'testpass123',
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
    //    Firebase SDK reads IndexedDB asynchronously on init; our write
    //    should complete before Firebase reads it.
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

    await use(context);
  },
});

module.exports = { test, expect };
