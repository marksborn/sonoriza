export type SimulationInconclusiveReason =
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "SOURCE_UNAVAILABLE";

export type InconclusiveSourceDiagnostic = {
  source: string;
  state: "CONFIRMED" | "UNAVAILABLE" | "NOT_ATTEMPTED";
  stateLabel: string;
  detail: string;
  pagesRead: number;
  partialRead: boolean;
  httpStatus: number | null;
  operation: string | null;
  retryAfterSeconds: number | null;
};

export type InconclusiveSimulationView = {
  title: string;
  reason: SimulationInconclusiveReason;
  reasonLabel: string;
  message: string;
  retryHint: string;
  canRetryFromCard: boolean;
  configuredSourceCount: number;
  readSourceCount: number;
  confirmedSourceCount: number;
  unavailableSourceCount: number;
  notAttemptedSourceCount: number;
  countsExact: boolean;
  unavailableSources: string[];
  sourceDiagnostics: InconclusiveSourceDiagnostic[];
};

type UnknownRecord = Record<string, unknown>;

export function readInconclusiveSimulation(
  summary: unknown,
): InconclusiveSimulationView | null {
  const root = asRecord(summary);
  if (!root || root.inconclusive !== true) return null;

  const sourceCollection = asRecord(root.sourceCollection);
  const spotifyApi = asRecord(root.spotifyApi);
  const callsByOperation = asRecord(spotifyApi?.callsByOperation);
  const failures = Array.isArray(sourceCollection?.failures)
    ? sourceCollection.failures.flatMap((entry) => {
        const value = asRecord(entry);
        return value ? [value] : [];
      })
    : [];
  const sourceStatuses = Array.isArray(sourceCollection?.sources)
    ? sourceCollection.sources.flatMap((entry) => {
        const value = asRecord(entry);
        return value ? [value] : [];
      })
    : [];

  const reason = readReason(root.inconclusiveReason, failures);
  const retryAfterSeconds = failures.reduce<number | null>((current, failure) => {
    const candidate = finiteNumber(failure.retryAfterSeconds);
    if (candidate === null || candidate < 0) return current;
    return current === null ? candidate : Math.max(current, candidate);
  }, null);

  const configuredSourceCount = nonNegativeCount(sourceCollection?.configuredSourceCount);
  const readSourceCount = nonNegativeCount(sourceCollection?.readSourceCount);
  const exactStatusesAvailable = sourceStatuses.length > 0;
  const confirmedSourceCount = nonNegativeCount(
    sourceCollection?.confirmedSourceCount,
    exactStatusesAvailable
      ? sourceStatuses.filter((source) => source.state === "CONFIRMED").length
      : readSourceCount,
  );
  const unavailableSourceCount = nonNegativeCount(
    sourceCollection?.unavailableSourceCount,
    exactStatusesAvailable
      ? sourceStatuses.filter((source) => source.state === "UNAVAILABLE").length
      : failures.length,
  );
  const exactNotAttemptedSourceCount = finiteNumber(sourceCollection?.notAttemptedSourceCount);
  const notAttemptedSourceCount =
    exactNotAttemptedSourceCount !== null
      ? Math.max(0, Math.trunc(exactNotAttemptedSourceCount))
      : exactStatusesAvailable
        ? sourceStatuses.filter((source) => source.state === "NOT_ATTEMPTED").length
        : Math.max(0, configuredSourceCount - readSourceCount - unavailableSourceCount);

  const sourceDiagnostics = exactStatusesAvailable
    ? sourceStatuses.map((source) =>
        readSourceStatusDiagnostic(source, callsByOperation),
      )
    : failures.map((failure) => readFailureDiagnostic(failure));

  return {
    title: "Não foi possível concluir a simulação",
    reason,
    reasonLabel: reasonLabel(reason),
    message: reasonMessage(reason),
    retryHint: retryHint(reason, retryAfterSeconds),
    canRetryFromCard: reason === "SOURCE_UNAVAILABLE",
    configuredSourceCount,
    readSourceCount,
    confirmedSourceCount,
    unavailableSourceCount,
    notAttemptedSourceCount,
    countsExact: exactStatusesAvailable || exactNotAttemptedSourceCount !== null,
    unavailableSources: unique(
      sourceDiagnostics
        .filter((diagnostic) => diagnostic.state === "UNAVAILABLE")
        .map((diagnostic) => diagnostic.source),
    ),
    sourceDiagnostics,
  };
}

function readSourceStatusDiagnostic(
  source: UnknownRecord,
  callsByOperation: UnknownRecord | null,
): InconclusiveSourceDiagnostic {
  const state =
    source.state === "CONFIRMED" ||
    source.state === "UNAVAILABLE" ||
    source.state === "NOT_ATTEMPTED"
      ? source.state
      : "NOT_ATTEMPTED";
  const pagesRead = nonNegativeCount(source.pagesRead);
  const partialRead = source.partialRead === true;

  if (state === "CONFIRMED") {
    return {
      source: safeSourceLabel(source),
      state,
      stateLabel: "Confirmada",
      detail:
        pagesRead > 0
          ? `Fonte consultada sem falhas até o ponto necessário nesta execução (${pagesRead} ${pagesRead === 1 ? "página lida" : "páginas lidas"}).`
          : "Fonte confirmada sem falhas nesta execução, possivelmente com reaproveitamento seguro do cache conhecido.",
      pagesRead,
      partialRead: false,
      httpStatus: null,
      operation: null,
      retryAfterSeconds: null,
    };
  }

  if (state === "NOT_ATTEMPTED") {
    return {
      source: safeSourceLabel(source),
      state,
      stateLabel: "Não verificada",
      detail:
        "Esta fonte não chegou a ser verificada porque a execução foi interrompida depois da falha de outra fonte. Isso não significa que ela esteja vazia ou com problema.",
      pagesRead,
      partialRead: false,
      httpStatus: null,
      operation: null,
      retryAfterSeconds: null,
    };
  }

  const errorKind = safeErrorKind(source.errorKind);
  const status = nonNegativeNullableInteger(source.status);
  const operation = safeOperation(source.operation);
  const retryAfterSeconds = nonNegativeNullableInteger(source.retryAfterSeconds);
  const postProviderLocalFailure = isPostProviderLocalPodcastFailure(
    source,
    pagesRead,
    errorKind,
    operation,
    callsByOperation,
  );
  const partialPrefix = partialRead
    ? pagesRead > 0
      ? `A fonte chegou a ser lida parcialmente (${pagesRead} ${pagesRead === 1 ? "página" : "páginas"}) antes da falha. `
      : "A fonte chegou a ser lida parcialmente antes da falha. "
    : "";

  return {
    source: safeSourceLabel(source),
    state,
    stateLabel: "Indisponível",
    detail:
      partialPrefix +
      failureDetail(
        errorKind,
        status,
        operation,
        retryAfterSeconds,
        postProviderLocalFailure,
      ),
    pagesRead,
    partialRead,
    httpStatus: status,
    operation,
    retryAfterSeconds,
  };
}

function readFailureDiagnostic(failure: UnknownRecord): InconclusiveSourceDiagnostic {
  const errorKind = safeErrorKind(failure.errorKind);
  const status = nonNegativeNullableInteger(failure.status);
  const operation = safeOperation(failure.operation);
  const retryAfterSeconds = nonNegativeNullableInteger(failure.retryAfterSeconds);

  return {
    source: safeSourceLabel(failure),
    state: "UNAVAILABLE",
    stateLabel: "Indisponível",
    detail: failureDetail(errorKind, status, operation, retryAfterSeconds, false),
    pagesRead: 0,
    partialRead: false,
    httpStatus: status,
    operation,
    retryAfterSeconds,
  };
}

function safeErrorKind(
  value: unknown,
): "QUOTA_EXCEEDED" | "RATE_LIMITED" | "HTTP_ERROR" | "SOURCE_READ_FAILED" {
  return value === "QUOTA_EXCEEDED" ||
    value === "RATE_LIMITED" ||
    value === "HTTP_ERROR" ||
    value === "SOURCE_READ_FAILED"
    ? value
    : "SOURCE_READ_FAILED";
}

function failureDetail(
  errorKind: "QUOTA_EXCEEDED" | "RATE_LIMITED" | "HTTP_ERROR" | "SOURCE_READ_FAILED",
  status: number | null,
  operation: string | null,
  retryAfterSeconds: number | null,
  postProviderLocalFailure: boolean,
): string {
  const during = operation ? ` durante ${operationLabel(operation)}` : "";

  if (errorKind === "QUOTA_EXCEEDED") {
    return `O Spotify recusou a leitura porque a quota disponível foi atingida${during}. Nenhum dado parcial dessa fonte foi usado para validar o plano.`;
  }

  if (errorKind === "RATE_LIMITED") {
    const retry =
      retryAfterSeconds !== null && retryAfterSeconds > 0
        ? ` O Spotify pediu para aguardar pelo menos ${retryAfterSeconds} ${
            retryAfterSeconds === 1 ? "segundo" : "segundos"
          }.`
        : "";
    return `O Spotify limitou temporariamente a leitura${during}, mesmo após a tentativa controlada de retry.${retry}`;
  }

  if (errorKind === "HTTP_ERROR") {
    if (status === 404) {
      return `O Spotify informou que a fonte não foi encontrada${during} (HTTP 404). Ela pode ter sido removida, tornado privada ou deixado de estar acessível para esta conta.`;
    }
    if (status === 403) {
      return `O Spotify recusou o acesso à fonte${during} (HTTP 403). A fonte existe, mas esta conta ou aplicação não recebeu permissão para essa leitura.`;
    }
    if (status === 401) {
      return `O Spotify não aceitou a autorização usada para ler a fonte${during} (HTTP 401). Pode ser necessário reconectar a conta do Spotify.`;
    }
    if (status !== null && status >= 500) {
      return `O Spotify apresentou uma falha temporária${during} (HTTP ${status}). A configuração não foi considerada incorreta.`;
    }
    if (status !== null) {
      return `O Spotify não conseguiu concluir a leitura${during} (HTTP ${status}). A configuração não foi considerada incorreta.`;
    }
  }

  if (postProviderLocalFailure) {
    return "O Spotify entregou a página solicitada, mas o Sonoriza falhou depois da resposta, durante o processamento local dos episódios. A execução foi interrompida para não validar o plano com estado de escuta incompleto.";
  }

  return `A leitura da fonte não pôde ser concluída${during}. O Sonoriza interrompeu a coleta para não avaliar a configuração com dados incompletos.`;
}

function isPostProviderLocalPodcastFailure(
  source: UnknownRecord,
  pagesRead: number,
  errorKind: "QUOTA_EXCEEDED" | "RATE_LIMITED" | "HTTP_ERROR" | "SOURCE_READ_FAILED",
  operation: string | null,
  callsByOperation: UnknownRecord | null,
): boolean {
  if (
    errorKind !== "SOURCE_READ_FAILED" ||
    operation !== null ||
    pagesRead <= 0 ||
    source.kind !== "PODCAST" ||
    !callsByOperation
  ) {
    return false;
  }

  const providerOperation =
    source.spotifyType === "SHOW"
      ? "show-episodes"
      : source.spotifyType === "SAVED_EPISODES"
        ? "saved-episodes"
        : source.spotifyType === "PLAYLIST"
          ? "playlist-items"
          : null;
  if (!providerOperation) return false;

  const providerCalls = finiteNumber(callsByOperation[providerOperation]);
  if (providerCalls === null) return false;

  // Request metrics are incremented before fetch. Equal call/page counts mean
  // no additional provider request was even attempted after the pages already
  // received, so a generic failure happened on the local post-response path.
  return Math.max(0, Math.trunc(providerCalls)) === pagesRead;
}

function readReason(
  raw: unknown,
  failures: UnknownRecord[],
): SimulationInconclusiveReason {
  if (
    raw === "QUOTA_EXCEEDED" ||
    raw === "RATE_LIMITED" ||
    raw === "SOURCE_UNAVAILABLE"
  ) {
    return raw;
  }

  if (failures.some((failure) => failure.errorKind === "QUOTA_EXCEEDED")) {
    return "QUOTA_EXCEEDED";
  }
  if (failures.some((failure) => failure.errorKind === "RATE_LIMITED")) {
    return "RATE_LIMITED";
  }
  return "SOURCE_UNAVAILABLE";
}

function reasonLabel(reason: SimulationInconclusiveReason): string {
  if (reason === "QUOTA_EXCEEDED") return "Quota do Spotify temporariamente indisponível";
  if (reason === "RATE_LIMITED") return "Limite temporário de requisições do Spotify";
  return "Uma ou mais fontes ficaram temporariamente indisponíveis";
}

function reasonMessage(reason: SimulationInconclusiveReason): string {
  if (reason === "QUOTA_EXCEEDED") {
    return "O Spotify atingiu a quota disponível durante a leitura das fontes. O Sonoriza interrompeu a coleta antes do planner, então nenhuma conclusão foi tirada sobre mix, fontes ou limites.";
  }
  if (reason === "RATE_LIMITED") {
    return "O Spotify continuou limitando a leitura mesmo após a tentativa controlada de retry. O Sonoriza não avaliou o planner com um pool parcial.";
  }
  return "Não foi possível concluir a leitura e o processamento de todas as fontes necessárias. O Sonoriza tratou a coleta como incompleta e não usou os dados parciais para julgar a configuração.";
}

function retryHint(
  reason: SimulationInconclusiveReason,
  retryAfterSeconds: number | null,
): string {
  if (reason === "QUOTA_EXCEEDED") {
    return "Tente novamente mais tarde. O Sonoriza não fará uma sequência agressiva de novas tentativas nesta execução.";
  }
  if (reason === "RATE_LIMITED") {
    if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
      const seconds = Math.ceil(retryAfterSeconds);
      return `O Spotify pediu para aguardar pelo menos ${seconds} ${seconds === 1 ? "segundo" : "segundos"}. Tente novamente depois desse intervalo.`;
    }
    return "Tente novamente em alguns instantes. A tentativa anterior já respeitou o retry controlado desta execução.";
  }
  return "Você pode tentar a simulação novamente. Se a indisponibilidade persistir, consulte os avisos técnicos antes de alterar a configuração.";
}

function safeSourceLabel(failure: UnknownRecord): string {
  const source = typeof failure.source === "string" ? failure.source.trim() : "";
  if (source && !/^(PLAYLIST|SHOW|SAVED_EPISODES):/i.test(source)) return source;

  const kind = failure.kind;
  const spotifyType = failure.spotifyType;
  if (spotifyType === "SAVED_EPISODES") return "Seus episódios";
  if (kind === "PODCAST" && spotifyType === "SHOW") return "Programa do Spotify";
  if (kind === "PODCAST") return "Playlist de podcasts do Spotify";
  if (kind === "MUSIC") return "Playlist de músicas do Spotify";
  return "Fonte do Spotify";
}

function safeOperation(value: unknown): string | null {
  if (
    value === "playlist-items" ||
    value === "playlist-metadata" ||
    value === "show-episodes" ||
    value === "saved-episodes" ||
    value === "recently-played" ||
    value === "user-playlists" ||
    value === "saved-shows" ||
    value === "current-user" ||
    value === "playlist-write" ||
    value === "spotify-api"
  ) {
    return value;
  }
  return null;
}

function operationLabel(operation: string): string {
  if (operation === "playlist-items") return "a leitura dos itens da playlist";
  if (operation === "playlist-metadata") return "a confirmação dos dados da playlist";
  if (operation === "show-episodes") return "a leitura dos episódios do programa";
  if (operation === "saved-episodes") return "a leitura dos seus episódios salvos";
  if (operation === "recently-played") return "a leitura do histórico recente";
  if (operation === "user-playlists") return "a leitura das playlists da conta";
  if (operation === "saved-shows") return "a leitura dos programas salvos";
  if (operation === "current-user") return "a confirmação da conta Spotify";
  if (operation === "playlist-write") return "uma operação de playlist";
  return "a chamada à API do Spotify";
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeCount(value: unknown, fallback = 0): number {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.max(0, Math.trunc(number));
}

function nonNegativeNullableInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.trunc(number));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
