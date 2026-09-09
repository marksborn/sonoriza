import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("PODCAST-06 cadence and priority for active SHOW sources participate in the configuration fingerprint", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");

  assert.match(source, /podcastShowCadencePolicy\.findMany/);
  assert.match(
    source,
    /source\.kind === "PODCAST" && source\.spotifyType === "SHOW"/,
  );
  assert.match(source, /policy\?\.cadenceMaxEpisodes \?\? null/);
  assert.match(source, /policy\?\.cadenceUnit \?\? null/);
  assert.match(source, /policy\?\.priority \?\? "NORMAL"/);

  const fingerprintStart = source.indexOf("const fingerprintPayload");
  const fingerprintEnd = source.indexOf("return {", fingerprintStart);
  assert.ok(fingerprintStart >= 0, "configuration fingerprint payload must exist");
  assert.ok(fingerprintEnd > fingerprintStart, "configuration fingerprint payload must terminate");

  const fingerprintSource = source.slice(fingerprintStart, fingerprintEnd);
  assert.match(fingerprintSource, /podcastShowCadencePolicies/);
  assert.doesNotMatch(
    fingerprintSource,
    /showName/,
    "presentation-only show names must not invalidate simulations",
  );
});
