import { prisma } from "@/lib/prisma";
import { prepareMusic07EligibilityRuntime } from "@/jobs/music-exposure-runtime";

async function main() {
  const email = process.argv.find((arg) => arg.startsWith("--email="))?.slice(8).trim();
  if (!email) throw new Error("Use --email=<Sonoriza user email>");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found: ${email}`);

  const asOf = new Date();
  const state = await prepareMusic07EligibilityRuntime({
    userId: user.id,
    userEmail: user.email,
    asOf,
    targetPlaylistIds: null,
    modeOverride: "SHADOW",
  });

  console.log("========== MUSIC-07 GATE 3 — ELIGIBILITY ANCHOR ==========");
  console.log(`User:                         ${user.email ?? user.id}`);
  console.log("Mode:                         SHADOW");
  console.log("Planner influence:            NONE");
  console.log("Spotify playback API calls:   NONE");
  console.log("Database writes:              NONE");
  console.log("Exposure truth:               GenerationRun + GenerationItem + applied proof");
  console.log("Eligibility anchor source:    SONORIZA_EXPOSURE");
  console.log("lastPlayedAt written:         NO");
  console.log(`Status:                       ${state.status}`);
  console.log(`As of:                        ${asOf.toISOString()}`);
  console.log("");
  console.log("---------- DIAGNOSTICS ----------");
  for (const [key, value] of Object.entries(state.diagnostics)) {
    console.log(`${key.padEnd(30)} ${String(value)}`);
  }
  console.log("");
  console.log("---------- ANCHORS ----------");
  const anchors = state.projection?.anchors ?? [];
  console.log(`All anchors:                  ${anchors.length}`);
  console.log(`Active anchors:               ${state.projection?.activeAnchors.length ?? 0}`);
  if (anchors.length === 0) console.log("(none)");
  for (const anchor of anchors.slice(0, 30)) {
    console.log(
      `${anchor.active ? "ACTIVE" : "EXPIRED"} | ${anchor.targetName} | ${anchor.consecutiveUnconfirmedExposureCount}x | ${anchor.artistName} — ${anchor.trackName} | anchor=${anchor.anchorAt.toISOString()} | until=${anchor.cooldownUntil.toISOString()}`,
    );
  }
  console.log("");
  console.log("IMPORTANT:");
  console.log("- Gate 3 does not mutate TrackListeningState.");
  console.log("- SONORIZA_EXPOSURE is an eligibility anchor, not playback fact.");
  console.log("- factual Last.fm consumption resets the unconfirmed exposure streak.");
  console.log("- ACTIVE mode remains gated for Gate 4 rollout.");
  console.log("==========================================================");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
