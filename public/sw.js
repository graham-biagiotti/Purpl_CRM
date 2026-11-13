// purpl CRM Service Worker — offline shell caching
const CACHE = 'purpl-crm-v266'; // bump on every deploy
const SHELL = [
  '/',
  '/index.html',
  '/field.html', // v256: the road app shell cold-starts offline too
  '/style.css',
  '/firebase-config.js',
  '/db.js',
  '/auth.js',
  '/app.js',
  '/places.js',
  '/manifest.json',
];

// v256: versioned, immutable CDN files the app cannot boot without. Only
// these exact hosts/paths are ever cached cross-origin — Firestore/auth
// API traffic (dynamic data!) and Maps (auth'd, quota'd) are deliberately
// excluded and always go to the network.
function _cacheableCdn(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/')) return true;
    if (u.hostname === 'cdn.jsdelivr.net') return true;
    if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') return true;
    return false;
  } catch (_) { return false; }
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
  // Notify all open tabs that a new version is active. The cache name carries
  // the version so pages already running this version can ignore the message
  // (kills the false "new version" banner right after a deploy+refresh).
  self.clients.matchAll({type: 'window'}).then(clients => {
    clients.forEach(c => c.postMessage({type: 'SW_UPDATED', cache: CACHE}));
  });
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // v256: the SDK scripts and fonts are versioned and immutable, but they
  // were never cached (cors responses failed the type==='basic' check), so
  // the app could not cold-start offline — `firebase` was simply undefined.
  // Cache-first for exactly the allowlisted static CDN files; every deploy
  // bumps CACHE, so even these refresh on each release.
  if (_cacheableCdn(e.request.url)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res && res.status === 200 && (res.type === 'cors' || res.type === 'basic')) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }))
    );
    return;
  }

  // All other cross-origin traffic (Firestore, auth, Maps, Stripe…) goes
  // straight to the network — dynamic data must never be served from cache.
  if (new URL(e.request.url).origin !== self.location.origin) return;

  // Same-origin: network-first — always fresh files, cache fallback offline.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
