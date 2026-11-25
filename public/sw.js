// Makes Hourhand installable and shows a branded page when offline. Bump CACHE when the offline page or icons change.
// Only /offline and the icons are ever cached: no API responses, dashboard HTML or anything tied to a cookie.
const CACHE = "hourhand-shell-v1";
const SHELL = ["/offline", "/icons/192", "/icons/512", "/icons/maskable-512", "/icons/180"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match("/offline")));
});

// Phone alerts (src/lib/push). The server sends { title, body, url, tag }; a tap opens that dashboard page.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/dashboard";
  event.waitUntil(self.registration.showNotification(typeof data.title === "string" ? data.title : "Hourhand", {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icons/192",
    badge: "/icons/192",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/dashboard", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === url && "focus" in w);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
