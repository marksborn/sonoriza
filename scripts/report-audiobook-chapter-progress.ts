/**
 * AUDIOBOOK-02 (#489) — read-only probe: can the Spotify Web API tell which
 * chapter of the active book the user is on (chapter resume_point)?
 *
 *   npx tsx --env-file=.env scripts/report-audiobook-chapter-progress.ts --email you@example.com
 *
 * Only GET requests. No database writes, no Spotify writes, no tokens printed.
 * Uses the active D.12 library reading (its declared show/audiobook id) unless
 * --audiobook <id> is given.
 */
import { prisma } from "@/lib/prisma";
import { getSpotifyAccessToken } from "@/services/spotify/token";

const API = "https://api.spotify.com/v1";
const MAX_CHAPTER_PROBES = 3;

type Probe = { label: string; status: number; ms: number; note: string };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const reading = await prisma.userAudiobookLibraryReading.findFirst({
    where: { userId: user.id, completedAt: null },
    select: { bookTitle: true, spotifyShowId: true, chapterLabel: true },
  });
  const audiobookId = args.audiobook ?? reading?.spotifyShowId ?? null;
  if (!audiobookId) throw new Error("No active reading; pass --audiobook <id>.");

  const token = await getSpotifyAccessToken(user.id);
  const probes: Probe[] = [];
  const get = async (label: string, path: string) => {
    const started = Date.now();
    const response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ms = Date.now() - started;
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const retryAfter = response.headers.get("retry-after");
    probes.push({
      label,
      status: response.status,
      ms,
      note: response.ok
        ? "OK"
        : `${errorMessage(body) ?? text.slice(0, 120)}${retryAfter ? ` (retry-after ${retryAfter}s)` : ""}`,
    });
    return response.ok ? body : null;
  };

  console.log("========== AUDIOBOOK-02 — CHAPTER PROGRESS PROBE (READ-ONLY) ==========");
  console.log(`Active reading:   ${reading ? `${reading.bookTitle} · ${reading.chapterLabel}` : "(none)"}`);
  console.log(`Audiobook id:     ${audiobookId}`);
  console.log(`Run at:           ${new Date().toISOString()}`);

  const book = record(await get("GET /audiobooks/{id}", `/audiobooks/${audiobookId}?market=from_token`));
  const chaptersPage = record(
    await get(
      "GET /audiobooks/{id}/chapters",
      `/audiobooks/${audiobookId}/chapters?market=from_token&limit=50`,
    ),
  );
  const chapters = Array.isArray(chaptersPage?.items) ? chaptersPage.items.map(record) : [];

  if (book) {
    console.log(`\nBook:             ${text(book.name)} · total chapters ${num(book.total_chapters)}`);
  }
  if (chapters.length > 0) {
    const withResume = chapters.filter((chapter) => record(chapter?.resume_point));
    console.log(`Chapters listed:  ${chapters.length} (with resume_point: ${withResume.length})`);
    console.log("\n#   fully_played  resume_ms     duration_ms   name");
    chapters.forEach((chapter, index) => {
      const resume = record(chapter?.resume_point);
      console.log(
        `${String(index + 1).padEnd(4)}${String(resume?.fully_played ?? "-").padEnd(14)}` +
          `${String(resume?.resume_position_ms ?? "-").padEnd(14)}` +
          `${String(chapter?.duration_ms ?? "-").padEnd(14)}${text(chapter?.name)}`,
      );
    });
    const current = chapters.find((chapter) => {
      const resume = record(chapter?.resume_point);
      return resume && resume.fully_played !== true;
    });
    console.log(
      `\nInferred current: ${current ? `${text(current.name)} @ ${num(record(current.resume_point)?.resume_position_ms)} ms` : "(not inferable)"}`,
    );
  }

  for (const chapter of chapters.slice(0, MAX_CHAPTER_PROBES)) {
    if (typeof chapter?.id !== "string") continue;
    await get(`GET /chapters/{id} (${text(chapter.name)})`, `/chapters/${chapter.id}?market=from_token`);
  }
  await get(
    "GET /me/player/currently-playing",
    "/me/player/currently-playing?additional_types=episode,chapter&market=from_token",
  );

  console.log("\nHTTP probes:");
  for (const probe of probes) {
    console.log(`  ${String(probe.status).padEnd(5)}${String(probe.ms).padStart(6)} ms  ${probe.label}  ${probe.note}`);
  }
}

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const email = value("--email");
  if (!email) throw new Error("Usage: --email <user email> [--audiobook <id>]");
  return { email, audiobook: value("--audiobook") };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "-";
}

function num(value: unknown): string {
  return typeof value === "number" ? String(value) : "-";
}

function errorMessage(body: unknown): string | null {
  const error = record(record(body)?.error);
  return typeof error?.message === "string" ? error.message : null;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
