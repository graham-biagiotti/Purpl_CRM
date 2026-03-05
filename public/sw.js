// purpl CRM Service Worker — offline shell caching
const CACHE = 'purpl-crm-v1';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/firebase-config.js',
  '/db.js',
  '/auth.js',
  '/app.js',
  '/manifest.json',
];

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
});

self.addEventListener('fetch', e => {
  // Network-first for Firebase (auth/Firestore), cache-first for app shell
  if (e.request.url.includes('firestore.googleapis.com') ||
      e.request.url.includes('identitytoolkit') ||
      e.request.url.includes('googleapis.com')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
