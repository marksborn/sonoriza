from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one match, got {text.count(old)} for {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))


GEN = "src/jobs/generate-playlists-incremental.ts"
replace_once(
    GEN,
    '''  /** SCHEDULE-01: live URIs owned by enabled targets outside this scoped batch. */
  reservedUris?: string[];
}''',
    '''  /** SCHEDULE-01: live URIs owned by enabled targets outside this scoped batch. */
  reservedUris?: string[];
  /** Snapshots proving the external reservation set is still current pre-write. */
  reservedTargetSnapshots?: Record<string, string>;
  /** Stable current state captured before a scheduled full rebuild. */
  rebuildByTargetId?: Record<
    string,
    { snapshotBefore: string; currentCount: number; currentDurationMs: number }
  >;
}''',
)

replace_once(
    GEN,
    '''    if (!simulate && writer) {
      const snapshotViolations: Array<{''',
    '''    if (!simulate && writer) {
      const reservationSnapshotViolations: Array<{
        spotifyPlaylistId: string;
        expected: string;
        actual: string;
      }> = [];
      for (const [spotifyPlaylistId, expected] of Object.entries(
        opts.reservedTargetSnapshots ?? {},
      )) {
        const actual = await writer.getPlaylistSnapshotId(spotifyPlaylistId);
        if (actual !== expected) {
          reservationSnapshotViolations.push({ spotifyPlaylistId, expected, actual });
        }
      }
      if (reservationSnapshotViolations.length > 0) {
        summary.externalReservationSnapshotViolations =
          reservationSnapshotViolations;
        const error =
          "A geração agendada foi bloqueada antes de alterar o Spotify porque outro destino mudou depois de reservar sua exclusividade.";
        log({ level: "ERROR", message: error, data: reservationSnapshotViolations });
        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }

      const snapshotViolations: Array<{''',
)

replace_once(
    GEN,
    '''      for (const target of targets) {
        const patch = opts.keepFilledByTargetId?.[target.id];
        if (!patch) continue;
        if (!target.spotifyPlaylistId) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected: patch.snapshotBefore,
            actual: null,
          });
          continue;
        }
        const actual = await writer.getPlaylistSnapshotId(target.spotifyPlaylistId);
        if (actual !== patch.snapshotBefore) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected: patch.snapshotBefore,
            actual,
          });
        }
      }''',
    '''      for (const target of targets) {
        const patch = opts.keepFilledByTargetId?.[target.id];
        const rebuild = opts.rebuildByTargetId?.[target.id];
        const expected = patch?.snapshotBefore ?? rebuild?.snapshotBefore ?? null;
        if (!expected) continue;
        if (!target.spotifyPlaylistId) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected,
            actual: null,
          });
          continue;
        }
        const actual = await writer.getPlaylistSnapshotId(target.spotifyPlaylistId);
        if (actual !== expected) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected,
            actual,
          });
        }
      }''',
)
replace_once(
    GEN,
    'summary.keepFilledSnapshotViolations = snapshotViolations;',
    'summary.scheduledTargetSnapshotViolations = snapshotViolations;',
)
replace_once(
    GEN,
    '"A manutenção foi bloqueada antes de alterar o Spotify porque a playlist mudou depois da leitura canônica. Tente novamente no próximo ciclo.";',
    '"A manutenção foi bloqueada antes de alterar o Spotify porque um destino mudou depois da leitura canônica. Tente novamente no próximo ciclo.";',
)

replace_once(
    GEN,
    '''        scheduledPolicy: opts.scheduledPolicyByTargetId?.[target.id] ?? null,
        sequencePattern:''',
    '''        scheduledPolicy: opts.scheduledPolicyByTargetId?.[target.id] ?? null,
        targetDurationMs: resolvedDuration?.durationMs ?? 0,
        sequencePattern:''',
)

replace_once(
    GEN,
    '''          if (!patch) {
            const snapshotAfter = await writer!.replacePlaylistItems(
              playlistId,
              items.map((item) => item.uri),
            );
            targetSummary.applied = true;
            targetSummary.snapshotAfter = snapshotAfter;
          } else {''',
    '''          if (!patch) {
            const rebuild = opts.rebuildByTargetId?.[target.id] ?? null;
            if (rebuild) {
              const currentSnapshot = await writer!.getPlaylistSnapshotId(playlistId);
              if (currentSnapshot !== rebuild.snapshotBefore) {
                throw new Error(
                  `Target "${target.name}" changed after its final rebuild preflight`,
                );
              }
            }
            const snapshotAfter = await writer!.replacePlaylistItems(
              playlistId,
              items.map((item) => item.uri),
            );
            targetSummary.applied = true;
            targetSummary.snapshotAfter = snapshotAfter;
            if (rebuild) {
              targetSummary.snapshotBefore = rebuild.snapshotBefore;
              targetSummary.validDurationBeforeMs = null;
              targetSummary.removedDurationMs = rebuild.currentDurationMs;
              targetSummary.addedDurationMs = stats.totalDurationMs;
              targetSummary.preservedCount = 0;
              targetSummary.removedCount = rebuild.currentCount;
              targetSummary.addedCount = items.length;
              targetSummary.maintenanceNoop = false;
            }
          } else {''',
)

SG = "src/jobs/scheduled-generation.ts"
replace_once(
    SG,
    '''      const scheduledPolicyByTargetId: Record<
        string,
        "KEEP_FILLED" | "REBUILD_DAILY"
      > = {};

      for (const entry of claimed) {''',
    '''      const scheduledPolicyByTargetId: Record<
        string,
        "KEEP_FILLED" | "REBUILD_DAILY"
      > = {};
      const rebuildByTargetId: Record<
        string,
        { snapshotBefore: string; currentCount: number; currentDurationMs: number }
      > = {};
      let maintenanceSpotify: SpotifyClient | null = null;

      for (const entry of claimed) {''',
)

replace_once(
    SG,
    '''        if (entry.target.updatePolicy !== "KEEP_FILLED") {
          executable.push(entry);
          continue;
        }
        try {
          const prepared = await prepareKeepFilledTarget(user.id, entry.target, now);''',
    '''        if (entry.target.updatePolicy !== "KEEP_FILLED") {
          try {
            if (!entry.target.spotifyPlaylistId) {
              throw new Error(`Target "${entry.target.name}" has no Spotify playlist`);
            }
            maintenanceSpotify ??= await SpotifyClient.forUser(user.id);
            const before = await maintenanceSpotify.getTargetPlaylistState(
              entry.target.spotifyPlaylistId,
            );
            rebuildByTargetId[entry.target.id] = {
              snapshotBefore: before.snapshotId,
              currentCount: before.items.length,
              currentDurationMs: before.items.reduce(
                (sum, item) => sum + Math.max(0, item.originalDurationMs ?? 0),
                0,
              ),
            };
            executable.push(entry);
          } catch (error) {
            const reason = errorMessage(error);
            await finishOne(entry.audit.id, "BLOCKED", reason, now);
            results.push(result(entry, "", `blocked: ${reason}`));
          }
          continue;
        }
        try {
          const prepared = await prepareKeepFilledTarget(user.id, entry.target, now);''',
)

replace_once(
    SG,
    '''      const reservedUris = new Set<string>();
      if (outsideTargets.length > 0) {
        const spotify = await SpotifyClient.forUser(user.id);
        for (const outside of outsideTargets) {
          if (!outside.spotifyPlaylistId) continue;
          const state = await spotify.getTargetPlaylistState(outside.spotifyPlaylistId);
          for (const item of state.items) {
            if (item.uri) reservedUris.add(item.uri);
          }
        }
      }''',
    '''      const reservedUris = new Set<string>();
      const reservedTargetSnapshots: Record<string, string> = {};
      if (outsideTargets.length > 0) {
        maintenanceSpotify ??= await SpotifyClient.forUser(user.id);
        for (const outside of outsideTargets) {
          if (!outside.spotifyPlaylistId) continue;
          const state = await maintenanceSpotify.getTargetPlaylistState(
            outside.spotifyPlaylistId,
          );
          reservedTargetSnapshots[outside.spotifyPlaylistId] = state.snapshotId;
          for (const item of state.items) {
            if (item.uri) reservedUris.add(item.uri);
          }
        }
      }''',
)
replace_once(
    SG,
    '''        musicOrderSimulationEvidence,
        reservedUris: [...reservedUris],
      });''',
    '''        musicOrderSimulationEvidence,
        reservedUris: [...reservedUris],
        reservedTargetSnapshots,
        rebuildByTargetId,
      });''',
)

TEST = "src/services/configuration-readiness.test.ts"
replace_once(
    TEST,
    'const preflight = source.indexOf("keepFilledSnapshotViolations");',
    'const preflight = source.indexOf("scheduledTargetSnapshotViolations");',
)

T = Path(TEST)
T.write_text(
    T.read_text()
    + r'''

test("SCHEDULE-01 revalidates external reservation and rebuild snapshots before writes", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const writer = source.indexOf("if (!simulate) writer = await SpotifyClient.forUser(userId)");
  const externalCheck = source.indexOf("externalReservationSnapshotViolations");
  const replace = source.indexOf("replacePlaylistItems", externalCheck);
  assert.ok(writer >= 0);
  assert.ok(externalCheck > writer);
  assert.ok(replace > externalCheck);
  assert.match(source, /rebuildByTargetId/);
  assert.match(source, /reservedTargetSnapshots/);
});
'''
)

print("SCHEDULE-01 stage7 hardening applied")
