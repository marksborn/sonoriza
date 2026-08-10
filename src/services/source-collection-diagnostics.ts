export type SourceCollectionState =
  | "CONFIRMED"
  | "UNAVAILABLE"
  | "NOT_ATTEMPTED";

export type SourceCollectionFailureRecord = {
  sourceId: string;
  source: string;
  kind: string;
  spotifyType: string;
  errorKind: string;
  status: number | null;
  reason: string | null;
  operation: string | null;
  retryAfterSeconds: number | null;
};

export type SourceCollectionSource = {
  id: string;
  name: string | null;
  kind: string;
  spotifyType: string;
  spotifyId: string;
};

export type SourceCollectionPublicFailure = Omit<
  SourceCollectionFailureRecord,
  "sourceId"
>;

export type SourceCollectionSourceStatus = {
  source: string;
  kind: string;
  spotifyType: string;
  state: SourceCollectionState;
  pagesRead: number;
  partialRead: boolean;
  errorKind: string | null;
  status: number | null;
  reason: string | null;
  operation: string | null;
  retryAfterSeconds: number | null;
};

export type SourceCollectionDiagnosticSummary = {
  configuredSourceCount: number;
  attemptedSourceCount: number;
  readSourceCount: number;
  confirmedSourceCount: number;
  unavailableSourceCount: number;
  notAttemptedSourceCount: number;
  failures: SourceCollectionPublicFailure[];
  sources: SourceCollectionSourceStatus[];
};

type SourceReadMetric = { pagesRead?: number };

export function buildSourceCollectionDiagnosticSummary(input: {
  sources: SourceCollectionSource[];
  attemptedSourceIds: ReadonlySet<string>;
  readSourceIds: ReadonlySet<string>;
  failures: SourceCollectionFailureRecord[];
  sourceReads?: Record<string, SourceReadMetric>;
}): SourceCollectionDiagnosticSummary {
  const failureBySourceId = new Map(
    input.failures.map((failure) => [failure.sourceId, failure]),
  );

  const sources = input.sources.map<SourceCollectionSourceStatus>((source) => {
    const failure = failureBySourceId.get(source.id) ?? null;
    const pagesRead = sourcePagesRead(source, input.sourceReads ?? {});
    const wasRead = input.readSourceIds.has(source.id);

    const state: SourceCollectionState = failure
      ? "UNAVAILABLE"
      : wasRead
        ? "CONFIRMED"
        : "NOT_ATTEMPTED";

    return {
      source: safeConfiguredSourceLabel(source),
      kind: source.kind,
      spotifyType: source.spotifyType,
      state,
      pagesRead,
      partialRead: state === "UNAVAILABLE" && (wasRead || pagesRead > 0),
      errorKind: failure?.errorKind ?? null,
      status: failure?.status ?? null,
      reason: failure?.reason ?? null,
      operation: failure?.operation ?? null,
      retryAfterSeconds: failure?.retryAfterSeconds ?? null,
    };
  });

  return {
    configuredSourceCount: sources.length,
    attemptedSourceCount: input.attemptedSourceIds.size,
    readSourceCount: input.readSourceIds.size,
    confirmedSourceCount: sources.filter((source) => source.state === "CONFIRMED").length,
    unavailableSourceCount: sources.filter((source) => source.state === "UNAVAILABLE").length,
    notAttemptedSourceCount: sources.filter((source) => source.state === "NOT_ATTEMPTED").length,
    failures: input.failures.map(({ sourceId: _sourceId, ...failure }) => failure),
    sources,
  };
}

export function safeConfiguredSourceLabel(source: {
  name: string | null;
  kind: string;
  spotifyType: string;
}): string {
  const name = source.name?.trim();
  if (name) return name;
  if (source.spotifyType === "SAVED_EPISODES") return "Seus episódios";
  if (source.kind === "PODCAST" && source.spotifyType === "SHOW") {
    return "Programa do Spotify";
  }
  if (source.kind === "PODCAST") return "Playlist de podcasts do Spotify";
  if (source.kind === "MUSIC") return "Playlist de músicas do Spotify";
  return "Fonte do Spotify";
}

function sourcePagesRead(
  source: SourceCollectionSource,
  sourceReads: Record<string, SourceReadMetric>,
): number {
  const key =
    source.spotifyType === "SAVED_EPISODES"
      ? "SAVED_EPISODES"
      : `${source.spotifyType}:${source.spotifyId}`;
  const pagesRead = sourceReads[key]?.pagesRead;
  return typeof pagesRead === "number" && Number.isFinite(pagesRead)
    ? Math.max(0, Math.trunc(pagesRead))
    : 0;
}
