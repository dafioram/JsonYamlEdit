/*
 * Brace — service-worker.js
 *
 * Cache-first app shell so Brace works offline once installed. There's no
 * server component to talk to in the first place, so "offline" here just
 * means "loads from cache instead of disk on every visit."
 *
 * Bump CACHE_VERSION whenever any precached file changes so clients pick
 * up the new files instead of serving stale ones from a previous install.
 */

var CACHE_VERSION = "brace-v1";

var PRECACHE_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "css/editor-theme.css",
  "js/app.js",
  "js/convert.js",
  "js/editor.js",
  "js/linter.js",
  "js/parser.js",
  "js/table-view.js",
  "js/tree-view.js",
  "lib/js-yaml.min.js",
  "lib/codemirror/codemirror.js",
  "lib/codemirror/codemirror.css",
  "lib/codemirror/mode/javascript/javascript.js",
  "lib/codemirror/mode/yaml/yaml.js",
  "lib/codemirror/addon/edit/matchbrackets.js",
  "lib/codemirror/addon/fold/foldcode.js",
  "lib/codemirror/addon/fold/foldgutter.js",
  "lib/codemirror/addon/fold/foldgutter.css",
  "lib/codemirror/addon/fold/brace-fold.js",
  "lib/codemirror/addon/fold/indent-fold.js",
  "icons/icon-32.png",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(PRECACHE_FILES);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_VERSION; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        // Opportunistically cache same-origin files fetched after install
        // (e.g. if PRECACHE_FILES ever misses one) — never cache errors.
        if (response && response.ok && event.request.url.indexOf(self.location.origin) === 0) {
          var copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () {
        return cached; // offline and not precached — nothing more we can do
      });
    })
  );
});
