const SONORIZA_SW_VERSION = "pwa-01-network-fetch-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SONORIZA_ACTIVATE") {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === "SONORIZA_SW_VERSION") {
    event.source?.postMessage({
      type: "SONORIZA_SW_VERSION",
      version: SONORIZA_SW_VERSION,
    });
  }
});

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  if (!payload) return;

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/pwa-icon-192.png",
      badge: "/pwa-icon-192.png",
      tag: payload.tag,
      data: { url: safeDashboardUrl(payload.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = safeDashboardUrl(event.notification.data?.url);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin !== self.location.origin) continue;
        if ("navigate" in client) {
          return client.navigate(targetUrl).then(() => client.focus());
        }
        return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});

function readPushPayload(event) {
  if (!event.data) return null;
  try {
    const value = event.data.json();
    if (
      !value ||
      typeof value.title !== "string" ||
      typeof value.body !== "string" ||
      typeof value.url !== "string" ||
      typeof value.tag !== "string"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function safeDashboardUrl(value) {
  if (value === "/dashboard" || value?.startsWith?.("/dashboard/")) return value;
  return "/dashboard";
}

// PWA-01 diagnostic parity with Tião: the worker participates only in
// same-origin document navigations and always goes straight to the network.
// API requests and all non-navigation requests remain outside the worker.
// No Cache API is used, so authenticated HTML/session state is never persisted.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.mode !== "navigate") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(fetch(event.request));
});
