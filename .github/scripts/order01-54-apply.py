from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected exactly one match, found {count}\n--- needle ---\n{old}"
        )
    file.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Prisma: explicit per-target music order with safe legacy default.
# ---------------------------------------------------------------------------
replace_once(
    "prisma/schema.prisma",
    """enum CompositionMode {
  PROPORTION
  SEQUENCE
}

model TargetPlaylist {""",
    """enum CompositionMode {
  PROPORTION
  SEQUENCE
}

enum MusicOrderMode {
  STANDARD
  RANDOMIZED
}

model TargetPlaylist {""",
)
replace_once(
    "prisma/schema.prisma",
    """  compositionMode                  CompositionMode               @default(PROPORTION)
  durationMode                     DurationMode                  @default(FIXED)""",
    """  compositionMode                  CompositionMode               @default(PROPORTION)
  musicOrderMode                   MusicOrderMode                @default(STANDARD)
  durationMode                     DurationMode                  @default(FIXED)""",
)

migration = Path("prisma/migrations/20260811150000_music_order_mode/migration.sql")
migration.parent.mkdir(parents=True, exist_ok=True)
migration.write_text(
    """-- ORDER-01: explicit per-destination music ordering policy.
CREATE TYPE "MusicOrderMode" AS ENUM ('STANDARD', 'RANDOMIZED');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "musicOrderMode" "MusicOrderMode" NOT NULL DEFAULT 'STANDARD';
"""
)


# ---------------------------------------------------------------------------
# Pure ordering service: shuffle identities only inside existing MUSIC slots.
# ---------------------------------------------------------------------------
Path("src/services/playlist-ordering.ts").write_text(
    r'''import { createHash } from "node:crypto";

export type MusicOrderMode = "STANDARD" | "RANDOMIZED";

export type OrderablePlaylistItem = {
  uri: string;
  type: "MUSIC" | "PODCAST";
  position: number;
};

export type MusicOrderEvidence = {
  mode: MusicOrderMode;
  seed: string | null;
  seedSource: "RUN" | "SIMULATION" | null;
  changed: boolean;
  musicCount: number;
  orderHash: string;
};

export function createMusicOrderSeed(runId: string, targetPlaylistId: string): string {
  return createHash("sha256")
    .update(`ORDER-01\0${runId}\0${targetPlaylistId}`)
    .digest("hex")
    .slice(0, 32);
}

function rankingKey(seed: string, item: OrderablePlaylistItem, originalIndex: number) {
  return createHash("sha256")
    .update(`${seed}\0${originalIndex}\0${item.uri}`)
    .digest("hex");
}

function finalOrderHash(items: OrderablePlaylistItem[]) {
  return createHash("sha256")
    .update(items.map((item) => `${item.position}:${item.type}:${item.uri}`).join("\n"))
    .digest("hex");
}

/**
 * ORDER-01 runs strictly after selection. RANDOMIZED reassigns only MUSIC
 * identities among positions that are already MUSIC slots. Podcast positions,
 * the type pattern, selected URI set and total duration are untouched.
 */
export function applyMusicOrder<T extends OrderablePlaylistItem>(
  items: T[],
  mode: MusicOrderMode,
  seed: string | null,
  seedSource: MusicOrderEvidence["seedSource"] = seed ? "RUN" : null,
): { items: T[]; evidence: MusicOrderEvidence } {
  if (mode === "STANDARD") {
    const result = items.map((item) => ({ ...item })) as T[];
    return {
      items: result,
      evidence: {
        mode,
        seed: null,
        seedSource: null,
        changed: false,
        musicCount: result.filter((item) => item.type === "MUSIC").length,
        orderHash: finalOrderHash(result),
      },
    };
  }

  if (!seed) throw new Error("RANDOMIZED music order requires a seed");

  const originalMusic = items.filter((item) => item.type === "MUSIC");
  const rankedMusic = originalMusic
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      key: rankingKey(seed, item, originalIndex),
    }))
    .sort((left, right) =>
      left.key === right.key
        ? left.originalIndex - right.originalIndex
        : left.key.localeCompare(right.key),
    )
    .map((entry) => entry.item);

  let musicIndex = 0;
  const result = items.map((slot) => {
    if (slot.type !== "MUSIC") return { ...slot } as T;
    const selected = rankedMusic[musicIndex++]!;
    return { ...selected, position: slot.position } as T;
  });

  const originalMusicUris = originalMusic.map((item) => item.uri);
  const finalMusicUris = result
    .filter((item) => item.type === "MUSIC")
    .map((item) => item.uri);

  return {
    items: result,
    evidence: {
      mode,
      seed,
      seedSource,
      changed: originalMusicUris.some((uri, index) => finalMusicUris[index] !== uri),
      musicCount: originalMusic.length,
      orderHash: finalOrderHash(result),
    },
  };
}

export function readMusicOrderSeedsFromSummary(summary: unknown): Record<string, string> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return {};
  const targets = (summary as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return {};

  const result: Record<string, string> = {};
  for (const entry of targets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const target = entry as Record<string, unknown>;
    if (
      target.musicOrderMode === "RANDOMIZED" &&
      typeof target.targetPlaylistId === "string" &&
      typeof target.musicOrderSeed === "string" &&
      target.musicOrderSeed.length > 0
    ) {
      result[target.targetPlaylistId] = target.musicOrderSeed;
    }
  }
  return result;
}
'''
)

Path("src/services/playlist-ordering.test.ts").write_text(
    r'''import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMusicOrder,
  createMusicOrderSeed,
  readMusicOrderSeedsFromSummary,
  type OrderablePlaylistItem,
} from "./playlist-ordering";

function fixture(): OrderablePlaylistItem[] {
  return [
    { position: 0, type: "MUSIC", uri: "spotify:track:A" },
    { position: 1, type: "MUSIC", uri: "spotify:track:B" },
    { position: 2, type: "PODCAST", uri: "spotify:episode:P1" },
    { position: 3, type: "MUSIC", uri: "spotify:track:C" },
    { position: 4, type: "MUSIC", uri: "spotify:track:D" },
    { position: 5, type: "PODCAST", uri: "spotify:episode:P2" },
    { position: 6, type: "MUSIC", uri: "spotify:track:E" },
  ];
}

function uris(items: OrderablePlaylistItem[]) {
  return items.map((item) => item.uri);
}

test("STANDARD preserves the exact planned order", () => {
  const input = fixture();
  const ordered = applyMusicOrder(input, "STANDARD", null);
  assert.deepEqual(uris(ordered.items), uris(input));
  assert.equal(ordered.evidence.seed, null);
  assert.equal(ordered.evidence.changed, false);
});

test("RANDOMIZED is deterministic for the same seed", () => {
  const first = applyMusicOrder(fixture(), "RANDOMIZED", "seed-a");
  const second = applyMusicOrder(fixture(), "RANDOMIZED", "seed-a");
  assert.deepEqual(uris(first.items), uris(second.items));
  assert.equal(first.evidence.orderHash, second.evidence.orderHash);
});

test("RANDOMIZED changes only music identities, preserving podcast slots and selected set", () => {
  const input = fixture();
  const ordered = applyMusicOrder(input, "RANDOMIZED", "seed-a");

  assert.deepEqual(
    ordered.items.map((item) => item.type),
    input.map((item) => item.type),
  );
  assert.equal(ordered.items[2]?.uri, "spotify:episode:P1");
  assert.equal(ordered.items[5]?.uri, "spotify:episode:P2");
  assert.deepEqual([...uris(ordered.items)].sort(), [...uris(input)].sort());
  assert.deepEqual(
    ordered.items.map((item) => item.position),
    input.map((item) => item.position),
  );
  assert.equal(ordered.evidence.changed, true);
});

test("different seeds can produce different music order", () => {
  const first = applyMusicOrder(fixture(), "RANDOMIZED", "seed-a");
  const second = applyMusicOrder(fixture(), "RANDOMIZED", "seed-b");
  assert.notDeepEqual(uris(first.items), uris(second.items));
});

test("execution seed is stable for one run/target and changes with the run", () => {
  assert.equal(
    createMusicOrderSeed("run-a", "target-1"),
    createMusicOrderSeed("run-a", "target-1"),
  );
  assert.notEqual(
    createMusicOrderSeed("run-a", "target-1"),
    createMusicOrderSeed("run-b", "target-1"),
  );
});

test("reads only valid RANDOMIZED target seeds from persisted run summary", () => {
  assert.deepEqual(
    readMusicOrderSeedsFromSummary({
      targets: [
        {
          targetPlaylistId: "car",
          musicOrderMode: "RANDOMIZED",
          musicOrderSeed: "seed-car",
        },
        {
          targetPlaylistId: "work",
          musicOrderMode: "STANDARD",
          musicOrderSeed: "ignored",
        },
        { targetPlaylistId: "bad", musicOrderMode: "RANDOMIZED" },
      ],
    }),
    { car: "seed-car" },
  );
});
'''
)

# One-shot reuse of an approved simulation seed. A simulation is reusable only
# when it is newer than the latest real attempt and has the current fingerprint.
Path("src/services/music-order-simulation.ts").write_text(
    r'''import { prisma } from "@/lib/prisma";
import { readConfigurationFingerprint } from "@/services/configuration-readiness";
import { readMusicOrderSeedsFromSummary } from "@/services/playlist-ordering";

export async function findReusableSimulationMusicOrderSeeds(
  userId: string,
  configurationFingerprint: string,
): Promise<Record<string, string> | undefined> {
  const latestRealAttempt = await prisma.generationRun.findFirst({
    where: { userId, simulation: false },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });

  const simulations = await prisma.generationRun.findMany({
    where: {
      userId,
      simulation: true,
      status: "SUCCESS",
      ...(latestRealAttempt
        ? { startedAt: { gt: latestRealAttempt.startedAt } }
        : {}),
    },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: { summary: true },
  });

  for (const simulation of simulations) {
    if (readConfigurationFingerprint(simulation.summary) !== configurationFingerprint) {
      continue;
    }
    const seeds = readMusicOrderSeedsFromSummary(simulation.summary);
    if (Object.keys(seeds).length > 0) return seeds;
  }

  return undefined;
}
'''
)


# ---------------------------------------------------------------------------
# CONFIG-03 client form.
# ---------------------------------------------------------------------------
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    'type CompositionMode = "PROPORTION" | "SEQUENCE";\n',
    'type CompositionMode = "PROPORTION" | "SEQUENCE";\ntype MusicOrderMode = "STANDARD" | "RANDOMIZED";\n',
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    """  compositionMode: CompositionMode;
  podcastPercent: number;""",
    """  compositionMode: CompositionMode;
  musicOrderMode: MusicOrderMode;
  podcastPercent: number;""",
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    """  const [compositionMode, setCompositionMode] = useState<CompositionMode>(
    initial.compositionMode,
  );
  const [podcastPercent, setPodcastPercent] = useState(initial.podcastPercent);""",
    """  const [compositionMode, setCompositionMode] = useState<CompositionMode>(
    initial.compositionMode,
  );
  const [musicOrderMode, setMusicOrderMode] = useState<MusicOrderMode>(
    initial.musicOrderMode,
  );
  const [podcastPercent, setPodcastPercent] = useState(initial.podcastPercent);""",
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    """      </fieldset>

      {compositionMode === "PROPORTION" && (
        <div className={sectionClass}>""",
    """      </fieldset>

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Ordem das músicas
        </legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          A seleção continua a mesma. Esta opção muda apenas qual música ocupa cada slot de música; podcasts e a sequência de tipos não são alterados.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className={optionClass(musicOrderMode === "STANDARD")}>
            <input
              type="radio"
              name="musicOrderMode"
              value="STANDARD"
              checked={musicOrderMode === "STANDARD"}
              onChange={() => setMusicOrderMode("STANDARD")}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Ordem padrão</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
              Mantém a ordem musical produzida pelo planner.
            </span>
          </label>
          <label className={optionClass(musicOrderMode === "RANDOMIZED")}>
            <input
              type="radio"
              name="musicOrderMode"
              value="RANDOMIZED"
              checked={musicOrderMode === "RANDOMIZED"}
              onChange={() => setMusicOrderMode("RANDOMIZED")}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Randomizar músicas</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
              Cada execução recebe um seed auditável e pode produzir uma nova ordem, sem depender do Shuffle do Spotify.
            </span>
          </label>
        </div>
      </fieldset>

      {compositionMode === "PROPORTION" && (
        <div className={sectionClass}>""",
)


# ---------------------------------------------------------------------------
# CONFIG-03 server action, defaults and list presentation.
# ---------------------------------------------------------------------------
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    """  const compositionMode = String(formData.get("compositionMode") ?? "").trim();
  const emptyCalendarBehavior = String(""",
    """  const compositionMode = String(formData.get("compositionMode") ?? "").trim();
  const musicOrderMode = String(formData.get("musicOrderMode") ?? "STANDARD").trim();
  const emptyCalendarBehavior = String(""",
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    """  if (!normalizedCompositionMode) fail("invalid");
  if (!sequencePattern || podcastPercent === null || maxEpisodesPerProgram === null) {""",
    """  if (!normalizedCompositionMode) fail("invalid");
  const normalizedMusicOrderMode =
    musicOrderMode === "STANDARD" || musicOrderMode === "RANDOMIZED"
      ? musicOrderMode
      : null;
  if (!normalizedMusicOrderMode) fail("invalid");
  if (!sequencePattern || podcastPercent === null || maxEpisodesPerProgram === null) {""",
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    """    enabled,
    compositionMode: normalizedCompositionMode,
    durationMode,""",
    """    enabled,
    compositionMode: normalizedCompositionMode,
    musicOrderMode: normalizedMusicOrderMode,
    durationMode,""",
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    """                  compositionMode: "PROPORTION",
                  podcastPercent: 60,""",
    """                  compositionMode: "PROPORTION",
                  musicOrderMode: "STANDARD",
                  podcastPercent: 60,""",
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    """                            compositionMode: target.compositionMode,
                            podcastPercent: target.podcastPercent,""",
    """                            compositionMode: target.compositionMode,
                            musicOrderMode: target.musicOrderMode,
                            podcastPercent: target.podcastPercent,""",
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    """                          {` · ${podcastEpisodeMaxDurationLabel(target)}`}
                        </p>""",
    """                          {` · ${podcastEpisodeMaxDurationLabel(target)}`}
                          {` · músicas: ${
                            target.musicOrderMode === "RANDOMIZED"
                              ? "ordem randomizada"
                              : "ordem padrão"
                          }`}
                        </p>""",
)


# ---------------------------------------------------------------------------
# Configuration assessment/fingerprint — changing order invalidates simulation.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/configuration-readiness.ts",
    """    compositionMode: "PROPORTION" | "SEQUENCE";
    podcastPercent: number;""",
    """    compositionMode: "PROPORTION" | "SEQUENCE";
    musicOrderMode: "STANDARD" | "RANDOMIZED";
    podcastPercent: number;""",
)
replace_once(
    "src/services/configuration-readiness.ts",
    """          compositionMode: true,
          podcastPercent: true,""",
    """          compositionMode: true,
          musicOrderMode: true,
          podcastPercent: true,""",
)
replace_once(
    "src/services/configuration-readiness.ts",
    """    compositionMode: target.compositionMode,
    podcastPercent: target.podcastPercent,""",
    """    compositionMode: target.compositionMode,
    musicOrderMode: target.musicOrderMode,
    podcastPercent: target.podcastPercent,""",
)
replace_once(
    "src/services/configuration-readiness.ts",
    """      compositionMode: target.compositionMode,
      podcastPercent:
        target.compositionMode === "PROPORTION" ? target.podcastPercent : null,""",
    """      compositionMode: target.compositionMode,
      musicOrderMode: target.musicOrderMode,
      podcastPercent:
        target.compositionMode === "PROPORTION" ? target.podcastPercent : null,""",
)


# ---------------------------------------------------------------------------
# Generator: apply order after selection/quality, before defense/write/persist.
# ---------------------------------------------------------------------------
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    """import {
  parseSequencePattern,
  type RunTarget,
} from "@/services/playlist-planner";
import {""",
    """import {
  parseSequencePattern,
  type RunTarget,
} from "@/services/playlist-planner";
import {
  applyMusicOrder,
  createMusicOrderSeed,
  type MusicOrderEvidence,
} from "@/services/playlist-ordering";
import {""",
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    """  /** Day used to resolve calendar-based durations. Defaults to now. */
  date?: Date;
}""",
    """  /** Day used to resolve calendar-based durations. Defaults to now. */
  date?: Date;
  /** ORDER-01: one-shot seeds reused from a current approved simulation. */
  musicOrderSeeds?: Record<string, string>;
}""",
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    """    const targetByPlanId = new Map(targets.map((target) => [target.id, target]));
    const sequenceViolations = plan.targets.flatMap((planned) => {""",
    """    const targetByPlanId = new Map(targets.map((target) => [target.id, target]));
    const musicOrderEvidenceByTargetId = new Map<string, MusicOrderEvidence>();

    for (const planned of plan.targets) {
      const target = targetByPlanId.get(planned.targetPlaylistId);
      if (!target) continue;

      const reusedSeed = opts.musicOrderSeeds?.[target.id] ?? null;
      const seed =
        target.musicOrderMode === "RANDOMIZED"
          ? reusedSeed ?? createMusicOrderSeed(run.id, target.id)
          : null;
      const ordered = applyMusicOrder(
        planned.result.items,
        target.musicOrderMode,
        seed,
        reusedSeed ? "SIMULATION" : seed ? "RUN" : null,
      );
      planned.result.items = ordered.items;
      musicOrderEvidenceByTargetId.set(target.id, ordered.evidence);
    }

    const sequenceViolations = plan.targets.flatMap((planned) => {""",
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    """      const podcastEpisodeMaxDurationMs =
        resolvedDuration?.podcastEpisodeMaxDurationMs ?? null;

      const targetSummary: Record<string, unknown> = {
        name: target.name,
        planned: items.length,""",
    """      const podcastEpisodeMaxDurationMs =
        resolvedDuration?.podcastEpisodeMaxDurationMs ?? null;
      const musicOrderEvidence = musicOrderEvidenceByTargetId.get(target.id) ?? null;

      const targetSummary: Record<string, unknown> = {
        targetPlaylistId: target.id,
        name: target.name,
        planned: items.length,
        musicOrderMode: target.musicOrderMode,
        musicOrderSeed: musicOrderEvidence?.seed ?? null,
        musicOrderSeedSource: musicOrderEvidence?.seedSource ?? null,
        musicOrderHash: musicOrderEvidence?.orderHash ?? null,
        musicOrderChanged: musicOrderEvidence?.changed ?? false,""",
)


# ---------------------------------------------------------------------------
# Manual real run: reuse a current simulation seed once.
# ---------------------------------------------------------------------------
replace_once(
    "src/app/api/generate/route.ts",
    """import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";
import {""",
    """import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";
import { findReusableSimulationMusicOrderSeeds } from "@/services/music-order-simulation";
import {""",
)
replace_once(
    "src/app/api/generate/route.ts",
    """  const result = await generatePlaylists({
    userId: session.user.id,
    trigger: simulate ? "SIMULATION" : "MANUAL",
    simulate,
  });""",
    """  const musicOrderSeeds = simulate
    ? undefined
    : await findReusableSimulationMusicOrderSeeds(
        session.user.id,
        assessment.fingerprint,
      );

  const result = await generatePlaylists({
    userId: session.user.id,
    trigger: simulate ? "SIMULATION" : "MANUAL",
    simulate,
    musicOrderSeeds,
  });""",
)


# Scheduled first real run follows the same approved simulation order.
replace_once(
    "src/jobs/scheduled-generation.ts",
    """} from "@/services/configuration-readiness";

import { generatePlaylists } from "./generate-playlists";""",
    """} from "@/services/configuration-readiness";
import { findReusableSimulationMusicOrderSeeds } from "@/services/music-order-simulation";

import { generatePlaylists } from "./generate-playlists";""",
)
replace_once(
    "src/jobs/scheduled-generation.ts",
    """      const { runId, status } = await generatePlaylists({
        userId: user.id,
        trigger: "SCHEDULED",
      });""",
    """      const musicOrderSeeds = await findReusableSimulationMusicOrderSeeds(
        user.id,
        assessment.fingerprint,
      );
      const { runId, status } = await generatePlaylists({
        userId: user.id,
        trigger: "SCHEDULED",
        musicOrderSeeds,
      });""",
)


# ---------------------------------------------------------------------------
# CONFIG-04: configured mode + exact final simulated GenerationItem order.
# ---------------------------------------------------------------------------
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """type SimulationTargetSummary = {
  name: string;""",
    """type SimulationTargetSummary = {
  targetPlaylistId: string | null;
  name: string;""",
)
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """  compositionMode: "PROPORTION" | "SEQUENCE" | null;
  compositionQualityPassed: boolean | null;""",
    """  compositionMode: "PROPORTION" | "SEQUENCE" | null;
  musicOrderMode: "STANDARD" | "RANDOMIZED" | null;
  musicOrderSeed: string | null;
  musicOrderSeedSource: "RUN" | "SIMULATION" | null;
  musicOrderHash: string | null;
  musicOrderChanged: boolean | null;
  compositionQualityPassed: boolean | null;""",
)
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """      {
        name: value.name,
        planned: numberValue(value.planned),""",
    """      {
        targetPlaylistId:
          typeof value.targetPlaylistId === "string" ? value.targetPlaylistId : null,
        name: value.name,
        planned: numberValue(value.planned),""",
)
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """        compositionMode:
          value.compositionMode === "PROPORTION" || value.compositionMode === "SEQUENCE"
            ? value.compositionMode
            : null,
        compositionQualityPassed:""",
    """        compositionMode:
          value.compositionMode === "PROPORTION" || value.compositionMode === "SEQUENCE"
            ? value.compositionMode
            : null,
        musicOrderMode:
          value.musicOrderMode === "STANDARD" || value.musicOrderMode === "RANDOMIZED"
            ? value.musicOrderMode
            : null,
        musicOrderSeed:
          typeof value.musicOrderSeed === "string" ? value.musicOrderSeed : null,
        musicOrderSeedSource:
          value.musicOrderSeedSource === "RUN" || value.musicOrderSeedSource === "SIMULATION"
            ? value.musicOrderSeedSource
            : null,
        musicOrderHash:
          typeof value.musicOrderHash === "string" ? value.musicOrderHash : null,
        musicOrderChanged: booleanValue(value.musicOrderChanged),
        compositionQualityPassed:""",
)
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """          logs: {
            orderBy: { createdAt: "asc" },
            select: { level: true, message: true },
          },""",
    """          logs: {
            orderBy: { createdAt: "asc" },
            select: { level: true, message: true },
          },
          items: {
            orderBy: { position: "asc" },
            select: {
              targetPlaylistId: true,
              position: true,
              contentType: true,
              title: true,
            },
          },""",
)
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """  const simulatedTargets = readSimulationTargets(simulation?.summary);
  const skippedTargets = readSkipped(simulation?.summary);""",
    """  const simulatedTargets = readSimulationTargets(simulation?.summary);
  const simulatedOrderByTargetId = new Map<
    string,
    Array<{ position: number; type: "MUSIC" | "PODCAST"; title: string }>
  >();
  for (const item of simulation?.items ?? []) {
    const current = simulatedOrderByTargetId.get(item.targetPlaylistId) ?? [];
    current.push({
      position: item.position,
      type: item.contentType,
      title: item.title ?? "Item sem título",
    });
    simulatedOrderByTargetId.set(item.targetPlaylistId, current);
  }
  const skippedTargets = readSkipped(simulation?.summary);""",
)
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """                    {` · ${configuredPodcastDurationLabel(target)}`}
                  </p>""",
    """                    {` · ${configuredPodcastDurationLabel(target)}`}
                    {` · músicas: ${
                      target.musicOrderMode === "RANDOMIZED"
                        ? "ordem randomizada"
                        : "ordem padrão"
                    }`}
                  </p>""",
)
replace_once(
    "src/app/dashboard/configuracao/revisao/page.tsx",
    """                          {target.calendarDurationMinutes !== null && (
                            <p className="mt-2 text-xs font-semibold leading-5 opacity-70">""",
    """                          {target.musicOrderMode === "RANDOMIZED" && (
                            <div className="status-info mt-3 rounded-xl border p-3 text-xs leading-5">
                              <p className="font-black">Músicas randomizadas nesta simulação</p>
                              <p className="mt-1 opacity-80">
                                Seed: <code>{target.musicOrderSeed ?? "indisponível"}</code>
                                {target.musicOrderChanged === false
                                  ? " · a ordem coincidiu com a original nesta execução"
                                  : ""}
                              </p>
                              {target.targetPlaylistId &&
                                (simulatedOrderByTargetId.get(target.targetPlaylistId)?.length ?? 0) > 0 && (
                                  <details className="mt-2">
                                    <summary className="cursor-pointer font-black">
                                      Ver ordem simulada ({simulatedOrderByTargetId.get(target.targetPlaylistId)!.length} itens)
                                    </summary>
                                    <ol className="mt-2 space-y-1">
                                      {simulatedOrderByTargetId.get(target.targetPlaylistId)!.map((item) => (
                                        <li key={`${item.position}-${item.type}-${item.title}`}>
                                          {item.position + 1}. {item.type === "MUSIC" ? "M" : "P"} · {item.title}
                                        </li>
                                      ))}
                                    </ol>
                                    {target.musicOrderHash && (
                                      <p className="mt-2 opacity-65">
                                        Hash da ordem: <code>{target.musicOrderHash}</code>
                                      </p>
                                    )}
                                  </details>
                                )}
                            </div>
                          )}
                          {target.calendarDurationMinutes !== null && (
                            <p className="mt-2 text-xs font-semibold leading-5 opacity-70">""",
)


# ---------------------------------------------------------------------------
# Structural regressions: fingerprint and one-shot simulation seed reuse.
# ---------------------------------------------------------------------------
path = Path("src/services/configuration-readiness.test.ts")
source = path.read_text()
source += r'''

test("ORDER-01 music ordering policy participates in configuration fingerprint", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");
  const fingerprintStart = source.indexOf("const fingerprintPayload");
  const fingerprintEnd = source.indexOf("return {", fingerprintStart);
  const fingerprintSource = source.slice(fingerprintStart, fingerprintEnd);
  assert.match(fingerprintSource, /musicOrderMode/);
});

test("ORDER-01 real entry points resolve reusable simulation seeds before generation", () => {
  const manual = readFileSync("src/app/api/generate/route.ts", "utf8");
  const scheduled = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  for (const source of [manual, scheduled]) {
    const seedLookup = source.indexOf("findReusableSimulationMusicOrderSeeds");
    const generatorCall = source.indexOf("await generatePlaylists({");
    assert.ok(seedLookup >= 0);
    assert.ok(generatorCall > seedLookup);
    assert.match(source, /musicOrderSeeds/);
  }
});
'''
path.write_text(source)
