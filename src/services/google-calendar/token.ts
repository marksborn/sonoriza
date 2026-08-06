import { prisma } from "@/lib/prisma";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_SKEW_SECONDS = 60;

/**
 * Returns a valid Google access token for the user, refreshing it via the
 * stored refresh_token when needed. Google only returns a refresh_token on the
 * first consent (that is why the OAuth config forces `prompt=consent`).
 */
export async function getGoogleAccessToken(userId: string): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
  });
  if (!account) {
    throw new Error(`No Google account connected for user ${userId}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const stillValid =
    account.access_token &&
    account.expires_at &&
    account.expires_at - EXPIRY_SKEW_SECONDS > now;

  if (stillValid) return account.access_token!;

  if (!account.refresh_token) {
    throw new Error(
      `Google token expired and no refresh_token is stored for user ${userId}. Reconnect Google.`,
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Google token refresh failed (${res.status}): ${await res.text()}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  await prisma.account.update({
    where: { id: account.id },
    data: {
      access_token: data.access_token,
      expires_at: now + data.expires_in,
    },
  });

  return data.access_token;
}
