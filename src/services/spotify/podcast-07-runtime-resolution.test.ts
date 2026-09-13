import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nextConfig = readFileSync(
  new URL("../../../next.config.mjs", import.meta.url),
  "utf8",
);

const tsconfig = JSON.parse(
  readFileSync(new URL("../../../tsconfig.json", import.meta.url), "utf8"),
) as {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
};

test("PODCAST-07 reader override is wired in both TypeScript and Next runtime resolution", () => {
  assert.deepEqual(
    tsconfig.compilerOptions?.paths?.["@/services/spotify/incremental-reader"],
    ["./src/services/spotify/podcast-07-incremental-reader"],
  );

  assert.match(
    nextConfig,
    /"@\/services\/spotify\/incremental-reader"\s*:\s*path\.resolve\([\s\S]*?podcast-07-incremental-reader\.ts/,
  );
});
