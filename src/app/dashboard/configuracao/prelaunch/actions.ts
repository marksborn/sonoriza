"use server";

import { notFound } from "next/navigation";

import { auth } from "@/lib/auth";
import { isPrelaunchAdmin } from "@/lib/prelaunch-admin";
import { createPrelaunchInvite } from "@/services/prelaunch-invite";

export type InviteActionState = {
  invitePath?: string;
  expiresAt?: string;
  error?: string;
};

export async function generateInviteLink(
  _previousState: InviteActionState,
  formData: FormData,
): Promise<InviteActionState> {
  const session = await auth();
  if (
    !session?.user?.id ||
    !session.user.email ||
    !isPrelaunchAdmin(session.user.email)
  ) {
    notFound();
  }

  const signupId = String(formData.get("signupId") ?? "");
  if (!signupId) return { error: "Inscrição inválida." };

  try {
    const invite = await createPrelaunchInvite({
      signupId,
      actorUserId: session.user.id,
      actorEmail: session.user.email,
    });
    return {
      invitePath: `/convite/${invite.token}`,
      expiresAt: invite.expiresAt.toISOString(),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Não foi possível gerar o convite.",
    };
  }
}
