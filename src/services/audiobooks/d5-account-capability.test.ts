import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AudiobookCapabilityInspector } from "@/components/AudiobookCapabilityInspector";

import {
  assessSpotifyAudiobookAccountCapability,
  type AudiobookCapabilityEvidence,
} from "./d5-account-capability";
import {
  probeSpotifyAudiobookAccountCapability,
} from "./d5-account-capability-probe";

const bookId = "5E76EUAq7or1ncd4QNyHjI";
const safeEvidence: AudiobookCapabilityEvidence = {
  spotifyConnected: true,
  profileScopeGranted: true,
  profileRead: "SUCCESS",
  accountCountry: "US",
  catalogRead: "SUCCESS",
  checkedAudiobookId: bookId,
  readableChapterCount: 3,
  playableChapterCount: 2,
};

function noWrite(decision: ReturnType<typeof assessSpotifyAudiobookAccountCapability>) {
  assert.equal(decision.automaticPlaylistWritesAllowed, false);
  assert.equal(decision.spotifyPlaylistPreservationGuaranteed, false);
  assert.equal(decision.wholeBookIdentityInPlaylistVerified, false);
  assert.equal(decision.productionApprovalGranted, false);
  assert.equal(decision.existingBindingGuardsRemainRequired, true);
  assert.equal(decision.manualChapterControlRequired, true);
  assert.equal(decision.onlyManualSpotifyPlayback, true);
}

test("#489 D.5: even a readable valid catalog NEVER authorizes provider playlist writes", () => {
  const result = assessSpotifyAudiobookAccountCapability(safeEvidence);
  assert.equal(result.status, "CATALOG_CHAPTERS_READABLE");
  assert.equal(result.accountCountrySource, "SPOTIFY_PROFILE_GET_ME");
  assert.equal(result.accountCountry, "US");
  assert.equal(result.marketDocumentation, "DOCUMENTED");
  assert.equal(result.catalogAccessibleForBook, true);
  assert.equal(result.verifiedAudiobookId, bookId);
  assert.equal(result.readableChapterCount, 3);
  assert.equal(result.playableChapterCount, 2);
  noWrite(result);
});

test("#489 D.5: no provider connection or missing grant are different reasons", () => {
  for (const [fields, code] of [
    [{ spotifyConnected: false }, "SPOTIFY_NOT_CONNECTED"],
    [{ profileScopeGranted: false }, "PROFILE_SCOPE_MISSING"],
    [{ profileRead: "ERROR" }, "PROFILE_READ_FAILED"],
    [{ profileRead: "NOT_ATTEMPTED" }, "ACCOUNT_MARKET_UNKNOWN"],
    [{ accountCountry: "us" }, "ACCOUNT_MARKET_UNKNOWN"],
    [{ accountCountry: "USA" }, "ACCOUNT_MARKET_UNKNOWN"],
    [{ accountCountry: null }, "ACCOUNT_MARKET_UNKNOWN"],
  ] as const) {
    const result = assessSpotifyAudiobookAccountCapability({ ...safeEvidence, ...fields });
    assert.equal(result.status, code);
    assert.equal(result.catalogAccessibleForBook, false);
    noWrite(result);
  }
});

test("#489 D.5: BR and all undocumented countries deny catalog support without claiming failure", () => {
  for (const country of ["BR", "AR", "PT", "ES", "FR", "DE"]) {
    const r = assessSpotifyAudiobookAccountCapability({
      ...safeEvidence, accountCountry: country,
    });
    assert.equal(r.status, "MARKET_NOT_DOCUMENTED");
    assert.equal(r.marketDocumentation, "NOT_DOCUMENTED");
    assert.equal(r.accountCountry, country);
    assert.equal(r.catalogAccessibleForBook, false);
    noWrite(r);
  }
});

test("#489 D.5: documented countries are not the same as validated audiobook access", () => {
  for (const country of ["US", "GB", "CA", "IE", "NZ", "AU"]) {
    const decision = assessSpotifyAudiobookAccountCapability({
      ...safeEvidence,
      accountCountry: country,
      catalogRead: "NOT_ATTEMPTED",
      checkedAudiobookId: null,
    });
    assert.equal(decision.status, "CATALOG_NOT_CHECKED");
    assert.equal(decision.marketDocumentation, "DOCUMENTED");
    assert.equal(decision.catalogAccessibleForBook, false);
    noWrite(decision);
  }
});

test("#489 D.5: malformed or inaccessible catalog fails closed", () => {
  const cases: Array<[Partial<AudiobookCapabilityEvidence>, string]> = [
    [{ catalogRead: "ERROR" }, "CATALOG_READ_FAILED"],
    [{ checkedAudiobookId: "fake" }, "CATALOG_READ_FAILED"],
    [{ readableChapterCount: 201 }, "CATALOG_READ_FAILED"],
    [{ playableChapterCount: 4 }, "CATALOG_READ_FAILED"],
    [{ readableChapterCount: -1 }, "CATALOG_READ_FAILED"],
    [{ readableChapterCount: null }, "CATALOG_READ_FAILED"],
    [{ playableChapterCount: 0 }, "NO_PLAYABLE_CHAPTERS"],
  ];
  for (const [change, reason] of cases) {
    const r = assessSpotifyAudiobookAccountCapability({ ...safeEvidence, ...change });
    assert.equal(r.status, reason);
    assert.equal(r.catalogAccessibleForBook, false);
    noWrite(r);
  }
});

function fakeProbe(changes: Partial<Parameters<typeof probeSpotifyAudiobookAccountCapability>[0]> = {}) {
  const calls: string[] = [];
  const params = {
    spotifyConnected: true,
    profileScopeGranted: true,
    requestedAudiobookId: bookId,
    readProfile: async (): Promise<unknown> => {
      calls.push("GET_ME");
      return { type: "user", country: "US" };
    },
    readCatalog: async (id: string) => {
      calls.push("GET_CATALOG:" + id);
      return { audiobookId: id, truncated: false, chapters: [
        { playable: true }, { playable: false },
      ] };
    },
    ...changes,
  };
  return { calls, run: () => probeSpotifyAudiobookAccountCapability(params) };
}

test("#489 D.5: preflight never calls provider if grant or connection is absent", async () => {
  for (const change of [{ spotifyConnected: false }, { profileScopeGranted: false }]) {
    const fake = fakeProbe(change);
    const result = await fake.run();
    assert.deepEqual(fake.calls, []);
    noWrite(result);
  }
});

test("#489 D.5: country BR blocks catalog request before any book GET", async () => {
  const fake = fakeProbe({ readProfile: async () => ({ country: "BR" }) });
  const r = await fake.run();
  assert.equal(r.status, "MARKET_NOT_DOCUMENTED");
  assert.deepEqual(fake.calls, []);
  noWrite(r);
});

test("#489 D.5: documented account calls profile once and catalog once after opt-in", async () => {
  const fake = fakeProbe();
  const r = await fake.run();
  assert.deepEqual(fake.calls, ["GET_ME", "GET_CATALOG:" + bookId]);
  assert.equal(r.status, "CATALOG_CHAPTERS_READABLE");
  noWrite(r);
});

test("#489 D.5: no book ID skips expensive catalog reads even for US", async () => {
  const fake = fakeProbe({ requestedAudiobookId: null });
  const r = await fake.run();
  assert.deepEqual(fake.calls, ["GET_ME"]);
  assert.equal(r.status, "CATALOG_NOT_CHECKED");
  noWrite(r);
});

test("#489 D.5: profile or catalog failure has actionable but non-authorizing decision", async () => {
  const denyProfile = fakeProbe({
    readProfile: async () => { throw new Error("HTTP 403"); },
  });
  const a = await denyProfile.run();
  assert.equal(a.status, "PROFILE_READ_FAILED");
  noWrite(a);
  const denyCatalog = fakeProbe({
    readCatalog: async () => { throw new Error("HTTP 429"); },
  });
  const b = await denyCatalog.run();
  assert.equal(b.status, "CATALOG_READ_FAILED");
  noWrite(b);
});

test("#489 D.5: reject truncated catalogs and cross-book payloads", async () => {
  for (const readCatalog of [
    async () => ({ audiobookId: bookId, truncated: true, chapters: [{ playable: true }] }),
    async () => ({ audiobookId: "x".repeat(22), truncated: false, chapters: [{ playable: true }] }),
  ]) {
    const fake = fakeProbe({ readCatalog });
    const r = await fake.run();
    assert.equal(r.status, "CATALOG_READ_FAILED");
    noWrite(r);
  }
});

test("#489 D.5: UI and route use owner-scoped account and read-only Spotify APIs", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  const route = read("src/app/api/audiobooks/account-capability/route.ts");
  const api = read("src/services/audiobooks/d5-account-capability-probe.ts");
  const ui = read("src/components/AudiobookCapabilityInspector.tsx");
  const wizard = read("src/components/AudiobookManualBindWizard.tsx");
  const auth = read("src/lib/auth.ts");
  assert.match(auth, /"user-read-private"/);
  assert.match(route, /where: \{ userId: ownerId, provider: "spotify" \}/);
  assert.match(route, /manualAudiobookOriginAllowed/);
  assert.match(route, /AUDIOBOOK02_BIND_UI_MODE/);
  assert.match(route, /path: "\/me"/);
  assert.match(route, /method: "GET"/);
  assert.match(route, /getSpotifyAccessToken/);
  assert.match(ui, /Diagnosticar conta e catálogo/);
  assert.match(wizard, /AudiobookCapabilityInspector/);
  for (const file of [route, api]) {
    assert.doesNotMatch(file,
      /appendPlaylistItems|replacePlaylistItems|removePlaylistItems|\.create\(|\.update\(|\.delete\(/);
  }
});

test("#489 D.5: preview SSR describes read-only diagnosis without provider-apply button", () => {
  const html = renderToStaticMarkup(
    React.createElement(AudiobookCapabilityInspector, { audiobookId: bookId }),
  );
  assert.match(html, /Diagnosticar conta e catálogo/);
  assert.match(html, /Não altera seus livros, a reprodução ou a playlist/);
  assert.doesNotMatch(html, /Aplicar no Spotify/);
});
