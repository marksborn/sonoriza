import type { Candidate } from "@/services/playlist-planner";

export type PodcastEpisodeOrderValue =
  | "SOURCE_DEFAULT"
  | "OLDEST_FIRST"
  | "NEWEST_FIRST";

export function sortShowCandidates(
  candidates: Candidate[],
  order: PodcastEpisodeOrderValue,
): Candidate[] {
  if (order === "SOURCE_DEFAULT") return [...candidates];
  const direction = order === "OLDEST_FIRST" ? 1 : -1;
  return [...candidates].sort((left, right) => {
    const leftKey = releaseKey(left.releaseDate, left.releaseDatePrecision);
    const rightKey = releaseKey(right.releaseDate, right.releaseDatePrecision);
    if (leftKey === null && rightKey !== null) return 1;
    if (leftKey !== null && rightKey === null) return -1;
    if (leftKey !== null && rightKey !== null && leftKey !== rightKey) {
      return (leftKey < rightKey ? -1 : 1) * direction;
    }
    return left.uri.localeCompare(right.uri);
  });
}

function releaseKey(date: string | undefined, precision: string | undefined): string | null {
  if (!date) return null;
  const parts = date.split("-");
  const year = Number(parts[0]);
  if (!Number.isInteger(year)) return null;
  const month = precision === "year" ? 0 : Number(parts[1] ?? 0);
  const day = precision === "day" ? Number(parts[2] ?? 0) : 0;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
