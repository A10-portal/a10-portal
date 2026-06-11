const CACHE_NAME = 'mova99-v2';
const STATIC_ASSETS = ['/', '/dashboard', '/login', '/signup', '/image/logo.PNG'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/')) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});

// PUSH NOTIFICATION HANDLER
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch(e) { data = { title: 'Mova99', body: event.data ? event.data.text() : 'New deals available!' }; }
  const title = data.title || 'Mova99 Shopping Store';
  const options = {
    body: data.body || 'Check out our latest deals!',
    icon: '/image/logo.png',
    badge: '/image/logo.png',
    data: { url: data.url || 'https://www.mova99.com/dashboard' },
    actions: [{ action: 'shop', title: 'Shop Now' }, { action: 'dismiss', title: 'Dismiss' }],
    vibrate: [200, 100, 200],
    tag: 'mova99-promo',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// NOTIFICATION CLICK
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || 'https://www.mova99.com/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('mova99.com') && 'focus' in client) { client.navigate(url); return client.focus(); }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
