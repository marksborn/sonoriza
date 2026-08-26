export type TrackVersionClassification =
  | "STUDIO_OR_STANDARD"
  | "LIVE"
  | "UNKNOWN";

export type TrackVersionClassificationReason =
  | "TRACK_LIVE_SUFFIX"
  | "TRACK_LIVE_CONTEXT"
  | "TRACK_AO_VIVO_CONTEXT"
  | "TRACK_EN_VIVO_CONTEXT"
  | "TRACK_IN_CONCERT_CONTEXT"
  | "ALBUM_LIVE_CONTEXT"
  | "ALBUM_AO_VIVO_CONTEXT"
  | "ALBUM_EN_VIVO_CONTEXT"
  | "ALBUM_IN_CONCERT_CONTEXT"
  | "NO_LIVE_MARKER"
  | "INSUFFICIENT_METADATA";

export type TrackVersionClassificationResult = {
  classification: TrackVersionClassification;
  reason: TrackVersionClassificationReason;
  source: "TRACK_NAME" | "ALBUM_NAME" | null;
  matchedText: string | null;
};

export type TrackVersionShadowRow = {
  spotifyTrackId: string;
  artistName: string;
  trackName: string;
  albumName: string | null;
  rawScore?: number | null;
};

export type TrackVersionShadowReport = {
  generatedAt: Date;
  safety: {
    shadowOnly: true;
    plannerInfluence: false;
    databaseWrites: false;
    spotifyWrites: false;
  };
  totals: {
    candidates: number;
    live: number;
    studioOrStandard: number;
    unknown: number;
    liveShare: number;
  };
  rows: Array<
    TrackVersionShadowRow & {
      version: TrackVersionClassificationResult;
    }
  >;
};

const TRACK_PATTERNS: Array<{
  reason: TrackVersionClassificationReason;
  regex: RegExp;
}> = [
  {
    reason: "TRACK_LIVE_SUFFIX",
    regex: /(?:\s[-–—:]\s*live(?:\b.*)?|\s[([]\s*live(?:\b.*)?[)\]]?)$/i,
  },
  {
    reason: "TRACK_LIVE_CONTEXT",
    regex: /(?:^|[\s([{\-–—:])live\s+(?:at|from|in)\b[^\])}]*[\])}]?/i,
  },
  {
    reason: "TRACK_AO_VIVO_CONTEXT",
    regex: /(?:^|[\s([{\-–—:])ao\s+vivo(?:$|[\s\])},:;\-–—])/i,
  },
  {
    reason: "TRACK_EN_VIVO_CONTEXT",
    regex: /(?:^|[\s([{\-–—:])en\s+vivo(?:$|[\s\])},:;\-–—])/i,
  },
  {
    reason: "TRACK_IN_CONCERT_CONTEXT",
    regex: /(?:^|[\s([{\-–—:])in\s+concert(?:$|[\s\])},:;\-–—])/i,
  },
];

const ALBUM_PATTERNS: Array<{
  reason: TrackVersionClassificationReason;
  regex: RegExp;
}> = [
  {
    reason: "ALBUM_LIVE_CONTEXT",
    regex:
      /(?:^live$|(?:^|[\s([{\-–—:])live\s+(?:at|from|in)\b|\s[-–—:]\s*live(?:$|[\s:;\-–—]))/i,
  },
  {
    reason: "ALBUM_AO_VIVO_CONTEXT",
    regex: /(?:^|[\s([{\-–—:])ao\s+vivo(?:$|[\s\])},:;\-–—])/i,
  },
  {
    reason: "ALBUM_EN_VIVO_CONTEXT",
    regex: /(?:^|[\s([{\-–—:])en\s+vivo(?:$|[\s\])},:;\-–—])/i,
  },
  {
    reason: "ALBUM_IN_CONCERT_CONTEXT",
    regex: /(?:^|[\s([{\-–—:])in\s+concert(?:$|[\s\])},:;\-–—])/i,
  },
];

export function classifyTrackVersion(input: {
  trackName: string | null | undefined;
  albumName?: string | null | undefined;
}): TrackVersionClassificationResult {
  const trackName = normalizeMetadata(input.trackName);
  const albumName = normalizeMetadata(input.albumName);

  if (!trackName && !albumName) {
    return {
      classification: "UNKNOWN",
      reason: "INSUFFICIENT_METADATA",
      source: null,
      matchedText: null,
    };
  }

  for (const pattern of TRACK_PATTERNS) {
    const match = trackName.match(pattern.regex);
    if (match) {
      return {
        classification: "LIVE",
        reason: pattern.reason,
        source: "TRACK_NAME",
        matchedText: match[0].trim(),
      };
    }
  }

  for (const pattern of ALBUM_PATTERNS) {
    const match = albumName.match(pattern.regex);
    if (match) {
      return {
        classification: "LIVE",
        reason: pattern.reason,
        source: "ALBUM_NAME",
        matchedText: match[0].trim(),
      };
    }
  }

  return {
    classification: "STUDIO_OR_STANDARD",
    reason: "NO_LIVE_MARKER",
    source: null,
    matchedText: null,
  };
}

export function buildTrackVersionShadowReport(
  rows: TrackVersionShadowRow[],
): TrackVersionShadowReport {
  const classifiedRows = rows.map((row) => ({
    ...row,
    version: classifyTrackVersion({
      trackName: row.trackName,
      albumName: row.albumName,
    }),
  }));
  const live = classifiedRows.filter(
    (row) => row.version.classification === "LIVE",
  ).length;
  const studioOrStandard = classifiedRows.filter(
    (row) => row.version.classification === "STUDIO_OR_STANDARD",
  ).length;
  const unknown = classifiedRows.length - live - studioOrStandard;

  return {
    generatedAt: new Date(),
    safety: {
      shadowOnly: true,
      plannerInfluence: false,
      databaseWrites: false,
      spotifyWrites: false,
    },
    totals: {
      candidates: classifiedRows.length,
      live,
      studioOrStandard,
      unknown,
      liveShare:
        classifiedRows.length > 0
          ? rounded(live / classifiedRows.length)
          : 0,
    },
    rows: classifiedRows,
  };
}

function normalizeMetadata(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}
