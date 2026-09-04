/* The shell is worth caching so the app opens instantly and survives a moment
 * without the tailnet. Anything under /api never is: stale session state is
 * worse than no session state. */
const SHELL = 'ccs-shell-v33';
const FILES = ['./', './index.html', './app.js?v=26', 
               './icon-180.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

/* A push arrives with the app closed; this is the only code still running. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Claude Code', {
    body: data.body || '',
    icon: './icon-512.png',
    badge: './icon-180.png',
    // One notification per session: a later answer replaces the earlier
    // one rather than stacking up a column of them.
    tag: data.session || 'ccs',
    renotify: true,
    data: { session: data.session || '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const session = (event.notification.data || {}).session || '';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        client.postMessage({ open: session });
        return;
      }
    }
    await self.clients.openWindow('./?session=' + encodeURIComponent(session));
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL).then((c) => c.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('./index.html'))));
});
