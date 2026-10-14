// Socius AI - Service Worker for Background & Inactivity Study Reminders
const CACHE_NAME = 'socius-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle notification click: Focus active window or open dashboard
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./dashboard.html');
      }
    })
  );
});

// Receive message from main thread to show notification
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    self.registration.showNotification(title || 'Socius AI · Study Reminder', {
      body: options.body || "It's been a long time to see your dashboard and stuff! Time to review your incomplete topics.",
      icon: options.icon || '',
      badge: options.badge || '',
      tag: options.tag || 'socius-study-reminder',
      renotify: true,
      data: options.data || { url: './dashboard.html' }
    });
  }
});
