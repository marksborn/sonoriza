from pathlib import Path
import re


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one match, found {count}: {old[:100]!r}"
        )
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Generic incremental collector: caller-selected recoverable source failures.
# A degraded source loses every candidate already read in the current run.
# ---------------------------------------------------------------------------
path = "src/jobs/incremental-planning.ts"

replace_once(
    path,
    """  stoppedEarly: boolean;
  failure: IncrementalSourceFailure<TSource> | null;
};""",
    """  stoppedEarly: boolean;
  failure: IncrementalSourceFailure<TSource> | null;
  degradedFailures: IncrementalSourceFailure<TSource>[];
};""",
)

replace_once(
    path,
    """  sequenceTerminalUnderfillToleranceMs?: number;
};""",
    """  sequenceTerminalUnderfillToleranceMs?: number;
  /** Caller-owned fail-open policy for an isolated source read. Defaults false. */
  recoverSourceFailure?: (source: TSource, error: unknown) => boolean;
};""",
)

replace_once(
    path,
    """  revalidateBeforeWrite = revalidateMusicRepeatBeforeRealWrite,
  replanAfterEachSourceRead = false,
  sequenceTerminalUnderfillToleranceMs = 0,
}: CollectIncrementallyOptions<TSource>): Promise<IncrementalPlanningResult<TSource>> {""",
    """  revalidateBeforeWrite = revalidateMusicRepeatBeforeRealWrite,
  replanAfterEachSourceRead = false,
  sequenceTerminalUnderfillToleranceMs = 0,
  recoverSourceFailure = () => false,
}: CollectIncrementallyOptions<TSource>): Promise<IncrementalPlanningResult<TSource>> {""",
)

replace_once(
    path,
    """  const activeSources: TSource[] = discovery ? discovery.podcastSources : sources;
  const pools: PlannerPools = {""",
    """  const activeSources: TSource[] = discovery ? discovery.podcastSources : sources;
  const activeSourceById = new Map(activeSources.map((source) => [source.id, source]));
  const degradedSourceIds = new Set<string>();
  const degradedFailures: IncrementalSourceFailure<TSource>[] = [];
  const sourceCandidatesById = new Map<string, Candidate[]>();
  const pools: PlannerPools = {""",
)

replace_once(
    path,
    """  const pools: PlannerPools = {
    music: discovery ? dedupeByUri(discovery.rankedMusic) : [],
    podcasts: [],
  };
  let musicPoolByTargetId: Map<string, Candidate[]> | undefined;""",
    """  const pools: PlannerPools = {
    music: discovery ? dedupeByUri(discovery.rankedMusic) : [],
    podcasts: [],
  };
  const baseMusicPool = [...pools.music];
  let musicPoolByTargetId: Map<string, Candidate[]> | undefined;""",
)

replace_once(
    path,
    """  const attemptedSourceIds = new Set<string>(
    discovery?.completedMusicSourceIds ?? [],
  );""",
    """  const rebuildPoolsFromActiveSourceContributions = () => {
    const music = [...baseMusicPool];
    const podcasts: Candidate[] = [];

    for (const [sourceId, candidates] of sourceCandidatesById) {
      if (degradedSourceIds.has(sourceId)) continue;
      const source = activeSourceById.get(sourceId);
      if (!source) continue;
      if (source.kind === "MUSIC") music.push(...candidates);
      else podcasts.push(...candidates);
    }

    pools.music = dedupeByUri(filterMusicBatchForCurrentRun(music).candidates);
    pools.podcasts = podcasts;
  };

  const attemptedSourceIds = new Set<string>(
    discovery?.completedMusicSourceIds ?? [],
  );""",
)

replace_once(
    path,
    """          activeSources.some((source) => source.kind === kind && !source.done),""",
    """          activeSources.some(
            (source) =>
              source.kind === kind &&
              !source.done &&
              !degradedSourceIds.has(source.id),
          ),""",
)

replace_once(
    path,
    """    const readable = activeSources.filter(
      (source) => !source.done && requestedKinds.has(source.kind),
    );""",
    """    const readable = activeSources.filter(
      (source) =>
        !source.done &&
        !degradedSourceIds.has(source.id) &&
        requestedKinds.has(source.kind),
    );""",
)

replace_once(
    path,
    """      try {
        batch = await source.readNext();
      } catch (error) {
        return {
          pools,
          plan,
          qualityFailures,
          attemptedSourceIds,
          readSourceIds,
          rounds,
          stoppedEarly: false,
          failure: { source, error },
        };
      }""",
    """      try {
        batch = await source.readNext();
      } catch (error) {
        if (recoverSourceFailure(source, error)) {
          degradedSourceIds.add(source.id);
          degradedFailures.push({ source, error });
          sourceCandidatesById.delete(source.id);
          rebuildPoolsFromActiveSourceContributions();
          rebuildPlan();
          refreshRequestedKinds();
          continue;
        }

        return {
          pools,
          plan,
          qualityFailures,
          attemptedSourceIds,
          readSourceIds,
          rounds,
          stoppedEarly: false,
          failure: { source, error },
          degradedFailures,
        };
      }""",
)

replace_once(
    path,
    """      readSourceIds.add(source.id);
      if (source.kind === "MUSIC") {""",
    """      sourceCandidatesById.set(source.id, [
        ...(sourceCandidatesById.get(source.id) ?? []),
        ...batch.candidates,
      ]);

      readSourceIds.add(source.id);
      if (source.kind === "MUSIC") {""",
)

p = Path(path)
text = p.read_text()
text, count = re.subn(
    r"(?m)^(\s*)failure: null,$",
    lambda m: f"{m.group(1)}failure: null,\n{m.group(1)}degradedFailures,",
    text,
)
if count < 3:
    raise SystemExit(f"{path}: expected at least 3 successful returns, found {count}")
p.write_text(text)


# ---------------------------------------------------------------------------
# Spotify provider policy: ONLY HTTP 502 is degradable.
# ---------------------------------------------------------------------------
Path("src/jobs/source-failure-policy.ts").write_text(
    '''import { isSpotifyApiError } from "@/services/spotify";

/**
 * A 502 means the provider gateway temporarily failed to obtain a valid
 * upstream response. During source collection only, this specific status may
 * degrade one source while every other provider/auth/quota/local failure stays
 * fail-closed.
 */
export function isDegradableSpotifySourceFailure(error: unknown): boolean {
  return (
    isSpotifyApiError(error) &&
    error.kind === "HTTP_ERROR" &&
    error.status === 502
  );
}
'''
)

Path("src/jobs/source-failure-policy.test.ts").write_text(
    '''import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyApiError } from "@/services/spotify/errors";

import { isDegradableSpotifySourceFailure } from "./source-failure-policy";

function providerError(
  status: number,
  kind: "HTTP_ERROR" | "RATE_LIMITED" | "QUOTA_EXCEEDED",
) {
  return new SpotifyApiError({
    kind,
    status,
    method: "GET",
    operation: "show-episodes",
    retryable: status >= 500 || kind === "RATE_LIMITED",
    message: `provider ${status}`,
  });
}

test("only an isolated Spotify HTTP 502 source failure is degradable", () => {
  assert.equal(isDegradableSpotifySourceFailure(providerError(502, "HTTP_ERROR")), true);
  assert.equal(isDegradableSpotifySourceFailure(providerError(503, "HTTP_ERROR")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(429, "RATE_LIMITED")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(429, "QUOTA_EXCEEDED")), false);
  assert.equal(isDegradableSpotifySourceFailure(new Error("local")), false);
});
'''
)


# ---------------------------------------------------------------------------
# Collector regression: remove partial candidates from the 502 source and use
# a substitute source. Other fatal errors keep their existing regression.
# ---------------------------------------------------------------------------
test_path = "src/jobs/incremental-planning.test.ts"
test_text = Path(test_path).read_text()
anchor = 'test("exhausts the necessary kind before declaring a conclusive quality failure", async () => {'
if test_text.count(anchor) != 1:
    raise SystemExit("incremental test anchor mismatch")
regression = r'''test("recoverable source failure discards its partial pool and continues with substitutes", async () => {
  const music = fakeSource({
    id: "music-degraded",
    kind: "MUSIC",
    batches: [
      { candidates: [candidate("spotify:track:degraded", "MUSIC", 600_000)], done: true },
    ],
  });
  const flaky = fakeSource({
    id: "podcast-flaky",
    kind: "PODCAST",
    batches: [
      { candidates: [candidate("spotify:episode:must-disappear", "PODCAST", 100_000, "show-flaky")], done: false },
      new Error("HTTP 502"),
    ],
  });
  const fallback = fakeSource({
    id: "podcast-fallback",
    kind: "PODCAST",
    batches: [
      { candidates: [candidate("spotify:episode:fallback-1", "PODCAST", 100_000, "show-ok-1")], done: false },
      { candidates: [candidate("spotify:episode:fallback-2", "PODCAST", 500_000, "show-ok-2")], done: true },
    ],
  });

  const result = await collectIncrementally({
    sources: [music, flaky, fallback],
    targets: [target(1_200_000)],
    recoverSourceFailure: (source, error) =>
      source.id === "podcast-flaky" && String(error).includes("502"),
  });

  assert.equal(result.failure, null);
  assert.equal(result.degradedFailures.length, 1);
  assert.equal(result.degradedFailures[0]?.source.id, "podcast-flaky");
  assert.equal(flaky.calls, 2);
  assert.equal(fallback.calls, 2);
  assert.equal(
    result.pools.podcasts.some((item) => item.uri === "spotify:episode:must-disappear"),
    false,
  );
  assert.equal(result.qualityFailures.length, 0);
});

'''
Path(test_path).write_text(test_text.replace(anchor, regression + anchor, 1))


# ---------------------------------------------------------------------------
# Generator: preserve degraded 502 diagnostics and return PARTIAL after a
# successful write with a degraded source.
# ---------------------------------------------------------------------------
gen = "src/jobs/generate-playlists-incremental.ts"
replace_once(
    gen,
    'import { revalidateMusicRepeatBeforeRealWrite } from "./music-repeat-runtime";',
    'import { revalidateMusicRepeatBeforeRealWrite } from "./music-repeat-runtime";\nimport { isDegradableSpotifySourceFailure } from "./source-failure-policy";',
)

replace_once(
    gen,
    """      initialReserved: opts.reservedUris ?? [],
      onBatch(source, batch) {""",
    """      initialReserved: opts.reservedUris ?? [],
      recoverSourceFailure: (_source, error) =>
        isDegradableSpotifySourceFailure(error),
      onBatch(source, batch) {""",
)

replace_once(
    gen,
    """    const readFailure = incremental.failure
      ? sourceFailureFromCursor(
          incremental.failure.source as SpotifyIncrementalCandidateSource,
          incremental.failure.error,
        )
      : null;
    const failures = readFailure ? [readFailure] : [];""",
    """    const readFailure = incremental.failure
      ? sourceFailureFromCursor(
          incremental.failure.source as SpotifyIncrementalCandidateSource,
          incremental.failure.error,
        )
      : null;
    const degradedFailures = incremental.degradedFailures.map((failure) =>
      sourceFailureFromCursor(
        failure.source as SpotifyIncrementalCandidateSource,
        failure.error,
      ),
    );
    const failures = [
      ...degradedFailures,
      ...(readFailure ? [readFailure] : []),
    ];""",
)

replace_once(
    gen,
    """      exhaustedSourceCount,
      stoppedEarly: incremental.stoppedEarly,
      planningRounds: incremental.rounds,""",
    """      exhaustedSourceCount,
      degradedSourceCount: degradedFailures.length,
      stoppedEarly: incremental.stoppedEarly,
      planningRounds: incremental.rounds,""",
)

replace_once(
    gen,
    """    summary.musicUnavailableSkippedCount = musicUnavailableSkippedCount;
    summary.genericPodcastSuppressedCount = genericPodcastSuppressedCount;

    if (readFailure) {""",
    """    summary.musicUnavailableSkippedCount = musicUnavailableSkippedCount;
    summary.genericPodcastSuppressedCount = genericPodcastSuppressedCount;

    if (degradedFailures.length > 0) {
      log({
        level: "WARN",
        message:
          `Continuing with ${degradedFailures.length} source(s) degraded by HTTP 502; ` +
          "all candidates previously read from those sources were discarded.",
        data: degradedFailures,
      });
    }

    if (readFailure) {""",
)

replace_once(
    gen,
    '    const status: RunStatus = anyFailed ? "PARTIAL" : "SUCCESS";',
    '''    const status: RunStatus =
      anyFailed || degradedFailures.length > 0 ? "PARTIAL" : "SUCCESS";''',
)


# ---------------------------------------------------------------------------
# Safe UI diagnostics helper.
# ---------------------------------------------------------------------------
Path("src/services/generation-run-diagnostics.ts").write_text(
    '''export type GenerationRunDiagnostic = {
  headline: string;
  detail: string;
  source: string | null;
  operation: string | null;
  providerStatus: number | null;
  pagesRead: number | null;
  partialRead: boolean;
  retryAfterSeconds: number | null;
};

type JsonRecord = Record<string, unknown>;

export function runSummaryMentionsTarget(summary: unknown, targetId: string): boolean {
  const root = asRecord(summary);
  if (!root) return false;

  const targetScope = Array.isArray(root.targetScope) ? root.targetScope : [];
  if (targetScope.some((entry) => entry === targetId)) return true;

  const targets = recordArray(root.targets);
  return targets.some((target) => target.targetPlaylistId === targetId);
}

export function summarizeGenerationRunDiagnostic(input: {
  summary: unknown;
  error: string | null;
  scheduleReason?: string | null;
}): GenerationRunDiagnostic | null {
  const root = asRecord(input.summary);
  const collection = asRecord(root?.sourceCollection);
  const failures = recordArray(collection?.failures);
  const failure = failures[0] ?? null;

  if (failure) {
    const source = stringOrNull(failure.source);
    const operation = stringOrNull(failure.operation);
    const providerStatus = numberOrNull(failure.status);
    const retryAfterSeconds = numberOrNull(failure.retryAfterSeconds);
    const sourceState = recordArray(collection?.sources).find(
      (entry) => source !== null && entry.source === source,
    );
    const pagesRead = numberOrNull(sourceState?.pagesRead);
    const partialRead = sourceState?.partialRead === true;

    let headline = "Falha na leitura de uma fonte";
    if (providerStatus === 502) headline = "Fonte temporariamente indisponível";
    else if (failure.errorKind === "RATE_LIMITED") {
      headline = "Spotify limitou temporariamente as chamadas";
    } else if (failure.errorKind === "QUOTA_EXCEEDED") {
      headline = "Cota do Spotify indisponível";
    }

    const subject = source ?? "Uma fonte do Sonoriza";
    const statusPart = providerStatus === null ? "" : ` HTTP ${providerStatus}`;
    const operationPart = operation ? ` durante ${operation}` : "";

    return {
      headline,
      detail: `${subject} retornou${statusPart}${operationPart}.`,
      source,
      operation,
      providerStatus,
      pagesRead,
      partialRead,
      retryAfterSeconds,
    };
  }

  const fallback =
    safeDiagnosticText(input.scheduleReason) ?? safeDiagnosticText(input.error);
  if (!fallback) return null;

  return {
    headline: "Execução não concluída",
    detail: fallback,
    source: null,
    operation: null,
    providerStatus: null,
    pagesRead: null,
    partialRead: false,
    retryAfterSeconds: null,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeDiagnosticText(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (/(?:https?:\/\/|authorization|bearer|token|secret|password|client_secret)/i.test(text)) {
    return null;
  }
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
'''
)

Path("src/services/generation-run-diagnostics.test.ts").write_text(
    '''import assert from "node:assert/strict";
import test from "node:test";

import {
  runSummaryMentionsTarget,
  summarizeGenerationRunDiagnostic,
} from "./generation-run-diagnostics";

test("summarizes a partial 502 source read without exposing raw provider payload", () => {
  const diagnostic = summarizeGenerationRunDiagnostic({
    error: "raw error should not be needed",
    summary: {
      sourceCollection: {
        failures: [
          {
            source: "Welcome to Night Vale",
            status: 502,
            errorKind: "HTTP_ERROR",
            operation: "show-episodes",
            retryAfterSeconds: null,
          },
        ],
        sources: [
          {
            source: "Welcome to Night Vale",
            pagesRead: 2,
            partialRead: true,
          },
        ],
      },
    },
  });

  assert.ok(diagnostic);
  assert.equal(diagnostic.headline, "Fonte temporariamente indisponível");
  assert.equal(diagnostic.source, "Welcome to Night Vale");
  assert.equal(diagnostic.providerStatus, 502);
  assert.equal(diagnostic.operation, "show-episodes");
  assert.equal(diagnostic.pagesRead, 2);
  assert.equal(diagnostic.partialRead, true);
});

test("target membership is recovered from targetScope or target summaries", () => {
  assert.equal(runSummaryMentionsTarget({ targetScope: ["target-a"] }, "target-a"), true);
  assert.equal(
    runSummaryMentionsTarget({ targets: [{ targetPlaylistId: "target-b" }] }, "target-b"),
    true,
  );
  assert.equal(runSummaryMentionsTarget({ targetScope: ["target-a"] }, "target-z"), false);
});

test("free-text diagnostics reject strings that look sensitive", () => {
  assert.equal(
    summarizeGenerationRunDiagnostic({
      summary: null,
      error: "Authorization: Bearer abc123",
    }),
    null,
  );
});
'''
)


# ---------------------------------------------------------------------------
# Playlist page: last applied playlist + recent run history with failures.
# ---------------------------------------------------------------------------
page = "src/app/dashboard/playlists/[targetId]/page.tsx"
replace_once(
    page,
    'import { prisma } from "@/lib/prisma";',
    '''import { prisma } from "@/lib/prisma";
import {
  runSummaryMentionsTarget,
  summarizeGenerationRunDiagnostic,
} from "@/services/generation-run-diagnostics";''',
)

replace_once(
    page,
    '''  const run = await prisma.generationRun.findFirst({
    where: {
      userId: session.user.id,
      simulation: false,
      status: { in: ["SUCCESS", "PARTIAL"] },
      items: {
        some: { targetPlaylistId: target.id },
      },
    },
    orderBy: { startedAt: "desc" },
    include: {
      items: {
        where: { targetPlaylistId: target.id },
        orderBy: { position: "asc" },
      },
    },
  });''',
    '''  const [run, recentCandidates] = await Promise.all([
    prisma.generationRun.findFirst({
      where: {
        userId: session.user.id,
        simulation: false,
        status: { in: ["SUCCESS", "PARTIAL"] },
        items: {
          some: { targetPlaylistId: target.id },
        },
      },
      orderBy: { startedAt: "desc" },
      include: {
        items: {
          where: { targetPlaylistId: target.id },
          orderBy: { position: "asc" },
        },
      },
    }),
    prisma.generationRun.findMany({
      where: {
        userId: session.user.id,
        simulation: false,
      },
      orderBy: { startedAt: "desc" },
      take: 40,
      select: {
        id: true,
        trigger: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        error: true,
        summary: true,
        items: {
          where: { targetPlaylistId: target.id },
          select: { id: true },
          take: 1,
        },
        scheduleRuns: {
          where: { targetPlaylistId: target.id },
          orderBy: { startedAt: "desc" },
          select: { status: true, reason: true, attempt: true },
          take: 1,
        },
      },
    }),
  ]);

  const recentRuns = recentCandidates
    .filter(
      (candidate) =>
        candidate.items.length > 0 ||
        candidate.scheduleRuns.length > 0 ||
        runSummaryMentionsTarget(candidate.summary, target.id),
    )
    .slice(0, 8);''',
)

history = '''

        <section className="product-panel overflow-hidden">
          <div className="border-b border-line-dark/55 px-5 py-5 sm:px-6">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              Histórico operacional
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
              Execuções recentes
            </h2>
            <p className="mt-1 text-sm text-muted-inverse">
              Sucessos, execuções parciais e falhas deste destino. Nenhuma consulta extra ao Spotify é feita para montar este histórico.
            </p>
          </div>

          {recentRuns.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-inverse sm:px-6">
              Nenhuma execução real deste destino foi registrada ainda.
            </div>
          ) : (
            <div className="divide-y divide-line-dark/45">
              {recentRuns.map((recentRun) => {
                const schedule = recentRun.scheduleRuns[0] ?? null;
                const diagnostic = summarizeGenerationRunDiagnostic({
                  summary: recentRun.summary,
                  error: recentRun.error,
                  scheduleReason: schedule?.reason ?? null,
                });

                return (
                  <article key={recentRun.id} className="px-5 py-5 sm:px-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${runStatusClass(recentRun.status)}`}
                          >
                            <UiIcon
                              name={recentRun.status === "SUCCESS" ? "check" : "warning"}
                              size={13}
                            />
                            {runStatusLabel(recentRun.status)}
                          </span>
                          <span className="text-xs font-bold text-muted-inverse">
                            {triggerLabel(recentRun.trigger)}
                          </span>
                          {schedule && schedule.attempt > 1 ? (
                            <span className="text-xs font-semibold text-muted-inverse">
                              tentativa {schedule.attempt}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-2 font-black text-ink-inverse">
                          {formatRunDate(recentRun.startedAt)}
                        </p>
                        <p className="mt-1 break-all text-xs text-muted-inverse">
                          Run <code className="text-ink-inverse">{recentRun.id}</code>
                        </p>
                      </div>

                      {recentRun.finishedAt ? (
                        <span className="text-xs font-semibold text-muted-inverse">
                          finalizada {formatRunDate(recentRun.finishedAt)}
                        </span>
                      ) : null}
                    </div>

                    {diagnostic ? (
                      <details
                        className={`mt-4 rounded-2xl border p-4 ${
                          recentRun.status === "FAILED"
                            ? "border-red-400/25 bg-red-500/10"
                            : "border-amber-400/20 bg-amber-400/5"
                        }`}
                        open={recentRun.status === "FAILED"}
                      >
                        <summary className="cursor-pointer list-none font-black text-ink-inverse">
                          {diagnostic.headline}
                        </summary>
                        <p className="mt-2 text-sm leading-6 text-muted-inverse">
                          {diagnostic.detail}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-muted-inverse">
                          {diagnostic.source ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              {diagnostic.source}
                            </span>
                          ) : null}
                          {diagnostic.operation ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              {diagnostic.operation}
                            </span>
                          ) : null}
                          {diagnostic.providerStatus !== null ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              HTTP {diagnostic.providerStatus}
                            </span>
                          ) : null}
                          {diagnostic.pagesRead !== null ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              {diagnostic.pagesRead} página{diagnostic.pagesRead === 1 ? "" : "s"} lida{diagnostic.pagesRead === 1 ? "" : "s"}
                            </span>
                          ) : null}
                          {diagnostic.partialRead ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              leitura parcial descartada
                            </span>
                          ) : null}
                          {diagnostic.retryAfterSeconds !== null ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              retry após {diagnostic.retryAfterSeconds}s
                            </span>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>'''

replace_once(
    page,
    '''        )}
      </div>''',
    '''        )}''' + history + '''
      </div>''',
)

replace_once(
    page,
    '''function Metric({ label, value }: { label: string; value: string }) {''',
    '''function runStatusClass(status: string): string {
  if (status === "SUCCESS") return "status-success";
  if (status === "PARTIAL") return "status-warning";
  return "border-red-400/30 bg-red-500/10 text-red-200";
}

function runStatusLabel(status: string): string {
  if (status === "SUCCESS") return "SUCESSO";
  if (status === "PARTIAL") return "PARCIAL";
  if (status === "FAILED") return "FALHA";
  return status;
}

function triggerLabel(trigger: string): string {
  if (trigger === "SCHEDULED") return "Agendada";
  if (trigger === "MANUAL") return "Manual";
  return trigger;
}

function Metric({ label, value }: { label: string; value: string }) {''',
)
