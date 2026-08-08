import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import Spotify from "next-auth/providers/spotify";

import { prisma } from "@/lib/prisma";

// Scopes the engine needs. Google: read the calendar to compute trip durations.
// Spotify: discover source playlists/shows/episodes, read podcast playback
// position and recent music playback, and create/modify target playlists.
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-library-read",
  "user-read-playback-position",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

export const { handlers, auth, signIn, signOut } = NextAuth({
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
      // is replaced with params only. Library access powers CONFIG-02,
      // playback-position access lets PODCAST-01 budget episode progress, and
      // recently-played access powers MUSIC-01 without mutating source playlists.
      authorization: {
        url: "https://accounts.spotify.com/authorize",
        params: { scope: SPOTIFY_SCOPES },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
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
