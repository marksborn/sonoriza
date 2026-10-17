import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SpotifyTargetPlaylistState } from "@/services/spotify/client";
import { analyzeOpaqueAudiobookPlaylist } from "./opaque-playlist-reconciliation";

function state(items: SpotifyTargetPlaylistState["items"]): SpotifyTargetPlaylistState {
  return { snapshotId: "stable-123", items };
}

test("#489 Gate D.2: null item is opaque, never proof of audiobook presence", () => {
  const result = analyzeOpaqueAudiobookPlaylist(state([
    { position: 0, uri: null, type: null, removableByUri: false },
    { position: 1, uri: "spotify:track:valid", type: "MUSIC", removableByUri: true },
  ]));
  assert.equal(result.status, "BOOK_ID_UNVERIFIABLE");
  assert.equal(result.stableSnapshotRead, true);
  assert.equal(result.snapshotId, "stable-123");
  assert.equal(result.listedItemCount, 2);
  assert.equal(result.opaqueItemCount, 1);
  assert.deepEqual(result.opaquePositions, [0]);
  assert.equal(result.musicItemCount, 1);
  assert.equal(result.remoteBookPresenceVerified, false);
  assert.equal(result.canIdentifyBook, false);
  assert.equal(result.safeToMutatePlaylist, false);
  assert.equal(result.eligibleForAutomaticReconciliation, false);
});

test("#489 Gate D.2: even zero opaque or exactly one opaque cannot authorize writes", () => {
  for (const items of [
    [],
    [{ position: 0, uri: "spotify:track:some", type: "MUSIC" as const,
      removableByUri: true }],
    [{ position: 0, uri: "spotify:episode:some", type: "PODCAST" as const,
      removableByUri: true }],
    [{ position: 0, uri: "spotify:audiobook:unknown", type: null,
      removableByUri: false }],
  ]) {
    const result = analyzeOpaqueAudiobookPlaylist(state(items));
    assert.equal(result.remoteBookPresenceVerified, false);
    assert.equal(result.safeToMutatePlaylist, false);
    assert.equal(result.eligibleForAutomaticReconciliation, false);
  }
});

test("#489 Gate D.2: unknown, blank and unstable snapshots fail closed", () => {
  for (const invalid of [
    null,
    undefined,
    { snapshotId: "", items: [] },
    { snapshotId: "snap", items: null },
    { snapshotId: "snap", items: [
      { position: 7, uri: null, type: null, removableByUri: false },
    ] },
  ]) {
    assert.throws(() => analyzeOpaqueAudiobookPlaylist(invalid as SpotifyTargetPlaylistState),
      /AUDIOBOOK_REMOTE_/);
  }
});

test("#489 Gate D.2: no automatic writes in observation path or UI", () => {
  const service = readFileSync("src/services/audiobooks/opaque-playlist-reconciliation.ts", "utf8");
  const route = readFileSync("src/app/api/audiobooks/remote-observation/route.ts", "utf8");
  const editor = readFileSync("src/components/AudiobookChapterChangeEditor.tsx", "utf8");
  assert.match(route, /AUDIOBOOK02_BIND_UI_MODE/);
  assert.match(route, /getTargetPlaylistState/);
  assert.match(route, /manualAudiobookOriginAllowed/);
  assert.match(editor, /Consultar snapshot remoto/);
  assert.match(editor, /Escrita automática no Spotify: bloqueada/);
  for (const content of [service, route]) {
    assert.doesNotMatch(content,
      /appendPlaylistItems|replacePlaylistItems|removePlaylistItems|createPlaylist/);
  }
});
