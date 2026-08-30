import { NextResponse } from "next/server";

import { prelaunchSignupSchema } from "@/services/prelaunch-contract";
import {
  PrelaunchRateLimitError,
  getPrelaunchRequestIdentity,
  registerPrelaunchInterest,
} from "@/services/prelaunch-signup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Invalid JSON is handled by the schema below.
  }

  const parsed = prelaunchSignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Informe um e-mail válido e confirme o aviso de privacidade." },
      { status: 400 },
    );
  }

  try {
    await registerPrelaunchInterest({
      email: parsed.data.email,
      requestIdentity: getPrelaunchRequestIdentity(request),
    });
  } catch (error) {
    if (error instanceof PrelaunchRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    throw error;
  }

  return NextResponse.json({
    ok: true,
    message: "Seu interesse foi registrado. Avisaremos quando houver uma vaga no piloto.",
  });
}
