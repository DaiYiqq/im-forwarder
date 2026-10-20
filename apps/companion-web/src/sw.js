/*
 * Service Worker：只缓存应用外壳。
 *
 * 硬性约束：
 *  - 绝不缓存 /api/*（伴生 API 响应含状态与日志，不应离线留存），也不缓存跨源请求；
 *  - 只处理 GET；导航请求用 network-first（保证拿到最新外壳），其它外壳资源用 cache-first；
 *  - 缓存键带版本号，activate 时清理旧版本。
 *
 * 本文件是纯静态 JS，不参与 TypeScript 类型检查；构建时原样拷贝到 dist/。
 */

const CACHE_NAME = "im-forwarder-companion-shell-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* 离线外壳是可选增强：缓存失败不影响应用可用。 */
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/** API 与跨源请求一律绕过缓存。 */
function isCacheable(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.includes("/api/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isCacheable(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached !== undefined) return cached;
      return fetch(request).then((response) => {
        if (!response.ok) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      });
    }),
  );
});
