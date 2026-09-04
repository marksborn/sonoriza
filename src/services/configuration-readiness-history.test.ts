import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCurrentSimulationHistoryGate,
  type ConfigurationAssessment,
  type SimulationForGate,
} from "./configuration-readiness";

const CURRENT_FINGERPRINT = "current-fingerprint";

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

function simulation(input: {
  at: string;
  status?: string;
  fingerprint?: string;
  qualityPassed?: boolean;
  inconclusive?: boolean;
}): SimulationForGate {
  return {
    startedAt: new Date(input.at),
    status: input.status ?? "SUCCESS",
    summary: {
      configurationFingerprint: input.fingerprint ?? CURRENT_FINGERPRINT,
      qualityPassed: input.qualityPassed ?? true,
      ...(input.inconclusive === undefined
        ? {}
        : { inconclusive: input.inconclusive }),
    },
  };
}

test("#280 allows an older approved simulation when a newer retry for the same fingerprint is inconclusive", () => {
  const gate = evaluateCurrentSimulationHistoryGate(assessment(), [
    simulation({
      at: "2026-09-04T10:00:00.000Z",
      status: "FAILED",
      qualityPassed: false,
      inconclusive: true,
    }),
    simulation({ at: "2026-09-03T10:00:00.000Z" }),
  ]);

  assert.equal(gate.realRunAllowed, true);
  assert.equal(gate.reason, null);
  assert.equal(
    gate.latestSimulationAt?.toISOString(),
    "2026-09-03T10:00:00.000Z",
  );
});

test("#280 keeps a newer conclusive quality failure authoritative for the same fingerprint", () => {
  const gate = evaluateCurrentSimulationHistoryGate(assessment(), [
    simulation({
      at: "2026-09-04T10:00:00.000Z",
      qualityPassed: false,
    }),
    simulation({ at: "2026-09-03T10:00:00.000Z" }),
  ]);

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /regras de composição/i);
});

test("#280 keeps a newer conclusive failed run authoritative for the same fingerprint", () => {
  const gate = evaluateCurrentSimulationHistoryGate(assessment(), [
    simulation({
      at: "2026-09-04T10:00:00.000Z",
      status: "FAILED",
      qualityPassed: false,
      inconclusive: false,
    }),
    simulation({ at: "2026-09-03T10:00:00.000Z" }),
  ]);

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /não foi concluída/i);
});

test("#280 never reuses an approved simulation from another fingerprint", () => {
  const gate = evaluateCurrentSimulationHistoryGate(assessment(), [
    simulation({
      at: "2026-09-04T10:00:00.000Z",
      status: "FAILED",
      qualityPassed: false,
      inconclusive: true,
    }),
    simulation({
      at: "2026-09-03T10:00:00.000Z",
      fingerprint: "old-fingerprint",
    }),
  ]);

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /não existe uma simulação válida anterior/i);
});

test("#280 blocks when the current fingerprint has only inconclusive attempts", () => {
  const gate = evaluateCurrentSimulationHistoryGate(assessment(), [
    simulation({
      at: "2026-09-04T10:00:00.000Z",
      status: "FAILED",
      qualityPassed: false,
      inconclusive: true,
    }),
  ]);

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /inconclusivas/i);
});

test("#280 structural configuration issues still override simulation history", () => {
  const gate = evaluateCurrentSimulationHistoryGate(
    assessment({
      issues: [
        {
          code: "SOURCE_REQUIRED",
          message: "Fonte obrigatória",
          href: "/dashboard/configuracao/fontes",
        },
      ],
    }),
    [simulation({ at: "2026-09-03T10:00:00.000Z" })],
  );

  assert.equal(gate.realRunAllowed, false);
  assert.match(gate.reason ?? "", /pendências/i);
});

test("#280 history evaluation is deterministic regardless of caller ordering", () => {
  const older = simulation({ at: "2026-09-03T10:00:00.000Z" });
  const newer = simulation({
    at: "2026-09-04T10:00:00.000Z",
    status: "FAILED",
    qualityPassed: false,
    inconclusive: true,
  });

  const left = evaluateCurrentSimulationHistoryGate(assessment(), [older, newer]);
  const right = evaluateCurrentSimulationHistoryGate(assessment(), [newer, older]);

  assert.deepEqual(left, right);
});
