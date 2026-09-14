import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import manifest from "../app/manifest";

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

function readPngDimensions(relativePath: string) {
  const data = readFileSync(path.join(root, relativePath));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  assert.deepEqual(data.subarray(0, 8), signature);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

// Checking IHDR alone accepts truncated images that browsers may display
// tolerantly but a WebAPK packager cannot decode.
function assertPngIntegrity(relativePath: string) {
  const data = readFileSync(path.join(root, relativePath));
  const { width, height } = readPngDimensions(relativePath);
  const imageData: Buffer[] = [];
  let ended = false;
  let offset = 8;
  while (offset < data.length) {
    assert.ok(offset + 12 <= data.length, `${relativePath}: truncated chunk`);
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    assert.ok(end <= data.length, `${relativePath}: truncated ${type}`);
    let crc = 0xffffffff;
    for (const byte of data.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, data.readUInt32BE(end - 4), `${relativePath}: ${type} CRC`);
    if (type === "IDAT") imageData.push(data.subarray(offset + 8, end - 4));
    offset = end;
    if (type === "IEND") {
      assert.equal(length, 0);
      ended = true;
      break;
    }
  }
  assert.ok(ended, `${relativePath}: missing IEND`);
  assert.equal(offset, data.length, `${relativePath}: trailing bytes`);
  assert.ok(imageData.length > 0, `${relativePath}: missing IDAT`);
  // Our shipped icons are 8-bit, non-interlaced PNGs.
  assert.equal(data[24], 8, `${relativePath}: bit depth`);
  assert.equal(data[28], 0, `${relativePath}: interlace`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[data.readUInt8(25)];
  assert.ok(channels, `${relativePath}: color type`);
  const pixels = inflateSync(Buffer.concat(imageData));
  const stride = width * channels + 1;
  assert.equal(pixels.length, height * stride, `${relativePath}: incomplete scanlines`);
  for (let row = 0; row < height; row++) {
    assert.ok(pixels.readUInt8(row * stride) <= 4, `${relativePath}: invalid PNG filter`);
  }
}

for (const size of [180, 192, 512]) {
  test(`PWA-01 ${size}px icon has complete chunks, valid checksums and pixel data`, () => {
    assertPngIntegrity(`public/pwa-icon-${size}.png`);
  });
}

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
        icon.src === "/pwa-icon-192.png" &&
        icon.sizes === "192x192" &&
        icon.type === "image/png",
    ),
  );
  assert.ok(
    icons.some(
      (icon) =>
        icon.src === "/pwa-icon-512.png" &&
        icon.sizes === "512x512" &&
        icon.type === "image/png",
    ),
  );
  assert.ok(
    icons.some(
      (icon) =>
        icon.src === "/pwa-icon-512.png" && icon.purpose === "maskable",
    ),
  );
});

test("PWA-01 service worker uses network-only navigation without Cache API", () => {
  const source = read("public/sw.js");

  assert.match(source, /addEventListener\("install"/);
  assert.match(source, /addEventListener\("activate"/);
  assert.match(source, /addEventListener\("fetch"/);
  assert.match(source, /event\.request\.mode !== "navigate"/);
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /event\.respondWith\(fetch\(event\.request\)\)/);
  assert.doesNotMatch(source, /\bcaches\s*\./);
  assert.doesNotMatch(source, /\bcaches\s*\(/);
  assert.doesNotMatch(source, /cache\.put\s*\(/);
  assert.doesNotMatch(source, /cache\.match\s*\(/);
});

test("PWA-01 registers the worker without using the HTTP cache", () => {
  const source = read("src/components/PwaServiceWorker.tsx");

  assert.match(source, /process\.env\.NODE_ENV !== "production"/);
  assert.match(source, /serviceWorker\.register\("\/sw\.js"/);
  assert.match(source, /updateViaCache:\s*"none"/);
});

test("PWA-01 exposes an explicit install flow inside Sonoriza", () => {
  const source = read("src/components/PwaInstallPrompt.tsx");
  const layout = read("src/app/layout.tsx");

  assert.match(source, /beforeinstallprompt/);
  assert.match(source, /preventDefault\(\)/);
  assert.match(source, /deferredPrompt\.prompt\(\)/);
  assert.match(source, /deferredPrompt\.userChoice/);
  assert.match(source, /appinstalled/);
  assert.match(source, /display-mode: standalone/);
  assert.match(source, /standalone\?: boolean/);
  assert.match(source, /Instalar o Sonoriza/);
  assert.match(source, /Vivaldi para Android/);
  assert.match(source, /Criar atalho/);
  assert.match(layout, /<PwaInstallPrompt \/>/);
});

test("PWA-01 ships valid static raster install icons", () => {
  assert.deepEqual(readPngDimensions("public/pwa-icon-180.png"), {
    width: 180,
    height: 180,
  });
  assert.deepEqual(readPngDimensions("public/pwa-icon-192.png"), {
    width: 192,
    height: 192,
  });
  assert.deepEqual(readPngDimensions("public/pwa-icon-512.png"), {
    width: 512,
    height: 512,
  });
});

test("PWA-01 sends safe update headers for the service worker", () => {
  const source = read("next.config.mjs");

  assert.match(source, /source:\s*"\/sw\.js"/);
  assert.match(source, /Service-Worker-Allowed/);
  assert.match(source, /no-cache, no-store, must-revalidate/);
  assert.match(source, /Content-Security-Policy/);
});
