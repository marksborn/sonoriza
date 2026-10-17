/**
 * AUDIOBOOK-02 Gate D.5: provider capabilities != playlist mutation admission.
 * All statuses deliberately deny automated mutation of a target containing a
 * WHOLE audiobook opaque in GET /playlists/{id}/items.
 *
 * Spotify's published audiobook/chapter markets (2026-10-17): US, GB, CA,
 * IE, NZ, AU. The account country is from GET /me only; never infer from IP.
 */
export const DOCUMENTED_SPOTIFY_AUDIOBOOK_MARKETS = [
  "US", "GB", "CA", "IE", "NZ", "AU",
] as const;

export type AudiobookCapabilityStatus =
  | "SPOTIFY_NOT_CONNECTED"
  | "PROFILE_SCOPE_MISSING"
  | "PROFILE_READ_FAILED"
  | "ACCOUNT_MARKET_UNKNOWN"
  | "MARKET_NOT_DOCUMENTED"
  | "CATALOG_NOT_CHECKED"
  | "CATALOG_READ_FAILED"
  | "NO_PLAYABLE_CHAPTERS"
  | "CATALOG_CHAPTERS_READABLE";

export type AudiobookCapabilityEvidence = Readonly<{
  spotifyConnected: boolean;
  profileScopeGranted: boolean;
  profileRead: "NOT_ATTEMPTED" | "ERROR" | "SUCCESS";
  accountCountry: unknown;
  catalogRead: "NOT_ATTEMPTED" | "ERROR" | "SUCCESS";
  checkedAudiobookId: string | null;
  readableChapterCount: number | null;
  playableChapterCount: number | null;
}>;

export type AudiobookCapabilityDecision = Readonly<{
  status: AudiobookCapabilityStatus;
  accountCountry: string | null;
  accountCountrySource: "SPOTIFY_PROFILE_GET_ME" | "UNKNOWN";
  marketDocumentation: "NOT_DOCUMENTED" | "DOCUMENTED" | "UNKNOWN";
  catalogAccessibleForBook: boolean;
  verifiedAudiobookId: string | null;
  readableChapterCount: number | null;
  playableChapterCount: number | null;
  onlyManualSpotifyPlayback: true;
  manualChapterControlRequired: true;
  wholeBookIdentityInPlaylistVerified: false;
  spotifyPlaylistPreservationGuaranteed: false;
  automaticPlaylistWritesAllowed: false;
  productionApprovalGranted: false;
  existingBindingGuardsRemainRequired: true;
}>;

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= 200;
}
function normalizeProfileCountry(country: unknown): string | null {
  // Do not silently normalize user locale or arbitrary strings into a claim.
  return typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : null;
}

export function assessSpotifyAudiobookAccountCapability(
  evidence: AudiobookCapabilityEvidence,
): AudiobookCapabilityDecision {
  let status: AudiobookCapabilityStatus;
  let country: string | null = null;
  let marketDocumentation: AudiobookCapabilityDecision["marketDocumentation"] = "UNKNOWN";
  let chapterCount: number | null = null;
  let playableChapterCount: number | null = null;
  let verifiedBook: string | null = null;

  if (!evidence.spotifyConnected) {
    status = "SPOTIFY_NOT_CONNECTED";
  } else if (!evidence.profileScopeGranted) {
    status = "PROFILE_SCOPE_MISSING";
  } else if (evidence.profileRead === "ERROR") {
    status = "PROFILE_READ_FAILED";
  } else if (evidence.profileRead !== "SUCCESS" ||
             !(country = normalizeProfileCountry(evidence.accountCountry))) {
    status = "ACCOUNT_MARKET_UNKNOWN";
  } else if (!DOCUMENTED_SPOTIFY_AUDIOBOOK_MARKETS.some(value => value === country)) {
    marketDocumentation = "NOT_DOCUMENTED";
    status = "MARKET_NOT_DOCUMENTED";
  } else {
    marketDocumentation = "DOCUMENTED";
    if (evidence.catalogRead === "ERROR") {
      status = "CATALOG_READ_FAILED";
    } else if (evidence.catalogRead !== "SUCCESS") {
      status = "CATALOG_NOT_CHECKED";
    } else if (!evidence.checkedAudiobookId ||
               !/^[A-Za-z0-9]{22}$/.test(evidence.checkedAudiobookId) ||
               !safeCount(evidence.readableChapterCount) ||
               !safeCount(evidence.playableChapterCount) ||
               evidence.playableChapterCount > evidence.readableChapterCount) {
      status = "CATALOG_READ_FAILED";
    } else if (evidence.playableChapterCount === 0) {
      status = "NO_PLAYABLE_CHAPTERS";
    } else {
      status = "CATALOG_CHAPTERS_READABLE";
      chapterCount = evidence.readableChapterCount;
      playableChapterCount = evidence.playableChapterCount;
      verifiedBook = evidence.checkedAudiobookId;
    }
  }

  return {
    status,
    accountCountry: country,
    accountCountrySource: country ? "SPOTIFY_PROFILE_GET_ME" : "UNKNOWN",
    marketDocumentation,
    catalogAccessibleForBook: status === "CATALOG_CHAPTERS_READABLE",
    verifiedAudiobookId: verifiedBook,
    readableChapterCount: chapterCount,
    playableChapterCount,
    onlyManualSpotifyPlayback: true,
    manualChapterControlRequired: true,
    wholeBookIdentityInPlaylistVerified: false,
    spotifyPlaylistPreservationGuaranteed: false,
    automaticPlaylistWritesAllowed: false,
    productionApprovalGranted: false,
    existingBindingGuardsRemainRequired: true,
  };
}
