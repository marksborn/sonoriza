/** #374 Gate 5D.3 — bounded historical sample selection; no provider calls. */
const MAX_POSITIONS = 5;
const MAX_POSITION = 500;

export type Gate5CHistoricalSelection = Readonly<{
  runId: string | null;
  positions: readonly number[] | null;
}>;

export function parseGate5CHistoricalPositions(raw: string): number[] {
  if (!/^[1-9]\d*(,[1-9]\d*){0,4}$/.test(raw)) {
    throw new Error("Gate 5D.3: --positions must be 1–5 distinct positive integers");
  }
  const positions = raw.split(",").map(Number);
  if (positions.some((position) => !Number.isSafeInteger(position) || position > MAX_POSITION)) {
    throw new Error("Gate 5D.3: positions must be integers from 1 to 500");
  }
  if (new Set(positions).size !== positions.length) {
    throw new Error("Gate 5D.3: duplicate positions are not allowed");
  }
  return positions;
}

export function validateGate5CHistoricalSelection(input: {
  runId?: string | null;
  positions?: readonly number[] | null;
  paginationRequested?: boolean;
}): Gate5CHistoricalSelection {
  const runId = input.runId === undefined || input.runId === null
    ? null
    : input.runId.trim();

  if (runId !== null && !/^[a-z0-9_-]{1,128}$/i.test(runId)) {
    throw new Error("Gate 5D.3: invalid or empty historical run id");
  }
  const positions = input.positions ?? null;
  if (positions !== null) {
    if (!runId) throw new Error("Gate 5D.3: --positions requires --run-id");
    if (input.paginationRequested) {
      throw new Error("Gate 5D.3: --positions cannot be combined with --offset or --limit");
    }
    if (positions.length < 1 || positions.length > MAX_POSITIONS
      || positions.some((position) => !Number.isSafeInteger(position) || position < 1 || position > MAX_POSITION)
      || new Set(positions).size !== positions.length) {
      throw new Error("Gate 5D.3: invalid or duplicate positions (1–500, max 5)");
    }
  }
  return { runId, positions: positions === null ? null : [...positions] };
}
