import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  saveSpotifyTrackToLibrary,
  SpotifyLibraryModifyScopeRequiredError,
} from "@/services/spotify/library";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5 Spotify library write requires expanded grant and uses the 2026 Library endpoint",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `spotify-library-write-${suffix}@example.test` },
    });
    const account = await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-${suffix}`,
        access_token: "gate5-test-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "Bearer",
        scope: "user-library-read",
      },
    });

    t.after(async () => {
      await prisma.account.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    let providerCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      providerCalls += 1;
      return new Response(null, { status: 200 });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    await assert.rejects(
      saveSpotifyTrackToLibrary({
        userId: user.id,
        spotifyTrackId: "track-before-reconnect",
      }),
      SpotifyLibraryModifyScopeRequiredError,
    );
    assert.equal(providerCalls, 0, "missing scope must fail before Spotify traffic");

    await prisma.account.update({
      where: { id: account.id },
      data: { scope: "user-library-read user-library-modify" },
    });

    let observedUrl = "";
    let observedMethod = "";
    let observedAuthorization = "";
    globalThis.fetch = async (input, init) => {
      providerCalls += 1;
      observedUrl = String(input);
      observedMethod = init?.method ?? "GET";
      observedAuthorization = String(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return new Response(null, { status: 200 });
    };

    await saveSpotifyTrackToLibrary({
      userId: user.id,
      spotifyTrackId: "track-after-reconnect",
    });

    assert.equal(providerCalls, 1);
    assert.equal(observedMethod, "PUT");
    assert.equal(observedAuthorization, "Bearer gate5-test-token");
    assert.equal(
      observedUrl,
      "https://api.spotify.com/v1/me/library?uris=spotify%3Atrack%3Atrack-after-reconnect",
    );
  },
);
