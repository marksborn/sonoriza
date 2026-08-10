"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

type SpotifyBackoff = { blockedUntil: string };
const BLOCKED_LABELS = new Set(["Adicionar", "Adicionar Seus episódios"]);

export default function SpotifySourcesTemplate({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [backoff, setBackoff] = useState<SpotifyBackoff | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/generate", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { spotifyBackoff?: SpotifyBackoff | null }) => {
        if (active) setBackoff(data.spotifyBackoff ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const buttons = [...root.querySelectorAll("button")].filter((button) =>
      BLOCKED_LABELS.has(button.textContent?.trim() ?? ""),
    );
    for (const button of buttons) {
      button.disabled = Boolean(backoff);
      button.setAttribute("aria-disabled", backoff ? "true" : "false");
      if (backoff) button.title = `Spotify bloqueado até ${formatBackoffDate(backoff.blockedUntil)}`;
      else button.removeAttribute("title");
    }

    if (!backoff) return;
    const delay = Math.max(250, Date.parse(backoff.blockedUntil) - Date.now() + 250);
    const timer = window.setTimeout(() => window.location.reload(), delay);
    return () => window.clearTimeout(timer);
  }, [backoff]);

  function blockProviderSubmit(event: FormEvent<HTMLDivElement>) {
    if (!backoff) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLButtonElement)) return;
    if (!BLOCKED_LABELS.has(submitter.textContent?.trim() ?? "")) return;
    event.preventDefault();
    event.stopPropagation();
    (event.nativeEvent as SubmitEvent).stopImmediatePropagation();
  }

  return (
    <div ref={rootRef} onSubmitCapture={blockProviderSubmit}>
      {backoff ? (
        <div className="status-warning mx-auto mt-4 max-w-6xl rounded-2xl border px-4 py-3 text-sm font-semibold">
          Novas fontes do Spotify não podem ser consultadas/adicionadas até {formatBackoffDate(backoff.blockedUntil)}. Ativar, desativar ou remover fontes já cadastradas continua disponível porque essas ações são locais.
        </div>
      ) : null}
      {children}
    </div>
  );
}

function formatBackoffDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}
