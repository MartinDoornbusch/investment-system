// Web Push handlers, imported into the Workbox-generated service worker via
// vite-plugin-pwa's workbox.importScripts. Kept as a plain public/ file so it needs
// no bundling and is served at /push-sw.js.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (_) { data = { body: event.data && event.data.text() } }
  const title = data.title || 'InvSys'
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'invsys-alert',
    data: { url: data.url || '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus() }
      return self.clients.openWindow(url)
    })
  )
})
