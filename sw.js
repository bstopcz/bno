// Działanie bez internetu: apka i raz otwarte mapy treningów zostają w pamięci telefonu.
// Kod i lista treningów: najpierw sieć (żeby od razu widać było nowe wersje), a gdy nie odpowiada w 3 s – kopia.
// Obrazy map, siatki terenu i czcionki: od razu kopia, a w tle odświeżenie.
const CACHE = 'bno-v1';
const SHELL = ['./', 'index.html', 'logo.jpg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest',
  'geo.js', 'mapfile.js', 'align.js', 'lines.js', 'core.js', 'store.js', 'ocad.js', 'symbols.js', 'course.js',
  'info.js', 'live.js', 'treningi.js', 'gen.js', 'app.js', 'treningi/treningi.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('bno-')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => {
  if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  const extern = /(^|\.)(googleapis\.com|gstatic\.com|cdnjs\.cloudflare\.com)$/.test(url.hostname);
  if (!own && !extern) return;
  const media = extern || /\.(jpg|jpeg|png|webp|woff2?)$/i.test(url.pathname);
  if (media) {
    e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => {
      const net = fetch(req).then((res) => put(req, res));
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    }));
    return;
  }
  e.respondWith(new Promise((resolve, reject) => {
    let done = false;
    const fallback = () => caches.match(req, { ignoreSearch: req.mode === 'navigate', ignoreVary: true })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
    const timer = setTimeout(() => fallback().then((hit) => { if (hit && !done) { done = true; resolve(hit); } }), 3000);
    fetch(req).then((res) => {
      clearTimeout(timer);
      put(req, res);
      if (!done) { done = true; resolve(res); }
    }).catch((err) => {
      clearTimeout(timer);
      if (done) return;
      fallback().then((hit) => { done = true; if (hit) resolve(hit); else reject(err); });
    });
  }));
});
