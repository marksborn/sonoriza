/**
 * Seeds the initial use case (Car + Work playlists) for an existing user.
 *
 *   npx prisma db seed
 *
 * Requires a user to already exist (created by signing in). Set SEED_USER_ID to
 * target a specific user; otherwise the first user is used.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// uma música, um podcast, duas músicas, um podcast → repete
const SEQUENCE = ["MUSIC", "PODCAST", "MUSIC", "MUSIC", "PODCAST"];

async function main() {
  const userId =
    process.env.SEED_USER_ID ?? (await prisma.user.findFirst())?.id;

  if (!userId) {
    console.error(
      "No user found. Sign in first (creates a user), then run the seed.",
    );
    process.exit(1);
  }

  // Car: duration from the calendar, generated first.
  await prisma.targetPlaylist.upsert({
    where: { id: `${userId}-carro` },
    update: {},
    create: {
      id: `${userId}-carro`,
      userId,
      name: "Carro",
      priority: 0,
      durationMode: "CALENDAR",
      emptyCalendarBehavior: "CLEAR",
      podcastPercent: 60,
      sequencePattern: SEQUENCE,
      maxEpisodesPerProgram: 1,
    },
  });

  // Work: fixed 8 h, generated after Car (only leftover content).
  await prisma.targetPlaylist.upsert({
    where: { id: `${userId}-trabalho` },
    update: {},
    create: {
      id: `${userId}-trabalho`,
      userId,
      name: "Trabalho",
      priority: 1,
      durationMode: "FIXED",
      fixedDurationSeconds: 8 * 60 * 60,
      podcastPercent: 60,
      sequencePattern: SEQUENCE,
      maxEpisodesPerProgram: 1,
    },
  });

  console.log(`Seeded Carro + Trabalho target playlists for user ${userId}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
