const CACHE_NAME = 'webterm-v3';
const urlsToCache = [
  '/webterm/static/index.html',
  '/webterm/static/app.css',
  '/webterm/static/app.js',
  '/webterm/static/xterm.js',
  '/webterm/static/xterm.css',
  '/webterm/static/xterm-addon-fit.js',
  '/webterm/static/xterm-addon-serialize.js',
  '/webterm/static/SourceCodePro-Regular.woff2',
  '/webterm/static/SourceCodePro-Bold.woff2',
  '/webterm/static/manifest.json',
  '/webterm/static/icon-192.png',
  '/webterm/static/icon-512.png',
  '/webterm/static/icon.svg'
];

// Install service worker and cache assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Activate service worker and clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // API requests: always network
  if (event.request.url.includes('/webterm/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Navigation requests (e.g. /webterm/foo): serve cached index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/webterm/static/index.html')
        .then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Static assets: network first, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
