export type GenerationRunDiagnostic = {
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
