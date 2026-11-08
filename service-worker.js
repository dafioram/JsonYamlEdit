/*
 * Brace — service-worker.js
 *
 * Cache-first app shell. Cache names include the registration scope so
 * several static apps can share the same hosting origin.
 *
 * Bump CACHE_VERSION whenever any precached file changes so clients pick
 * up the new files instead of serving stale ones from a previous install.
 * The unscoped legacy cache is deliberately left alone because another
 * Brace copy on the same origin may still use it.
 */

var CACHE_VERSION = "v2";
var CACHE_PREFIX = "brace-shell:" + self.registration.scope + ":";
var CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

var PRECACHE_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "css/editor-theme.css",
  "js/app.js",
  "js/convert.js",
  "js/csv.js",
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
    caches.open(CACHE_NAME).then(function (cache) {
      var requests = PRECACHE_FILES.map(function (asset) {
        return new Request(new URL(asset, self.registration.scope), { cache: "reload" });
      });
      return cache.addAll(requests);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var scope = new URL(self.registration.scope);
  var url = new URL(event.request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  var relativePath = url.pathname.slice(scope.pathname.length);
  var asset = relativePath || "./";
  if (PRECACHE_FILES.indexOf(asset) === -1) return;

  event.respondWith(caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(event.request, { ignoreSearch: true }).then(function (cached) {
      return cached || fetch(event.request);
    });
  }));
});
