// purpl CRM Service Worker — offline shell caching
const CACHE = 'purpl-crm-v8'; // bump on every deploy
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/firebase-config.js',
  '/db.js',
  '/auth.js',
  '/app.js',
  '/places.js',
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
  // Notify all open tabs that a new version is active
  self.clients.matchAll({type: 'window'}).then(clients => {
    clients.forEach(c => c.postMessage({type: 'SW_UPDATED'}));
  });
});

self.addEventListener('fetch', e => {
  // Network-first for everything: always get fresh files, fall back to cache offline
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
