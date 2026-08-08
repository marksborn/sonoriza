export type SimulationInconclusiveReason =
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "SOURCE_UNAVAILABLE";

export type InconclusiveSimulationView = {
  title: string;
  reason: SimulationInconclusiveReason;
  reasonLabel: string;
  message: string;
  retryHint: string;
  canRetryFromCard: boolean;
  configuredSourceCount: number;
  readSourceCount: number;
  unavailableSourceCount: number;
  unavailableSources: string[];
};

type UnknownRecord = Record<string, unknown>;

export function readInconclusiveSimulation(
  summary: unknown,
): InconclusiveSimulationView | null {
  const root = asRecord(summary);
  if (!root || root.inconclusive !== true) return null;

  const sourceCollection = asRecord(root.sourceCollection);
  const failures = Array.isArray(sourceCollection?.failures)
    ? sourceCollection.failures.flatMap((entry) => {
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

  return {
    title: "Não foi possível concluir a simulação",
    reason,
    reasonLabel: reasonLabel(reason),
    message: reasonMessage(reason),
    retryHint: retryHint(reason, retryAfterSeconds),
    canRetryFromCard: reason === "SOURCE_UNAVAILABLE",
    configuredSourceCount: nonNegativeCount(sourceCollection?.configuredSourceCount),
    readSourceCount: nonNegativeCount(sourceCollection?.readSourceCount),
    unavailableSourceCount: nonNegativeCount(
      sourceCollection?.unavailableSourceCount,
      failures.length,
    ),
    unavailableSources: unique(
      failures.map((failure) => safeSourceLabel(failure)),
    ),
  };
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
  return "O Spotify não permitiu ler todas as fontes necessárias. O Sonoriza tratou a coleta como incompleta e não usou os dados parciais para julgar a configuração.";
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
