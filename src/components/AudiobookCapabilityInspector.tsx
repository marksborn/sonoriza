"use client";

import React, { useState } from "react";
import type {
  AudiobookCapabilityDecision,
  AudiobookCapabilityStatus,
} from "@/services/audiobooks/d5-account-capability";

const explanations: Record<AudiobookCapabilityStatus, string> = {
  SPOTIFY_NOT_CONNECTED:
    "Esta conta Sonoriza não possui um Spotify conectado. Nenhum diagnóstico remoto foi executado.",
  PROFILE_SCOPE_MISSING:
    "A conexão Spotify não concedeu user-read-private. Reconecte sua conta para consultar o país do perfil; não tentaremos inferi-lo.",
  PROFILE_READ_FAILED:
    "A leitura do perfil Spotify falhou. Pode haver erro de autorização, cota ou indisponibilidade temporária.",
  ACCOUNT_MARKET_UNKNOWN:
    "O Spotify não informou um país válido no perfil da conta. Não faremos suposições pela localização ou idioma.",
  MARKET_NOT_DOCUMENTED:
    "O país desta conta não consta nos mercados com API de audiolivros/capítulos documentada pelo Spotify. Não tentaremos fabricar dados de capítulos nem alterar a playlist.",
  CATALOG_NOT_CHECKED:
    "O país da conta consta nos mercados documentados, mas o acesso ao livro ainda não foi comprovado. Informe um ID válido e repita a consulta.",
  CATALOG_READ_FAILED:
    "O Spotify não confirmou o livro e seus capítulos nesta conta. A disponibilidade não é garantida mesmo em um mercado documentado.",
  NO_PLAYABLE_CHAPTERS:
    "O catálogo foi consultado, mas não retornou capítulos reproduzíveis para o vínculo.",
  CATALOG_CHAPTERS_READABLE:
    "A leitura do catálogo deste livro funcionou. Isso não comprova a presença nem a integridade do livro inteiro na playlist.",
};

export function AudiobookCapabilityInspector({ audiobookId }: Readonly<{
  audiobookId: string | null;
}>) {
  const [result, setResult] = useState<AudiobookCapabilityDecision | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function inspect() {
    if (pending) return;
    setPending(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/audiobooks/account-capability", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(audiobookId ? { spotifyAudiobookId: audiobookId } : {}),
      });
      const raw: unknown = await response.json();
      if (!response.ok || !raw || typeof raw !== "object" || Array.isArray(raw) ||
          !("status" in raw) || typeof raw.status !== "string" ||
          !(raw.status in explanations)) {
        throw new Error("Não foi possível consultar o diagnóstico de capacidade.");
      }
      setResult(raw as AudiobookCapabilityDecision);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Serviço de diagnóstico indisponível.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-line-dark p-4">
      <h3 className="font-bold text-ink-inverse">Compatibilidade da conta Spotify · Gate D.5</h3>
      <p className="text-sm leading-6 text-muted-inverse">
        Consulta sob demanda ao país informado pela própria conta Spotify.
        {audiobookId
          ? " Também tentará ler o catálogo deste livro se o mercado for documentado."
          : " Cole o link do livro acima para testar também o catálogo."}
        {" "}Não altera seus livros, a reprodução ou a playlist.
      </p>
      <button type="button" className="secondary-button" disabled={pending}
        onClick={inspect}>
        {pending ? "Consultando conta..." : "Diagnosticar conta e catálogo"}
      </button>
      {result ? (
        <div className="space-y-2 text-sm leading-6 text-ink-inverse" role="status">
          <p><strong>País da conta:</strong> {result.accountCountry ?? "não confirmado"}.
            {" "}<strong>API:</strong> {result.marketDocumentation === "DOCUMENTED"
              ? "mercado documentado"
              : result.marketDocumentation === "NOT_DOCUMENTED"
                ? "mercado não documentado para audiolivros"
                : "disponibilidade desconhecida"}.</p>
          <p>{explanations[result.status]}</p>
          {result.catalogAccessibleForBook ? (
            <p>Capítulos reproduzíveis encontrados: {result.playableChapterCount} de{" "}
              {result.readableChapterCount} consultados. O vínculo ainda depende
              de validações independentes.</p>
          ) : null}
          <p className="font-semibold">
            Segurança: escrita automática no Spotify bloqueada;
            capítulo e reprodução sob controle manual. Itens opacos da playlist
            não foram identificados por esta consulta.
          </p>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-ink-inverse">{error}</p> : null}
    </section>
  );
}
