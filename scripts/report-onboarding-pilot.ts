import { prisma } from "@/lib/prisma";

type JsonObject = Record<string, unknown>;

function asObject(
  value: unknown,
): JsonObject | null {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asNumber(
  value: unknown,
): number {
  return typeof value === "number" &&
    Number.isFinite(value)
    ? value
    : 0;
}

function asString(
  value: unknown,
): string | null {
  return typeof value === "string"
    ? value
    : null;
}

function argValue(
  name: string,
): string | null {
  const prefix = `--${name}=`;

  const value = process.argv
    .slice(2)
    .find((arg) =>
      arg.startsWith(prefix),
    );

  return value
    ? value.slice(prefix.length).trim() ||
        null
    : null;
}

function hasArg(
  name: string,
): boolean {
  return process.argv
    .slice(2)
    .includes(`--${name}`);
}

function positiveNumberArg(
  name: string,
  fallback: number,
): number {
  const raw = Number(
    argValue(name) ?? fallback,
  );

  return Number.isFinite(raw) &&
    raw > 0
    ? raw
    : fallback;
}

function percent(
  numerator: number,
  denominator: number,
): number {
  if (denominator <= 0) return 0;

  return Number(
    (
      (numerator / denominator) *
      100
    ).toFixed(1),
  );
}

function median(
  values: number[],
): number | null {
  if (values.length === 0) {
    return null;
  }

  const ordered = [...values].sort(
    (left, right) => left - right,
  );

  const middle = Math.floor(
    ordered.length / 2,
  );

  const upper = ordered[middle];

  if (upper === undefined) {
    return null;
  }

  if (ordered.length % 2 === 1) {
    return upper;
  }

  const lower =
    ordered[middle - 1];

  if (lower === undefined) {
    return upper;
  }

  return (
    lower +
    upper
  ) / 2;
}

function minutesBetween(
  from: Date,
  to: Date,
): number {
  return Math.max(
    0,
    (to.getTime() - from.getTime()) /
      60_000,
  );
}

async function main() {
  const sinceDays =
    positiveNumberArg(
      "since-days",
      30,
    );

  const staleHours =
    positiveNumberArg(
      "stale-hours",
      24,
    );

  const email =
    argValue("email");

  const now = new Date();

  const since = new Date(
    now.getTime() -
      sinceDays *
        24 *
        60 *
        60 *
        1000,
  );

  const staleBefore = new Date(
    now.getTime() -
      staleHours *
        60 *
        60 *
        1000,
  );

  const selectedUser = email
    ? await prisma.user.findFirst({
        where: {
          email: {
            equals: email,
            mode: "insensitive",
          },
        },
        select: {
          id: true,
          email: true,
        },
      })
    : null;

  if (email && !selectedUser) {
    throw new Error(
      "Usuário piloto não encontrado.",
    );
  }

  const progressRows =
    await prisma.onboardingProgress.findMany({
      where: selectedUser
        ? {
            userId: selectedUser.id,
          }
        : {
            startedAt: {
              gte: since,
            },
          },
      orderBy: {
        startedAt: "asc",
      },
      select: {
        userId: true,
        status: true,
        currentStep: true,
        startedAt: true,
        readyForSimulationAt: true,
        completedAt: true,
        skippedAt: true,
        updatedAt: true,
      },
    });

  const userIds = progressRows.map(
    (row) => row.userId,
  );

  const events =
    userIds.length > 0
      ? await prisma.onboardingTelemetryEvent.findMany(
          {
            where: {
              userId: {
                in: userIds,
              },
              createdAt: {
                gte: since,
              },
            },
            orderBy: {
              createdAt: "asc",
            },
            select: {
              userId: true,
              event: true,
              step: true,
              metadata: true,
              createdAt: true,
            },
          },
        )
      : [];

  const generationRuns =
    userIds.length > 0
      ? await prisma.generationRun.findMany({
          where: {
            userId: {
              in: userIds,
            },
            startedAt: {
              gte: since,
            },
          },
          orderBy: {
            startedAt: "asc",
          },
          select: {
            userId: true,
            simulation: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            summary: true,
          },
        })
      : [];

  const onboardingSimulationRuns =
    generationRuns.filter((run) => {
      if (!run.simulation) {
        return false;
      }

      const summary =
        asObject(run.summary);

      const marker = asObject(
        summary?.onboardingSimulation,
      );

      return marker?.version === 1;
    });

  const realRuns =
    generationRuns.filter(
      (run) => !run.simulation,
    );

  const eventCounts =
    new Map<string, number>();

  const stepFailureCounts =
    new Map<string, number>();

  const abandonedByStep =
    new Map<string, number>();

  for (const event of events) {
    eventCounts.set(
      event.event,
      (eventCounts.get(
        event.event,
      ) ?? 0) + 1,
    );

    if (
      event.event === "stepFailed"
    ) {
      const metadata =
        asObject(event.metadata);

      const code =
        asString(metadata?.code) ??
        "unknown";

      const key =
        `${event.step ?? "UNKNOWN"}:${code}`;

      stepFailureCounts.set(
        key,
        (stepFailureCounts.get(
          key,
        ) ?? 0) + 1,
      );
    }
  }

  const started =
    progressRows.filter(
      (row) => row.startedAt,
    );

  const completed =
    progressRows.filter(
      (row) =>
        row.status === "COMPLETED" &&
        row.completedAt,
    );

  const skipped =
    progressRows.filter(
      (row) =>
        row.status === "SKIPPED",
    );

  const incomplete =
    progressRows.filter(
      (row) =>
        row.status ===
          "IN_PROGRESS" ||
        row.status ===
          "READY_FOR_SIMULATION",
    );

  const stalled =
    incomplete.filter(
      (row) =>
        row.updatedAt <= staleBefore,
    );

  for (const row of stalled) {
    abandonedByStep.set(
      row.currentStep,
      (abandonedByStep.get(
        row.currentStep,
      ) ?? 0) + 1,
    );
  }

  const completionMinutes =
    completed.flatMap((row) =>
      row.startedAt &&
      row.completedAt
        ? [
            minutesBetween(
              row.startedAt,
              row.completedAt,
            ),
          ]
        : [],
    );

  const eventsByUser =
    new Map<
      string,
      typeof events
    >();

  for (const event of events) {
    const rows =
      eventsByUser.get(
        event.userId,
      ) ?? [];

    rows.push(event);
    eventsByUser.set(
      event.userId,
      rows,
    );
  }

  let firstSimulationResults = 0;
  let firstSimulationSuccesses = 0;

  for (const rows of eventsByUser.values()) {
    const firstStartIndex =
      rows.findIndex(
        (event) =>
          event.event ===
          "firstSimulationStarted",
      );

    if (firstStartIndex < 0) {
      continue;
    }

    const result = rows
      .slice(firstStartIndex + 1)
      .find(
        (event) =>
          event.event ===
            "firstSimulationSucceeded" ||
          event.event ===
            "firstSimulationFailed",
      );

    if (!result) continue;

    firstSimulationResults += 1;

    if (
      result.event ===
      "firstSimulationSucceeded"
    ) {
      firstSimulationSuccesses += 1;
    }
  }

  const adjustedUsers = new Set(
    events
      .filter(
        (event) =>
          event.event ===
          "configurationAdjusted",
      )
      .map((event) => event.userId),
  );

  const oauthStepFailures =
    events.filter(
      (event) =>
        event.event === "stepFailed" &&
        event.step === "SPOTIFY",
    ).length;

  const api = {
    totalCalls: 0,
    rateLimitedCount: 0,
    quotaExceededCount: 0,
    retries: 0,
    retryWaitMs: 0,
    callsByOperation:
      {} as Record<string, number>,
  };

  for (
    const run of
    onboardingSimulationRuns
  ) {
    const summary =
      asObject(run.summary);

    const spotifyApi =
      asObject(
        summary?.spotifyApi,
      );

    if (!spotifyApi) continue;

    api.totalCalls +=
      asNumber(
        spotifyApi.totalCalls,
      );

    api.rateLimitedCount +=
      asNumber(
        spotifyApi.rateLimitedCount,
      );

    api.quotaExceededCount +=
      asNumber(
        spotifyApi.quotaExceededCount,
      );

    api.retries +=
      asNumber(
        spotifyApi.retries,
      );

    api.retryWaitMs +=
      asNumber(
        spotifyApi.retryWaitMs,
      );

    const callsByOperation =
      asObject(
        spotifyApi.callsByOperation,
      );

    if (callsByOperation) {
      for (
        const [operation, count]
        of Object.entries(
          callsByOperation,
        )
      ) {
        api.callsByOperation[
          operation
        ] =
          (
            api.callsByOperation[
              operation
            ] ?? 0
          ) +
          asNumber(count);
      }
    }
  }

  const firstRealStatus =
    new Map<string, number>();

  const firstUsefulMinutes:
    number[] = [];

  for (const progress of completed) {
    if (
      !progress.completedAt
    ) {
      continue;
    }

    const candidates =
      realRuns.filter(
        (run) =>
          run.userId ===
            progress.userId &&
          run.startedAt >=
            progress.completedAt!,
      );

    const first =
      candidates[0];

    if (first) {
      firstRealStatus.set(
        first.status,
        (
          firstRealStatus.get(
            first.status,
          ) ?? 0
        ) + 1,
      );
    }

    const firstUseful =
      candidates.find(
        (run) =>
          run.status ===
          "SUCCESS",
      );

    if (
      firstUseful &&
      progress.startedAt
    ) {
      firstUsefulMinutes.push(
        minutesBetween(
          progress.startedAt,
          firstUseful.finishedAt ??
            firstUseful.startedAt,
        ),
      );
    }
  }

  const report = {
    window: {
      since: since.toISOString(),
      sinceDays,
      staleHours,
    },

    users: {
      started: started.length,
      completed: completed.length,
      skipped: skipped.length,
      incomplete: incomplete.length,
      stalled: stalled.length,
      completionRatePercent:
        percent(
          completed.length,
          started.length,
        ),
    },

    funnel: {
      eventCounts:
        Object.fromEntries(
          [...eventCounts.entries()].sort(),
        ),
      stepFailures:
        Object.fromEntries(
          [
            ...stepFailureCounts.entries(),
          ].sort(),
        ),
      abandonmentProxyByStep:
        Object.fromEntries(
          [
            ...abandonedByStep.entries(),
          ].sort(),
        ),
      adjustedAfterReviewUsers:
        adjustedUsers.size,
      spotifyStepFailures:
        oauthStepFailures,
    },

    timing: {
      medianMinutesToCompletion:
        median(
          completionMinutes,
        ),
      medianMinutesToFirstUsefulRealGeneration:
        median(
          firstUsefulMinutes,
        ),
    },

    simulation: {
      runs:
        onboardingSimulationRuns.length,
      firstAttemptResults:
        firstSimulationResults,
      firstAttemptSuccesses:
        firstSimulationSuccesses,
      firstAttemptSuccessRatePercent:
        percent(
          firstSimulationSuccesses,
          firstSimulationResults,
        ),
    },

    spotifyApiDuringOnboardingSimulation:
      api,

    firstRealGeneration: {
      statusCounts:
        Object.fromEntries(
          [
            ...firstRealStatus.entries(),
          ].sort(),
        ),
    },
  };

  if (hasArg("json")) {
    console.log(
      JSON.stringify(
        report,
        null,
        2,
      ),
    );

    return;
  }

  const value = (
    label: string,
    data: unknown,
  ) =>
    console.log(
      `${label.padEnd(45)}${String(
        data,
      )}`,
    );

  console.log(
    "========== ONBOARDING-01 — GATE 8 PILOT ==========",
  );

  value(
    "Janela:",
    `${sinceDays} dia(s)`,
  );

  value(
    "Abandono proxy após:",
    `${staleHours}h sem atualização`,
  );

  if (selectedUser) {
    value(
      "Usuário filtrado:",
      selectedUser.email ??
        "(sem e-mail)",
    );
  }

  console.log();
  value(
    "Usuários iniciados:",
    report.users.started,
  );
  value(
    "Concluídos:",
    report.users.completed,
  );
  value(
    "Pulados:",
    report.users.skipped,
  );
  value(
    "Incompletos:",
    report.users.incomplete,
  );
  value(
    "Parados/abandono proxy:",
    report.users.stalled,
  );
  value(
    "Taxa de conclusão:",
    `${report.users.completionRatePercent}%`,
  );

  console.log();
  value(
    "Primeira simulação — resultados:",
    report.simulation
      .firstAttemptResults,
  );
  value(
    "Primeira simulação — sucesso:",
    `${report.simulation.firstAttemptSuccessRatePercent}%`,
  );
  value(
    "Usuários que voltaram para ajustar:",
    report.funnel
      .adjustedAfterReviewUsers,
  );

  console.log();
  value(
    "Spotify API calls (simulações):",
    api.totalCalls,
  );
  value(
    "Spotify 429 rate limited:",
    api.rateLimitedCount,
  );
  value(
    "Spotify quota exceeded:",
    api.quotaExceededCount,
  );
  value(
    "Spotify retries:",
    api.retries,
  );
  value(
    "Spotify retry wait ms:",
    api.retryWaitMs,
  );

  console.log();
  value(
    "Mediana início → conclusão:",
    report.timing
      .medianMinutesToCompletion ===
      null
      ? "sem evidência"
      : `${report.timing
          .medianMinutesToCompletion
          .toFixed(1)} min`,
  );

  value(
    "Mediana início → 1ª geração real útil:",
    report.timing
      .medianMinutesToFirstUsefulRealGeneration ===
      null
      ? "sem evidência"
      : `${report.timing
          .medianMinutesToFirstUsefulRealGeneration
          .toFixed(1)} min`,
  );

  console.log();
  console.log(
    "Falhas por etapa/código:",
  );

  if (
    Object.keys(
      report.funnel.stepFailures,
    ).length === 0
  ) {
    console.log("  nenhuma");
  } else {
    for (
      const [key, count]
      of Object.entries(
        report.funnel.stepFailures,
      )
    ) {
      console.log(
        `  ${key}: ${count}`,
      );
    }
  }

  console.log();
  console.log(
    "Abandono proxy por etapa:",
  );

  if (
    Object.keys(
      report.funnel
        .abandonmentProxyByStep,
    ).length === 0
  ) {
    console.log("  nenhum");
  } else {
    for (
      const [step, count]
      of Object.entries(
        report.funnel
          .abandonmentProxyByStep,
      )
    ) {
      console.log(
        `  ${step}: ${count}`,
      );
    }
  }

  console.log();
  console.log(
    "Chamadas Spotify da simulação por operação:",
  );

  if (
    Object.keys(
      api.callsByOperation,
    ).length === 0
  ) {
    console.log("  nenhuma");
  } else {
    for (
      const [operation, count]
      of Object.entries(
        api.callsByOperation,
      ).sort()
    ) {
      console.log(
        `  ${operation}: ${count}`,
      );
    }
  }

  if (selectedUser) {
    console.log();
    console.log(
      "Timeline de telemetria do piloto:",
    );

    const timeline =
      eventsByUser.get(
        selectedUser.id,
      ) ?? [];

    if (timeline.length === 0) {
      console.log(
        "  sem eventos na janela",
      );
    }

    for (const event of timeline) {
      const metadata =
        asObject(event.metadata);

      const code =
        asString(metadata?.code);

      console.log(
        `  ${event.createdAt.toISOString()} | ${event.event}` +
          `${event.step ? ` | ${event.step}` : ""}` +
          `${code ? ` | code=${code}` : ""}`,
      );
    }
  }

  console.log();
  console.log(
    "Nota: o contador de API acima cobre as chamadas da geração/simulação canônica, que já possui métricas autoritativas. Navegação OAuth e leituras interativas de configuração são acompanhadas por falha/429 por etapa, mas não são recontadas artificialmente no render.",
  );
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
