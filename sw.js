// Resume Tailor service worker — instant repeat loads.
// Stale-while-revalidate for same-origin GETs: serve the cached copy
// immediately, refresh it in the background. The page's own version.json
// check reloads once when a new version has landed.
const CACHE = 'rt-static-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('version.json')) return;   // version checks must hit the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request, { ignoreSearch: url.pathname.endsWith('.html') || url.pathname.endsWith('/') });
    const refresh = fetch(e.request).then(resp => {
      if (resp && resp.ok) cache.put(e.request, resp.clone());
      return resp;
    }).catch(() => null);
    return cached || (await refresh) || new Response('offline', { status: 503 });
  })());
});
