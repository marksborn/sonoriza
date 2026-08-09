"use client";

import type { FormEvent, ReactNode } from "react";

export default function MusicSourceCleanupTemplate({ children }: { children: ReactNode }) {
  async function handleSubmitCapture(event: FormEvent<HTMLDivElement>) {
    const nativeEvent = event.nativeEvent as SubmitEvent;
    const submitter = nativeEvent.submitter;

    if (!(submitter instanceof HTMLButtonElement)) return;
    if (submitter.textContent?.trim() !== "Gerar preview") return;

    const form = submitter.form;
    if (!form) return;

    event.preventDefault();
    event.stopPropagation();
    nativeEvent.stopImmediatePropagation();

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
        | { previewId?: string; error?: string }
        | null;

      if (response.ok && result?.previewId) {
        window.location.assign(
          `/dashboard/configuracao/limpeza?preview=${encodeURIComponent(result.previewId)}`,
        );
        return;
      }

      const errorCode = result?.error === "history" ? "history" : "preview";
      window.location.assign(`/dashboard/configuracao/limpeza?error=${errorCode}`);
    } catch {
      window.location.assign("/dashboard/configuracao/limpeza?error=preview");
    }
  }

  return <div onSubmitCapture={handleSubmitCapture}>{children}</div>;
}
