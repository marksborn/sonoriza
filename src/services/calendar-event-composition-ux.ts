export type Calendar04BlockPreview = Readonly<{
  filledDurationMs: number;
  deficitMs: number;
  musicDurationMs: number;
  podcastDurationMs: number;
  initialSequenceSlots: number;
  initialSequenceFilledSlots: number;
  remainderAfterSequenceMs: number;
  remainderFillStrategy: string;
  requestedRemainderPodcastPercent: number | null;
  remainderMusicDurationMs: number;
  remainderPodcastDurationMs: number;
  fallbackMusicDurationMs: number;
}>;

export type Calendar03BlockPreview = Readonly<{
  index: number;
  key: string;
  targetDurationMs: number;
  podcastUsableDurationMs: number;
  diagnosticCodes: string[];
  /** CALENDAR-04 only. */
  calendar04?: Calendar04BlockPreview;
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
      const calendar04 = calendar04BlockPreview(block);
      return [
        {
          index,
          key,
          targetDurationMs,
          podcastUsableDurationMs,
          diagnosticCodes: stringArray(block.diagnosticCodes),
          ...(calendar04 ? { calendar04 } : {}),
        },
      ];
    })
    .sort((left, right) => left.index - right.index);

  return {
    requestedMode: text(runtime.requestedMode) ?? "UNKNOWN",
    effectiveMode: text(runtime.effectiveMode) ?? "UNKNOWN",
    activationReason: text(runtime.activationReason) ?? "UNKNOWN",
    plannerInfluence: target.plannerInfluence === true,
    targetPlaylistId: normalizedTargetId,
    targetName: text(target.targetName) ?? normalizedTargetId,
    status: text(target.status) ?? "UNKNOWN",
    selectedPodcastUris: stringArray(target.selectedPodcastUris),
    blocks,
  };
}

function calendar04BlockPreview(
  block: Record<string, unknown>,
): Calendar04BlockPreview | null {
  const evidence = asRecord(block.calendar04);
  if (!evidence) return null;
  const numbers = {
    filledDurationMs: nonNegativeNumber(block.filledDurationMs),
    deficitMs: nonNegativeNumber(block.deficitMs),
    musicDurationMs: nonNegativeNumber(block.musicDurationMs),
    podcastDurationMs: nonNegativeNumber(block.podcastDurationMs),
    initialSequenceSlots: nonNegativeNumber(evidence.initialSequenceSlots),
    initialSequenceFilledSlots: nonNegativeNumber(evidence.initialSequenceFilledSlots),
    remainderAfterSequenceMs: nonNegativeNumber(evidence.remainderAfterSequenceMs),
    remainderMusicDurationMs: nonNegativeNumber(evidence.remainderMusicDurationMs),
    remainderPodcastDurationMs: nonNegativeNumber(evidence.remainderPodcastDurationMs),
    fallbackMusicDurationMs: nonNegativeNumber(evidence.fallbackMusicDurationMs),
  };
  const strategy = text(evidence.remainderFillStrategy);
  if (!strategy || Object.values(numbers).some((value) => value === null)) return null;
  return {
    ...(numbers as { [K in keyof typeof numbers]: number }),
    remainderFillStrategy: strategy,
    requestedRemainderPodcastPercent: nonNegativeNumber(
      evidence.requestedRemainderPodcastPercent,
    ),
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
