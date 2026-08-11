const SONORIZA_SW_VERSION = "pwa-01-v1";

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

// Intentionally no fetch handler and no Cache API usage in PWA-01.
// Authenticated pages, APIs and dynamic playlist state must always use the network.
