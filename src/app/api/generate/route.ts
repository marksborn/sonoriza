import { NextResponse } from "next/server";

import { generatePlaylists } from "@/jobs/generate-playlists";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manual / simulation trigger for the signed-in user.
 *
 *   POST /api/generate            → applies the playlists
 *   POST /api/generate  { "simulate": true }  → plans without touching Spotify
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let simulate = false;
  try {
    const body = (await request.json()) as { simulate?: boolean };
    simulate = Boolean(body?.simulate);
  } catch {
    // No / invalid body → default to a real run.
  }

  const result = await generatePlaylists({
    userId: session.user.id,
    trigger: simulate ? "SIMULATION" : "MANUAL",
    simulate,
  });

  return NextResponse.json(result);
}
