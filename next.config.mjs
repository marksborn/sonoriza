import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Build identity shown in the dashboard footer. Resolved once at `next build`
// so the running server reports the code it was actually built from.
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
const packageVersion = JSON.parse(
  readFileSync(path.join(rootDir, "package.json"), "utf8"),
).version;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    SONORIZA_VERSION: packageVersion,
    SONORIZA_BUILD_SHA: git(["rev-parse", "HEAD"]),
    SONORIZA_COMMIT_DATE: git(["log", "-1", "--format=%cI"]),
    SONORIZA_BUILD_TIME: new Date().toISOString(),
  },
  experimental: {
    // The generation engine only ever runs on the server.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@/services/spotify/incremental-reader": path.resolve(
        rootDir,
        "src/services/spotify/podcast-07-incremental-reader.ts",
      ),
    };
    return config;
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
