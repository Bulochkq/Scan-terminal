/**
 * SW.JS — service worker.
 *
 * ЩО БУЛО НЕ ТАК У ПОПЕРЕДНІЙ ВЕРСІЇ:
 *  1. Кешувались не ті бібліотеки: jQuery 3.6 з code.jquery.com і html5-qrcode
 *     з unpkg, тоді як сторінка вантажить jQuery 3.7.1 з cdnjs і html5-qrcode
 *     з jsdelivr. Тобто два файли качались щоразу і ніколи не використовувались,
 *     а SheetJS і PDF.js не кешувались узагалі.
 *  2. cache.addAll() падає ЦІЛКОМ, якщо хоч один URL не віддався. Через
 *     сторонні CDN у списку встановлення могло не завершуватись ніколи —
 *     і тоді service worker не активується, а пробує знову при кожному відкритті.
 *  3. Стратегія «спочатку мережа» застосовувалась до всього, включно з власним
 *     CSS. Тобто кеш не прискорював нічого — лише додавав шар.
 *
 * ТЕПЕР:
 *  - у precache тільки свої файли, і встановлення не може впасти через CDN;
 *  - своя статика віддається з кешу миттєво, оновлення підтягується у фоні;
 *  - бібліотеки з CDN кешуються при першому використанні;
 *  - запити до Apps Script не чіпаються взагалі.
 */

const VERSION = 'v8';
const SHELL_CACHE = 'terminal-shell-' + VERSION;
const LIB_CACHE = 'terminal-libs-' + VERSION;

/** Тільки свої файли — жодного стороннього URL, щоб установка не падала. */
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/config.js',
  './js/api.js',
  './js/importer.js',
  './js/app.js',
  './icons/icon.svg'
];

/** Хости бібліотек, які кешуємо при першому завантаженні. */
const LIB_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'cdn.sheetjs.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll падає цілком при будь-якій помилці, тому кладемо файли окремо.
      Promise.all(SHELL_FILES.map((url) =>
        cache.add(new Request(url, { cache: 'reload' }))
          .catch((err) => console.warn('[SW] не вдалось закешувати', url, err))
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((n) => n !== SHELL_CACHE && n !== LIB_CACHE)
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Запити до API (POST на Apps Script) не кешуються і не перехоплюються.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Apps Script — завжди напряму в мережу.
  if (url.hostname.indexOf('script.google') !== -1 ||
      url.hostname.indexOf('googleusercontent') !== -1) return;

  // Своя статика: спочатку кеш (миттєво), оновлення тягнемо у фоні.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // Бібліотеки з CDN: після першого завантаження беруться з кешу.
  if (LIB_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }

  // Решта (наприклад пошук картинок у Google) — звичайна мережа.
});

/** Віддає з кешу одразу, паралельно оновлюючи копію. */
function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && !res.redirected) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
}

/** Один раз качає, далі завжди з кешу. */
function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && !res.redirected) cache.put(req, res.clone());
        return res;
      });
    })
  );
}
