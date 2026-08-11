from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}\n--- needle ---\n{old}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/services/playlist-ordering.ts",
    '''export function readMusicOrderSeedsFromSummary(summary: unknown): Record<string, string> {
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
}''',
    '''export type ReusableMusicOrderEvidence = {
  seed: string;
  orderHash: string;
};

export function readMusicOrderEvidenceFromSummary(
  summary: unknown,
): Record<string, ReusableMusicOrderEvidence> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return {};
  const targets = (summary as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return {};

  const result: Record<string, ReusableMusicOrderEvidence> = {};
  for (const entry of targets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const target = entry as Record<string, unknown>;
    if (
      target.musicOrderMode === "RANDOMIZED" &&
      typeof target.targetPlaylistId === "string" &&
      typeof target.musicOrderSeed === "string" &&
      target.musicOrderSeed.length > 0 &&
      typeof target.musicOrderHash === "string" &&
      target.musicOrderHash.length > 0
    ) {
      result[target.targetPlaylistId] = {
        seed: target.musicOrderSeed,
        orderHash: target.musicOrderHash,
      };
    }
  }
  return result;
}''',
)

replace_once(
    "src/services/playlist-ordering.test.ts",
    '''  readMusicOrderSeedsFromSummary,
  type OrderablePlaylistItem,''',
    '''  readMusicOrderEvidenceFromSummary,
  type OrderablePlaylistItem,''',
)
replace_once(
    "src/services/playlist-ordering.test.ts",
    '''test("reads only valid RANDOMIZED target seeds from persisted run summary", () => {
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
});''',
    '''test("reads only complete RANDOMIZED seed/hash evidence from persisted run summary", () => {
  assert.deepEqual(
    readMusicOrderEvidenceFromSummary({
      targets: [
        {
          targetPlaylistId: "car",
          musicOrderMode: "RANDOMIZED",
          musicOrderSeed: "seed-car",
          musicOrderHash: "hash-car",
        },
        {
          targetPlaylistId: "work",
          musicOrderMode: "STANDARD",
          musicOrderSeed: "ignored",
          musicOrderHash: "ignored",
        },
        {
          targetPlaylistId: "missing-hash",
          musicOrderMode: "RANDOMIZED",
          musicOrderSeed: "seed-only",
        },
      ],
    }),
    { car: { seed: "seed-car", orderHash: "hash-car" } },
  );
});''',
)

Path("src/services/music-order-simulation.ts").write_text('''import { prisma } from "@/lib/prisma";
import { readConfigurationFingerprint } from "@/services/configuration-readiness";
import {
  readMusicOrderEvidenceFromSummary,
  type ReusableMusicOrderEvidence,
} from "@/services/playlist-ordering";

function summaryQualityPassed(summary: unknown): boolean {
  return Boolean(
    summary &&
      typeof summary === "object" &&
      !Array.isArray(summary) &&
      (summary as Record<string, unknown>).qualityPassed === true,
  );
}

/**
 * Returns one-shot ORDER-01 evidence only from a current, quality-approved
 * simulation that happened after the latest real run capable of writing.
 * FAILED real attempts do not consume the preview because they are expected to
 * have stopped before publication; SUCCESS/PARTIAL do.
 */
export async function findReusableSimulationMusicOrderEvidence(
  userId: string,
  configurationFingerprint: string,
): Promise<Record<string, ReusableMusicOrderEvidence> | undefined> {
  const latestAppliedRealRun = await prisma.generationRun.findFirst({
    where: {
      userId,
      simulation: false,
      status: { in: ["SUCCESS", "PARTIAL"] },
    },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });

  const simulations = await prisma.generationRun.findMany({
    where: {
      userId,
      simulation: true,
      status: "SUCCESS",
      ...(latestAppliedRealRun
        ? { startedAt: { gt: latestAppliedRealRun.startedAt } }
        : {}),
    },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: { summary: true },
  });

  for (const simulation of simulations) {
    if (!summaryQualityPassed(simulation.summary)) continue;
    if (readConfigurationFingerprint(simulation.summary) !== configurationFingerprint) {
      continue;
    }
    const evidence = readMusicOrderEvidenceFromSummary(simulation.summary);
    if (Object.keys(evidence).length > 0) return evidence;
  }

  return undefined;
}
''')

replace_once(
    "src/app/api/generate/route.ts",
    'import { findReusableSimulationMusicOrderSeeds } from "@/services/music-order-simulation";',
    'import { findReusableSimulationMusicOrderEvidence } from "@/services/music-order-simulation";',
)
replace_once(
    "src/app/api/generate/route.ts",
    '''  const musicOrderSeeds = simulate
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
  });''',
    '''  const musicOrderSimulationEvidence = simulate
    ? undefined
    : await findReusableSimulationMusicOrderEvidence(
        session.user.id,
        assessment.fingerprint,
      );

  const result = await generatePlaylists({
    userId: session.user.id,
    trigger: simulate ? "SIMULATION" : "MANUAL",
    simulate,
    musicOrderSimulationEvidence,
  });''',
)

replace_once(
    "src/jobs/scheduled-generation.ts",
    'import { findReusableSimulationMusicOrderSeeds } from "@/services/music-order-simulation";',
    'import { findReusableSimulationMusicOrderEvidence } from "@/services/music-order-simulation";',
)
replace_once(
    "src/jobs/scheduled-generation.ts",
    '''      const musicOrderSeeds = await findReusableSimulationMusicOrderSeeds(
        user.id,
        assessment.fingerprint,
      );
      const { runId, status } = await generatePlaylists({
        userId: user.id,
        trigger: "SCHEDULED",
        musicOrderSeeds,
      });''',
    '''      const musicOrderSimulationEvidence =
        await findReusableSimulationMusicOrderEvidence(
          user.id,
          assessment.fingerprint,
        );
      const { runId, status } = await generatePlaylists({
        userId: user.id,
        trigger: "SCHEDULED",
        musicOrderSimulationEvidence,
      });''',
)

replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''  type MusicOrderEvidence,
} from "@/services/playlist-ordering";''',
    '''  type MusicOrderEvidence,
  type ReusableMusicOrderEvidence,
} from "@/services/playlist-ordering";''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''  /** ORDER-01: one-shot seeds reused from a current approved simulation. */
  musicOrderSeeds?: Record<string, string>;''',
    '''  /** ORDER-01: one-shot seed/hash proof from a current approved simulation. */
  musicOrderSimulationEvidence?: Record<string, ReusableMusicOrderEvidence>;''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''    const musicOrderEvidenceByTargetId = new Map<string, MusicOrderEvidence>();

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

    const sequenceViolations''',
    '''    const musicOrderEvidenceByTargetId = new Map<string, MusicOrderEvidence>();
    const musicOrderPreviewViolations: Array<{
      targetPlaylistId: string;
      targetName: string;
      expectedOrderHash: string;
      actualOrderHash: string;
    }> = [];

    for (const planned of plan.targets) {
      const target = targetByPlanId.get(planned.targetPlaylistId);
      if (!target) continue;

      const reusedEvidence = opts.musicOrderSimulationEvidence?.[target.id] ?? null;
      const seed =
        target.musicOrderMode === "RANDOMIZED"
          ? reusedEvidence?.seed ?? createMusicOrderSeed(run.id, target.id)
          : null;
      const ordered = applyMusicOrder(
        planned.result.items,
        target.musicOrderMode,
        seed,
        reusedEvidence ? "SIMULATION" : seed ? "RUN" : null,
      );
      planned.result.items = ordered.items;
      musicOrderEvidenceByTargetId.set(target.id, ordered.evidence);

      if (
        !simulate &&
        reusedEvidence &&
        ordered.evidence.orderHash !== reusedEvidence.orderHash
      ) {
        musicOrderPreviewViolations.push({
          targetPlaylistId: target.id,
          targetName: target.name,
          expectedOrderHash: reusedEvidence.orderHash,
          actualOrderHash: ordered.evidence.orderHash,
        });
      }
    }

    if (musicOrderPreviewViolations.length > 0) {
      summary.musicOrderPreviewViolations = musicOrderPreviewViolations;
      const error =
        "A geração foi bloqueada antes de alterar o Spotify porque a ordem final mudou desde a simulação aprovada. Simule novamente antes de publicar.";
      log({ level: "ERROR", message: error, data: musicOrderPreviewViolations });
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

    const sequenceViolations''',
)

# Update structural regression names/calls and prove the pre-write hash gate exists.
path = Path("src/services/configuration-readiness.test.ts")
text = path.read_text()
text = text.replace(
    "findReusableSimulationMusicOrderSeeds",
    "findReusableSimulationMusicOrderEvidence",
)
text = text.replace("/musicOrderSeeds/", "/musicOrderSimulationEvidence/")
text += '''\n\ntest("ORDER-01 blocks a real write when the approved preview hash no longer matches", () => {\n  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");\n  const mismatchGate = source.indexOf("musicOrderPreviewViolations.length > 0");\n  const writerCreation = source.indexOf("if (!simulate) writer = await SpotifyClient.forUser(userId)");\n  assert.ok(mismatchGate >= 0);\n  assert.ok(writerCreation > mismatchGate);\n  assert.match(source, /Simule novamente antes de publicar/);\n});\n'''
path.write_text(text)
