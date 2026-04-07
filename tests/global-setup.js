'use strict';
// =============================================================
//  global-setup.js  —  Playwright global setup
//  1. Seeds Firebase emulator with test data
//  2. Creates test auth user
//  3. Creates empty .auth/user.json (auth is injected per-test
//     via IndexedDB in fixtures.js — storageState is not used
//     for Firebase auth since it stores in IndexedDB)
// =============================================================

const path = require('path');
const fs   = require('fs');

// Start emulators before running tests:
//   firebase emulators:start --only firestore,auth,functions
//
// The functions emulator requires functions/index.js to be present.
// RESEND_API_KEY is stubbed to 'test-key' via functions/.env.local so
// no real emails are sent during test runs.

const delay = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function globalSetup() {
  // ── Point Firebase Admin SDK at local emulators ───────────
  process.env.FIRESTORE_EMULATOR_HOST      = 'localhost:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST  = 'localhost:9099';
  process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST = 'localhost:5001';

  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'purpl-crm' });
  }

  const db   = admin.firestore();
  const auth = admin.auth();

  // ── Load seed data ────────────────────────────────────────
  const { SEED, PORTAL_ORDERS, PORTAL_NOTIFY } = require('./seed-data.js');
  const {
    extraAccounts, productionRuns, orders: ph1Orders, invoices: ph1Invoices,
    outreach, samples, portalInquiries, auditLog, distVelocity,
  } = require('./seed-phase1.js');

  // ── Merge Phase 1 data into SEED ─────────────────────────
  SEED.ac.push(...extraAccounts);
  SEED.prod_hist.push(...productionRuns);
  SEED.orders.push(...ph1Orders);

  const ph1Purpl = ph1Invoices.filter(iv => iv.type === 'purpl');
  const ph1LF    = ph1Invoices.filter(iv => iv.type === 'lf');
  const ph1Dist  = ph1Invoices.filter(iv => iv.type === 'dist');
  SEED.iv.push(...ph1Purpl);
  SEED.lf_invoices.push(...ph1LF);
  SEED.dist_invoices.push(...ph1Dist);

  SEED.audit_log = auditLog;

  // Append velocity reports into matching dist_profiles entries
  for (const vr of distVelocity) {
    const dp = SEED.dist_profiles.find(d => d.id === vr.distributorId);
    if (dp) dp.velocityReports.push(vr);
  }

  // ── Write main data store — split into chunks ─────────────
  // The full SEED object exceeds gRPC default timeout when written
  // as one .set() call. Write a skeleton first, then update large
  // arrays one at a time with 500ms gaps.
  const LARGE_KEYS = [
    'ac','pr','iv','orders','inv_log','prod_hist',
    'lf_invoices','combined_invoices','dist_invoices','dist_profiles',
    'audit_log',
  ];

  // Build skeleton without large arrays
  const skeleton = {};
  for (const k of Object.keys(SEED)) {
    if (!LARGE_KEYS.includes(k)) skeleton[k] = SEED[k];
  }

  const storeRef = db.collection('workspace').doc('main').collection('data').doc('store');

  console.log('[setup] Writing skeleton seed data...');
  await storeRef.set(skeleton);
  await delay(500);
  console.log('[setup] Skeleton written.');

  // Write each large array as a separate update
  for (const key of LARGE_KEYS) {
    if (SEED[key] === undefined) continue;
    console.log(`[setup] Writing ${key} (${Array.isArray(SEED[key]) ? SEED[key].length + ' items' : 'object'})...`);
    await storeRef.update({ [key]: SEED[key] });
    await delay(500);
  }
  console.log('[setup] Main store written.');

  // ── Write portal orders ───────────────────────────────────
  const ordBatch = db.batch();
  for (const order of PORTAL_ORDERS) {
    ordBatch.set(db.collection('portal_orders').doc(order.id), order);
  }
  await ordBatch.commit();
  console.log('[setup] Portal orders written:', PORTAL_ORDERS.length);

  // ── Write portal notify ───────────────────────────────────
  const notBatch = db.batch();
  for (const n of PORTAL_NOTIFY) {
    notBatch.set(db.collection('portal_notify').doc(n.id), n);
  }
  await notBatch.commit();
  console.log('[setup] Portal notify written:', PORTAL_NOTIFY.length);

  // ── Write portal inquiries ────────────────────────────────
  const inqBatch = db.batch();
  for (const inq of portalInquiries) {
    inqBatch.set(db.collection('portal_inquiries').doc(inq.id), inq);
  }
  await inqBatch.commit();
  console.log('[setup] Portal inquiries written:', portalInquiries.length);

  // ── Create test auth user (CRM admin) ────────────────────
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

  // ── Create retailer auth user (no CRM access) ─────────────
  // Used to verify that authenticated non-CRM users cannot reach the
  // CRM dashboard (index.html) — security boundary test.
  try {
    await auth.createUser({
      uid:         'test-retailer-001',
      email:       'retailer@test.local',
      password:    'retailer123',
      displayName: 'Test Retailer',
    });
    console.log('[setup] Retailer auth user created.');
  } catch (e) {
    if (e.code === 'auth/uid-already-exists' || e.code === 'auth/email-already-exists') {
      console.log('[setup] Retailer auth user already exists — OK.');
    } else {
      throw e;
    }
  }

  // ── Create .auth/user.json placeholder ───────────────────
  // Real auth injection happens per-test via addInitScript in fixtures.js.
  // The 'crm' project still references this file as storageState;
  // an empty-but-valid file satisfies Playwright's check.
  const authDir = path.join(__dirname, '.auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const placeholder = { cookies: [], origins: [] };
  fs.writeFileSync(path.join(authDir, 'user.json'), JSON.stringify(placeholder));
  console.log('[setup] Auth placeholder created.');

  await admin.app().delete();
  console.log('[setup] Global setup complete.');
};
