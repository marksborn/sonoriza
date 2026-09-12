import type { Prisma } from "@prisma/client";

import {
  generatePlaylists,
} from "@/jobs/generate-playlists";
import { prisma } from "@/lib/prisma";
import {
  assessCalendar03GenerationConfiguration,
} from "@/services/calendar-event-composition-generation";
import {
  assessConfiguration,
} from "@/services/configuration-readiness";
import {
  calendar03PlannerRuntimeSummary,
  createCalendar03PlannerRuntimeState,
  runWithCalendar03PlannerRuntimeState,
} from "@/services/playlist-planner/calendar-event-composition-runtime";
import {
  getActiveSpotifyBackoff,
} from "@/services/spotify/backoff";
import {
  recordOnboardingTelemetry,
} from "@/services/onboarding/telemetry";

export type OnboardingSimulationErrorCode =
  | "no-target"
  | "rate-limit"
  | "configuration"
  | "simulation";

export class OnboardingSimulationError
  extends Error {
  constructor(
    readonly code:
      OnboardingSimulationErrorCode,
    readonly details: unknown = null,
  ) {
    super(code);
    this.name =
      "OnboardingSimulationError";
  }
}

type JsonObject =
  Record<string, unknown>;

function asObject(
  value: unknown,
): JsonObject | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as JsonObject;
}

function asNumber(
  value: unknown,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value)
    ? value
    : null;
}

function asString(
  value: unknown,
): string | null {
  return typeof value === "string"
    ? value
    : null;
}

function targetSummaryFor(
  summary: JsonObject,
  targetId: string,
): JsonObject | null {
  const targets = Array.isArray(
    summary.targets,
  )
    ? summary.targets
    : [];

  for (const candidate of targets) {
    const target = asObject(candidate);

    if (
      target?.targetPlaylistId ===
      targetId
    ) {
      return target;
    }
  }

  return null;
}

async function throwOnboardingSimulationFailure(
  input: {
    userId: string;
    error: OnboardingSimulationError;
  },
): Promise<never> {
  const metadata = {
    code: input.error.code,
    ...(input.error.code === "rate-limit"
      ? {
          provider: "spotify",
        }
      : {}),
  };

  await recordOnboardingTelemetry({
    userId: input.userId,
    event: "firstSimulationFailed",
    step: "SIMULATION",
    metadata,
  });

  await recordOnboardingTelemetry({
    userId: input.userId,
    event: "stepFailed",
    step: "SIMULATION",
    metadata,
  });

  throw input.error;
}

export async function runOnboardingTargetSimulation(
  input: {
    userId: string;
    targetId: string;
  },
) {
  await recordOnboardingTelemetry({
    userId: input.userId,
    event: "firstSimulationStarted",
    step: "SIMULATION",
  });

  const target =
    await prisma.targetPlaylist.findFirst({
      where: {
        id: input.targetId,
        userId: input.userId,
      },
      select: {
        id: true,
      },
    });

  if (!target) {
    return throwOnboardingSimulationFailure({
      userId: input.userId,
      error: new OnboardingSimulationError(
        "no-target",
      ),
    });
  }

  const backoff =
    await getActiveSpotifyBackoff();

  if (backoff) {
    return throwOnboardingSimulationFailure({
      userId: input.userId,
      error: new OnboardingSimulationError(
        "rate-limit",
        {
          blockedUntil:
            backoff.blockedUntil,
        },
      ),
    });
  }

  const baseAssessment =
    await assessConfiguration(
      input.userId,
      {
        targetPlaylistIds: [
          input.targetId,
        ],
        includeDisabledTargetIds: [
          input.targetId,
        ],
      },
    );

  const calendar03 =
    await assessCalendar03GenerationConfiguration(
      input.userId,
      baseAssessment,
    );

  if (
    calendar03.assessment.issues.length >
    0
  ) {
    return throwOnboardingSimulationFailure({
      userId: input.userId,
      error: new OnboardingSimulationError(
        "configuration",
        calendar03.assessment.issues,
      ),
    });
  }

  const user =
    await prisma.user.findUnique({
      where: {
        id: input.userId,
      },
      select: {
        email: true,
      },
    });

  const calendar03State =
    createCalendar03PlannerRuntimeState({
      policies:
        calendar03.policies,
      requestedMode:
        process.env
          .CALENDAR_03_PLANNER_MODE ??
        "SHADOW",
      userEmail:
        user?.email ?? null,
      activeEmailAllowlist:
        process.env
          .CALENDAR_03_PLANNER_EMAIL_ALLOWLIST ??
        null,
      activeTargetIds:
        process.env
          .CALENDAR_03_PLANNER_TARGET_IDS ??
        null,
    });

  let result;

  try {
    result =
      await runWithCalendar03PlannerRuntimeState(
        calendar03State,
        () =>
          generatePlaylists({
            userId: input.userId,
            trigger: "SIMULATION",
            simulate: true,
            targetPlaylistIds: [
              input.targetId,
            ],
            simulationIncludeDisabledTargetIds:
              [input.targetId],
          }),
      );
  } catch (error) {
    return throwOnboardingSimulationFailure({
      userId: input.userId,
      error:
        new OnboardingSimulationError(
          "simulation",
          error,
        ),
    });
  }

  const run =
    await prisma.generationRun.findFirst({
      where: {
        id: result.runId,
        userId: input.userId,
        simulation: true,
      },
      select: {
        summary: true,
      },
    });

  const existingSummary =
    asObject(run?.summary) ?? {};

  await prisma.generationRun.updateMany({
    where: {
      id: result.runId,
      userId: input.userId,
      simulation: true,
    },
    data: {
      summary: {
        ...existingSummary,

        configurationFingerprint:
          calendar03.assessment
            .fingerprint,

        calendar03PlannerRuntime:
          calendar03PlannerRuntimeSummary(
            calendar03State,
          ),

        onboardingSimulation: {
          version: 1,
          targetPlaylistId:
            input.targetId,
        },
      } as Prisma.InputJsonValue,
    },
  });

  if (result.status === "SUCCESS") {
    await recordOnboardingTelemetry({
      userId: input.userId,
      event: "firstSimulationSucceeded",
      step: "SIMULATION",
      metadata: {
        runStatus: result.status,
      },
    });

    await recordOnboardingTelemetry({
      userId: input.userId,
      event: "stepCompleted",
      step: "SIMULATION",
      metadata: {
        outcome: "completed",
        runStatus: result.status,
      },
    });
  } else {
    const metadata = {
      code: "run-not-success",
      runStatus: result.status,
    };

    await recordOnboardingTelemetry({
      userId: input.userId,
      event: "firstSimulationFailed",
      step: "SIMULATION",
      metadata,
    });

    await recordOnboardingTelemetry({
      userId: input.userId,
      event: "stepFailed",
      step: "SIMULATION",
      metadata,
    });
  }

  return result;
}

export type OnboardingSimulationPresentation =
  Readonly<{
    runId: string;
    status: string;
    startedAt: Date;
    error: string | null;

    planned: number;
    musicCount: number;
    podcastCount: number;
    totalMinutes: number;
    targetDurationMinutes: number;

    qualityPassed: boolean;
    collectionComplete: boolean;
    inconclusive: boolean;

    sources: ReadonlyArray<{
      label: string;
      count: number;
    }>;

    exclusions: readonly string[];

    preview: ReadonlyArray<{
      position: number;
      title: string;
      subtitle: string | null;
      contentType:
        | "MUSIC"
        | "PODCAST";
      durationMinutes: number;
    }>;
  }>;

export async function loadLatestOnboardingSimulation(
  userId: string,
  targetId: string,
): Promise<
  OnboardingSimulationPresentation | null
> {
  const runs =
    await prisma.generationRun.findMany({
      where: {
        userId,
        simulation: true,
      },
      orderBy: {
        startedAt: "desc",
      },
      take: 20,
      select: {
        id: true,
        status: true,
        startedAt: true,
        error: true,
        summary: true,
        items: {
          where: {
            targetPlaylistId:
              targetId,
          },
          orderBy: {
            position: "asc",
          },
          select: {
            position: true,
            contentType: true,
            title: true,
            subtitle: true,
            durationMs: true,
            sourceSpotifyType: true,
            sourceSpotifyId: true,
          },
        },
      },
    });

  const run = runs.find((candidate) => {
    const summary =
      asObject(candidate.summary);

    const marker = asObject(
      summary?.onboardingSimulation,
    );

    return (
      marker?.version === 1 &&
      marker?.targetPlaylistId ===
        targetId
    );
  });

  if (!run) {
    return null;
  }

  const summary =
    asObject(run.summary) ?? {};

  const targetSummary =
    targetSummaryFor(
      summary,
      targetId,
    ) ?? {};

  const sourceSpotifyIds = [
    ...new Set(
      run.items
        .map(
          (item) =>
            item.sourceSpotifyId,
        )
        .filter(
          (
            value,
          ): value is string =>
            Boolean(value),
        ),
    ),
  ];

  const sourceRows =
    sourceSpotifyIds.length > 0
      ? await prisma.sourcePlaylist.findMany({
          where: {
            userId,
            spotifyId: {
              in: sourceSpotifyIds,
            },
          },
          select: {
            spotifyId: true,
            spotifyType: true,
            name: true,
          },
        })
      : [];

  const sourceName = new Map(
    sourceRows.map((source) => [
      `${source.spotifyType}:${source.spotifyId}`,
      source.name ??
        source.spotifyId,
    ]),
  );

  const groupedSources =
    new Map<string, number>();

  for (const item of run.items) {
    const key =
      item.sourceSpotifyId &&
      item.sourceSpotifyType
        ? `${item.sourceSpotifyType}:${item.sourceSpotifyId}`
        : "__SONORIZA__";

    groupedSources.set(
      key,
      (groupedSources.get(key) ??
        0) + 1,
    );
  }

  const sources = [
    ...groupedSources.entries(),
  ].map(([key, count]) => ({
    label:
      key === "__SONORIZA__"
        ? "Descoberta / curadoria do Sonoriza"
        : sourceName.get(key) ??
          "Fonte Spotify",
    count,
  }));

  const exclusions: string[] = [];

  const addCount = (
    value: unknown,
    label: string,
  ) => {
    const count = asNumber(value);

    if (count && count > 0) {
      exclusions.push(
        `${count} ${label}`,
      );
    }
  };

  addCount(
    summary
      .musicUnavailableSkippedCount,
    "música(s) indisponível(is) no Spotify",
  );

  addCount(
    summary
      .genericPodcastSuppressedCount,
    "episódio(s) de podcast descartado(s) por fonte não autoritativa",
  );

  const repeat =
    asObject(summary.musicRepeat);

  addCount(
    repeat
      ?.recentlyPlayedSkippedCount,
    "música(s) barrada(s) pela regra de repetição",
  );

  const inferred =
    asObject(
      summary.musicInferredSkip,
    );

  addCount(
    inferred
      ?.inferredSkipSuppressedCount,
    "música(s) barrada(s) por sinais de skip",
  );

  const qualityReason =
    asString(
      targetSummary.qualityReason,
    );

  if (qualityReason) {
    exclusions.push(
      `Composição: ${qualityReason}`,
    );
  }

  const inconclusiveReason =
    asString(
      summary.inconclusiveReason,
    );

  if (inconclusiveReason) {
    exclusions.push(
      `Simulação inconclusiva: ${inconclusiveReason}`,
    );
  }

  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    error: run.error,

    planned:
      asNumber(
        targetSummary.planned,
      ) ?? run.items.length,

    musicCount:
      asNumber(
        targetSummary.musicCount,
      ) ??
      run.items.filter(
        (item) =>
          item.contentType === "MUSIC",
      ).length,

    podcastCount:
      asNumber(
        targetSummary.podcastCount,
      ) ??
      run.items.filter(
        (item) =>
          item.contentType === "PODCAST",
      ).length,

    totalMinutes:
      asNumber(
        targetSummary.totalMinutes,
      ) ?? 0,

    targetDurationMinutes:
      Math.round(
        (
          asNumber(
            targetSummary
              .targetDurationMs,
          ) ?? 0
        ) / 60_000,
      ),

    qualityPassed:
      summary.qualityPassed === true,

    collectionComplete:
      summary.collectionComplete ===
      true,

    inconclusive:
      summary.inconclusive === true,

    sources,

    exclusions: [
      ...new Set(exclusions),
    ],

    preview: run.items
      .slice(0, 10)
      .map((item) => ({
        position:
          item.position + 1,
        title:
          item.title ??
          "Item sem título",
        subtitle:
          item.subtitle,
        contentType:
          item.contentType,
        durationMinutes:
          Math.max(
            1,
            Math.round(
              item.durationMs /
                60_000,
            ),
          ),
      })),
  };
}
