/**
 * JARVIS Service Worker
 * Keeps the agent alive in background, caches the app shell,
 * and provides notification support for voice responses.
 */

const CACHE_NAME = 'jarvis-v2';
const ASSETS = ['/', '/index.html', '/manifest.json'];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first, fallback to cache
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for app shell only
        if (response.ok && ASSETS.some((a) => event.request.url.endsWith(a))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Keep-alive from client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'KEEP_ALIVE') {
    // Periodic keep-alive — prevents the service worker from being killed
    console.log('[SW] Keep-alive received');
  }

  if (event.data?.type === 'SPEAK_TEXT') {
    // Show notification when app is in background
    self.registration.showNotification('JARVIS', {
      body: event.data.text?.slice(0, 200) || 'Respondiendo...',
      icon: '/manifest.json',
      tag: 'jarvis-response',
      silent: true
    });
  }
});

// Notification click — focus the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});
