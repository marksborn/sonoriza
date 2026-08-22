import assert from "node:assert/strict";
import test from "node:test";

import { createDiscoveryGate4ARunState } from "./discovery-runtime";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Gate 5H requires the existing discovery runtime plus its own flag and allowlist", () => {
  withEnv(
    {
      DISCOVERY_RUNTIME_ENABLED: "true",
      DISCOVERY_RUNTIME_USER_EMAILS: "user@example.com",
      DISCOVERY_GATE5H_ENABLED: "true",
      DISCOVERY_GATE5H_USER_EMAILS: "user@example.com",
    },
    () => {
      const state = createDiscoveryGate4ARunState({
        userId: "user-1",
        userEmail: "USER@example.com",
        asOf: new Date("2026-08-22T12:00:00.000Z"),
      });
      assert.equal(state.enabled, true);
      assert.equal(state.gate5h.enabled, true);
      assert.equal(state.gate5h.reason, "ENABLED");
    },
  );
});

test("Gate 5H stays disabled when its own rollout flag is off", () => {
  withEnv(
    {
      DISCOVERY_RUNTIME_ENABLED: "true",
      DISCOVERY_RUNTIME_USER_EMAILS: "user@example.com",
      DISCOVERY_GATE5H_ENABLED: "false",
      DISCOVERY_GATE5H_USER_EMAILS: "user@example.com",
    },
    () => {
      const state = createDiscoveryGate4ARunState({
        userId: "user-1",
        userEmail: "user@example.com",
        asOf: new Date("2026-08-22T12:00:00.000Z"),
      });
      assert.equal(state.enabled, true);
      assert.equal(state.gate5h.enabled, false);
      assert.equal(state.gate5h.reason, "MASTER_DISABLED");
    },
  );
});
