// Service worker de la PWA — recibe los push del hub y muestra la burbuja
// de notificación aunque la app no esté abierta en primer plano.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Centro de Alertas', body: 'Nueva notificación' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  );

  // Ícono del dock/taskbar (Badging API) — para que se note aunque la app
  // esté cerrada. Sin la app abierta no sabemos el total real de
  // pendientes, así que acá solo marca "hay algo nuevo" (sin número); el
  // número exacto lo pone pantalla-sucursal.html apenas la app se abre.
  if ('setAppBadge' in self.navigator) {
    event.waitUntil(self.navigator.setAppBadge().catch(() => {}));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
