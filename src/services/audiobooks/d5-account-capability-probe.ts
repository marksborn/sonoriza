import {
  assessSpotifyAudiobookAccountCapability,
  type AudiobookCapabilityDecision,
  type AudiobookCapabilityEvidence,
} from "./d5-account-capability";

export type D5CatalogEvidence = Readonly<{
  audiobookId: string;
  truncated: boolean;
  chapters: readonly Readonly<{ playable: boolean }>[];
}>;

/**
 * Side-effect-free orchestration of injected provider READS. No provider
 * writes and no mutation admission; network/credential access is injected by
 * the API route. Do not call catalog on an unknown/undocumented account market.
 */
export async function probeSpotifyAudiobookAccountCapability(input: Readonly<{
  spotifyConnected: boolean;
  profileScopeGranted: boolean;
  requestedAudiobookId: string | null;
  readProfile: () => Promise<unknown>;
  readCatalog: (id: string) => Promise<D5CatalogEvidence>;
}>): Promise<AudiobookCapabilityDecision> {
  const evidence: {
    -readonly [K in keyof AudiobookCapabilityEvidence]: AudiobookCapabilityEvidence[K]
  } = {
    spotifyConnected: input.spotifyConnected,
    profileScopeGranted: input.profileScopeGranted,
    profileRead: "NOT_ATTEMPTED",
    accountCountry: null,
    catalogRead: "NOT_ATTEMPTED",
    checkedAudiobookId: null,
    readableChapterCount: null,
    playableChapterCount: null,
  };
  if (!input.spotifyConnected || !input.profileScopeGranted) {
    return assessSpotifyAudiobookAccountCapability(evidence);
  }
  try {
    const raw = await input.readProfile();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("PROFILE_SHAPE_INVALID");
    }
    evidence.profileRead = "SUCCESS";
    evidence.accountCountry = (raw as Record<string, unknown>).country;
  } catch {
    evidence.profileRead = "ERROR";
    return assessSpotifyAudiobookAccountCapability(evidence);
  }
  const preliminary = assessSpotifyAudiobookAccountCapability(evidence);
  if (preliminary.marketDocumentation !== "DOCUMENTED" ||
      !input.requestedAudiobookId) {
    return preliminary;
  }
  // This is deliberately NOT a proof of remote opaque audiobook membership.
  try {
    const catalog = await input.readCatalog(input.requestedAudiobookId);
    if (catalog.audiobookId !== input.requestedAudiobookId ||
        catalog.truncated || !Array.isArray(catalog.chapters) ||
        catalog.chapters.length > 200) {
      throw new Error("CATALOG_EVIDENCE_INCOMPLETE");
    }
    evidence.catalogRead = "SUCCESS";
    evidence.checkedAudiobookId = catalog.audiobookId;
    evidence.readableChapterCount = catalog.chapters.length;
    evidence.playableChapterCount =
      catalog.chapters.filter(chapter => chapter.playable === true).length;
  } catch {
    evidence.catalogRead = "ERROR";
  }
  return assessSpotifyAudiobookAccountCapability(evidence);
}
