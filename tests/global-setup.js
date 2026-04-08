'use strict';
// =============================================================
//  global-setup.js  —  Playwright global setup
//  1. Seeds Firebase emulator with test data (always fresh)
//  2. Creates test auth users
//  3. Creates empty .auth/user.json placeholder
// =============================================================

const path = require('path');
const fs   = require('fs');
const http = require('http');

const delay = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function globalSetup() {
  process.env.FIRESTORE_EMULATOR_HOST          = 'localhost:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST      = 'localhost:9099';
  process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST = 'localhost:5001';

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: 'purpl-crm' });
  }
  let db   = admin.firestore();
  const auth = admin.auth();

  // ── Load seed data ────────────────────────────────────────
  // IMPORTANT: Deep-copy SEED so that we don't mutate the module-level
  // export.  spec files import the same require()-cached module, so any
  // in-place push() here would be visible to those files (causing doubled
  // Phase-1 data when a spec also does [...SEED.ac, ...extraAccounts]).
  const rawSeed = require('./seed-data.js');
  const SEED = JSON.parse(JSON.stringify(rawSeed.SEED));
  const { PORTAL_ORDERS, PORTAL_NOTIFY } = rawSeed;
  const {
    extraAccounts, productionRuns, orders: ph1Orders, invoices: ph1Invoices,
    portalInquiries, auditLog, distVelocity,
  } = require('./seed-phase1.js');

  // ── Merge Phase 1 into SEED copy ─────────────────────────
  SEED.ac.push(...extraAccounts);
  SEED.prod_hist.push(...productionRuns);
  SEED.orders.push(...ph1Orders);
  SEED.iv.push(...ph1Invoices.filter(iv => iv.type === 'purpl'));
  SEED.lf_invoices.push(...ph1Invoices.filter(iv => iv.type === 'lf'));
  SEED.dist_invoices.push(...ph1Invoices.filter(iv => iv.type === 'dist'));
  SEED.audit_log = auditLog;
  for (const vr of distVelocity) {
    const dp = SEED.dist_profiles.find(d => d.id === vr.distributorId);
    if (dp) dp.velocityReports.push(vr);
  }

  // ── Clear Firestore emulator data (fresh start every run) ────
  try {
    await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost', port: 8080, method: 'DELETE',
        path: '/emulator/v1/projects/purpl-crm/databases/(default)/documents',
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.setTimeout(5000, () => { req.destroy(); resolve(); });
      req.end();
    });
    console.log('[setup] Emulator data cleared.');
    await delay(300);
  } catch (e) {
    console.log('[setup] Clear skipped:', e.message.slice(0, 60));
  }

  // ── Write store document — skeleton first, then large arrays ─
  // Strategy: set a skeleton doc (no large arrays), then .update() each
  // large array one at a time with 500ms gaps.
  //
  // WRITE ORDER MATTERS: the Firestore emulator rejects updates that push
  // the document past ~190 KB in one step.  Writing 'iv' before 'ac' keeps
  // each intermediate size below that threshold even though the final
  // document is ~258 KB.
  // Write order chosen empirically: iv first (59 KB), then ac (99 KB),
  // then pr, then orders — this sequence avoids emulator gRPC failures.
  const LARGE_KEYS = [
    'iv', 'ac', 'pr', 'orders', 'inv_log',
    'prod_hist', 'lf_invoices', 'combined_invoices',
    'dist_invoices', 'dist_profiles',
  ];

  const skeleton = {};
  for (const k of Object.keys(SEED)) {
    if (!LARGE_KEYS.includes(k)) skeleton[k] = SEED[k];
  }
  // Include audit_log in skeleton (small — 80 entries / ~13 KB)
  skeleton.audit_log = SEED.audit_log;

  // getStore returns a fresh reference (uses current 'db' variable).
  const getStore = () => db.collection('workspace').doc('main')
                            .collection('data').doc('store');

  // Retry helper: on gRPC UNKNOWN errors, reinit Admin SDK for a fresh
  // gRPC channel and retry up to 3 times.
  async function retryWrite(writeFn) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await writeFn();
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[setup]   → write failed (${e.code}), re-initing admin (attempt ${attempt})...`);
        await delay(1500 * attempt);
        try { await admin.app().delete(); } catch (_) {}
        admin.initializeApp({ projectId: 'purpl-crm' });
        db = admin.firestore();
      }
    }
  }

  console.log('[setup] Writing skeleton...');
  await retryWrite(() => getStore().set(skeleton));
  await delay(500);

  for (const key of LARGE_KEYS) {
    if (SEED[key] === undefined) continue;
    const n = Array.isArray(SEED[key]) ? SEED[key].length : '—';
    console.log(`[setup]   .update ${key} (${n})`);
    await retryWrite(() => getStore().update({ [key]: SEED[key] }));
    await delay(500);
  }
  console.log('[setup] Main store written.');

  // ── Portal collections ────────────────────────────────────
  const ordBatch = db.batch();
  for (const o of PORTAL_ORDERS) ordBatch.set(db.collection('portal_orders').doc(o.id), o);
  await ordBatch.commit();
  console.log('[setup] Portal orders written:', PORTAL_ORDERS.length);

  const notBatch = db.batch();
  for (const n of PORTAL_NOTIFY) notBatch.set(db.collection('portal_notify').doc(n.id), n);
  await notBatch.commit();
  console.log('[setup] Portal notify written:', PORTAL_NOTIFY.length);

  const inqBatch = db.batch();
  for (const inq of portalInquiries) inqBatch.set(db.collection('portal_inquiries').doc(inq.id), inq);
  await inqBatch.commit();
  console.log('[setup] Portal inquiries written:', portalInquiries.length);

  // ── Auth users ────────────────────────────────────────────
  for (const u of [
    { uid: 'test-uid-001',    email: 'test@purpl.local',    password: 'testpass123',  displayName: 'Test User'    },
    { uid: 'test-retailer-001', email: 'retailer@test.local', password: 'retailer123', displayName: 'Test Retailer' },
  ]) {
    try {
      await auth.createUser(u);
      console.log(`[setup] Auth user created: ${u.email}`);
    } catch (e) {
      if (['auth/uid-already-exists','auth/email-already-exists'].includes(e.code)) {
        console.log(`[setup] Auth user exists: ${u.email}`);
      } else throw e;
    }
  }

  // ── .auth/user.json placeholder ───────────────────────────
  const authDir = path.join(__dirname, '.auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'user.json'), JSON.stringify({ cookies: [], origins: [] }));
  console.log('[setup] Auth placeholder created.');

  await admin.app().delete();
  console.log('[setup] Global setup complete.');
};
