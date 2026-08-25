from pathlib import Path
import re


def sub_once(path: str, pattern: str, replacement: str, flags: int = 0):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one replacement, got {count}: {pattern[:120]}")
    p.write_text(updated, encoding="utf-8")


def append_once(path: str, marker: str, addition: str):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if addition.strip() in text:
        return
    idx = text.rfind(marker)
    if idx < 0:
        raise SystemExit(f"{path}: marker not found: {marker}")
    p.write_text(text[:idx] + addition + text[idx:], encoding="utf-8")


# 1) Discovery complete-universe reads must honor the same isolated-source
#    recovery policy, while discarding all partial candidates from that source.
path = "src/services/music-discovery/planner-preview.ts"
sub_once(
    path,
    r'export type CompleteDiscoverySourceUniverse = \{',
    '''export type DiscoveryPreviewSourceFailure<\n  TSource extends DiscoveryPreviewSource = DiscoveryPreviewSource,\n> = {\n  source: TSource;\n  error: unknown;\n};\n\nexport type CompleteDiscoverySourceUniverse<\n  TSource extends DiscoveryPreviewSource = DiscoveryPreviewSource,\n> = {''',
)
sub_once(
    path,
    r'(  podcasts: Candidate\[\];\n)(  evidence: \{)',
    r'''\1  degradedFailures: DiscoveryPreviewSourceFailure<TSource>[];\n\2''',
)
sub_once(
    path,
    r'(    duplicateMusicUriDroppedCount: number;\n)(    sources: Array<\{)',
    r'''\1    degradedSourceCount: number;\n    degradedSources: Array<{\n      id: string;\n      label: string;\n      kind: DiscoveryPreviewSourceKind;\n    }>;\n\2''',
)
sub_once(
    path,
    r'export async function collectCompleteDiscoverySourceUniverse\([\s\S]*?\n\}\n\n/\*\* Complete historical facts \+ complete source MUSIC',
    '''export async function collectCompleteDiscoverySourceUniverse<\n  TSource extends DiscoveryPreviewSource,\n>(\n  sources: TSource[],\n  options: {\n    recoverSourceFailure?: (source: TSource, error: unknown) => boolean;\n  } = {},\n): Promise<CompleteDiscoverySourceUniverse<TSource>> {\n  const rawMusic: Candidate[] = [];\n  const podcasts: Candidate[] = [];\n  const sourceEvidence: CompleteDiscoverySourceUniverse<TSource>["evidence"]["sources"] = [];\n  const degradedFailures: DiscoveryPreviewSourceFailure<TSource>[] = [];\n  const recoverSourceFailure = options.recoverSourceFailure ?? (() => false);\n  let readCalls = 0;\n  let cacheBatchCount = 0;\n  let unavailableMusicSkippedCount = 0;\n\n  for (const source of sources) {\n    let sourceReadCalls = 0;\n    let candidateCount = 0;\n    const sourceMusic: Candidate[] = [];\n    const sourcePodcasts: Candidate[] = [];\n\n    try {\n      while (!source.done) {\n        if (readCalls >= MAX_SOURCE_READ_CALLS) {\n          throw new Error(\n            `DISCOVERY Gate 3B source collection exceeded ${MAX_SOURCE_READ_CALLS} read calls before every cursor completed`,\n          );\n        }\n\n        const batch = await source.readNext();\n        readCalls += 1;\n        sourceReadCalls += 1;\n        candidateCount += batch.candidates.length;\n        if (batch.fromCache) cacheBatchCount += 1;\n        unavailableMusicSkippedCount += batch.unavailableMusicSkippedCount ?? 0;\n\n        if (source.kind === "MUSIC") sourceMusic.push(...batch.candidates);\n        else sourcePodcasts.push(...batch.candidates);\n\n        if (batch.done && !source.done) {\n          throw new Error(\n            `DISCOVERY Gate 3B source ${source.id} reported batch.done=true while its cursor remained open`,\n          );\n        }\n      }\n    } catch (error) {\n      if (!recoverSourceFailure(source, error)) throw error;\n      degradedFailures.push({ source, error });\n      continue;\n    }\n\n    // Commit candidates only after the source cursor completes. This makes a\n    // recovered 502 atomic: pages read before the failure never enter ranking.\n    rawMusic.push(...sourceMusic);\n    podcasts.push(...sourcePodcasts);\n    sourceEvidence.push({\n      id: source.id,\n      label: source.label,\n      kind: source.kind,\n      readCalls: sourceReadCalls,\n      candidateCount,\n      done: true,\n    });\n  }\n\n  const dedupedMusic = dedupeMusicByUri(rawMusic);\n\n  return {\n    universe: "COMPLETE",\n    music: dedupedMusic.candidates,\n    podcasts,\n    degradedFailures,\n    evidence: {\n      sourceCount: sources.length,\n      musicSourceCount: sources.filter((source) => source.kind === "MUSIC").length,\n      podcastSourceCount: sources.filter((source) => source.kind === "PODCAST").length,\n      readCalls,\n      cacheBatchCount,\n      unavailableMusicSkippedCount,\n      duplicateMusicUriDroppedCount: dedupedMusic.droppedCount,\n      degradedSourceCount: degradedFailures.length,\n      degradedSources: degradedFailures.map(({ source }) => ({\n        id: source.id,\n        label: source.label,\n        kind: source.kind,\n      })),\n      sources: sourceEvidence,\n    },\n  };\n}\n\n/** Complete historical facts + complete source MUSIC''',
    flags=re.S,
)

# 2) Carry discovery-phase degraded source failures into the generic incremental
#    result so generator diagnostics and PARTIAL semantics stay identical.
path = "src/jobs/discovery-runtime.ts"
sub_once(
    path,
    r'\>\(sources: TSource\[\]\): Promise<\{\n  rankedMusic: Candidate\[\];\n  sourceEntries: DiscoveryPlannerPoolEntry\[\];\n  podcastSources: TSource\[\];\n  completedMusicSourceIds: string\[\];\n\} \| null> \{',
    '''>(\n  sources: TSource[],\n  options: {\n    recoverSourceFailure?: (source: TSource, error: unknown) => boolean;\n  } = {},\n): Promise<{\n  rankedMusic: Candidate[];\n  sourceEntries: DiscoveryPlannerPoolEntry[];\n  podcastSources: TSource[];\n  completedMusicSourceIds: string[];\n  degradedFailures: Array<{ source: TSource; error: unknown }>;\n} | null> {''',
)
sub_once(
    path,
    r'const sourceUniverse = await collectCompleteDiscoverySourceUniverse\(musicSources\);',
    'const sourceUniverse = await collectCompleteDiscoverySourceUniverse(musicSources, options);',
)
sub_once(
    path,
    r'(      musicSourceReadCalls: sourceUniverse\.evidence\.readCalls,\n)',
    r'''\1      degradedMusicSourceCount: sourceUniverse.evidence.degradedSourceCount,\n      degradedMusicSources: sourceUniverse.evidence.degradedSources,\n''',
)
sub_once(
    path,
    r'(      completedMusicSourceIds: sourceUniverse\.evidence\.sources\.map\(\(source\) => source\.id\),\n)(    \};)',
    r'''\1      degradedFailures: sourceUniverse.degradedFailures,\n\2''',
)

path = "src/jobs/incremental-planning.ts"
sub_once(
    path,
    r'\? await prepareDiscoveryMusicForCurrentRun\(sources\)\n    : null;',
    '''? await prepareDiscoveryMusicForCurrentRun(sources, { recoverSourceFailure })\n    : null;''',
)
sub_once(
    path,
    r'  const activeSources: TSource\[\] = discovery \? discovery\.podcastSources : sources;\n  const activeSourceById = new Map\(activeSources\.map\(\(source\) => \[source\.id, source\]\)\);\n  const degradedSourceIds = new Set<string>\(\);\n  const degradedFailures: IncrementalSourceFailure<TSource>\[\] = \[\];',
    '''  const activeSources: TSource[] = discovery ? discovery.podcastSources : sources;\n  const activeSourceById = new Map(activeSources.map((source) => [source.id, source]));\n  const degradedFailures: IncrementalSourceFailure<TSource>[] = [\n    ...(discovery?.degradedFailures ?? []),\n  ];\n  const degradedSourceIds = new Set<string>(\n    degradedFailures.map((failure) => failure.source.id),\n  );''',
)
sub_once(
    path,
    r'  const attemptedSourceIds = new Set<string>\(\n    discovery\?\.completedMusicSourceIds \?\? \[\],\n  \);',
    '''  const attemptedSourceIds = new Set<string>([\n    ...(discovery?.completedMusicSourceIds ?? []),\n    ...degradedFailures.map((failure) => failure.source.id),\n  ]);''',
)

# 3) Persist all resolved target ids immediately so manual all-target failures
#    remain attributable even if the run returns before summary.targets exists.
path = "src/jobs/generate-playlists-incremental.ts"
sub_once(
    path,
    r'(    if \(targetScope && targets\.length !== targetScope\.length\) \{\n      throw new Error\([\s\S]*?\n      \);\n    \}\n)',
    r'''\1    summary.resolvedTargetIds = targets.map((target) => target.id);\n''',
)

path = "src/services/generation-run-diagnostics.ts"
sub_once(
    path,
    r'(  const targetScope = Array\.isArray\(root\.targetScope\) \? root\.targetScope : \[\];\n  if \(targetScope\.some\(\(entry\) => entry === targetId\)\) return true;\n)',
    r'''\1\n  const resolvedTargetIds = Array.isArray(root.resolvedTargetIds)\n    ? root.resolvedTargetIds\n    : [];\n  if (resolvedTargetIds.some((entry) => entry === targetId)) return true;\n''',
)

# 4) Paginate operational history until eight runs for this target are found,
#    instead of truncating the user's global history before target filtering.
path = "src/app/dashboard/playlists/[targetId]/page.tsx"
sub_once(
    path,
    r'  const \[run, recentCandidates\] = await Promise\.all\(\[[\s\S]*?\n  \]\);\n\n  const recentRuns = recentCandidates[\s\S]*?\.slice\(0, 8\);',
    '''  const [run, recentRuns] = await Promise.all([\n    prisma.generationRun.findFirst({\n      where: {\n        userId: session.user.id,\n        simulation: false,\n        status: { in: ["SUCCESS", "PARTIAL"] },\n        items: {\n          some: { targetPlaylistId: target.id },\n        },\n      },\n      orderBy: { startedAt: "desc" },\n      include: {\n        items: {\n          where: { targetPlaylistId: target.id },\n          orderBy: { position: "asc" },\n        },\n      },\n    }),\n    loadRecentTargetRuns(session.user.id, target.id),\n  ]);''',
    flags=re.S,
)

append_once(
    path,
    'function Metric(',
    '''async function loadRecentRunBatch(userId: string, targetId: string, skip: number) {\n  return prisma.generationRun.findMany({\n    where: {\n      userId,\n      simulation: false,\n    },\n    orderBy: { startedAt: "desc" },\n    skip,\n    take: 40,\n    select: {\n      id: true,\n      trigger: true,\n      status: true,\n      startedAt: true,\n      finishedAt: true,\n      error: true,\n      summary: true,\n      items: {\n        where: { targetPlaylistId: targetId },\n        select: { id: true },\n        take: 1,\n      },\n      scheduleRuns: {\n        where: { targetPlaylistId: targetId },\n        orderBy: { startedAt: "desc" },\n        select: { status: true, reason: true, attempt: true },\n        take: 1,\n      },\n    },\n  });\n}\n\ntype RecentRunCandidate = Awaited<ReturnType<typeof loadRecentRunBatch>>[number];\n\nasync function loadRecentTargetRuns(\n  userId: string,\n  targetId: string,\n): Promise<RecentRunCandidate[]> {\n  const matches: RecentRunCandidate[] = [];\n  let skip = 0;\n\n  while (matches.length < 8) {\n    const batch = await loadRecentRunBatch(userId, targetId, skip);\n    for (const candidate of batch) {\n      if (\n        candidate.items.length > 0 ||\n        candidate.scheduleRuns.length > 0 ||\n        runSummaryMentionsTarget(candidate.summary, targetId)\n      ) {\n        matches.push(candidate);\n        if (matches.length >= 8) break;\n      }\n    }\n\n    if (batch.length < 40) break;\n    skip += batch.length;\n  }\n\n  return matches.slice(0, 8);\n}\n\n''',
)

# Focused regressions.
path = "src/services/generation-run-diagnostics.test.ts"
sub_once(
    path,
    r'test\("target membership is recovered from targetScope or target summaries", \(\) => \{',
    'test("target membership is recovered from explicit scope, resolved scope or target summaries", () => {',
)
sub_once(
    path,
    r'(  assert\.equal\(runSummaryMentionsTarget\(\{ targetScope: \["target-a"\] \}, "target-a"\), true\);\n)',
    r'''\1  assert.equal(\n    runSummaryMentionsTarget({ resolvedTargetIds: ["target-early"] }, "target-early"),\n    true,\n  );\n''',
)

path = "src/services/music-discovery/planner-preview.test.ts"
append_once(
    path,
    'test("Gate 3B refuses a cursor',
    '''test("Gate 3B recovery discards partial candidates from a degraded source", async () => {\n  const partial = music("partial", "Partial Artist", "Partial Track");\n  const healthy = music("healthy", "Healthy Artist", "Healthy Track");\n  let calls = 0;\n  const degraded: DiscoveryPreviewSource = {\n    id: "degraded",\n    label: "degraded",\n    kind: "MUSIC",\n    get done() {\n      return false;\n    },\n    async readNext() {\n      calls += 1;\n      if (calls === 1) return { candidates: [partial], done: false };\n      throw new Error("HTTP 502");\n    },\n  };\n\n  const universe = await collectCompleteDiscoverySourceUniverse(\n    [degraded, sourceWithPages("healthy", "MUSIC", [[healthy]])],\n    { recoverSourceFailure: (_source, error) => String(error).includes("502") },\n  );\n\n  assert.deepEqual(universe.music.map((candidate) => candidate.spotifyTrackId), ["healthy"]);\n  assert.equal(universe.degradedFailures.length, 1);\n  assert.equal(universe.degradedFailures[0]?.source.id, "degraded");\n  assert.equal(universe.evidence.degradedSourceCount, 1);\n  assert.deepEqual(universe.evidence.sources.map((source) => source.id), ["healthy"]);\n});\n\ntest("Gate 3B keeps non-recoverable source failures fail-closed", async () => {\n  const broken: DiscoveryPreviewSource = {\n    id: "non-recoverable",\n    label: "non-recoverable",\n    kind: "MUSIC",\n    get done() {\n      return false;\n    },\n    async readNext() {\n      throw new Error("HTTP 503");\n    },\n  };\n\n  await assert.rejects(\n    collectCompleteDiscoverySourceUniverse([broken], {\n      recoverSourceFailure: () => false,\n    }),\n    /503/,\n  );\n});\n\n''',
)

print("PR 183 review fixes applied")
