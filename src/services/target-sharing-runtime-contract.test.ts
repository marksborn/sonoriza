import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#204 Gate 5 runtime is ACTIVE and planner-influencing", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(generator, /targetSharingRuntime/);
  assert.match(generator, /gate:\s*5/);
  assert.match(generator, /mode:\s*"ACTIVE"/);
  assert.match(generator, /plannerInfluence:\s*true/);
});

test("#204 Gate 5 scheduled partial execution carries external owner policy", () => {
  const scheduler = readFileSync(
    "src/jobs/scheduled-generation.ts",
    "utf8",
  );

  assert.match(scheduler, /externalReservationsByUri/);
  assert.match(scheduler, /outside\.sharingPolicy/);
  assert.match(scheduler, /resolveEffectiveSharingPolicy/);
  assert.match(scheduler, /reservedTargetSnapshots/);
});

test("#204 Gate 5 retains snapshot guard before Spotify mutation", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  const guard = generator.indexOf("reservationSnapshotViolations");
  const replace = generator.indexOf("replacePlaylistItems");

  assert.ok(guard >= 0);
  assert.ok(replace >= 0);
  assert.ok(guard < replace);
});

test("#204 Gate 5 validates final post-discovery plan before write", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  const finalSharing = generator.indexOf("findTargetSharingViolations");
  const writer = generator.indexOf("SpotifyClient.forUser(userId)");

  assert.ok(finalSharing >= 0);
  assert.ok(writer >= 0);
  assert.ok(finalSharing < writer);
});
