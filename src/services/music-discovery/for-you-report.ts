import { prisma } from "@/lib/prisma";
import { LastFmSimilarityClient } from "@/services/lastfm/similarity";

import { getBatchedRetainedCompleteMusicDiscoveryProfile } from "./complete-profile-batched";
import {
  acquireLastFmExternalDiscovery,
  evaluateExternalDiscoveryCandidates,
  type AcquiredExternalDiscoveryCandidate,
  type ExternalDiscoveryHistoryEvidence,
} from "./external-discovery";
import type { DiscoveryTrackProfile } from "./profile";
import {
  buildDiscoveryGate22ScoringReport,
  type DiscoveryGate22ReasonCode,
  type DiscoveryGate22TrackCandidate,
} from "./scoring-gate2-2";
import type { DiscoveryScoreReasonCode } from "./scoring";
import { getDiscoveryTrackIdentityEvidence } from "./track-identity";

const DEFAULT_LIMIT_PER_CATEGORY = 4;
const EXTERNAL_ARTIST_SEEDS = 4;
const EXTERNAL_TRACK_SEEDS = 6;
const EXTERNAL_PER_SEED = 6;

export type ForYouCategory = "FAMILIAR" | "REDESCOBERTA" | "DESCOBERTA";

export type ForYouProvenance =
  | "LISTENING_HISTORY"
  | "REDISCOVERY"
  | "LASTFM_SIMILAR_ARTIST"
  | "LASTFM_SIMILAR_TRACK";

export type ForYouRecommendation = {
  key: string;
  category: ForYouCategory;
  artistName: string;
  trackName: string;
  albumName: string | null;
  spotifyTrackId: string | null;
  score: number;
  reasonCodes: Array<DiscoveryGate22ReasonCode | DiscoveryScoreReasonCode>;
  provenance: ForYouProvenance;
  playCount: number | null;
  plays30d: number | null;
  lastPlayedAt: Date | null;
  seedArtistName: string | null;
  seedTrackName: string | null;
};

export type ForYouExternalStatus =
  | "READY"
  | "PARTIAL"
  | "ABSTAINED"
  | "UNAVAILABLE";

export type ForYouReport = {
  generatedAt: Date;
  coverage: {
    totalCanonicalEvents: number;
    firstPlayedAt: Date | null;
    lastPlayedAt: Date | null;
  };
  cooldown: {
    enabled: boolean;
    complete: boolean;
  };
  familiar: ForYouRecommendation[];
  rediscovery: ForYouRecommendation[];
  discovery: ForYouRecommendation[];
  external: {
    status: ForYouExternalStatus;
    providerFailures: number;
    note: string;
  };
};

export type ForYouReportOptions = {
  limitPerCategory?: number;
};

export async function getForYouReport(
  userId: string,
  options: ForYouReportOptions = {},
): Promise<ForYouReport> {
  const limitPerCategory = boundedLimit(
    options.limitPerCategory ?? DEFAULT_LIMIT_PER_CATEGORY,
  );

  const [profile, trackIdentities] = await Promise.all([
    getBatchedRetainedCompleteMusicDiscoveryProfile(userId),
    getDiscoveryTrackIdentityEvidence(userId),
  ]);

  const scoring = buildDiscoveryGate22ScoringReport({
    generatedAt: profile.generatedAt,
    dormantDays: profile.heuristics.dormantDays,
    rediscoveryGapDays: profile.heuristics.rediscoveryGapDays,
    topN: Math.max(limitPerCategory * 3, 12),
    artists: profile.topArtistsHistorical,
    tracks: profile.topTracksHistorical,
    trackIdentities,
    candidateUniverse: "COMPLETE",
  });

  const trackById = new Map(
    profile.topTracksHistorical.map((track) => [track.spotifyTrackId, track] as const),
  );

  const familiar = scoring.familiarCandidates
    .slice(0, limitPerCategory)
    .map((candidate) =>
      localRecommendation(candidate, trackById.get(candidate.spotifyTrackId) ?? null),
    );
  const rediscovery = scoring.rediscoveryCandidates
    .slice(0, limitPerCategory)
    .map((candidate) =>
      localRecommendation(candidate, trackById.get(candidate.spotifyTrackId) ?? null),
    );

  const external = await buildExternalRecommendations({
    userId,
    scoring,
    limit: limitPerCategory,
  });

  return {
    generatedAt: profile.generatedAt,
    coverage: {
      totalCanonicalEvents: profile.coverage.totalCanonicalEvents,
      firstPlayedAt: profile.coverage.firstPlayedAt,
      lastPlayedAt: profile.coverage.lastPlayedAt,
    },
    cooldown: {
      enabled: profile.cooldown.enabled,
      complete: profile.cooldown.complete,
    },
    familiar,
    rediscovery,
    discovery: external.recommendations,
    external: external.status,
  };
}

function localRecommendation(
  candidate: DiscoveryGate22TrackCandidate,
  track: DiscoveryTrackProfile | null,
): ForYouRecommendation {
  return {
    key: `${candidate.category}:${candidate.spotifyTrackId}`,
    category: candidate.category,
    artistName: candidate.artistName,
    trackName: candidate.trackName,
    albumName: track?.albumName ?? null,
    spotifyTrackId: candidate.spotifyTrackId,
    score: candidate.score,
    reasonCodes: candidate.reasons.map((reason) => reason.code),
    provenance:
      candidate.category === "REDESCOBERTA" ? "REDISCOVERY" : "LISTENING_HISTORY",
    playCount: track?.playCount ?? null,
    plays30d: track?.plays30d ?? null,
    lastPlayedAt: track?.lastPlayedAt ?? null,
    seedArtistName: null,
    seedTrackName: null,
  };
}

async function buildExternalRecommendations(input: {
  userId: string;
  scoring: ReturnType<typeof buildDiscoveryGate22ScoringReport>;
  limit: number;
}): Promise<{
  recommendations: ForYouRecommendation[];
  status: ForYouReport["external"];
}> {
  const apiKey = process.env.LASTFM_API_KEY?.trim();
  if (!apiKey) {
    return {
      recommendations: [],
      status: {
        status: "UNAVAILABLE",
        providerFailures: 0,
        note: "Descoberta externa indisponível porque o Last.fm não está configurado.",
      },
    };
  }

  try {
    const artistAffinityByName = new Map(
      input.scoring.topArtistAffinity.map(
        (row) => [normalized(row.artistName), row.score / 100] as const,
      ),
    );
    const artistSeeds = input.scoring.topArtistAffinity
      .slice(0, EXTERNAL_ARTIST_SEEDS)
      .map((row) => ({
        artistName: row.artistName,
        affinity: row.score / 100,
      }));

    const trackSeeds = uniqueScoredTracks([
      ...input.scoring.familiarCandidates,
      ...input.scoring.rediscoveryCandidates,
    ])
      .slice(0, EXTERNAL_TRACK_SEEDS)
      .map((row) => ({
        artistName: row.artistName,
        trackName: row.trackName,
        artistAffinity:
          artistAffinityByName.get(normalized(row.artistName)) ?? row.score / 100,
        trackAffinity: row.score / 100,
      }));

    const acquisition = await acquireLastFmExternalDiscovery({
      provider: new LastFmSimilarityClient({ apiKey }),
      artistSeeds,
      trackSeeds,
      perSeed: EXTERNAL_PER_SEED,
      maxCandidates: Math.max(input.limit * 12, 48),
    });

    const history = await getKnownHistory(input.userId, acquisition.candidates);
    const evaluation = evaluateExternalDiscoveryCandidates({
      candidates: acquisition.candidates,
      historyEvidence: (candidate) => historyEvidenceFor(candidate, history),
      topN: Math.max(input.limit * 4, 16),
    });

    const recommendations = evaluation.eligible
      .filter(
        (candidate): candidate is typeof candidate & { trackName: string } =>
          candidate.candidateType === "TRACK" && Boolean(candidate.trackName),
      )
      .slice(0, input.limit)
      .map<ForYouRecommendation>((candidate) => ({
        key: `DESCOBERTA:${candidate.candidateKey}`,
        category: "DESCOBERTA",
        artistName: candidate.artistName,
        trackName: candidate.trackName,
        albumName: null,
        spotifyTrackId: null,
        score: candidate.scoreCard.score,
        reasonCodes: candidate.scoreCard.reasons.map((reason) => reason.code),
        provenance: candidate.source,
        playCount: null,
        plays30d: null,
        lastPlayedAt: null,
        seedArtistName: candidate.seedArtistName,
        seedTrackName: candidate.seedTrackName,
      }));

    const providerFailures = acquisition.failures.length;
    if (recommendations.length > 0) {
      return {
        recommendations,
        status: {
          status: providerFailures > 0 ? "PARTIAL" : "READY",
          providerFailures,
          note:
            providerFailures > 0
              ? "Algumas consultas de similaridade falharam; as recomendações exibidas usam apenas respostas válidas."
              : "Descoberta externa calculada com similaridade Last.fm e o histórico canônico do Sonoriza.",
        },
      };
    }

    return {
      recommendations: [],
      status: {
        status: acquisition.status === "ABSTAINED" ? "ABSTAINED" : "READY",
        providerFailures,
        note:
          acquisition.abstentionReason === "PROVIDER_ERRORS"
            ? "O provedor de similaridade não respondeu com candidatos válidos agora."
            : "Nenhuma descoberta nova ultrapassou os critérios de qualidade agora.",
      },
    };
  } catch {
    return {
      recommendations: [],
      status: {
        status: "UNAVAILABLE",
        providerFailures: 1,
        note: "O radar de descoberta externa não respondeu agora. Familiaridade e Redescoberta continuam disponíveis normalmente.",
      },
    };
  }
}

export function forYouReasonTexts(
  recommendation: Pick<
    ForYouRecommendation,
    "category" | "reasonCodes" | "seedArtistName" | "seedTrackName"
  >,
  max = 2,
): string[] {
  const messages = recommendation.reasonCodes.flatMap((code) => {
    const message = REASON_TEXT[code];
    return message ? [message] : [];
  });

  if (recommendation.category === "DESCOBERTA" && recommendation.seedArtistName) {
    messages.push(
      recommendation.seedTrackName
        ? `Relacionada a ${recommendation.seedArtistName} — ${recommendation.seedTrackName}.`
        : `Relacionada a ${recommendation.seedArtistName}.`,
    );
  }

  return unique(messages).slice(0, Math.max(1, max));
}

export function forYouStrengthLabel(score: number): string {
  if (score >= 80) return "Afinidade alta";
  if (score >= 65) return "Boa compatibilidade";
  return "Vale explorar";
}

const REASON_TEXT: Partial<
  Record<DiscoveryGate22ReasonCode | DiscoveryScoreReasonCode, string>
> = {
  HIGH_HISTORICAL_AFFINITY: "Você tem afinidade histórica forte com este artista.",
  TRACK_HISTORY_SUPPORT: "Esta faixa tem presença consistente no seu histórico.",
  STRONG_LISTENING_DAY_DEPTH: "Este artista aparece em muitos dias diferentes de escuta.",
  RECENT_INTEREST: "Seu interesse por este artista está recente.",
  POSITIVE_MOMENTUM: "Você tem ouvido mais este artista ultimamente.",
  LOW_EXPLICIT_SKIP_RATE: "Há poucos sinais de pulo nas reproduções observadas.",
  LONG_DORMANCY: "Faz bastante tempo que esta faixa não aparece nas suas escutas.",
  REDISCOVERY_RETURN: "Um favorito antigo voltou a ganhar espaço recentemente.",
  HIGH_SIMILARITY: "A similaridade com referências do seu perfil é alta.",
  STRONG_SEED_AFFINITY: "A recomendação veio de uma referência com alta afinidade.",
};

type HistoryIndex = {
  byArtistName: Map<string, number>;
  byArtistMbid: Map<string, number>;
  byTrackMbid: Map<string, number>;
  byArtistTrackName: Map<string, number>;
};

async function getKnownHistory(
  userId: string,
  candidates: AcquiredExternalDiscoveryCandidate[],
): Promise<HistoryIndex> {
  const artistNames = [...new Set(candidates.map((row) => row.artistName))];
  const artistMbids = [
    ...new Set(
      candidates
        .map((row) => row.artistMbid)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const trackCandidates = candidates.filter(
    (row): row is AcquiredExternalDiscoveryCandidate & { trackName: string } =>
      row.candidateType === "TRACK" && Boolean(row.trackName),
  );
  const trackMbids = [
    ...new Set(
      trackCandidates
        .map((row) => row.trackMbid)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const trackArtistNames = [...new Set(trackCandidates.map((row) => row.artistName))];
  const trackNames = [...new Set(trackCandidates.map((row) => row.trackName))];

  const [artistNameRows, artistMbidRows, trackMbidRows, artistTrackRows] =
    await Promise.all([
      artistNames.length === 0
        ? Promise.resolve([])
        : prisma.trackListeningEvent.groupBy({
            by: ["artistName"],
            where: {
              userId,
              artistName: { in: artistNames, mode: "insensitive" },
            },
            _count: { _all: true },
          }),
      artistMbids.length === 0
        ? Promise.resolve([])
        : prisma.trackListeningEvent.groupBy({
            by: ["artistMbid"],
            where: { userId, artistMbid: { in: artistMbids } },
            _count: { _all: true },
          }),
      trackMbids.length === 0
        ? Promise.resolve([])
        : prisma.trackListeningEvent.groupBy({
            by: ["trackMbid"],
            where: { userId, trackMbid: { in: trackMbids } },
            _count: { _all: true },
          }),
      trackArtistNames.length === 0 || trackNames.length === 0
        ? Promise.resolve([])
        : prisma.trackListeningEvent.groupBy({
            by: ["artistName", "trackName"],
            where: {
              userId,
              artistName: { in: trackArtistNames, mode: "insensitive" },
              trackName: { in: trackNames, mode: "insensitive" },
            },
            _count: { _all: true },
          }),
    ]);

  const byArtistName = new Map<string, number>();
  for (const row of artistNameRows) {
    const key = normalized(row.artistName);
    byArtistName.set(key, (byArtistName.get(key) ?? 0) + row._count._all);
  }

  const byArtistMbid = new Map<string, number>();
  for (const row of artistMbidRows) {
    if (!row.artistMbid) continue;
    byArtistMbid.set(
      row.artistMbid,
      (byArtistMbid.get(row.artistMbid) ?? 0) + row._count._all,
    );
  }

  const byTrackMbid = new Map<string, number>();
  for (const row of trackMbidRows) {
    if (!row.trackMbid) continue;
    byTrackMbid.set(
      row.trackMbid,
      (byTrackMbid.get(row.trackMbid) ?? 0) + row._count._all,
    );
  }

  const byArtistTrackName = new Map<string, number>();
  for (const row of artistTrackRows) {
    const key = artistTrackKey(row.artistName, row.trackName);
    byArtistTrackName.set(
      key,
      (byArtistTrackName.get(key) ?? 0) + row._count._all,
    );
  }

  return { byArtistName, byArtistMbid, byTrackMbid, byArtistTrackName };
}

function historyEvidenceFor(
  candidate: AcquiredExternalDiscoveryCandidate,
  history: HistoryIndex,
): ExternalDiscoveryHistoryEvidence {
  const artistByName = history.byArtistName.get(normalized(candidate.artistName)) ?? 0;
  const artistByMbid = candidate.artistMbid
    ? history.byArtistMbid.get(candidate.artistMbid) ?? 0
    : 0;
  const artistHistoricalPlayCount = Math.max(artistByName, artistByMbid);

  if (candidate.candidateType !== "TRACK" || !candidate.trackName) {
    return {
      artistHistoricalPlayCount,
      trackHistoricalPlayCount: 0,
      trackHistoryMatch: "NOT_APPLICABLE",
    };
  }

  const trackByMbid = candidate.trackMbid
    ? history.byTrackMbid.get(candidate.trackMbid) ?? 0
    : 0;
  const trackByName =
    history.byArtistTrackName.get(
      artistTrackKey(candidate.artistName, candidate.trackName),
    ) ?? 0;

  if (trackByMbid > 0) {
    return {
      artistHistoricalPlayCount,
      trackHistoricalPlayCount: Math.max(trackByMbid, trackByName),
      trackHistoryMatch: "MBID",
    };
  }
  if (trackByName > 0) {
    return {
      artistHistoricalPlayCount,
      trackHistoricalPlayCount: trackByName,
      trackHistoryMatch: "ARTIST_TRACK_NAME",
    };
  }
  return {
    artistHistoricalPlayCount,
    trackHistoricalPlayCount: 0,
    trackHistoryMatch: "NONE",
  };
}

function uniqueScoredTracks(rows: DiscoveryGate22TrackCandidate[]) {
  const byId = new Map<string, DiscoveryGate22TrackCandidate>();
  for (const row of rows) byId.set(row.spotifyTrackId, row);
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

function artistTrackKey(artistName: string, trackName: string): string {
  return `${normalized(artistName)}\u0000${normalized(trackName)}`;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error("limitPerCategory must be an integer between 1 and 12");
  }
  return value;
}
