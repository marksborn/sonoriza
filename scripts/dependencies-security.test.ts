import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfigFromFile } from "@prisma/config";
import postcss from "postcss";
import nested from "postcss-nested";
import tailwindcss from "tailwindcss";
import { z } from "zod";

import { prelaunchSignupSchema } from "../src/services/prelaunch-contract";

test("Zod upgrade preserves signup trimming, defaults, consent and rejection", () => {
  assert.deepEqual(prelaunchSignupSchema.parse({
    email: "  Person+tag@example.com  ", privacyAccepted: true, extra: "discard",
  }), { email: "Person+tag@example.com", privacyAccepted: true, website: "" });
  for (const body of [null, {}, { email: "bad", privacyAccepted: true },
    { email: "person@example.com", privacyAccepted: false },
    { email: "person@example.com", privacyAccepted: "true" },
    { email: "person@example.com", privacyAccepted: true, website: "bot" }]) {
    assert.equal(prelaunchSignupSchema.safeParse(body).success, false);
  }
});

test("patched Zod rejects an oversized bounded collection before visiting elements", () => {
  let visited = 0;
  const schema = z.array(z.string().refine(() => { visited += 1; return true; })).max(2);
  const parsed = schema.safeParse(Array.from({ length: 100 }, () => "value"));
  assert.equal(parsed.success, false);
  assert.equal(visited, 0);
});

test("Prisma's scoped merger preserves ordinary config data and handles cyclic graphs", () => {
  const prismaRequire = createRequire(require.resolve("@prisma/config"));
  const { deepmerge } = prismaRequire("deepmerge-ts") as typeof import("deepmerge-ts");
  assert.deepEqual(deepmerge(
    { migrations: { path: "prisma/migrations" }, flags: ["a"] },
    { migrations: { seed: "tsx prisma/seed.ts" }, flags: ["b"] },
  ), { migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" }, flags: ["a", "b"] });
  const left: { self?: unknown } = {};
  const right: { self?: unknown } = {};
  left.self = left;
  right.self = right;
  assert.doesNotThrow(() => deepmerge(left, right));
});

test("Prisma 6 loads a real config file through the overridden merger", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sonoriza-deps-523-"));
  try {
    const configFile = path.join(directory, "prisma.config.mjs");
    await writeFile(configFile, `export default ${JSON.stringify({
      schema: "./schema.prisma",
      migrations: { path: "./migrations", seed: "tsx seed.ts" },
    })};\n`);
    const loaded = await loadConfigFromFile({ configFile, configRoot: directory });
    assert.equal(loaded.error, undefined);
    assert.equal(loaded.config?.schema, path.join(directory, "schema.prisma"));
    assert.equal(loaded.config?.migrations?.path, path.join(directory, "migrations"));
    assert.equal(loaded.config?.migrations?.seed, "tsx seed.ts");
  } finally {
    // Only the exact directory returned by mkdtemp above is removed.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("selector parser upgrade preserves Tailwind variants and nested selectors", async () => {
  const output = await postcss([
    tailwindcss({
      content: [{ raw: '<div class="hover:bg-red-500 md:flex [&>span]:font-bold"></div>' }],
      corePlugins: { preflight: false },
    }),
    nested(),
  ]).process("@tailwind utilities; .parent { &:hover { color: red } & > span { color: blue } }", {
    from: undefined,
  });
  assert.match(output.css, /\.hover\\:bg-red-500:hover/);
  assert.match(output.css, /@media \(min-width: 768px\)/);
  assert.match(output.css, /\.md\\:flex/);
  assert.match(output.css, /\.parent:hover/);
  assert.match(output.css, /\.parent > span/);
  assert.match(output.css, /font-weight: 700/);
  assert.equal(output.warnings().length, 0);
});
