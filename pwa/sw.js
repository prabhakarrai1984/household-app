// Offline support. When the phone is online the app always asks the server for the newest files (so an update shows up
// on the next open), and falls back to the saved copy when offline or when the network is very slow.
// No user data ever passes through here, except that a chat file shared TO the app is parked briefly so the app can read it.
const CACHE = 'household-shell-v4';   // change this name to throw away every old saved copy
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './core/dates.js', './core/format.js', './core/parser.js', './core/store.js', './core/recurring.js',
  './core/reports.js', './core/service.js', './core/chat.js', './core/xlsx.js', './core/grocery.js', './core/food.js', './ocr.js', './pdfbill.js'];

self.addEventListener('install', (e) => {
  // one missing file must not stop the app from installing, so add them individually
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((f) => c.add(new Request(f, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  const keep = [CACHE, 'household-shared', 'household-reader'];
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

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
  // the bill-photo reader comes from a public library host once, then is kept for offline use
  if (req.method === 'GET' && url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith((async () => {
      const cache = await caches.open('household-reader');
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await Promise.race([fetch(req.url, { cache: 'no-cache' }), new Promise((_, no) => setTimeout(no, 4000))]);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || new Response('Offline', { status: 503 });
    }
  })());
});
