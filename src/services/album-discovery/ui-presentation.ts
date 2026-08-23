import type {
  AlbumOpportunityCandidate,
  AlbumOpportunityReasonCode,
} from "./opportunity";

const REASON_LABELS: Record<AlbumOpportunityReasonCode, string> = {
  HIGH_ARTIST_DEEPENING: "Artista com alta afinidade",
  NO_ALBUM_HISTORY: "Você ainda não explorou este álbum",
  LOW_ALBUM_COVERAGE: "Pouco explorado no seu histórico",
  MODERATE_ALBUM_COVERAGE: "Ainda há bastante para conhecer",
  ALBUM_MOSTLY_KNOWN: "Álbum já bastante conhecido",
  ALBUM_FULLY_OBSERVED: "Álbum praticamente todo conhecido",
  RECENT_ALBUM_ACTIVITY: "Você ouviu este álbum recentemente",
  ELEVATED_ALBUM_SKIP_RATE: "Algumas faixas foram puladas",
  STRONG_ALBUM_SKIP_RATE: "Há sinais fortes de skips neste álbum",
  LABEL_ONLY_COVERAGE_EVIDENCE: "Cobertura histórica aproximada",
  MIXED_COVERAGE_EVIDENCE: "Cobertura combina evidências históricas",
  ALBUM_ALREADY_QUEUED: "Esta edição já foi enfileirada",
};

export function albumReasonLabel(code: AlbumOpportunityReasonCode): string {
  return REASON_LABELS[code];
}

export function albumCoverageSummary(candidate: AlbumOpportunityCandidate): string {
  const observed = candidate.coverage.observedTrackCount;
  const eligible = candidate.coverage.eligibleTrackCount;
  const percent = Math.round((candidate.coverage.analyticCoverage ?? 0) * 100);
  return `${observed} de ${eligible} faixas · ${percent}% conhecido`;
}

export function albumRecommendationReasons(
  candidate: AlbumOpportunityCandidate,
  limit = 3,
): string[] {
  return candidate.reasons.slice(0, Math.max(1, limit)).map((reason) => albumReasonLabel(reason.code));
}

export function formatAlbumDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours}h${String(minutes).padStart(2, "0")}`;
}

export function formatTrackDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
