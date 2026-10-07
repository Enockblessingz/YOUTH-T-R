/* ============================================================
   Youth Transformers — Service Worker
   Cache-first for shell, network-first for navigation,
   bypass Supabase and CDN.
   ============================================================ */

const VERSION = 'yt-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL_URLS = [
  '/',
  '/index.html',
  '/app.html',
  '/login.html',
  '/signup.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/maintenance.html',
  '/auth.js',
  '/manifest.json',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

const BYPASS = [
  'supabase.co',
  'supabase.in',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com'
];

/* ---------- Install ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

/* ---------- Activate ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ---------- Fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // bypass third-party & supabase
  if (BYPASS.some((host) => url.hostname.includes(host))) return;

  // navigation requests: network-first with cached shell fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/maintenance.html')))
    );
    return;
  }

  // same-origin assets: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) {
          fetch(req).then((res) => {
            if (res.ok) caches.open(ASSET_CACHE).then((c) => c.put(req, res)).catch(() => {});
          }).catch(() => {});
          return cached;
        }
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => caches.match('/maintenance.html'));
      })
    );
  }
});

/* ---------- Push ---------- */
self.addEventListener('push', (event) => {
  let data = { title: 'Youth Transformers', body: 'New ministry activity', icon: '/icons/icon-192.png', url: '/app.html' };
  try { data = { ...data, ...(event.data?.json() || {}) }; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: '/icons/favicon-32.png',
      data: { url: data.url },
      vibrate: [80, 40, 80]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/app.html';
  event.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* ---------- SKIP_WAITING ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
