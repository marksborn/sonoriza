"use client";

import { useState, type FormEvent } from "react";

import { UiIcon } from "@/components/UiIcon";

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function PrelaunchSignupForm() {
  const [state, setState] = useState<SubmissionState>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    setState({ kind: "submitting" });

    try {
      const response = await fetch("/api/prelaunch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          privacyAccepted: data.get("privacyAccepted") === "on",
          website: data.get("website") || "",
        }),
      });
      const payload = (await response.json()) as { message?: string; error?: string };

      if (!response.ok) {
        setState({
          kind: "error",
          message: payload.error || "Não foi possível registrar agora. Tente novamente.",
        });
        return;
      }

      form.reset();
      setState({
        kind: "success",
        message: payload.message || "Seu interesse foi registrado.",
      });
    } catch {
      setState({
        kind: "error",
        message: "Não foi possível registrar agora. Verifique sua conexão e tente novamente.",
      });
    }
  }

  return (
    <div className="product-panel max-w-xl p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="product-icon-tile-accent h-10 w-10 shrink-0">
          <UiIcon name="mail" size={19} />
        </span>
        <div>
          <p className="text-xs font-black uppercase tracking-[0.14em] text-accent-400">
            Pré-lançamento
          </p>
          <h2 className="mt-1 text-lg font-black text-ink-inverse">
            Quero testar o Sonoriza
          </h2>
          <p className="mt-1 text-sm leading-5 text-muted-inverse">
            Deixe seu e-mail para entrar na lista de espera. O acesso será liberado
            gradualmente durante o piloto.
          </p>
        </div>
      </div>

      {state.kind === "success" ? (
        <div className="status-success mt-4 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold" role="status">
          <UiIcon name="check" size={18} className="mt-0.5 shrink-0" />
          <span>{state.message}</span>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="prelaunch-email">
              Seu e-mail
            </label>
            <input
              id="prelaunch-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={320}
              placeholder="voce@exemplo.com"
              className="min-h-12 min-w-0 flex-1 rounded-full border border-line-dark/70 bg-surface-elevated px-4 text-sm font-semibold text-ink-inverse outline-none transition placeholder:text-muted-inverse/60 focus:border-brand-400 focus:ring-2 focus:ring-brand-400/25"
            />
            <button
              type="submit"
              disabled={state.kind === "submitting"}
              className="primary-button min-h-12 disabled:cursor-wait disabled:opacity-60"
            >
              {state.kind === "submitting" ? "Registrando…" : "Quero participar"}
              <UiIcon name="arrow-right" size={17} />
            </button>
          </div>

          <div className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
            <label htmlFor="prelaunch-website">Não preencha</label>
            <input id="prelaunch-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted-inverse">
            <input
              name="privacyAccepted"
              type="checkbox"
              required
              className="mt-1 h-4 w-4 shrink-0 accent-brand-400"
            />
            <span>
              Concordo que o Sonoriza use este e-mail para comunicações sobre o
              pré-lançamento e o convite de acesso. Não é inscrição automática em newsletter.
            </span>
          </label>

          {state.kind === "error" ? (
            <p className="status-danger rounded-xl border px-3 py-2 text-sm font-semibold" role="alert">
              {state.message}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
