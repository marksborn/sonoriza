export const SPOTIFY_PROVIDER_REVOCATION_MODE =
  "MANUAL_USER_ACTION_REQUIRED" as const;

export const SPOTIFY_PROVIDER_REVOCATION_REASON =
  "NO_DOCUMENTED_APPLICATION_REVOCATION_ENDPOINT" as const;

export const SPOTIFY_CONNECTED_APPS_URL =
  "https://www.spotify.com/account/apps/" as const;

export const SPOTIFY_PROVIDER_REVOCATION_SUPPORT_URL =
  "https://support.spotify.com/br-pt/article/spotify-on-other-apps/" as const;

export type SpotifyProviderRevocationPlan = Readonly<{
  mode: typeof SPOTIFY_PROVIDER_REVOCATION_MODE;
  reason: typeof SPOTIFY_PROVIDER_REVOCATION_REASON;
  localDisconnectCompleted: boolean;
  nextAction:
    | "EXECUTE_LOCAL_DISCONNECT"
    | "OPEN_SPOTIFY_CONNECTED_APPS";
  connectedAppsUrl: typeof SPOTIFY_CONNECTED_APPS_URL;
  supportUrl: typeof SPOTIFY_PROVIDER_REVOCATION_SUPPORT_URL;
  canAutomateProviderRevocation: false;
  providerRevocationVerifiedBySonoriza: false;
}>;

/**
 * Gate 6C contract.
 *
 * Spotify's documented authorization surface exposes token issuance/refresh,
 * while provider-side app access removal is documented as a user action in the
 * Spotify account Connected Apps page. Sonoriza must therefore fail closed and
 * never invent an undocumented HTTP revocation endpoint.
 *
 * This contract is deliberately pure: no fetch, no token use, no mutation.
 */
export function buildSpotifyProviderRevocationPlan(input: {
  localDisconnectCompleted: boolean;
}): SpotifyProviderRevocationPlan {
  return {
    mode: SPOTIFY_PROVIDER_REVOCATION_MODE,
    reason: SPOTIFY_PROVIDER_REVOCATION_REASON,
    localDisconnectCompleted: input.localDisconnectCompleted,
    nextAction: input.localDisconnectCompleted
      ? "OPEN_SPOTIFY_CONNECTED_APPS"
      : "EXECUTE_LOCAL_DISCONNECT",
    connectedAppsUrl: SPOTIFY_CONNECTED_APPS_URL,
    supportUrl: SPOTIFY_PROVIDER_REVOCATION_SUPPORT_URL,
    canAutomateProviderRevocation: false,
    providerRevocationVerifiedBySonoriza: false,
  };
}
