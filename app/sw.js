// Offline support: the whole app and both course files are cached on first load.
// Bump VERSION whenever any app file changes so phones pick up the new version.
const VERSION = 'dialed-v0.7.0';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/gps.js', 'js/geo.js', 'js/course.js', 'js/clubs.js',
  'js/rounds.js', 'js/holemap.js', 'js/voice.js', 'js/weather.js',
  'courses/balboa_9_course.json', 'courses/balboa_18_course.json', 'courses/balboa_9_zones.json',
  'fonts/InstrumentSerif-normal.woff2', 'fonts/InstrumentSerif-italic.woff2', 'fonts/Jost-normal.woff2',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // weather API etc. go to the network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
