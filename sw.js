/* Make it Fast Edit Arsenal service worker — app shell + local render engine offline. */
const VERSION = 'make-it-fast-v3.0.0';
const CACHE = `${VERSION}-shell`;
const SHELL = [
  './', './index.html', './styles.css',
  './app.js', './background.js', './player.js', './blackout.css', './engine.js', './ffmpeg-plan.js', './media-utils.js', './zip.js',
  './manifest.webmanifest', './assets/logo.svg',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/icon-maskable-512.png', './assets/icons/apple-touch-icon.png',
  './assets/fonts/Inter.woff2', './assets/fonts/SpaceGrotesk.woff2', './assets/fonts/NotoArabic.woff2',
  './vendor/ffmpeg/index.js', './vendor/ffmpeg/classes.js', './vendor/ffmpeg/const.js',
  './vendor/ffmpeg/errors.js', './vendor/ffmpeg/types.js', './vendor/ffmpeg/utils.js', './vendor/ffmpeg/worker.js',
  './engine/ffmpeg-core.js', './engine/ffmpeg-core.wasm.gz'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol === 'blob:' || url.protocol === 'data:') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put('./index.html', copy));
        return response;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response.ok && (response.type === 'basic' || response.type === 'default')) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached || caches.match(request).then(fallback => fallback || Response.error()));
      return cached || network;
    })
  );
});
