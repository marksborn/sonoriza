import { prisma } from "@/lib/prisma";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
// Refresh a little before the real expiry to avoid mid-request 401s.
const EXPIRY_SKEW_SECONDS = 60;

/**
 * Returns a valid Spotify access token for the user, refreshing it via the
 * stored refresh_token when the current one is missing or about to expire.
 */
export async function getSpotifyAccessToken(userId: string): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "spotify" },
  });
  if (!account) {
    throw new Error(`No Spotify account connected for user ${userId}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const stillValid =
    account.access_token &&
    account.expires_at &&
    account.expires_at - EXPIRY_SKEW_SECONDS > now;

  if (stillValid) return account.access_token!;

  if (!account.refresh_token) {
    throw new Error(
      `Spotify token expired and no refresh_token is stored for user ${userId}. Reconnect Spotify.`,
    );
  }

  const clientId = process.env.AUTH_SPOTIFY_ID ?? "";
  const clientSecret = process.env.AUTH_SPOTIFY_SECRET ?? "";
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Spotify token refresh failed (${res.status}): ${await res.text()}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  await prisma.account.update({
    where: { id: account.id },
    data: {
      access_token: data.access_token,
      expires_at: now + data.expires_in,
      // Spotify only sometimes returns a rotated refresh_token.
      refresh_token: data.refresh_token ?? account.refresh_token,
    },
  });

  return data.access_token;
}
