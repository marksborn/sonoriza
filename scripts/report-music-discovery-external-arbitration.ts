import { spawnSync } from "node:child_process";

import {
  arbitrateExternalDiscoveryPaths,
  summarizeExternalDiscoveryPathConcentration,
  type ExternalDiscoveryPathArbitrationRejectionReason,
  type ExternalDiscoveryPathCandidate,
} from "@/services/music-discovery/external-discovery-arbitration";

type Args = {
  email: string;
  topN: number;
  maxPerPath: number;
  maxPerRoot: number;
  maxPerBridge: number;
  repeatPenaltyPerSelection: number;
  minimumAdjustedScore: number;
  json: boolean;
  gate5cArgs: string[];
};

type Gate5CPayload = {
  user: string;
  generatedAt: string;
  gate: string;
  mode: "READ_ONLY";
  acquisition: {
    totalProviderCalls: number;
    totalProviderFailures: number;
    combinedCandidateCount: number;
  };
  comparison: {
    diversified: {
      evaluatedCount: number;
      eligibleCount: number;
      newArtistCount: number;
      newTrackKnownArtistCount: number;
      knownTrackRejectedCount: number;
      knownArtistRejectedCount: number;
      uniqueArtistCount: number;
      knownShare: number;
      maxCandidatesForSingleArtist: number;
      depth2CandidateCount: number;
      depth2EligibleCount: number;
    };
  };
  eligible: ExternalDiscoveryPathCandidate[];
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const gate5c = runGate5C(args.gate5cArgs);
  const arbitration = arbitrateExternalDiscoveryPaths({
    candidates: gate5c.eligible,
    topN: args.topN,
    maxPerPath: args.maxPerPath,
    maxPerRoot: args.maxPerRoot,
    maxPerBridge: args.maxPerBridge,
    repeatPenaltyPerSelection: args.repeatPenaltyPerSelection,
    minimumAdjustedScore: args.minimumAdjustedScore,
  });

  const before = summarizeExternalDiscoveryPathConcentration(gate5c.eligible);
  const after = summarizeExternalDiscoveryPathConcentration(arbitration.selected);
  const rejectionCounts = countRejections(arbitration.rejected.map((row) => row.reason));

  const payload = {
    user: gate5c.user,
    generatedAt: new Date(),
    gate: "DISCOVERY-01 Gate 5D",
    mode: "READ_ONLY" as const,
    sourceGate: {
      gate: gate5c.gate,
      generatedAt: gate5c.generatedAt,
      totalProviderCalls: gate5c.acquisition.totalProviderCalls,
      totalProviderFailures: gate5c.acquisition.totalProviderFailures,
      combinedCandidateCount: gate5c.acquisition.combinedCandidateCount,
      diversifiedMetrics: gate5c.comparison.diversified,
      eligibleCount: gate5c.eligible.length,
    },
    arbitration: {
      policy: arbitration.policy,
      selectedCount: arbitration.selected.length,
      rejectedEligibleCount: arbitration.rejected.length,
      rejectionCounts,
      concentrationBefore: before,
      concentrationAfter: after,
      selected: arbitration.selected,
      rejected: arbitration.rejected,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 5D PATH ARBITRATION READ-ONLY ==========");
  console.log(`User:                         ${payload.user}`);
  console.log(`Last.fm calls (Gate 5C):      ${payload.sourceGate.totalProviderCalls}`);
  console.log(`Provider failures:            ${payload.sourceGate.totalProviderFailures}`);
  console.log(`Combined candidates:          ${payload.sourceGate.combinedCandidateCount}`);
  console.log(`Gate 5C eligible before:      ${gate5c.eligible.length}`);
  console.log(`Gate 5D selected:             ${arbitration.selected.length}`);
  console.log(`Rejected eligible:            ${arbitration.rejected.length}`);
  console.log("");
  console.log("Policy:");
  console.log(`  Max per root→bridge path:   ${arbitration.policy.maxPerPath}`);
  console.log(`  Max per root:               ${arbitration.policy.maxPerRoot}`);
  console.log(`  Max per bridge:             ${arbitration.policy.maxPerBridge}`);
  console.log(
    `  Repeat path penalty:       ${(arbitration.policy.repeatPenaltyPerSelection * 100).toFixed(1)}% per prior selected candidate`,
  );
  console.log(`  Minimum adjusted score:     ${arbitration.policy.minimumAdjustedScore}`);
  console.log(`  Top N ceiling:              ${arbitration.policy.topN}`);
  console.log("");
  console.log("Concentration before arbitration:");
  printConcentration(before);
  console.log("");
  console.log("Concentration after arbitration:");
  printConcentration(after);
  console.log("");
  console.log("Rejected eligible by reason:");
  for (const reason of rejectionReasonOrder) {
    console.log(`  ${reason.padEnd(31)} ${rejectionCounts[reason]}`);
  }
  console.log("");
  console.log("Selected DESCOBERTA candidates:");
  if (arbitration.selected.length === 0) console.log("  (none / arbitration abstained)");
  arbitration.selected.forEach((row, index) => {
    const subject = row.trackName ? `${row.artistName} — ${row.trackName}` : row.artistName;
    console.log(
      `  ${String(index + 1).padStart(2)}. ${subject} — class=${row.historyClass}, depth=${row.acquisitionDepth}, raw=${row.scoreCard.score}, adjusted=${row.arbitrationAdjustedScore}, pathIndex=${row.pathSelectionIndex}, path=${row.pathLabel}`,
    );
  });
  console.log("");
  console.log("Rejected candidates that were eligible before arbitration:");
  if (arbitration.rejected.length === 0) console.log("  (none)");
  arbitration.rejected.slice(0, 30).forEach((row, index) => {
    const candidate = row.candidate;
    const subject = candidate.trackName
      ? `${candidate.artistName} — ${candidate.trackName}`
      : candidate.artistName;
    console.log(
      `  ${String(index + 1).padStart(2)}. ${subject} — reason=${row.reason}, raw=${candidate.scoreCard.score}, adjusted=${row.arbitrationAdjustedScore}, pathIndex=${row.pathSelectionIndex}, path=${row.pathLabel}`,
    );
  });
  console.log("");
  console.log("No writes: no Spotify, MUSIC-03, preference, score persistence or planner changes.");
}

function runGate5C(args: string[]): Gate5CPayload {
  const command = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const result = spawnSync(
    command,
    ["scripts/report-music-discovery-external-diversity.ts", ...args, "--json"],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`Gate 5C source report failed: ${detail}`);
  }

  try {
    return JSON.parse(result.stdout) as Gate5CPayload;
  } catch (error) {
    throw new Error(
      `Gate 5C source report did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function printConcentration(summary: ReturnType<typeof summarizeExternalDiscoveryPathConcentration>) {
  console.log(`  Total:                       ${summary.total}`);
  console.log(`  Unique roots:                ${summary.uniqueRoots}`);
  console.log(`  Unique bridges:              ${summary.uniqueBridges}`);
  console.log(`  Unique paths:                ${summary.uniquePaths}`);
  console.log(`  Max root share:              ${(summary.maxRootShare * 100).toFixed(1)}%`);
  console.log(`  Max bridge share:            ${(summary.maxBridgeShare * 100).toFixed(1)}%`);
  console.log(`  Max path share:              ${(summary.maxPathShare * 100).toFixed(1)}%`);
  printTopEntries("roots", summary.roots);
  printTopEntries("bridges", summary.bridges);
  printTopEntries("paths", summary.paths);
}

function printTopEntries(
  label: string,
  rows: Array<{ label: string; count: number; share: number }>,
): void {
  if (rows.length === 0) return;
  console.log(`  Top ${label}:`);
  rows.slice(0, 5).forEach((row) => {
    console.log(`    ${row.label}: ${row.count} (${(row.share * 100).toFixed(1)}%)`);
  });
}

const rejectionReasonOrder: ExternalDiscoveryPathArbitrationRejectionReason[] = [
  "PATH_CAP",
  "ROOT_CAP",
  "BRIDGE_CAP",
  "ADJUSTED_SCORE_BELOW_MINIMUM",
  "TOP_N",
];

function countRejections(
  reasons: ExternalDiscoveryPathArbitrationRejectionReason[],
): Record<ExternalDiscoveryPathArbitrationRejectionReason, number> {
  const counts: Record<ExternalDiscoveryPathArbitrationRejectionReason, number> = {
    PATH_CAP: 0,
    ROOT_CAP: 0,
    BRIDGE_CAP: 0,
    ADJUSTED_SCORE_BELOW_MINIMUM: 0,
    TOP_N: 0,
  };
  for (const reason of reasons) counts[reason] += 1;
  return counts;
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let topN = 30;
  let maxPerPath = 2;
  let maxPerRoot = 3;
  let maxPerBridge = 2;
  let repeatPenaltyPerSelection = 0.07;
  let minimumAdjustedScore = 55;
  let json = false;
  const gate5cArgs: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      gate5cArgs.push(arg);
    } else if (arg.startsWith("--top=")) {
      topN = boundedIntArg(arg, "--top=", 1, 100);
      gate5cArgs.push(arg);
    } else if (arg.startsWith("--path-cap=")) {
      maxPerPath = boundedIntArg(arg, "--path-cap=", 1, 20);
    } else if (arg.startsWith("--root-cap=")) {
      maxPerRoot = boundedIntArg(arg, "--root-cap=", 1, 20);
    } else if (arg.startsWith("--bridge-cap=")) {
      maxPerBridge = boundedIntArg(arg, "--bridge-cap=", 1, 20);
    } else if (arg.startsWith("--repeat-penalty=")) {
      repeatPenaltyPerSelection = boundedNumberArg(arg, "--repeat-penalty=", 0, 1);
    } else if (arg.startsWith("--min-adjusted-score=")) {
      minimumAdjustedScore = boundedNumberArg(arg, "--min-adjusted-score=", 0, 100);
    } else if (arg === "--json") {
      json = true;
    } else {
      gate5cArgs.push(arg);
    }
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return {
    email,
    topN,
    maxPerPath,
    maxPerRoot,
    maxPerBridge,
    repeatPenaltyPerSelection,
    minimumAdjustedScore,
    json,
    gate5cArgs,
  };
}

function boundedIntArg(arg: string, prefix: string, min: number, max: number): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boundedNumberArg(arg: string, prefix: string, min: number, max: number): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} must be between ${min} and ${max}`);
  }
  return value;
}

main();
