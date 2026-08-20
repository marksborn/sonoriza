import { readFile, writeFile } from "node:fs/promises";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  readSpotifyExtendedHistoryPackage,
  type SpotifyExtendedHistoryPackage,
} from "@/services/spotify-extended-history/parser";
import {
  buildSpotifyExtendedPersistenceManifest,
  parseSpotifyExtendedPersistenceManifest,
  type SpotifyExtendedPersistenceManifest,
} from "@/services/spotify-extended-history/persistence-manifest";
import {
  buildSpotifyExtendedPersistencePlan,
  type SpotifyExtendedPersistencePlan,
} from "@/services/spotify-extended-history/persistence-plan";
import { applySpotifyExtendedHistory } from "@/services/spotify-extended-history/persistence-writer";
import {
  AMBIGUOUS_MATCH_TOLERANCE_MS,
  reconcileSpotifyExtendedHistory,
  summarizeAbsoluteDeltas,
  type ExistingListeningEvent,
  type SpotifyExtendedReconciliation,
} from "@/services/spotify-extended-history/reconcile";

const APPLY_CONFIRMATION = "HISTORY-02-APPLY";

type Args = {
  file: string;
  email: string;
  samples: number;
  planOut: string | null;
  apply: boolean;
  planFile: string | null;
  expectedPackageSha256: string | null;
  expectedPlanHash: string | null;
  expectedManifestHash: string | null;
  confirm: string | null;
};

type Snapshot = {
  user: { id: string; email: string | null };
  existingEvents: ExistingListeningEvent[];
  reconciliation: SpotifyExtendedReconciliation;
};

type ManifestPostcheck = {
  requiredActions: number;
  satisfiedActions: number;
  driftQuarantinedActions: number;
  pendingActions: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("========== HISTORY-02 — SPOTIFY EXTENDED HISTORY ==========");
  console.log(`Mode:                 ${args.apply ? "APPLY / FROZEN MANIFEST" : "DRY-RUN / READ-ONLY"}`);
  console.log(`Package:              ${args.file}`);

  const parsed = await readSpotifyExtendedHistoryPackage(args.file);
  printPackageSummary(parsed);

  if (args.apply && parsed.invalidMusicRecords.length > 0) {
    throw new Error("HISTORY-02 apply refuses a package with invalid music records");
  }

  const before = await readSnapshot(args.email, parsed);
  printSnapshot(before);
  printReconciliation(before.reconciliation);

  const livePlan = buildSpotifyExtendedPersistencePlan(
    parsed.archiveSha256,
    before.reconciliation,
  );

  if (!args.apply) {
    await finishDryRun(args, parsed, before, livePlan);
    return;
  }

  await runApply(args, parsed, before, livePlan);
}

async function finishDryRun(
  args: Args,
  parsed: SpotifyExtendedHistoryPackage,
  snapshot: Snapshot,
  plan: SpotifyExtendedPersistencePlan,
): Promise<void> {
  printPlan(plan, false);

  if (args.planOut) {
    const manifest = buildSpotifyExtendedPersistenceManifest(snapshot.user.id, plan);
    await writeFile(
      args.planOut,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    console.log("");
    console.log("========== FROZEN MANIFEST ==========");
    console.log(`Manifest file:         ${args.planOut}`);
    console.log(`Manifest hash:         ${manifest.manifestHash}`);
    console.log(`Bound user id:         ${manifest.userId}`);
    console.log("File mode requested:   0600");
  }

  printSamples(args.samples, snapshot.reconciliation);

  console.log("");
  console.log("DRY-RUN COMPLETE: nenhuma linha do banco foi alterada.");
  console.log("Nenhuma chamada ou escrita Spotify foi executada.");
  console.log(`Pacote verificado: ${parsed.archiveSha256}`);
  console.log("Apply não foi executado.");
}

async function runApply(
  args: Args,
  parsed: SpotifyExtendedHistoryPackage,
  before: Snapshot,
  livePlan: SpotifyExtendedPersistencePlan,
): Promise<void> {
  assertApplyArgs(args);

  const manifest = await readManifest(args.planFile!);
  if (manifest.userId !== before.user.id) {
    throw new Error("HISTORY-02 manifest is bound to a different Sonoriza user");
  }
  if (parsed.archiveSha256 !== args.expectedPackageSha256) {
    throw new Error("HISTORY-02 package SHA differs from the explicitly expected SHA");
  }
  if (manifest.packageSha256 !== args.expectedPackageSha256) {
    throw new Error("HISTORY-02 manifest package SHA differs from the explicitly expected SHA");
  }
  if (manifest.planHash !== args.expectedPlanHash) {
    throw new Error("HISTORY-02 manifest plan hash differs from the explicitly expected plan hash");
  }
  if (manifest.manifestHash !== args.expectedManifestHash) {
    throw new Error("HISTORY-02 manifest hash differs from the explicitly expected manifest hash");
  }

  const priorAttempts = await countPriorAttempts(
    before.user.id,
    manifest.packageSha256,
    manifest.planHash,
  );
  const livePlanMatchesManifest = livePlan.planHash === manifest.planHash;

  console.log("");
  console.log("========== APPLY GATE ==========");
  console.log(`Expected package SHA:  ${args.expectedPackageSha256}`);
  console.log(`Expected plan hash:    ${args.expectedPlanHash}`);
  console.log(`Expected manifest:     ${args.expectedManifestHash}`);
  console.log(`Current live plan:     ${livePlan.planHash}`);
  console.log(`Live plan unchanged:   ${livePlanMatchesManifest ? "SIM" : "NÃO — DRIFT-SAFE MODE"}`);
  console.log(`Prior attempts:        ${priorAttempts}`);
  console.log(`Execution mode:        ${priorAttempts === 0 ? "FIRST APPLY" : "RESUME / IDEMPOTENT REPLAY"}`);
  console.log(`Confirmation:          ${APPLY_CONFIRMATION}`);
  console.log("Spotify writes:        NÃO");
  console.log("Playlist generation:   NÃO");
  console.log("TrackListeningState:   NÃO ALTERAR");
  console.log("Frozen quarantine:     NUNCA PROMOVIDA AUTOMATICAMENTE");
  console.log("Stale INSERT_NEW:      REVALIDADO SOB LOCK; pode virar NOOP");

  const result = await applySpotifyExtendedHistory({
    userId: before.user.id,
    packageSha256: parsed.archiveSha256,
    expectedPackageSha256: args.expectedPackageSha256!,
    expectedPlanHash: args.expectedPlanHash!,
    expectedManifestHash: args.expectedManifestHash!,
    manifest,
    musicEvents: parsed.musicEvents,
    client: prisma,
  });

  console.log("");
  console.log("========== APPLY RESULT ==========");
  console.log(`Audit run:             ${result.runId}`);
  console.log(`Inserted events:       ${result.insertedEvents}`);
  console.log(`Enriched events:       ${result.enrichedEvents}`);
  console.log(`Guarded/no-op inserts: ${result.duplicateEvents}`);
  console.log(`No-op enrichment:      ${result.noopEvents}`);
  console.log(`Frozen quarantine:     ${result.quarantinedEvents}`);

  const after = await readSnapshot(args.email, parsed);
  console.log("");
  console.log("========== POSTCHECK ==========");
  printSnapshot(after);
  printReconciliation(after.reconciliation);
  const afterPlan = buildSpotifyExtendedPersistencePlan(parsed.archiveSha256, after.reconciliation);
  printPlan(afterPlan, true);

  const manifestPostcheck = assessManifestPostcheck(manifest, afterPlan);
  console.log("");
  console.log("========== FROZEN MANIFEST POSTCHECK ==========");
  console.log(`Required actions:      ${manifestPostcheck.requiredActions}`);
  console.log(`Satisfied actions:     ${manifestPostcheck.satisfiedActions}`);
  console.log(`Drift quarantined:     ${manifestPostcheck.driftQuarantinedActions}`);
  console.log(`Pending frozen work:   ${manifestPostcheck.pendingActions}`);

  if (manifestPostcheck.pendingActions !== 0) {
    throw new Error(
      `HISTORY-02 frozen manifest postcheck incomplete: pending=${manifestPostcheck.pendingActions}`,
    );
  }

  console.log("");
  console.log("APPLY COMPLETE: todas as ações ainda seguras do manifesto congelado convergiram.");
  console.log("Ações que sofreram drift foram mantidas sem escrita automática e podem ser reavaliadas em novo dry-run.");
  console.log("Conflitos congelados permanecem em quarentena.");
  console.log("Nenhuma escrita Spotify ou geração de playlist foi executada.");
}

async function readSnapshot(
  email: string,
  parsed: SpotifyExtendedHistoryPackage,
): Promise<Snapshot> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const user = await tx.user.findUnique({
        where: { email },
        select: { id: true, email: true },
      });
      if (!user) throw new Error(`Sonoriza user not found for ${email}`);

      const lowerBound = parsed.musicEvents.reduce<Date | null>(
        (current, event) =>
          current === null || event.estimatedStartedAt < current ? event.estimatedStartedAt : current,
        null,
      );
      const upperBound = parsed.latestEndedAt;
      if (!lowerBound || !upperBound) throw new Error("Spotify package contains no valid music events");

      const from = new Date(lowerBound.getTime() - AMBIGUOUS_MATCH_TOLERANCE_MS);
      const to = new Date(upperBound.getTime() + AMBIGUOUS_MATCH_TOLERANCE_MS);

      // Raw SQL is deliberate: the dry-run must work before the migration adds
      // SPOTIFY_EXTENDED_HISTORY to the generated Prisma enum.
      const existingEvents = await tx.$queryRaw<ExistingListeningEvent[]>(Prisma.sql`
        SELECT
          "id",
          "spotifyTrackId",
          "trackName",
          "artistName",
          "playedAt",
          "source"::text AS "source",
          "sourceEventKey",
          "metadata"
        FROM "TrackListeningEvent"
        WHERE "userId" = ${user.id}
          AND "playedAt" >= ${from}
          AND "playedAt" <= ${to}
          AND "source"::text IN (
            'LASTFM_SCROBBLE',
            'SPOTIFY_RECENTLY_PLAYED',
            'SPOTIFY_EXTENDED_HISTORY'
          )
      `);

      return {
        user,
        existingEvents,
        reconciliation: reconcileSpotifyExtendedHistory(parsed.musicEvents, existingEvents),
      };
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

async function readManifest(path: string): Promise<SpotifyExtendedPersistenceManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`HISTORY-02 could not read manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSpotifyExtendedPersistenceManifest(parsed);
}

async function countPriorAttempts(
  userId: string,
  packageSha256: string,
  planHash: string,
): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM "SpotifyExtendedHistoryImportRun"
      WHERE "userId" = ${userId}
        AND "packageSha256" = ${packageSha256}
        AND "planHash" = ${planHash}
    `);
    return Number(rows[0]?.count ?? 0n);
  } catch (error) {
    throw new Error(
      `HISTORY-02 apply requires its database migration before execution: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assessManifestPostcheck(
  manifest: SpotifyExtendedPersistenceManifest,
  afterPlan: SpotifyExtendedPersistencePlan,
): ManifestPostcheck {
  const currentBySourceKey = new Map(
    afterPlan.actions.map((action) => [action.sourceEventKey, action] as const),
  );

  let requiredActions = 0;
  let satisfiedActions = 0;
  let driftQuarantinedActions = 0;
  let pendingActions = 0;

  for (const frozen of manifest.actions) {
    if (frozen.kind !== "INSERT_NEW" && frozen.kind !== "ENRICH_EXISTING") continue;
    requiredActions += 1;

    const current = currentBySourceKey.get(frozen.sourceEventKey);
    if (!current) {
      pendingActions += 1;
      continue;
    }

    if (frozen.kind === "INSERT_NEW") {
      if (current.kind === "INSERT_NEW") {
        pendingActions += 1;
      } else if (current.kind === "NOOP_ALREADY_ENRICHED") {
        satisfiedActions += 1;
      } else {
        // A candidate appeared after the manifest, or this event is now
        // ambiguous. The guarded writer must not force the stale insert.
        driftQuarantinedActions += 1;
      }
      continue;
    }

    if (
      current.kind === "ENRICH_EXISTING"
      && current.existingEventId === frozen.existingEventId
    ) {
      pendingActions += 1;
    } else if (current.kind === "NOOP_ALREADY_ENRICHED") {
      satisfiedActions += 1;
    } else {
      // The original enrichment target disappeared/changed or became
      // ambiguous/new. Never retarget a frozen enrichment silently.
      driftQuarantinedActions += 1;
    }
  }

  return {
    requiredActions,
    satisfiedActions,
    driftQuarantinedActions,
    pendingActions,
  };
}

function printSnapshot(snapshot: Snapshot): void {
  console.log("");
  console.log("========== CANONICAL HISTORY SNAPSHOT ==========");
  console.log(`Sonoriza user:         ${snapshot.user.email ?? snapshot.user.id}`);
  console.log(`Existing events read:  ${snapshot.existingEvents.length}`);
  console.log(`Existing Last.fm:      ${snapshot.existingEvents.filter((event) => event.source === "LASTFM_SCROBBLE").length}`);
  console.log(`Existing Recently:     ${snapshot.existingEvents.filter((event) => event.source === "SPOTIFY_RECENTLY_PLAYED").length}`);
  console.log(`Existing Extended:     ${snapshot.existingEvents.filter((event) => event.source === "SPOTIFY_EXTENDED_HISTORY").length}`);
}

function printReconciliation(result: SpotifyExtendedReconciliation): void {
  const summary = result.summary;
  console.log("");
  console.log("========== RECONCILIATION ==========");
  console.log(`Unique music events:   ${summary.totalUniqueExportEvents}`);
  console.log(`EXACT Last.fm:         ${summary.exactExistingLastFm}`);
  console.log(`EXACT Recently Played: ${summary.exactExistingRecentlyPlayed}`);
  console.log(`EXACT Extended:        ${summary.exactExistingExtendedHistory}`);
  console.log(`NEW uncovered:         ${summary.newUncoveredEvents}`);
  console.log(`CONFLICT/ambiguous:    ${summary.conflictAmbiguous}`);
  console.log(`Enrichment candidates: ${summary.enrichmentCandidates}`);
  console.log(`Estimated inserts:     ${summary.estimatedInserts}`);

  printDeltaSummary("Last.fm start delta", summarizeAbsoluteDeltas(summary.lastFmMatchDeltaMs));
  printDeltaSummary("Recently start delta", summarizeAbsoluteDeltas(summary.recentlyPlayedMatchDeltaMs));

  console.log("");
  console.log("========== CONFLICT DIAGNOSTICS ==========");
  console.log(`MULTIPLE_CONFIDENT_LASTFM:  ${summary.conflictReasonCounts.MULTIPLE_CONFIDENT_LASTFM}`);
  console.log(`MULTIPLE_CONFIDENT_SPOTIFY: ${summary.conflictReasonCounts.MULTIPLE_CONFIDENT_SPOTIFY}`);
  console.log(`CONFIDENT_CROSS_SOURCE:     ${summary.conflictReasonCounts.CONFIDENT_CROSS_SOURCE}`);
  console.log(`NEAR_ONLY_LASTFM:           ${summary.conflictReasonCounts.NEAR_ONLY_LASTFM}`);
  console.log(`NEAR_ONLY_SPOTIFY:          ${summary.conflictReasonCounts.NEAR_ONLY_SPOTIFY}`);
  console.log(`NEAR_CROSS_SOURCE:          ${summary.conflictReasonCounts.NEAR_CROSS_SOURCE}`);
  console.log("Candidate count buckets:");
  console.log(`  1:                       ${summary.conflictCandidateCountBuckets.one}`);
  console.log(`  2:                       ${summary.conflictCandidateCountBuckets.two}`);
  console.log(`  3:                       ${summary.conflictCandidateCountBuckets.three}`);
  console.log(`  4:                       ${summary.conflictCandidateCountBuckets.four}`);
  console.log(`  5+:                      ${summary.conflictCandidateCountBuckets.fiveOrMore}`);
  printDeltaSummary("Conflict nearest delta", summarizeAbsoluteDeltas(summary.conflictNearestDeltaMs));
}

function printPlan(
  plan: SpotifyExtendedPersistencePlan,
  postcheck: boolean,
): void {
  console.log("");
  console.log(`========== ${postcheck ? "POSTCHECK PLAN" : "PERSISTENCE PLAN — FROZEN / READ-ONLY"} ==========`);
  console.log(`Plan version:           ${plan.version}`);
  console.log(`Plan hash:              ${plan.planHash}`);
  console.log(`INSERT_NEW:             ${plan.summary.insertNew}`);
  console.log(`ENRICH_EXISTING:        ${plan.summary.enrichExisting}`);
  console.log(`QUARANTINE_CONFLICT:    ${plan.summary.quarantineConflict}`);
  console.log(`NOOP_ALREADY_ENRICHED:  ${plan.summary.noopAlreadyEnriched}`);
}

function printSamples(samplesCount: number, result: SpotifyExtendedReconciliation): void {
  if (samplesCount <= 0) return;

  console.log("");
  console.log("========== LOCAL DIAGNOSTIC SAMPLES ==========");
  const samples = result.entries
    .filter((entry) => entry.classification === "NEW_UNCOVERED_EVENT" || entry.classification === "CONFLICT_AMBIGUOUS")
    .slice(0, samplesCount);
  for (const entry of samples) {
    console.log([
      entry.classification,
      entry.event.estimatedStartedAt.toISOString(),
      entry.event.artistName,
      entry.event.trackName,
      entry.event.spotifyTrackUri,
      `candidates=${entry.candidateCount}`,
      `reason=${entry.conflictReason ?? "n/a"}`,
      `nearest=${entry.nearestCandidateDeltaMs === null ? "n/a" : `${Math.round(entry.nearestCandidateDeltaMs / 1000)}s`}`,
    ].join(" | "));
  }
}

function printPackageSummary(parsed: SpotifyExtendedHistoryPackage): void {
  console.log("");
  console.log("========== PACKAGE ==========");
  console.log(`SHA-256:              ${parsed.archiveSha256}`);
  console.log(`Archive bytes:        ${parsed.archiveBytes}`);
  console.log(`Audio JSON files:     ${parsed.audioFileCount}`);
  console.log(`Video JSON files:     ${parsed.videoFileCount}`);
  console.log(`Audio records:        ${parsed.audioRecordCount}`);
  console.log(`Video records:        ${parsed.videoRecordCount}`);
  console.log(`Music records:        ${parsed.musicRecordCount}`);
  console.log(`Unique music events:  ${parsed.uniqueMusicEventCount}`);
  console.log(`Duplicate groups:     ${parsed.duplicateMusicGroupCount}`);
  console.log(`Duplicate occurrences:${parsed.duplicateMusicOccurrenceCount}`);
  console.log(`Podcast records:      ${parsed.podcastRecordCount}`);
  console.log(`Audiobook records:    ${parsed.audiobookRecordCount}`);
  console.log(`Other audio records:  ${parsed.otherAudioRecordCount}`);
  console.log(`Invalid music records:${parsed.invalidMusicRecords.length}`);
  console.log(`First music stop:     ${parsed.earliestEndedAt?.toISOString() ?? "n/a"}`);
  console.log(`Last music stop:      ${parsed.latestEndedAt?.toISOString() ?? "n/a"}`);
}

function printDeltaSummary(
  label: string,
  summary: { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null },
): void {
  const format = (value: number | null) => value === null ? "n/a" : `${Math.round(value / 1000)}s`;
  console.log(`${label}: count=${summary.count} p50=${format(summary.p50Ms)} p95=${format(summary.p95Ms)} max=${format(summary.maxMs)}`);
}

function assertApplyArgs(args: Args): void {
  if (!args.planFile) throw new Error("--apply requires --plan-file=<frozen manifest>");
  if (!isSha256(args.expectedPackageSha256)) {
    throw new Error("--apply requires --expected-package-sha=<64 hex chars>");
  }
  if (!isSha256(args.expectedPlanHash)) {
    throw new Error("--apply requires --expected-plan-hash=<64 hex chars>");
  }
  if (!isSha256(args.expectedManifestHash)) {
    throw new Error("--apply requires --expected-manifest-hash=<64 hex chars>");
  }
  if (args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm=${APPLY_CONFIRMATION}`);
  }
  if (args.planOut) throw new Error("--plan-out is dry-run only");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: "",
    email: "",
    samples: 0,
    planOut: null,
    apply: false,
    planFile: null,
    expectedPackageSha256: null,
    expectedPlanHash: null,
    expectedManifestHash: null,
    confirm: null,
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg.startsWith("--file=")) {
      args.file = arg.slice("--file=".length).trim();
      continue;
    }
    if (arg.startsWith("--email=")) {
      args.email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg.startsWith("--samples=")) {
      const samples = Number(arg.slice("--samples=".length));
      if (!Number.isInteger(samples) || samples < 0 || samples > 100) {
        throw new Error("--samples must be an integer between 0 and 100");
      }
      args.samples = samples;
      continue;
    }
    if (arg.startsWith("--plan-out=")) {
      args.planOut = arg.slice("--plan-out=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--plan-file=")) {
      args.planFile = arg.slice("--plan-file=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--expected-package-sha=")) {
      args.expectedPackageSha256 = arg.slice("--expected-package-sha=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--expected-plan-hash=")) {
      args.expectedPlanHash = arg.slice("--expected-plan-hash=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--expected-manifest-hash=")) {
      args.expectedManifestHash = arg.slice("--expected-manifest-hash=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--confirm=")) {
      args.confirm = arg.slice("--confirm=".length).trim() || null;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.file) throw new Error("--file=<Spotify Extended History ZIP> is required");
  if (!args.email) throw new Error("--email=<Sonoriza user email> is required");
  if (!args.apply && args.planFile) throw new Error("--plan-file is apply-only");
  if (!args.apply && (args.expectedPackageSha256 || args.expectedPlanHash || args.expectedManifestHash || args.confirm)) {
    throw new Error("expected hashes and --confirm are apply-only");
  }
  return args;
}

function isSha256(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{64}$/.test(value);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });