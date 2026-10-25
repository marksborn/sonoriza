import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";
import { classifyShadowResolverVersion, deriveBaseTitleSignal } from "@/services/music-identity/shadow-resolver-report";

export type CleanupRecordingMetadata = Readonly<{
  title: string;
  artistId: string | null;
  artistName: string | null;
  durationMs: number | null;
  isrc: string | null;
}>;

export type CleanupRecordingCandidate = Readonly<{
  uri: string | null;
  aliases: readonly string[];
  isTrack: boolean;
  isLocal: boolean;
  recording?: CleanupRecordingMetadata;
}>;

export type CleanupPlaybackFact = CleanupRecordingMetadata & Readonly<{
  userId: string;
  spotifyTrackId: string | null;
  source: string;
  playedAt: Date;
}>;

export type CleanupRecordingDecision =
  | "CONFIRMED_RECORDING"
  | "REVIEW_TEXTUAL_ALIAS"
  | "REVIEW_VERSION"
  | "REVIEW_BUDGET"
  | "ABSTAIN_METADATA"
  | "ABSTAIN_CONFLICT"
  | "ABSTAIN_NO_FACT";

export type CleanupRecordingAssessment = Readonly<{
  uri: string;
  decision: CleanupRecordingDecision;
  evidenceTrackIds: string[];
}>;

const MAX_LOOKUP_CANDIDATES = 100;
const MAX_DURATION_DELTA_MS = 1_000;

function isrc(value: string | null): string | null {
  const code = value?.replace(/[-\s]/g, "").toUpperCase() ?? "";
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code) ? code : null;
}

function validDuration(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function eligibleFacts(userId: string, facts: readonly CleanupPlaybackFact[], now: Date) {
  return facts.filter(fact => fact.userId === userId &&
    fact.source === "SPOTIFY_RECENTLY_PLAYED" && Boolean(fact.spotifyTrackId) && isrc(fact.isrc) !== null &&
    Number.isFinite(fact.playedAt.getTime()) && fact.playedAt <= now);
}

/** ISRC is necessary but insufficient. No graph merge, timestamp or ref write. */
export function assessCleanupRecording(
  userId: string,
  metadata: CleanupRecordingMetadata,
  facts: readonly CleanupPlaybackFact[],
  now: Date,
): Omit<CleanupRecordingAssessment, "uri"> {
  const code = isrc(metadata.isrc);
  const base = deriveBaseTitleSignal(metadata.title);
  const artist = normalizeMusicIdentityText(metadata.artistName);
  if (!code || !base || !metadata.artistId || !artist || !validDuration(metadata.durationMs)) {
    return { decision: "ABSTAIN_METADATA", evidenceTrackIds: [] };
  }
  const matches = eligibleFacts(userId, facts, now).filter(fact => isrc(fact.isrc) === code);
  if (!matches.length) return { decision: "ABSTAIN_NO_FACT", evidenceTrackIds: [] };
  let spacingAlias = false;
  const version = classifyShadowResolverVersion({ trackName: metadata.title });
  if (version === "UNKNOWN") return { decision: "ABSTAIN_METADATA", evidenceTrackIds: [] };
  // Venue, remaster year and other performance qualifiers are deliberately
  // not enough to authorize destruction via a stripped base title.
  let versionReview = version !== "STANDARD";
  for (const fact of matches) {
    const factBase = deriveBaseTitleSignal(fact.title);
    if (!factBase || !fact.artistId || !normalizeMusicIdentityText(fact.artistName) ||
        !validDuration(fact.durationMs)) {
      return { decision: "ABSTAIN_METADATA", evidenceTrackIds: [] };
    }
    if (fact.artistId !== metadata.artistId || normalizeMusicIdentityText(fact.artistName) !== artist ||
        Math.abs(fact.durationMs - metadata.durationMs) > MAX_DURATION_DELTA_MS ||
        factBase.replace(/\s/g, "") !== base.replace(/\s/g, "")) {
      return { decision: "ABSTAIN_CONFLICT", evidenceTrackIds: [] };
    }
    const factVersion = classifyShadowResolverVersion({ trackName: fact.title });
    if (factVersion === "UNKNOWN") return { decision: "ABSTAIN_METADATA", evidenceTrackIds: [] };
    if (version !== factVersion) versionReview = true;
    if (factBase !== base) spacingAlias = true;
  }
  return {
    decision: versionReview ? "REVIEW_VERSION" : spacingAlias ? "REVIEW_TEXTUAL_ALIAS" : "CONFIRMED_RECORDING",
    evidenceTrackIds: [...new Set(matches.map(fact => fact.spotifyTrackId!))].sort(),
  };
}

/** A textual shortlist only bounds metadata reads; it never proves a deletion. */
function couldHaveRecordingFact(metadata: CleanupRecordingMetadata | undefined, facts: readonly CleanupPlaybackFact[]) {
  if (!metadata) return false;
  const base = deriveBaseTitleSignal(metadata.title);
  const artist = normalizeMusicIdentityText(metadata.artistName);
  return facts.some(fact =>
    (isrc(metadata.isrc) !== null && isrc(metadata.isrc) === isrc(fact.isrc)) ||
    (base && artist && artist === normalizeMusicIdentityText(fact.artistName) &&
      base.replace(/\s/g, "") === deriveBaseTitleSignal(fact.title)?.replace(/\s/g, "")));
}

/**
 * One resolver for preview, confirmation and automatic cleanup. All enrichment
 * finishes before callers can issue DELETE. A provider failure propagates.
 * Budget exhaustion is a local abstention; no retry or provider bypass.
 */
export async function resolveCleanupRecordingEvidence(input: {
  userId: string;
  candidates: readonly CleanupRecordingCandidate[];
  playedTrackIds: ReadonlySet<string>;
  facts: readonly CleanupPlaybackFact[];
  now: Date;
  lookup?: (trackId: string) => Promise<CleanupRecordingMetadata | "BUDGET" | null>;
}): Promise<{ playedTrackIds: Set<string>; assessments: CleanupRecordingAssessment[] }> {
  const playedTrackIds = new Set(input.playedTrackIds);
  const facts = eligibleFacts(input.userId, input.facts, input.now);
  const assessments: CleanupRecordingAssessment[] = [];
  const seen = new Set<string>();
  let lookups = 0;
  for (const candidate of input.candidates) {
    if (!candidate.uri || !candidate.isTrack || candidate.isLocal || !candidate.aliases.length ||
        seen.has(candidate.uri) || candidate.aliases.some(id => input.playedTrackIds.has(id))) continue;
    seen.add(candidate.uri);
    if (!couldHaveRecordingFact(candidate.recording, facts)) continue;
    let metadata = candidate.recording;
    if (!metadata?.isrc || !metadata.artistId || !validDuration(metadata.durationMs)) {
      if (!input.lookup || lookups >= MAX_LOOKUP_CANDIDATES) {
        assessments.push({ uri: candidate.uri, decision: input.lookup ? "REVIEW_BUDGET" : "ABSTAIN_METADATA", evidenceTrackIds: [] });
        continue;
      }
      lookups += 1;
      const enriched = await input.lookup(candidate.aliases[0]!);
      if (enriched === "BUDGET") {
        assessments.push({ uri: candidate.uri, decision: "REVIEW_BUDGET", evidenceTrackIds: [] });
        continue;
      }
      if (!enriched) {
        assessments.push({ uri: candidate.uri, decision: "ABSTAIN_METADATA", evidenceTrackIds: [] });
        continue;
      }
      // Catalog data must still describe the item from the stable source.
      const source = candidate.recording;
      const sourceBase = deriveBaseTitleSignal(source?.title);
      const enrichedBase = deriveBaseTitleSignal(enriched.title);
      if (!source || !sourceBase || !enrichedBase ||
          sourceBase.replace(/\s/g, "") !== enrichedBase.replace(/\s/g, "") ||
          classifyShadowResolverVersion({ trackName: enriched.title }) !== classifyShadowResolverVersion({ trackName: source.title }) ||
          normalizeMusicIdentityText(enriched.artistName) !== normalizeMusicIdentityText(source.artistName) ||
          (source.artistId && source.artistId !== enriched.artistId) ||
          (validDuration(source.durationMs) && (!validDuration(enriched.durationMs) ||
            Math.abs(source.durationMs - enriched.durationMs) > MAX_DURATION_DELTA_MS))) {
        assessments.push({ uri: candidate.uri, decision: "ABSTAIN_CONFLICT", evidenceTrackIds: [] });
        continue;
      }
      if (sourceBase !== enrichedBase) {
        assessments.push({ uri: candidate.uri, decision: "REVIEW_TEXTUAL_ALIAS", evidenceTrackIds: [] });
        continue;
      }
      metadata = enriched;
    }
    const assessment = { uri: candidate.uri, ...assessCleanupRecording(input.userId, metadata, facts, input.now) };
    assessments.push(assessment);
    if (assessment.decision === "CONFIRMED_RECORDING") {
      // Only this source occurrence is authorized. No global alias expansion.
      for (const id of candidate.aliases) playedTrackIds.add(id);
    }
  }
  return { playedTrackIds, assessments };
}
