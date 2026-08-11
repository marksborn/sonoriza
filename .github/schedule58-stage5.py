from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one match, got {text.count(old)} for {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# TypeScript cannot infer the recursive snapshot update strongly enough here;
# make the provider response explicit without changing runtime semantics.
p = Path("src/services/spotify/client.ts")
text = p.read_text()
text = text.replace(
    'const result = await this.request<{ snapshot_id?: string }>(',
    'const result: { snapshot_id?: string } = await this.request<{ snapshot_id?: string }>(',
)
p.write_text(text)

replace_once(
    "src/jobs/scheduled-generation.ts",
    "Object.entries(reusable).filter(([targetId]) => rebuildIds.has(targetId))",
    "Object.entries(reusable ?? {}).filter(([targetId]) => rebuildIds.has(targetId))",
)

# The existing test helper rules() takes positional arguments; keep the new
# SCHEDULE-01 tests explicit so they test planner semantics, not helper syntax.
replace_once(
    "src/services/playlist-planner/planner.test.ts",
    '''    rules: rules({ targetDurationMs: 540_000, podcastPercent: 0 }),''',
    '''    rules: {
      targetDurationMs: 540_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
    },''',
)
replace_once(
    "src/services/playlist-planner/planner.test.ts",
    '''    rules: rules({
      targetDurationMs: 360_000,
      compositionMode: "SEQUENCE",
      sequencePattern: ["MUSIC", "PODCAST"],
    }),''',
    '''    rules: {
      targetDurationMs: 360_000,
      compositionMode: "SEQUENCE",
      podcastPercent: 50,
      sequencePattern: ["MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 1,
    },''',
)
replace_once(
    "src/services/playlist-planner/planner.test.ts",
    '  const nextPodcast = podcast("next-podcast", 180_000, "program-next");',
    '  const nextPodcast = podcast("next-podcast", "program-next", 180_000);',
)

print("SCHEDULE-01 stage5 patch applied")
