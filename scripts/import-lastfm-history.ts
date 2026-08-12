import { prisma } from "@/lib/prisma";
import { LastFmClient } from "@/services/lastfm/client";
import { importLastFmHistory } from "@/services/lastfm/import-history";

type Args = {
  apply: boolean;
  email: string | null;
  maxPages: number | undefined;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.LASTFM_API_KEY?.trim();
  const username = process.env.LASTFM_USERNAME?.trim();
  if (!apiKey) throw new Error("Configure LASTFM_API_KEY before running HISTORY-01");
  if (!username) throw new Error("Configure LASTFM_USERNAME before running HISTORY-01");

  const client = new LastFmClient({ apiKey });
  const profile = await client.getUserInfo(username);
  const recent = await client.getRecentTracksPage({ username, limit: 10 });
  const top = await client.getTopTracksPage({ username, limit: 10, period: "overall" });

  console.log("========== HISTORY-01 — LAST.FM PREFLIGHT ==========");
  console.log(`Username:             ${profile.username}`);
  console.log(`Profile playcount:    ${profile.playCount ?? "unknown"}`);
  console.log(`Registered at:        ${profile.registeredAt?.toISOString() ?? "unknown"}`);
  console.log(`Recent total:         ${recent.total}`);
  console.log(`Recent page events:   ${recent.events.length}`);
  console.log(`Top tracks returned:  ${top.tracks.length}`);
  console.log("Top sample:");
  for (const track of top.tracks.slice(0, 5)) {
    console.log(`  ${track.playCount}x — ${track.artistName} — ${track.trackName}`);
  }

  if (!args.apply) {
    console.log("DRY-RUN: nenhuma linha do banco foi alterada.");
    console.log("Para importar, execute novamente com --apply --email=<usuario Sonoriza>.");
    return;
  }

  if (!args.email) {
    throw new Error("--apply requires --email=<Sonoriza user email>");
  }
  const user = await prisma.user.findUnique({ where: { email: args.email } });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  console.log("========== HISTORY-01 — APPLY ==========");
  console.log(`Sonoriza user:        ${user.email ?? user.id}`);
  console.log(`Max pages this run:   ${args.maxPages ?? "all"}`);
  const result = await importLastFmHistory({
    userId: user.id,
    username,
    apiKey,
    maxPages: args.maxPages,
  });
  console.log(`Run ID:               ${result.runId}`);
  console.log(`Status:               ${result.status}`);
  console.log(`Completed:            ${result.completed}`);
  console.log(`Last.fm history until:${result.lastFmHistoryUntil.toISOString()}`);
  console.log(`Next page:            ${result.nextPage}`);
  console.log(`Total pages:          ${result.totalPages ?? "unknown"}`);
  console.log(`Accepted events:      ${result.acceptedEvents}`);
  console.log(`Inserted events:      ${result.insertedEvents}`);
  console.log(`Duplicate events:     ${result.duplicateEvents}`);
  console.log(`Profile playcount:    ${result.profilePlayCount ?? "unknown"}`);
}

function parseArgs(argv: string[]): Args {
  let apply = false;
  let email: string | null = null;
  let maxPages: number | undefined;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      const parsed = Number(arg.slice("--max-pages=".length));
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--max-pages must be a positive integer");
      }
      maxPages = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { apply, email, maxPages };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
