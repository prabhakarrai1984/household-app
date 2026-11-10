// Offline support. Files are served from the phone's cache and refreshed quietly in the background,
// so a new version arrives the next time the app is opened. No user data ever passes through here,
// except that a chat file shared TO the app is parked briefly so the app can read it.
const CACHE = 'household-shell';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './core/dates.js', './core/format.js', './core/parser.js', './core/store.js', './core/recurring.js',
  './core/reports.js', './core/service.js', './core/chat.js', './core/xlsx.js'];

self.addEventListener('install', (e) => {
  // one missing file must not stop the app from installing, so add them individually
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((f) => c.add(f)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('chat');
        if (file && file.size) {
          const shared = await caches.open('household-shared');
          await shared.put('shared-chat', new Response(file, { headers: { 'x-filename': encodeURIComponent(file.name || 'chat') } }));
        }
      } catch { /* fall through to the app */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || new Response('Offline', { status: 503 });
  })());
});
