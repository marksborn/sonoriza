export type Calendar03BlockPreview = Readonly<{
  index: number;
  key: string;
  targetDurationMs: number;
  podcastUsableDurationMs: number;
  diagnosticCodes: string[];
}>;

export type Calendar03TargetPreview = Readonly<{
  requestedMode: string;
  effectiveMode: string;
  activationReason: string;
  plannerInfluence: boolean;
  targetPlaylistId: string;
  targetName: string;
  status: string;
  selectedPodcastUris: string[];
  blocks: Calendar03BlockPreview[];
}>;

export function calendar03TargetPreviewFromSummary(
  summary: unknown,
  targetPlaylistId: string,
): Calendar03TargetPreview | null {
  const normalizedTargetId = targetPlaylistId.trim();
  if (!normalizedTargetId) return null;

  const summaryRecord = asRecord(summary);
  const runtime = asRecord(summaryRecord?.calendar03PlannerRuntime);
  if (runtime?.runtimeVersion !== "calendar03-gate3-runtime-v1") return null;

  const targets = Array.isArray(runtime.targets) ? runtime.targets : [];
  const target = targets
    .map(asRecord)
    .find((candidate) => candidate?.targetPlaylistId === normalizedTargetId);
  if (!target) return null;

  const rawBlocks = Array.isArray(target.blockDiagnostics)
    ? target.blockDiagnostics
    : [];
  const blocks = rawBlocks
    .map(asRecord)
    .flatMap((block) => {
      if (!block) return [];
      const index = integer(block.index);
      const key = text(block.key);
      const targetDurationMs = nonNegativeNumber(block.targetDurationMs);
      const podcastUsableDurationMs = nonNegativeNumber(
        block.podcastUsableDurationMs,
      );
      if (
        index === null ||
        key === null ||
        targetDurationMs === null ||
        podcastUsableDurationMs === null
      ) {
        return [];
      }
      return [
        {
          index,
          key,
          targetDurationMs,
          podcastUsableDurationMs,
          diagnosticCodes: stringArray(block.diagnosticCodes),
        },
      ];
    })
    .sort((left, right) => left.index - right.index);

  return {
    requestedMode: text(runtime.requestedMode) ?? "UNKNOWN",
    effectiveMode: text(runtime.effectiveMode) ?? "UNKNOWN",
    activationReason: text(runtime.activationReason) ?? "UNKNOWN",
    plannerInfluence: runtime.plannerInfluence === true,
    targetPlaylistId: normalizedTargetId,
    targetName: text(target.targetName) ?? normalizedTargetId,
    status: text(target.status) ?? "UNKNOWN",
    selectedPodcastUris: stringArray(target.selectedPodcastUris),
    blocks,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const normalized = text(entry);
    return normalized ? [normalized] : [];
  });
}
