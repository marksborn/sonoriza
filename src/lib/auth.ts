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
      // Personal-use MVP: link Google + Spotify onto the same account by email.
      // Revisit before opening the app to multiple untrusted users.
      allowDangerousEmailAccountLinking: true,
    }),
    Spotify({
      clientId: process.env.AUTH_SPOTIFY_ID,
      clientSecret: process.env.AUTH_SPOTIFY_SECRET,
      authorization: {
        params: { scope: SPOTIFY_SCOPES },
      },
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  pages: {
    signIn: "/",
  },
});
