"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

type SpotifyBackoff = {
  code: "SPOTIFY_BACKOFF_ACTIVE";
  reason: "QUOTA_EXCEEDED" | "RATE_LIMITED";
  blockedUntil: string;
  retryAfterSecondsRemaining: number;
};

export default function MusicSourceCleanupTemplate({ children }: { children: ReactNode }) {
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
    const buttons = [...root.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Gerar preview",
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

  async function handleSubmitCapture(event: FormEvent<HTMLDivElement>) {
    const nativeEvent = event.nativeEvent as SubmitEvent;
    const submitter = nativeEvent.submitter;

    if (!(submitter instanceof HTMLButtonElement)) return;
    if (submitter.textContent?.trim() !== "Gerar preview") return;

    event.preventDefault();
    event.stopPropagation();
    nativeEvent.stopImmediatePropagation();

    if (backoff) return;

    const form = submitter.form;
    if (!form) return;
    if (submitter.dataset.musicPreviewBusy === "true") return;

    const sourcePlaylistId = String(new FormData(form).get("id") ?? "").trim();
    if (!sourcePlaylistId) {
      window.location.assign("/dashboard/configuracao/limpeza?error=preview");
      return;
    }

    submitter.dataset.musicPreviewBusy = "true";
    submitter.disabled = true;
    submitter.setAttribute("aria-busy", "true");
    submitter.textContent = "Gerando preview…";
    form.setAttribute("aria-busy", "true");

    try {
      const response = await fetch("/api/music-source-cleanup/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePlaylistId }),
      });
      const result = (await response.json().catch(() => null)) as
        | {
            previewId?: string;
            error?: string;
            code?: string;
            reason?: SpotifyBackoff["reason"];
            blockedUntil?: string;
            retryAfterSecondsRemaining?: number;
          }
        | null;

      if (response.ok && result?.previewId) {
        window.location.assign(
          `/dashboard/configuracao/limpeza?preview=${encodeURIComponent(result.previewId)}`,
        );
        return;
      }

      if (
        result?.code === "SPOTIFY_BACKOFF_ACTIVE" &&
        result.reason &&
        result.blockedUntil &&
        typeof result.retryAfterSecondsRemaining === "number"
      ) {
        setBackoff({
          code: "SPOTIFY_BACKOFF_ACTIVE",
          reason: result.reason,
          blockedUntil: result.blockedUntil,
          retryAfterSecondsRemaining: result.retryAfterSecondsRemaining,
        });
        submitter.textContent = "Gerar preview";
        submitter.dataset.musicPreviewBusy = "false";
        submitter.removeAttribute("aria-busy");
        form.removeAttribute("aria-busy");
        return;
      }

      const errorCode = result?.error === "history" ? "history" : "preview";
      window.location.assign(`/dashboard/configuracao/limpeza?error=${errorCode}`);
    } catch {
      window.location.assign("/dashboard/configuracao/limpeza?error=preview");
    }
  }

  return (
    <div ref={rootRef} onSubmitCapture={handleSubmitCapture}>
      {backoff ? (
        <div className="status-warning mx-auto mt-4 max-w-5xl rounded-2xl border px-4 py-3 text-sm font-semibold">
          MUSIC-02 bloqueada até {formatBackoffDate(backoff.blockedUntil)} por indisponibilidade temporária do Spotify.
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
