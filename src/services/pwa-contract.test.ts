import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import manifest from "../app/manifest";

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

test("PWA-01 manifest exposes the installable Sonoriza contract", () => {
  const value = manifest();

  assert.equal(value.short_name, "Sonoriza");
  assert.equal(value.start_url, "/dashboard");
  assert.equal(value.scope, "/");
  assert.equal(value.display, "standalone");
  assert.equal(value.theme_color, "#0B021F");
  assert.equal(value.background_color, "#0B021F");

  const icons = value.icons ?? [];
  assert.ok(
    icons.some(
      (icon) =>
        icon.src === "/pwa-icon/192" &&
        icon.sizes === "192x192" &&
        icon.type === "image/png",
    ),
  );
  assert.ok(
    icons.some(
      (icon) =>
        icon.src === "/pwa-icon/512" &&
        icon.sizes === "512x512" &&
        icon.type === "image/png",
    ),
  );
  assert.ok(
    icons.some(
      (icon) => icon.src === "/pwa-icon/512" && icon.purpose === "maskable",
    ),
  );
});

test("PWA-01 service worker is intentionally cacheless", () => {
  const source = read("public/sw.js");

  assert.match(source, /addEventListener\("install"/);
  assert.match(source, /addEventListener\("activate"/);
  assert.doesNotMatch(source, /addEventListener\("fetch"/);
  assert.doesNotMatch(source, /\bcaches\s*\./);
  assert.doesNotMatch(source, /respondWith\s*\(/);
});

test("PWA-01 registers the worker without using the HTTP cache", () => {
  const source = read("src/components/PwaServiceWorker.tsx");

  assert.match(source, /process\.env\.NODE_ENV !== "production"/);
  assert.match(source, /serviceWorker\.register\("\/sw\.js"/);
  assert.match(source, /updateViaCache:\s*"none"/);
});

test("PWA-01 icon route derives raster icons from the current Sonoriza mark", () => {
  const source = read("src/app/pwa-icon/[size]/route.tsx");

  assert.match(source, /sonoriza-mark\.webp/);
  assert.match(source, /new Set\(\[180, 192, 512\]\)/);
  assert.match(source, /background:\s*"#0B021F"/);
});

test("PWA-01 sends safe update headers for the service worker", () => {
  const source = read("next.config.mjs");

  assert.match(source, /source:\s*"\/sw\.js"/);
  assert.match(source, /Service-Worker-Allowed/);
  assert.match(source, /no-cache, no-store, must-revalidate/);
  assert.match(source, /Content-Security-Policy/);
});
