/**
 * JARVIS Service Worker — Background Persistence
 * Keeps the connection alive when the page is hidden,
 * handles notifications, and enables PWA install.
 */

const CACHE_NAME = 'jarvis-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// ─── Install ─────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ─── Activate ────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Fetch ───────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Network-first for API calls, cache-first for assets
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Server offline', state: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
      )
    );
  }
});

// ─── Message Handler ─────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'KEEP_ALIVE') {
    // Keep the service worker alive by sending periodic pings
    setInterval(() => {
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'PING' }));
      });
    }, 25000);
  }
});

// ─── Push Notifications (future) ─────────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() || { title: 'JARVIS', body: 'New message' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      vibrate: [100, 50, 100],
      tag: 'jarvis-notification'
    })
  );
});

// ─── Notification Click ──────────────────────
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
