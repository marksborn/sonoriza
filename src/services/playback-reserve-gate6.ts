import {
  normalizeGenerationPlanRole,
  type GenerationPlanRoleValue,
} from "./playback-reserve-policy";

export type GenerationPlanItemRoleCoordinate = Readonly<{
  runId: string;
  targetPlaylistId: string;
  position: number;
}>;

export type GenerationPlanItemRoleRow = GenerationPlanItemRoleCoordinate &
  Readonly<{
    role: GenerationPlanRoleValue;
  }>;

/**
 * PLAYBACK-RESERVE-01 Gate 6 behavioral-evidence boundary.
 *
 * Historical GenerationItems predate GenerationPlanItemRole, therefore an
 * absent sidecar row is deliberately PRIMARY for backward compatibility.
 * Explicit RESERVE is excluded from MUSIC-06 gap/negative inference and from
 * MUSIC-07 publication exposure until a future contract can prove that the
 * reserve region was actually reached during playback.
 */
export function generationPlanItemParticipatesInBehavioralEvidence(
  role: GenerationPlanRoleValue | null | undefined,
): boolean {
  return normalizeGenerationPlanRole(role) === "PRIMARY";
}

export function generationPlanItemRoleCoordinateKey(
  coordinate: GenerationPlanItemRoleCoordinate,
): string {
  const runId = requiredId(coordinate.runId, "runId");
  const targetPlaylistId = requiredId(
    coordinate.targetPlaylistId,
    "targetPlaylistId",
  );
  if (!Number.isInteger(coordinate.position) || coordinate.position < 0) {
    throw new Error("position must be a non-negative integer.");
  }
  return `${runId}\u0000${targetPlaylistId}\u0000${coordinate.position}`;
}

export function buildGenerationPlanItemRoleIndex(
  rows: readonly GenerationPlanItemRoleRow[],
): ReadonlyMap<string, GenerationPlanRoleValue> {
  const index = new Map<string, GenerationPlanRoleValue>();
  for (const row of rows) {
    const key = generationPlanItemRoleCoordinateKey(row);
    if (index.has(key)) {
      throw new Error(`Duplicate generation plan role coordinate: ${key}`);
    }
    index.set(key, normalizeGenerationPlanRole(row.role));
  }
  return index;
}

export function resolveGenerationPlanItemRole(
  index: ReadonlyMap<string, GenerationPlanRoleValue>,
  coordinate: GenerationPlanItemRoleCoordinate,
): GenerationPlanRoleValue {
  return normalizeGenerationPlanRole(
    index.get(generationPlanItemRoleCoordinateKey(coordinate)),
  );
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
