'use strict';
// ============================================================
//  routing.js — Playwright route setup for sandbox environment
//
//  The Chromium browser process cannot access localhost/127.0.0.1
//  directly in this container. page.route() intercepts requests
//  BEFORE they hit the network, so we can:
//   1. Serve app files (./public/) from disk
//   2. Serve Firebase SDK from ./node_modules/firebase/ (instead of CDN)
//   3. Forward Firebase emulator calls via Node.js (which CAN reach 127.0.0.1)
//   4. Abort all other external requests (CDN, fonts, etc.)
//
//  Playwright uses LIFO route matching, so add catch-all first,
//  then specific routes — specific routes take priority.
// ============================================================

const path = require('path');
const fs   = require('fs');

const PUBLIC_DIR     = path.join(__dirname, '..', 'public');
const FIREBASE_SDK   = path.join(__dirname, '..', 'node_modules', 'firebase');

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.ico':   'image/x-icon',
  '.svg':   'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
  '.webp':  'image/webp',
};

function getMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Wire up all routes needed to run the app in this sandbox.
 * Call on a BrowserContext before creating pages.
 */
async function setupAppRoutes(context) {
  // ── Catch-all: abort anything not handled by routes below ──
  // (Added first = lowest priority since Playwright uses LIFO matching)
  await context.route('**/*', async (route) => {
    await route.abort('blockedbyclient').catch(() => {});
  });

  // ── Firebase Firestore emulator ──────────────────────────
  await context.route('http://localhost:8080/**', async (route) => {
    const target = route.request().url().replace('http://localhost:8080', 'http://127.0.0.1:8080');
    try {
      const resp = await route.fetch({ url: target });
      await route.fulfill({ response: resp });
    } catch (e) {
      await route.abort('failed').catch(() => {});
    }
  });

  // ── Firebase Auth emulator ───────────────────────────────
  await context.route('http://localhost:9099/**', async (route) => {
    const target = route.request().url().replace('http://localhost:9099', 'http://127.0.0.1:9099');
    try {
      const resp = await route.fetch({ url: target });
      await route.fulfill({ response: resp });
    } catch (e) {
      await route.abort('failed').catch(() => {});
    }
  });

  // ── Firebase Functions emulator (localhost:5001) ──────────
  // Handles cases where the SDK is configured to use the emulator directly.
  await context.route('http://localhost:5001/**', async (route) => {
    const target = route.request().url().replace('http://localhost:5001', 'http://127.0.0.1:5001');
    try {
      const resp = await route.fetch({ url: target });
      await route.fulfill({ response: resp });
    } catch (e) {
      await route.abort('failed').catch(() => {});
    }
  });

  // ── Firebase Functions production URL → emulator ──────────
  // firebase.functions().httpsCallable() calls the production URL when the
  // SDK is not configured with useEmulator(). Intercept and forward to local
  // emulator so tests never hit production Functions or Resend.
  await context.route('https://us-central1-purpl-crm.cloudfunctions.net/**', async (route) => {
    const target = route.request().url()
      .replace('https://us-central1-purpl-crm.cloudfunctions.net', 'http://127.0.0.1:5001/purpl-crm/us-central1');
    try {
      const resp = await route.fetch({ url: target });
      await route.fulfill({ response: resp });
    } catch (e) {
      await route.abort('failed').catch(() => {});
    }
  });

  // ── Firebase SDK from node_modules (instead of CDN) ──────
  await context.route('https://www.gstatic.com/firebasejs/**', async (route) => {
    const filename = route.request().url().split('/').pop();
    const sdkPath  = path.join(FIREBASE_SDK, filename);
    if (fs.existsSync(sdkPath)) {
      await route.fulfill({
        status:      200,
        contentType: 'application/javascript; charset=utf-8',
        body:        fs.readFileSync(sdkPath),
      });
    } else {
      await route.abort('blockedbyclient').catch(() => {});
    }
  });

  // ── App files from ./public/ ──────────────────────────────
  await context.route('http://127.0.0.1:5000/**', async (route) => {
    try {
      const pathname = new URL(route.request().url()).pathname;
      const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        let body = fs.readFileSync(filePath);
        const ct = getMime(filePath);

        // Inject emulator connection into auth.js for testing only.
        // Production auth.js has NO emulator code — this injection happens
        // only in the Playwright test routing layer, never in production.
        if (pathname === '/auth.js') {
          const injection = [
            '',
            '  // [TEST ONLY] Connect to local emulators — injected by tests/routing.js',
            '  try { db.useEmulator("localhost", 8080); } catch(e) {}',
            '  try { auth.useEmulator("http://localhost:9099"); } catch(e) {}',
            '',
          ].join('\n');
          const src = body.toString();
          body = src.replace(
            'const db = getFirestore(app);',
            'const db = getFirestore(app);\n' + injection
          );
        }

        await route.fulfill({
          status:      200,
          contentType: ct,
          body,
        });
      } else {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Not found: ${pathname}` });
      }
    } catch (e) {
      await route.abort('failed').catch(() => {});
    }
  });
}

module.exports = { setupAppRoutes };
