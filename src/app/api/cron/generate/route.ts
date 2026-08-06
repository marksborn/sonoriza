import { NextResponse } from "next/server";

import { runScheduledGeneration } from "@/jobs/scheduled-generation";

// The scheduled generation can be slow (many API calls); never cache it and
// allow a generous execution window.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Triggered by the server cron (CloudPanel / crontab):
 *
 *   curl -fsS -X POST https://<host>/api/cron/generate \
 *        -H "Authorization: Bearer $CRON_SECRET"
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runScheduledGeneration();
  return NextResponse.json(result);
}
