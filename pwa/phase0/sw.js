// Phase 0 probe service worker: show push notifications, set badge, focus app on tap.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'Phase 0 probe', body: 'Test push' };
  try {
    if (event.data) Object.assign(data, event.data.json());
  } catch { /* keep defaults */ }
  const tasks = [
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-180.png',
      data: { url: '/' },
    }),
  ];
  if ('setAppBadge' in navigator) {
    tasks.push(navigator.setAppBadge(1).catch(() => { /* badge is best-effort */ }));
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
