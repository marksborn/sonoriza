const SONORIZA_SW_VERSION = "notify-01-v1";

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

// Intentionally no fetch handler and no Cache API usage.
// Authenticated pages, APIs and dynamic playlist state always use the network.
