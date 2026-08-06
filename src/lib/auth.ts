import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import Spotify from "next-auth/providers/spotify";

import { prisma } from "@/lib/prisma";

// Scopes the engine needs. Google: read the calendar to compute trip durations.
// Spotify: read source playlists/shows and create/modify the target playlists.
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

const SPOTIFY_SCOPES = [
  "user-read-email",
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
      // The Spotify provider currently exposes its default authorization
      // endpoint as a string. Replacing it with params only drops the endpoint
      // and makes Auth.js call new URL(undefined). Keep the endpoint explicit.
      authorization: {
        url: "https://accounts.spotify.com/authorize",
        params: { scope: SPOTIFY_SCOPES },
      },
    }),
  ],
  // Account linking is deliberately explicit. Auth.js safely links a new OAuth
  // account when the callback carries an existing authenticated session. It
  // must never merge users silently just because two providers return the same
  // email address.
  pages: {
    signIn: "/",
    error: "/auth/error",
  },
});
