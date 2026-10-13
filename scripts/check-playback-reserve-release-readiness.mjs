#!/usr/bin/env node
/**
 * FEATURE-PARITY-B1.5 — read-only release gate.
 * No Prisma, network, provider, filesystem mutations or secrets in output.
 * Usage:
 *   node --env-file=.env scripts/check-playback-reserve-release-readiness.mjs --baseline
 *   node --env-file=.env scripts/check-playback-reserve-release-readiness.mjs \
 *      --verify --expect-count=N --expect-hash=64_HEX --expect-runtime=ACTIVE
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MODES = new Set(["UNSET", "OFF", "SHADOW", "ACTIVE"]);
const VALID_HASH = /^[a-f0-9]{64}$/i;

function mode(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "UNSET";
  return String(value).trim().toUpperCase();
}

function ids(input) {
  return [...new Set((input ?? "").split(",").map(x => x.trim()).filter(Boolean))].sort();
}

export function inspectReleaseEnvironment(env, expected = null) {
  const globalMode = mode(env.PLAYBACK_RESERVE_RUNTIME_MODE);
  const productMode = mode(env.PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE);
  const simulationMode = mode(env.PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE);
  const legacyIds = ids(env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS);
  const legacyHash = createHash("sha256").update(legacyIds.join("\n")).digest("hex");
  const blockers = [];
  for (const [name, value] of [
    ["PLAYBACK_RESERVE_RUNTIME_MODE", globalMode],
    ["PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE", productMode],
    ["PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE", simulationMode],
  ]) {
    if (!MODES.has(value)) blockers.push(`${name}: invalid mode`);
  }
  if (productMode === "ACTIVE") blockers.push("New PRODUCT_OPT_IN rollout must remain OFF");
  if (simulationMode === "ACTIVE") blockers.push("New capability simulation rollout must remain OFF");

  if (expected) {
    if (!Number.isSafeInteger(expected.legacyCount) || expected.legacyCount < 0) {
      blockers.push("A nonnegative expected legacy pilot count is required");
    } else if (expected.legacyCount !== legacyIds.length) {
      blockers.push("Legacy pilot target count differs from baseline");
    }
    if (!VALID_HASH.test(expected.legacyHash ?? "")) {
      blockers.push("A valid baseline legacy pilot SHA-256 is required");
    } else if (expected.legacyHash.toLowerCase() !== legacyHash) {
      blockers.push("Legacy pilot target set differs from baseline");
    }
    if (!MODES.has(expected.runtimeMode ?? "") || globalMode !== expected.runtimeMode) {
      blockers.push("Global runtime mode differs from baseline");
    }
  }

  return {
    releaseStage: "DORMANT_CODE_ONLY",
    ready: blockers.length === 0,
    globalRuntimeMode: globalMode,
    productAuthorizationMode: productMode,
    capabilitySimulationMode: simulationMode,
    legacyPilot: { count: legacyIds.length, fingerprintSha256: legacyHash },
    blockers,
  };
}

function parse(argv) {
  const modes = argv.filter(v => v === "--baseline" || v === "--verify");
  if (modes.length !== 1) throw new Error("Choose exactly one: --baseline or --verify");
  if (modes[0] === "--baseline") {
    if (argv.length !== 1) throw new Error("--baseline accepts no extra arguments");
    return { command: "baseline", expected: null };
  }
  const obj = {};
  for (const arg of argv.filter(v => v !== "--verify")) {
    const match = /^--(expect-count|expect-hash|expect-runtime)=(.+)$/.exec(arg);
    if (!match) throw new Error("Invalid verification argument");
    if (obj[match[1]] !== undefined) throw new Error("Duplicate verification argument");
    obj[match[1]] = match[2];
  }
  if (Object.keys(obj).length !== 3 || !/^(0|[1-9][0-9]*)$/.test(obj["expect-count"] ?? "")) {
    throw new Error("Expected --expect-count=N --expect-hash=64_HEX --expect-runtime=MODE");
  }
  return {command: "verify", expected: {
    legacyCount: Number(obj["expect-count"]),
    legacyHash: obj["expect-hash"],
    runtimeMode: obj["expect-runtime"],
  }};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parse(process.argv.slice(2));
    const result = inspectReleaseEnvironment(process.env, args.expected);
    // Only modes, a count and a one-way hash — never raw allowlist IDs or secrets.
    process.stdout.write(JSON.stringify({command: args.command, ...result}, null, 2) + "\n");
    if (!result.ready) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Release gate: ${error.message}\n`);
    process.exitCode = 2;
  }
}
