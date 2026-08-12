import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  getNotificationPreferences,
  saveNotificationPreferences,
} from "@/services/notifications";

export const dynamic = "force-dynamic";

const preferencesSchema = z.object({
  generationEnabled: z.boolean(),
  cleanupEnabled: z.boolean(),
  errorEnabled: z.boolean(),
  noopEnabled: z.boolean(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await getNotificationPreferences(session.user.id));
}

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Invalid JSON is handled by the schema below.
  }
  const parsed = preferencesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Preferências inválidas." }, { status: 400 });
  }

  return NextResponse.json(
    await saveNotificationPreferences(session.user.id, parsed.data),
  );
}
