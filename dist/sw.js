const CACHE = "rigcheck-v0.3.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./patch-v02.css",
  "./firebase-auth.css",
  "./app.js",
  "./patch-v02.js",
  "./firebase-auth.js",
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
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    }))
  );
});
