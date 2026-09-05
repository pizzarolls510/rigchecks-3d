const CACHE = "rigcheck-v0.4.5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./patch-v02.css",
  "./firebase-auth.css",
  "./cloud-library.css",
  "./update-manager.js",
  "./app.js",
  "./patch-v02.js",
  "./firebase-auth.js",
  "./cloud-library.js",
  "./lib/model-schema.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./vendor/three/three.module.min.js",
  "./vendor/three/three.core.min.js",
  "./vendor/three/addons/controls/OrbitControls.js",
  "./vendor/three/addons/loaders/GLTFLoader.js",
  "./vendor/three/addons/loaders/DRACOLoader.js",
  "./vendor/three/addons/utils/BufferGeometryUtils.js",
  "./vendor/three/addons/libs/meshopt_decoder.module.js",
  "./vendor/three/addons/libs/draco/gltf/draco_decoder.js",
  "./vendor/three/addons/libs/draco/gltf/draco_wasm_wrapper.js",
  "./vendor/three/addons/libs/draco/gltf/draco_decoder.wasm"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first keeps the app current while preserving an offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
