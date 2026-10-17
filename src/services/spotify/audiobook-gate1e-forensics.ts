/**
 * AUDIOBOOK-01 Gate 1E: offline, pure, metadata-only classification.
 * This helper must NOT authorize playlist writes, even for an episode-shaped
 * audiobook chapter. Do not infer upload eligibility from GET /episodes.
 */
import { asObject, safeId, stringField } from "./audiobook-playlist-gate1c";
import { GATE1D } from "./audiobook-gate1d-readonly";

export const GATE1E = {
  chapterId: GATE1D.chapterId,
  chapterEpisodeUri: GATE1D.chapterUri,
  controlId: GATE1D.controlEpisodeId,
  controlEpisodeUri: GATE1D.controlEpisodeUri,
} as const;

export function episodeMetadata(raw: unknown, expectedId: string) {
  const obj = asObject(raw);
  const nestedShow = asObject(obj?.show);
  const restrictions = asObject(obj?.restrictions);
  const status = obj?.is_playable;
  return {
    validId: safeId(expectedId) !== null && obj?.id === expectedId,
    validUri: obj?.uri === `spotify:episode:${expectedId}`,
    type: stringField(obj?.type),
    isPlayable: status === true ? true : status === false ? false : null,
    hasRestrictionReason: typeof restrictions?.reason === "string",
    showId: safeId(nestedShow?.id),
    showType: stringField(nestedShow?.type),
    nestedShowMediaType: stringField(nestedShow?.media_type),
    isExternallyHosted: obj?.is_externally_hosted === true
      ? true : obj?.is_externally_hosted === false ? false : null,
    durationMs: typeof obj?.duration_ms === "number" && Number.isFinite(obj.duration_ms)
      ? obj.duration_ms : null,
    showAvailableMarketsCount: Array.isArray(nestedShow?.available_markets)
      ? nestedShow.available_markets.length : null,
    showPublisherPresent: typeof nestedShow?.publisher === "string",
    showExplicit: nestedShow?.explicit === true
      ? true : nestedShow?.explicit === false ? false : null,
    resumePointPresent: asObject(obj?.resume_point) !== null,
  };
}

export function showMetadata(raw: unknown, expectedId: string) {
  const obj = asObject(raw);
  return {
    idMatches: safeId(expectedId) !== null && obj?.id === expectedId,
    type: stringField(obj?.type),
    mediaType: stringField(obj?.media_type),
    isExternallyHosted: obj?.is_externally_hosted === true
      ? true : obj?.is_externally_hosted === false ? false : null,
    availableMarketsCount: Array.isArray(obj?.available_markets)
      ? obj.available_markets.length : null,
    episodesTotal: typeof asObject(obj?.episodes)?.total === "number"
      ? asObject(obj?.episodes)?.total : null,
    languagesCount: Array.isArray(obj?.languages) ? obj.languages.length : null,
    publisherPresent: typeof obj?.publisher === "string",
    explicit: obj?.explicit === true ? true : obj?.explicit === false ? false : null,
    episodesReferencePresent: typeof asObject(obj?.episodes)?.href === "string",
  };
}

export function compareEpisodeMetadata(chapter: ReturnType<typeof episodeMetadata>,
  control: ReturnType<typeof episodeMetadata>) {
  const bothEpisode = chapter.validId && control.validId &&
    chapter.validUri && control.validUri &&
    chapter.type === "episode" && control.type === "episode";
  return {
    bothResolveAsEpisode: bothEpisode,
    bothPlayable: chapter.isPlayable === true && control.isPlayable === true,
    bothHaveShows: chapter.showType === "show" && control.showType === "show" &&
      chapter.showId !== null && control.showId !== null,
    sameShowId: chapter.showId !== null && chapter.showId === control.showId,
    sameExternalHostingFlag: chapter.isExternallyHosted !== null &&
      chapter.isExternallyHosted === control.isExternallyHosted,
    sameDurationMs: chapter.durationMs !== null && chapter.durationMs === control.durationMs,
    sameNestedShowMediaType: chapter.nestedShowMediaType !== null &&
      chapter.nestedShowMediaType === control.nestedShowMediaType,
    // No GET-based outcome may assert "playlist writing supported".
    playlistWriteCompatibility: "NOT_PROVEN_BY_GET_ONLY" as const,
  };
}
