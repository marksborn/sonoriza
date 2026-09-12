import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import test from "node:test";

const page = () =>
  readFileSync(
    "src/app/onboarding/page.tsx",
    "utf8",
  );

const simulation = () =>
  readFileSync(
    "src/services/onboarding/simulation.ts",
    "utf8",
  );

const readiness = () =>
  readFileSync(
    "src/services/configuration-readiness.ts",
    "utf8",
  );

const wrapper = () =>
  readFileSync(
    "src/jobs/generate-playlists.ts",
    "utf8",
  );

const incremental = () =>
  readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

test("#205 Gate 6 exposes an editable review before simulation", () => {
  const source = page();

  assert.match(
    source,
    /Revise sua primeira configuração/,
  );

  assert.match(
    source,
    /editReviewStep/,
  );

  assert.match(
    source,
    /value="SOURCES"/,
  );

  assert.match(
    source,
    /value="DESTINATION"/,
  );

  assert.match(
    source,
    /value="MUSIC_BEHAVIOR"/,
  );

  assert.match(
    source,
    /value="CALENDAR"/,
  );

  assert.match(
    source,
    /Testar configuração/,
  );
});

test("#205 Gate 6 enters READY_FOR_SIMULATION explicitly", () => {
  const source = page();

  assert.match(
    source,
    /status:\s*"READY_FOR_SIMULATION"/,
  );

  assert.match(
    source,
    /currentStep:\s*"SIMULATION"/,
  );

  assert.match(
    source,
    /readyForSimulationAt:\s*new Date\(\)/,
  );
});

test("#205 Gate 6 reuses CONFIG-04 and the canonical generator", () => {
  const source = simulation();

  assert.match(
    source,
    /assessConfiguration/,
  );

  assert.match(
    source,
    /assessCalendar03GenerationConfiguration/,
  );

  assert.match(
    source,
    /generatePlaylists/,
  );

  assert.match(
    source,
    /trigger:\s*"SIMULATION"/,
  );

  assert.match(
    source,
    /simulate:\s*true/,
  );
});

test("#205 Gate 6 can assess the explicit disabled onboarding target without changing global defaults", () => {
  const assessment = readiness();
  const source = simulation();

  assert.match(
    assessment,
    /includeDisabledTargetIds/,
  );

  assert.match(
    assessment,
    /Disabled targets require an explicit configuration assessment scope/,
  );

  assert.match(
    source,
    /targetPlaylistIds:\s*\[\s*input\.targetId/,
  );

  assert.match(
    source,
    /includeDisabledTargetIds:\s*\[\s*input\.targetId/,
  );
});

test("#205 Gate 6 disabled-target exception is fail-closed to scoped simulation", () => {
  const source = incremental();
  const generationWrapper = wrapper();

  assert.match(
    source,
    /simulationIncludeDisabledTargetIds/,
  );

  assert.match(
    source,
    /if \(!input\.simulate\)/,
  );

  assert.match(
    source,
    /if \(!input\.targetScope\)/,
  );

  assert.match(
    source,
    /Disabled simulation target must belong to the explicit target scope/,
  );

  assert.match(
    generationWrapper,
    /resolveSimulationDisabledTargetIds/,
  );
});

test("#205 Gate 6 presents understandable simulation evidence", () => {
  const source = page();
  const service = simulation();

  assert.match(
    source,
    /Fontes usadas/,
  );

  assert.match(
    source,
    /Principais exclusões e limitações/,
  );

  assert.match(
    source,
    /Prévia do plano/,
  );

  assert.match(
    service,
    /musicUnavailableSkippedCount/,
  );

  assert.match(
    service,
    /recentlyPlayedSkippedCount/,
  );

  assert.match(
    service,
    /inferredSkipSuppressedCount/,
  );
});

test("#205 Gate 6 never activates or writes the onboarding target", () => {
  const source = simulation();
  const onboarding = page();

  assert.doesNotMatch(
    source,
    /enabled:\s*true/,
  );

  assert.doesNotMatch(
    source,
    /replacePlaylistItems/,
  );

  assert.doesNotMatch(
    onboarding,
    /replacePlaylistItems/,
  );

  assert.match(
    onboarding,
    /Gate 7 liberará a ativação/,
  );
});
