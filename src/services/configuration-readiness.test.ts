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

test("CONFIG-04 green CTA is derived from the same realRunAllowed authority", () => {
  const source = readFileSync(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    "utf8",
  );

  assert.match(
    source,
    /simulation\.status === "SUCCESS" && gate\.realRunAllowed/,
  );
});
