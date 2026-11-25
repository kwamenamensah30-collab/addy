// Addy service worker: keeps the app usable with no signal.
// App files: network first (so updates arrive), cache fallback.
// Satellite and topographic tiles you have viewed online are kept so the same area still shows offline.
// OpenStreetMap's own tiles (tile.openstreetmap.org) are NOT cached here: their usage policy forbids offline
// and bulk caching, so those requests go straight to the network and the browser's normal HTTP cache.
// TILES is v2: activating this version deletes the v1 tile cache, which could hold "Access blocked" images.
const APP = 'addy-app-v7', TILES = 'addy-tiles-v2', MAX_TILES = 4000;
const FILES = ['./', 'index.html', 'app.css', 'js/app.js', 'js/geo.js', 'js/io.js', 'js/db.js', 'js/presets.js', 'js/route.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'apple-touch-icon.png', 'favicon-32.png', 'favicon-64.png', 'brand/addy-logo.png', 'brand/addy-logo-light.png', 'brand/addy-mark.png', 'brand/addy-mark-light.png'];
const TILE_HOSTS = /(^|\.)arcgisonline\.com$|(^|\.)opentopomap\.org$/;

self.addEventListener('install', e => e.waitUntil(caches.open(APP).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim())));

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }
let trimming = false;
async function trimTiles() {
  if (trimming) return; trimming = true;
  try { const c = await caches.open(TILES); const keys = await c.keys(); for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]); }
  finally { trimming = false; }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return; // data always goes to the server
    e.respondWith((async () => {
      try {
        const resp = await Promise.race([fetch(req), timeout(5000)]);
        if (resp.ok) { const copy = resp.clone(); caches.open(APP).then(c => c.put(req, copy)); }
        return resp;
      } catch {
        return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      }
    })());
    return;
  }
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp.ok || resp.type === 'opaque') { c.put(req, resp.clone()); trimTiles(); }
        return resp;
      } catch { return Response.error(); }
    })());
  }
});
