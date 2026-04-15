const CACHE_NAME = 'envoy-v7';
const urlsToCache = [
  '/envoy/static/index.html',
  '/envoy/static/app.css',
  '/envoy/static/app.js',
  '/envoy/static/xterm.js',
  '/envoy/static/xterm.css',
  '/envoy/static/xterm-addon-fit.js',
  '/envoy/static/xterm-addon-serialize.js',
  '/envoy/static/SourceCodePro-Regular.woff2',
  '/envoy/static/SourceCodePro-Bold.woff2',
  '/envoy/static/manifest.json',
  '/envoy/static/icon-192.png',
  '/envoy/static/icon-512.png',
  '/envoy/static/icon.svg'
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

  // API requests: bypass the service worker entirely so streaming responses
  // (e.g. /api/stream SSE) aren't tied to the SW lifecycle. On Firefox
  // Android, SWs can be terminated while the PWA is backgrounded, which
  // would tear down any fetch routed through event.respondWith.
  if (event.request.url.includes('/envoy/api/')) {
    return;
  }

  // Navigation requests (e.g. /envoy/foo): network first, fallback to cached index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put('/envoy/static/index.html', responseToCache);
          });
          return response;
        })
        .catch(() => caches.match('/envoy/static/index.html'))
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
