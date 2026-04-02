'use strict';
// =============================================================
//  global-setup.js  —  Playwright global setup
//  1. Seeds Firebase emulator with test data
//  2. Creates test auth user
//  3. Logs in via browser, saves storageState for all tests
// =============================================================

const path = require('path');

module.exports = async function globalSetup() {
  // ── Point Firebase Admin SDK at local emulators ───────────
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';

  const admin = require('firebase-admin');

  // Avoid re-initializing if already done (e.g. watch mode)
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'purpl-crm' });
  }

  const db   = admin.firestore();
  const auth = admin.auth();

  // ── Load seed data ────────────────────────────────────────
  const { SEED, PORTAL_ORDERS, PORTAL_NOTIFY } = require('./seed-data.js');

  // ── Write main data store (overwrites any previous test data) ─
  console.log('[setup] Writing seed data to Firestore emulator...');
  await db
    .collection('workspace').doc('main')
    .collection('data').doc('store')
    .set(SEED);
  console.log('[setup] Main store written.');

  // ── Write portal orders ───────────────────────────────────
  const ordBatch = db.batch();
  for (const order of PORTAL_ORDERS) {
    const ref = db.collection('portal_orders').doc(order.id);
    ordBatch.set(ref, order);
  }
  await ordBatch.commit();
  console.log('[setup] Portal orders written:', PORTAL_ORDERS.length);

  // ── Write portal notify ───────────────────────────────────
  const notBatch = db.batch();
  for (const n of PORTAL_NOTIFY) {
    const ref = db.collection('portal_notify').doc(n.id);
    notBatch.set(ref, n);
  }
  await notBatch.commit();
  console.log('[setup] Portal notify written:', PORTAL_NOTIFY.length);

  // ── Create test auth user ─────────────────────────────────
  try {
    await auth.createUser({
      uid:         'test-uid-001',
      email:       'test@purpl.local',
      password:    'testpass123',
      displayName: 'Test User',
    });
    console.log('[setup] Test auth user created.');
  } catch (e) {
    if (e.code === 'auth/uid-already-exists' || e.code === 'auth/email-already-exists') {
      console.log('[setup] Test auth user already exists — OK.');
    } else {
      throw e;
    }
  }

  // ── Launch browser and log in to save storageState ────────
  console.log('[setup] Launching browser for auth setup...');
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext();
  const page    = await context.newPage();

  try {
    await page.goto('http://localhost:5000', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('#auth-email', { timeout: 15000 });

    await page.fill('#auth-email',    'test@purpl.local');
    await page.fill('#auth-password', 'testpass123');
    await page.click('#sign-in-btn');

    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 25000 });
    console.log('[setup] Login successful.');

    // Save auth state (localStorage / sessionStorage)
    const authDir = path.join(__dirname, '.auth');
    const fs = require('fs');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    await context.storageState({ path: path.join(authDir, 'user.json') });
    console.log('[setup] Auth state saved to tests/.auth/user.json');

  } finally {
    await browser.close();
  }

  await admin.app().delete();
  console.log('[setup] Global setup complete.');
};
