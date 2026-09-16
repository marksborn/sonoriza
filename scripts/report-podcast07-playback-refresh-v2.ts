import { prisma } from "../src/lib/prisma";
import {
  evaluatePodcastShowCadenceShadow,
  type PodcastCadenceEvidence,
} from "../src/services/spotify/podcast-show-cadence-shadow";

const DEFAULT_AFTER = new Date("2026-09-14T23:14:42.000Z");
const DEFAULT_TIME_ZONE = "America/Sao_Paulo";
const DEFAULT_MAX_RUNS = 50;

type JsonObject = Record<string, unknown>;

type RefreshTelemetry = {
  selectedEpisodeIds: string[];
  selectedByShowId: Record<string, string[]>;
  eligibleEpisodeCount: number | null;
  eligibleShowCount: number | null;
  selectedEpisodeCount: number | null;
  selectedShowCount: number | null;
  refreshedEpisodeCount: number | null;
  completedFoundCount: number | null;
  skippedByBudgetCount: number | null;
};

async function main(): Promise<void> {
  const email = requiredArg("email");
  const episodeId = requiredArg("episode-id");
  const showId = requiredArg("show-id");
  const after = dateArg("after") ?? DEFAULT_AFTER;
  const asOf = dateArg("as-of") ?? new Date();
  const timeZone = optionalArg("time-zone") ?? DEFAULT_TIME_ZONE;
  const maxRuns = positiveIntegerArg("max-runs") ?? DEFAULT_MAX_RUNS;

  const snapshot = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const readOnly = await tx.$queryRaw<Array<{ read_only: string }>>`
        SELECT current_setting('transaction_read_only') AS read_only
      `;
      if (readOnly[0]?.read_only !== "on") {
        throw new Error(
          "PODCAST-07 #350 probe refused to run without READ ONLY transaction",
        );
      }

      const user = await tx.user.findUnique({
        where: { email },
        select: { id: true, email: true },
      });
      if (!user) throw new Error(`Sonoriza user not found: ${email}`);

      const [targetState, showStates, runs] = await Promise.all([
        tx.episodeListeningState.findUnique({
          where: {
            userId_spotifyEpisodeId: {
              userId: user.id,
              spotifyEpisodeId: episodeId,
            },
          },
          select: {
            spotifyEpisodeId: true,
            spotifyShowId: true,
            spotifyUri: true,
            status: true,
            fullyPlayed: true,
            resumePositionMs: true,
            firstProgressObservedAt: true,
            lastObservedAt: true,
            updatedAt: true,
          },
        }),
        tx.episodeListeningState.findMany({
          where: { userId: user.id, spotifyShowId: showId },
          orderBy: { lastObservedAt: "desc" },
          select: {
            spotifyEpisodeId: true,
            spotifyShowId: true,
            status: true,
            fullyPlayed: true,
            firstProgressObservedAt: true,
            lastObservedAt: true,
          },
        }),
        tx.generationRun.findMany({
          where: {
            userId: user.id,
            startedAt: { gte: after, lte: asOf },
            status: { in: ["SUCCESS", "PARTIAL"] },
          },
          orderBy: { startedAt: "desc" },
          take: maxRuns,
          select: {
            id: true,
            trigger: true,
            simulation: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            summary: true,
          },
        }),
      ]);

      return {
        user,
        targetState,
        showStates,
        runs,
        transactionReadOnly: readOnly[0]?.read_only ?? "unknown",
      };
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: 10_000,
      timeout: 30_000,
    },
  );

  const evidence: PodcastCadenceEvidence[] = snapshot.showStates.map((state) => ({
    spotifyEpisodeId: state.spotifyEpisodeId,
    spotifyShowId: state.spotifyShowId,
    status: state.status,
    firstProgressObservedAt: state.firstProgressObservedAt,
  }));
  const cadence = evaluatePodcastShowCadenceShadow({
    evidence,
    showId,
    maxEpisodes: 1,
    unit: "WEEK",
    timeZone,
    asOf,
  });

  const runEvidence = snapshot.runs.flatMap((run) => {
    const refresh = extractRefreshTelemetry(run.summary);
    if (!refresh) return [];
    return [{ run, refresh }];
  });
  const targetRefreshRuns = runEvidence.filter(({ refresh }) =>
    refresh.selectedEpisodeIds.includes(episodeId),
  );
  const latestRefreshRun = targetRefreshRuns[0] ?? null;

  const canonicalCompleted =
    snapshot.targetState?.status === "COMPLETED" &&
    snapshot.targetState.fullyPlayed === true;
  const targetWasSelectedByV2 = latestRefreshRun !== null;
  const cadenceConsumesTarget = cadence.consumedEpisodeIds.includes(episodeId);
  const cadenceBlocksNewEpisode =
    cadence.limitReached && cadence.newEpisodeAllowedByCadence === false;

  let verdict = "PASS";
  if (!targetWasSelectedByV2) {
    verdict = canonicalCompleted
      ? "PARTIAL_COMPLETED_WITHOUT_V2_SELECTION_TELEMETRY"
      : "PENDING_TARGET_NOT_SELECTED_BY_V2_YET";
  } else if (!canonicalCompleted) {
    verdict = "FAIL_SELECTED_BUT_CANONICAL_STATE_NOT_COMPLETED";
  } else if (!cadenceConsumesTarget || !cadenceBlocksNewEpisode) {
    verdict = "FAIL_COMPLETED_BUT_WEEKLY_CADENCE_NOT_CONSUMED";
  }

  console.log("========== PODCAST-07 #350 — PLAYBACK REFRESH V2 ==========");
  console.log(`Verdict:                       ${verdict}`);
  console.log(`User:                          ${snapshot.user.email}`);
  console.log(`Episode ID:                    ${episodeId}`);
  console.log(`Show ID:                       ${showId}`);
  console.log(`After:                         ${after.toISOString()}`);
  console.log(`As of:                         ${asOf.toISOString()}`);
  console.log(`Transaction read only:         ${snapshot.transactionReadOnly}`);
  console.log("Spotify API calls:             NONE");
  console.log("Spotify writes:                NONE");
  console.log("Database writes:               NONE");
  console.log();

  console.log("---------- CANONICAL EPISODE STATE ----------");
  if (!snapshot.targetState) {
    console.log("state                          MISSING");
  } else {
    console.log(`status                         ${snapshot.targetState.status}`);
    console.log(`fullyPlayed                    ${snapshot.targetState.fullyPlayed}`);
    console.log(`resumePositionMs               ${snapshot.targetState.resumePositionMs}`);
    console.log(
      `firstProgressObservedAt        ${snapshot.targetState.firstProgressObservedAt?.toISOString() ?? "null"}`,
    );
    console.log(
      `lastObservedAt                 ${snapshot.targetState.lastObservedAt.toISOString()}`,
    );
    console.log(`updatedAt                      ${snapshot.targetState.updatedAt.toISOString()}`);
    console.log(
      `showMatchesExpected            ${snapshot.targetState.spotifyShowId === showId}`,
    );
  }
  console.log();

  console.log("---------- V2 REFRESH TELEMETRY ----------");
  console.log(`runsWithPlaybackRefresh         ${runEvidence.length}`);
  console.log(`runsSelectingTargetEpisode      ${targetRefreshRuns.length}`);
  if (!latestRefreshRun) {
    console.log("latestTargetRefreshRun          NONE");
  } else {
    const { run, refresh } = latestRefreshRun;
    console.log(`latestTargetRefreshRun          ${run.id}`);
    console.log(`startedAt                       ${run.startedAt.toISOString()}`);
    console.log(`trigger                         ${run.trigger}`);
    console.log(`simulation                      ${run.simulation}`);
    console.log(`status                          ${run.status}`);
    console.log(`eligibleEpisodeCount            ${value(refresh.eligibleEpisodeCount)}`);
    console.log(`eligibleShowCount               ${value(refresh.eligibleShowCount)}`);
    console.log(`selectedEpisodeCount            ${value(refresh.selectedEpisodeCount)}`);
    console.log(`selectedShowCount               ${value(refresh.selectedShowCount)}`);
    console.log(`refreshedEpisodeCount           ${value(refresh.refreshedEpisodeCount)}`);
    console.log(`completedFoundCount             ${value(refresh.completedFoundCount)}`);
    console.log(`skippedByBudgetCount            ${value(refresh.skippedByBudgetCount)}`);
    console.log(
      `selectedForExpectedShow        ${(refresh.selectedByShowId[showId] ?? []).includes(episodeId)}`,
    );
  }
  console.log();

  console.log("---------- WEEKLY CADENCE POST-REFRESH ----------");
  console.log(`timeZone                        ${timeZone}`);
  console.log(`windowStart                     ${cadence.window.start.toISOString()}`);
  console.log(`windowEndExclusive              ${cadence.window.endExclusive.toISOString()}`);
  console.log(`consumedCount                   ${cadence.consumedCount}`);
  console.log(`limitReached                    ${cadence.limitReached}`);
  console.log(`newEpisodeAllowedByCadence      ${cadence.newEpisodeAllowedByCadence}`);
  console.log(`targetEpisodeConsumed           ${cadenceConsumesTarget}`);
  console.log(
    `completedConsumedEpisodeIds     ${cadence.completedConsumedEpisodeIds.join(",") || "NONE"}`,
  );
  console.log();

  console.log("---------- ACCEPTANCE ----------");
  console.log(`v2SelectedTargetEpisode         ${targetWasSelectedByV2}`);
  console.log(`canonicalCompleted              ${canonicalCompleted}`);
  console.log(`weeklyCadenceConsumesTarget     ${cadenceConsumesTarget}`);
  console.log(`weeklyCadenceBlocksNewEpisode   ${cadenceBlocksNewEpisode}`);
  console.log("============================================================");
}

function extractRefreshTelemetry(summary: unknown): RefreshTelemetry | null {
  const root = asObject(summary);
  const runtime = asObject(root?.podcast07Runtime);
  const refresh = asObject(runtime?.playbackRefresh);
  if (!refresh) return null;

  const selectedByShowId: Record<string, string[]> = {};
  const rawByShow = asObject(refresh.selectedByShowId);
  if (rawByShow) {
    for (const [showId, value] of Object.entries(rawByShow)) {
      selectedByShowId[showId] = stringArray(value);
    }
  }

  return {
    selectedEpisodeIds: stringArray(refresh.selectedEpisodeIds),
    selectedByShowId,
    eligibleEpisodeCount: numeric(refresh.eligibleEpisodeCount),
    eligibleShowCount: numeric(refresh.eligibleShowCount),
    selectedEpisodeCount: numeric(refresh.selectedEpisodeCount),
    selectedShowCount: numeric(refresh.selectedShowCount),
    refreshedEpisodeCount: numeric(refresh.refreshedEpisodeCount),
    completedFoundCount: numeric(refresh.completedFoundCount),
    skippedByBudgetCount: numeric(refresh.skippedByBudgetCount),
  };
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function value(input: number | null): string {
  return input === null ? "UNKNOWN" : String(input);
}

function requiredArg(name: string): string {
  const result = optionalArg(name);
  if (!result) throw new Error(`Missing required --${name}=...`);
  return result;
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length).trim() || null : null;
}

function dateArg(name: string): Date | null {
  const raw = optionalArg(name);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--${name} must be an ISO-8601 date/time`);
  }
  return parsed;
}

function positiveIntegerArg(name: string): number | null {
  const raw = optionalArg(name);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
