import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateCurrentSimulationGate,
  type ConfigurationAssessment,
  type LatestSimulationForGate,
} from "./configuration-readiness";

const CURRENT_FINGERPRINT = "current-fingerprint";
const SIMULATION_AT = new Date("2026-08-08T15:13:00.000Z");

function assessment(
  overrides: Partial<ConfigurationAssessment> = {},
): ConfigurationAssessment {
  return {
    hasGoogle: true,
    hasSpotify: true,
    hasSpotifyLibraryScope: true,
    hasSpotifyPlaybackScope: true,
    hasSpotifyRecentlyPlayedScope: true,
    musicRepeatPolicy: {
      enabled: false,
      windowValue: null,
      windowUnit: null,
      historyKnownSince: null,
      lastSyncAt: null,
    },
    calendars: [],
    sources: [],
    targets: [],
    issues: [],
    fingerprint: CURRENT_FINGERPRINT,
    ...overrides,
  };
}

function simulation(
  summary: Record<string, unknown>,
  status = "SUCCESS",
): Exclude<LatestSimulationForGate, null> {
  return {
    startedAt: SIMULATION_AT,
    status,
    summary,
  };
}

test("blocks a real run when the current configuration has no simulation", () => {
  const gate = evaluateCurrentSimulationGate(assessment(), null);

  assert.equal(gate.realRunAllowed, false);
  assert.equal(gate.requiresSimulation, true);
  assert.match(gate.reason ?? "", /simula/i);
  assert.equal(gate.latestSimulationAt, null);
});

test("allows a real run only for the latest successful simulation of the current fingerprint with quality approved", () => {
  const gate = evaluateCurrentSimulationGate(
    assessment(),
    simulation({
      configurationFingerprint: CURRENT_FINGERPRINT,
      qualityPassed: true,
    }),
  );

  assert.equal(gate.realRunAllowed, true);
  assert.equal(gate.reason, null);
  assert.equal(gate.latestSimulationAt, SIMULATION_AT);
});

test("blocks the production incident: successful simulation with current fingerprint but qualityPassed=false", () => {
  const gate = evaluateCurrentSimulationGate(
    assessment(),
    simulation({
      configurationFingerprint: CURRENT_FINGERPRINT,
      qualityPassed: false,
    }),
  );

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /regras de composição/i);
});

test("blocks a stale approved simulation after the configuration fingerprint changes", () => {
  const gate = evaluateCurrentSimulationGate(
    assessment(),
    simulation({
      configurationFingerprint: "old-fingerprint",
      qualityPassed: true,
    }),
  );

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /configuração mudou/i);
});

test("blocks a failed latest simulation even if its fingerprint and previous state were otherwise valid", () => {
  const gate = evaluateCurrentSimulationGate(
    assessment(),
    simulation(
      {
        configurationFingerprint: CURRENT_FINGERPRINT,
        qualityPassed: true,
      },
      "FAILED",
    ),
  );

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /não foi concluída/i);
});

test("blocks an inconclusive latest simulation and preserves the provider-specific reason", () => {
  const gate = evaluateCurrentSimulationGate(
    assessment(),
    simulation(
      {
        configurationFingerprint: CURRENT_FINGERPRINT,
        qualityPassed: false,
        inconclusive: true,
      },
      "FAILED",
    ),
  );

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /inconclusiva/i);
});

test("generator contract finalizes every inconclusive source collection as FAILED with quality denied", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const inconclusiveAssignments = [...source.matchAll(/summary\.inconclusive = true;/g)];

  assert.ok(inconclusiveAssignments.length > 0, "generator must expose inconclusive branches");
  for (const assignment of inconclusiveAssignments) {
    const remainder = source.slice(assignment.index, assignment.index + 1400);
    assert.match(remainder, /summary\.qualityPassed = false/);
    assert.match(remainder, /finalizeRun\(run\.id, "FAILED"/);
    assert.match(remainder, /status: "FAILED"/);
  }
});

test("structural configuration issues block real generation before simulation state", () => {
  const gate = evaluateCurrentSimulationGate(
    assessment({
      issues: [
        {
          code: "SOURCE_REQUIRED",
          message: "Fonte obrigatória",
          href: "/dashboard/configuracao/fontes",
        },
      ],
    }),
    simulation({
      configurationFingerprint: CURRENT_FINGERPRINT,
      qualityPassed: true,
    }),
  );

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /pendências/i);
});

test("historical real runs are not an authority that can bypass the latest simulation", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");

  assert.doesNotMatch(source, /generationRun\.findMany/);
  assert.doesNotMatch(source, /hasControlledRealRun/);
  assert.match(source, /generationRun\.findFirst/);
});

test("MUSIC-01 policy is fingerprinted but dynamic listening timestamps are not", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");
  const fingerprintStart = source.indexOf("const fingerprintPayload");
  const fingerprintEnd = source.indexOf("return {", fingerprintStart);
  const fingerprintSource = source.slice(fingerprintStart, fingerprintEnd);

  assert.match(fingerprintSource, /musicRepeatPolicy/);
  assert.match(fingerprintSource, /windowValue/);
  assert.match(fingerprintSource, /windowUnit/);
  assert.doesNotMatch(fingerprintSource, /historyKnownSince/);
  assert.doesNotMatch(fingerprintSource, /lastSyncAt/);
});

test("POST /api/generate checks the current gate before invoking the generator", () => {
  const source = readFileSync("src/app/api/generate/route.ts", "utf8");
  const gateCheck = source.indexOf("if (!gate.realRunAllowed)");
  const generatorCall = source.indexOf("await generatePlaylists({");

  assert.ok(gateCheck >= 0, "real-run gate check must exist");
  assert.ok(generatorCall >= 0, "generator call must exist");
  assert.ok(
    gateCheck < generatorCall,
    "blocked real runs must return before generatePlaylists can write to Spotify",
  );
});

test("scheduled generation checks the same current gate before invoking the generator", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  const assessmentCall = source.indexOf("await assessConfiguration(user.id)");
  const gateCall = source.indexOf("await getFirstRunGate(user.id, assessment)");
  const gateCheck = source.indexOf("if (!gate.realRunAllowed)");
  const generatorCall = source.indexOf("await generatePlaylists({");

  assert.ok(assessmentCall >= 0, "scheduled run must assess current configuration");
  assert.ok(gateCall > assessmentCall, "scheduled run must evaluate current readiness");
  assert.ok(gateCheck > gateCall, "scheduled run must check realRunAllowed");
  assert.ok(generatorCall > gateCheck, "scheduled run must block before generatePlaylists can write");
});

test("CONFIG-04 green CTA is derived from the same realRunAllowed authority", () => {
  const source = readFileSync(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    "utf8",
  );

  assert.match(
    source,
    /simulation\.status === "SUCCESS"\s*&&\s*gate\.realRunAllowed/,
  );
});


test("ORDER-01 music ordering policy participates in configuration fingerprint", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");
  const fingerprintStart = source.indexOf("const fingerprintPayload");
  const fingerprintEnd = source.indexOf("return {", fingerprintStart);
  const fingerprintSource = source.slice(fingerprintStart, fingerprintEnd);
  assert.match(fingerprintSource, /musicOrderMode/);
});

test("ORDER-01 real entry points resolve reusable simulation seeds before generation", () => {
  const manual = readFileSync("src/app/api/generate/route.ts", "utf8");
  const scheduled = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  for (const source of [manual, scheduled]) {
    const seedLookup = source.indexOf("findReusableSimulationMusicOrderEvidence");
    const generatorCall = source.indexOf("await generatePlaylists({");
    assert.ok(seedLookup >= 0);
    assert.ok(generatorCall > seedLookup);
    assert.match(source, /musicOrderSimulationEvidence/);
  }
});


test("ORDER-01 blocks a real write when the approved preview hash no longer matches", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const mismatchGate = source.indexOf("musicOrderPreviewViolations.length > 0");
  const writerCreation = source.indexOf("if (!simulate) writer = await SpotifyClient.forUser(userId)");
  assert.ok(mismatchGate >= 0);
  assert.ok(writerCreation > mismatchGate);
  assert.match(source, /Simule novamente antes de publicar/);
});


test("MUSIC-04 diversity limits participate in the configuration fingerprint", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");
  const fingerprintStart = source.indexOf("const fingerprintPayload");
  const fingerprintEnd = source.indexOf("return {", fingerprintStart);
  const fingerprintSource = source.slice(fingerprintStart, fingerprintEnd);
  assert.match(fingerprintSource, /maxTracksPerArtist/);
  assert.match(fingerprintSource, /maxTracksPerAlbum/);
});

test("MUSIC-04 revalidates live diversity configuration and selected items before Spotify writer creation", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const liveGate = source.indexOf("musicDiversityConfigurationChanges.length > 0");
  const planGate = source.indexOf("musicDiversityViolations.length > 0");
  const writerCreation = source.indexOf("if (!simulate) writer = await SpotifyClient.forUser(userId)");
  assert.ok(liveGate >= 0);
  assert.ok(planGate > liveGate);
  assert.ok(writerCreation > planGate);
});


test("SCHEDULE-01 policy, local time and timezone participate in configuration fingerprint", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");
  const fingerprintStart = source.indexOf("const fingerprintPayload");
  const fingerprintEnd = source.indexOf("return {", fingerprintStart);
  const fingerprintSource = source.slice(fingerprintStart, fingerprintEnd);
  assert.match(fingerprintSource, /updatePolicy/);
  assert.match(fingerprintSource, /dailyScheduleMinutes/);
  assert.match(fingerprintSource, /scheduleTimezone/);
});

test("SCHEDULE-01 scheduler excludes MANUAL targets and uses auditable daily slots", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  assert.match(source, /updatePolicy:\s*\{\s*not:\s*"MANUAL"/);
  assert.match(source, /dailyScheduleSlot/);
  assert.match(source, /targetScheduleRun/);
  assert.match(source, /scheduleKey/);
});

test("SCHEDULE-01 KEEP_FILLED revalidates target snapshot before any incremental mutation", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const preflight = source.indexOf("scheduledTargetSnapshotViolations");
  const append = source.indexOf("appendPlaylistItems");
  const remove = source.indexOf("removePlaylistItems");
  assert.ok(preflight >= 0);
  assert.ok(append > preflight);
  assert.ok(remove > preflight);
});


test("SCHEDULE-01 reserves live URIs from enabled destinations outside the due batch", () => {
  const scheduler = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  const generator = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  assert.match(scheduler, /outsideTargets/);
  assert.match(scheduler, /getTargetPlaylistState/);
  assert.match(scheduler, /reservedUris/);
  assert.match(generator, /initialReserved:\s*opts\.reservedUris/);
});

test("SCHEDULE-01 daily claim is concurrency-safe and successful slots are idempotent", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  assert.match(source, /\["SUCCESS", "NOOP", "PARTIAL"\]\.includes/);
  assert.match(source, /createMany\(/);
  assert.match(source, /skipDuplicates:\s*true/);
  assert.match(source, /updateMany\(/);
});


test("SCHEDULE-01 revalidates external reservation and rebuild snapshots before writes", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const writer = source.indexOf("if (!simulate) writer = await SpotifyClient.forUser(userId)");
  const externalCheck = source.indexOf("externalReservationSnapshotViolations");
  const replace = source.indexOf("replacePlaylistItems", externalCheck);
  assert.ok(writer >= 0);
  assert.ok(externalCheck > writer);
  assert.ok(replace > externalCheck);
  assert.match(source, /rebuildByTargetId/);
  assert.match(source, /reservedTargetSnapshots/);
});
