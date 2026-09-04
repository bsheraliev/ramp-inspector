/* SAFA Inspector — service worker.
   ВАЖНО: при любой правке index.html / app.js / data/* поднимать CACHE. */
const CACHE = 'safa-inspector-v1.4.0';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './data/checklist.js',
  './data/findings.js',
  './data/photos.js',
  './data/photos-manifest.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Оболочка обязана закэшироваться. Фотопримеры (~12 МБ) кладём отдельно и
// поштучно: одна недоступная картинка не должна валить установку целиком.
async function cachePhotos(cache) {
  try {
    const list = await fetch('./data/photos-manifest.json').then(r => r.json());
    await Promise.allSettled(list.map(u => cache.add('./' + u)));
  } catch (e) { /* примеры догрузятся при первом просмотре */ }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(ASSETS);
    self.skipWaiting();
    await cachePhotos(c);
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // отправку в GAS не трогаем
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;             // внешние адреса — мимо кэша

  // network-first для кода и данных: перрон работает офлайн, но обновление
  // не должно застревать в кэше (грабли из предыдущих PWA)
  e.respondWith(
    fetch(req)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
