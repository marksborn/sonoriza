import { NextResponse } from "next/server";

import { retryDuePushDeliveries } from "@/services/notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * NOTIFY-01 retry worker. It never calls Spotify/Google and only retries
 * previously persisted Web Push deliveries that are due.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await retryDuePushDeliveries());
}
