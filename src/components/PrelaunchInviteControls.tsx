"use client";

import { useActionState, useMemo, useState } from "react";

import {
  generateInviteLink,
  type InviteActionState,
} from "@/app/dashboard/configuracao/prelaunch/actions";

const initialState: InviteActionState = {};

export function PrelaunchInviteControls({
  signupId,
  activeInviteExpiresAt,
}: {
  signupId: string;
  activeInviteExpiresAt?: string;
}) {
  const [state, action, pending] = useActionState(generateInviteLink, initialState);
  const [copied, setCopied] = useState(false);

  const inviteUrl = useMemo(() => {
    if (!state.invitePath || typeof window === "undefined") return "";
    return new URL(state.invitePath, window.location.origin).toString();
  }, [state.invitePath]);

  async function copyInvite() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
  }

  return (
    <div className="space-y-2">
      {activeInviteExpiresAt && !state.invitePath ? (
        <p className="text-xs text-muted-inverse">
          Há um link ativo até{" "}
          {new Intl.DateTimeFormat("pt-BR", {
            dateStyle: "short",
            timeStyle: "short",
            timeZone: "America/Sao_Paulo",
          }).format(new Date(activeInviteExpiresAt))}
          . Gere outro para substituir.
        </p>
      ) : null}

      <form action={action}>
        <input type="hidden" name="signupId" value={signupId} />
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-2xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action disabled:opacity-60"
        >
          {pending
            ? "Gerando…"
            : activeInviteExpiresAt
              ? "Gerar novo link"
              : "Gerar link de convite"}
        </button>
      </form>

      {state.error ? (
        <p role="alert" className="text-xs font-bold text-danger">
          {state.error}
        </p>
      ) : null}

      {inviteUrl ? (
        <div className="rounded-2xl border border-success/35 bg-success-soft p-3">
          <p className="text-xs font-bold text-success">
            Link criado. Ele será exibido somente agora.
          </p>
          <button
            type="button"
            onClick={copyInvite}
            className="mt-2 w-full rounded-xl border border-success/35 bg-surface-dark px-4 py-2 text-sm font-black text-ink-inverse"
          >
            {copied ? "Link copiado" : "Copiar link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
