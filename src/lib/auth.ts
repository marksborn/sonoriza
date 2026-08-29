import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import Spotify from "next-auth/providers/spotify";

import {
  isEmailAllowed,
  isOAuthIdentityAllowed,
} from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";

// Scopes the engine needs. Google: read the calendar to compute trip durations.
// Spotify: discover source playlists/shows/episodes, read podcast playback
// position and recent music playback, create/modify target playlists, and let
// explicit HISTORY-04 likes save tracks into the user's Spotify library.
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "user-library-modify",
  "user-read-playback-position",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

const nextAuth = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // `access_type=offline` + `prompt=consent` are required to receive a
      // refresh_token that the scheduled job can use to mint new access tokens.
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
    Spotify({
      clientId: process.env.AUTH_SPOTIFY_ID,
      clientSecret: process.env.AUTH_SPOTIFY_SECRET,
      // The endpoint stays explicit because Auth.js loses it when authorization
      // is replaced with params only. Library read powers CONFIG-02 and
      // SOURCE-LIKED-01; library modify lets an explicit HISTORY-04 confirmation
      // become a real Spotify Saved Track. Existing grants must reconnect once
      // after this scope is introduced so Spotify can issue the expanded grant.
      authorization: {
        url: "https://accounts.spotify.com/authorize",
        params: { scope: SPOTIFY_SCOPES },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      // AUTH-01: reject before refreshing/storing any provider token. The raw
      // provider profile must expose an allowed email and the Auth.js user must
      // also remain allowed. Requiring both blocks a removed legacy session
      // from being used as an account-linking bridge.
      if (!isOAuthIdentityAllowed(user.email, profile)) return false;

      if (
        account &&
        user.id &&
        (account.provider === "google" || account.provider === "spotify")
      ) {
        // The adapter creates Account on the first link, but subsequent OAuth
        // sign-ins do not reliably refresh the stored grant. Persist only the
        // fields returned by the provider so omitted refresh tokens are kept.
        await prisma.account.updateMany({
          where: {
            userId: user.id,
            provider: account.provider,
            providerAccountId: account.providerAccountId,
          },
          data: {
            access_token: account.access_token ?? undefined,
            refresh_token: account.refresh_token ?? undefined,
            expires_at: account.expires_at ?? undefined,
            token_type: account.token_type ?? undefined,
            scope: account.scope ?? undefined,
            id_token: account.id_token ?? undefined,
          },
        });
      }

      return true;
    },
  },
  // Account linking is deliberately explicit. Auth.js safely links a new OAuth
  // account when the callback carries an existing authenticated session. It
  // must never merge users silently just because two providers return the same
  // email address.
  pages: {
    signIn: "/",
    error: "/auth/error",
  },
});

export const { handlers, signIn, signOut } = nextAuth;

/**
 * All application code imports this wrapper instead of Auth.js' raw `auth`.
 * Therefore an existing database session stops authorizing pages, APIs and
 * server actions as soon as its email is removed from the runtime allowlist.
 */
export async function auth() {
  const session = await nextAuth.auth();
  if (!session?.user) return session;
  return isEmailAllowed(session.user.email) ? session : null;
}
