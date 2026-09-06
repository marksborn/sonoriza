"use client";

import { useState } from "react";

import { UiIcon } from "@/components/UiIcon";
import type { SpotifyDisconnectUiState } from "@/services/data-policy";

type Props = {
  initialState: SpotifyDisconnectUiState;
  reconnectSpotifyAction: () => Promise<void>;
  connectGoogleRecoveryAction: () => Promise<void>;
};

type ErrorPayload = {
  error?: string;
  code?: string;
};

const numberFormatter = new Intl.NumberFormat("pt-BR");

export function SpotifyDisconnectSettings({
  initialState,
  reconnectSpotifyAction,
  connectGoogleRecoveryAction,
}: Props) {
  const [state, setState] = useState(initialState);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const canExecute = Boolean(
    state.destructive &&
      state.confirmationPhrase &&
      confirmation === state.confirmationPhrase &&
      state.recovery.durableRecoveryReady &&
      !busy,
  );

  const refreshPreview = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/spotify-disconnect", {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json()) as SpotifyDisconnectUiState & ErrorPayload;
      if (!response.ok) {
        throw new Error(payload.error ?? "Não foi possível atualizar o preview.");
      }
      setState(payload);
      setConfirmation("");
      setMessage("Preview atualizado. Confira novamente antes de confirmar.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao atualizar o preview.");
    } finally {
      setBusy(false);
    }
  };

  const executeDisconnect = async () => {
    if (!canExecute || !state.confirmationPhrase) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/spotify-disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractVersion: state.contractVersion,
          expectedFingerprint: state.fingerprint,
          confirmation,
        }),
      });
      const payload = (await response.json()) as SpotifyDisconnectUiState & ErrorPayload;
      if (!response.ok) {
        if (payload.code === "DATA_POLICY_SPOTIFY_DISCONNECT_PREVIEW_CHANGED") {
          setConfirmation("");
          setMessage(
            "O estado mudou desde o preview. Atualize o preview e confirme novamente; nada foi apagado.",
          );
          return;
        }
        throw new Error(payload.error ?? "Não foi possível concluir a desconexão local.");
      }

      setState(payload);
      setConfirmation("");
      setMessage(
        "Desconexão local concluída. Remova o acesso do Sonoriza no Spotify e, quando quiser, use Reconectar Spotify nesta mesma tela.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao desconectar o Spotify.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="product-panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              GATE 6F · RECOVERY
            </p>
            <h2 className="mt-1 text-xl font-black text-ink-inverse">
              Conexão e recuperação
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-inverse">
              A desconexão remove credenciais e dados Spotify locais, mas preserva as configurações do Sonoriza. Os bindings estáveis abaixo continuam disponíveis para uma futura reconexão.
            </p>
          </div>

          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${
              state.recovery.spotifyConnected ? "status-success" : "status-warning"
            }`}
          >
            <UiIcon
              name={state.recovery.spotifyConnected ? "check" : "warning"}
              size={14}
            />
            {state.recovery.spotifyConnected ? "Spotify conectado" : "Spotify desconectado"}
          </span>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <CountCard
            label="Fontes preservadas"
            value={state.recovery.sourcePlaylistBindings}
          />
          <CountCard
            label="Destinos preservados"
            value={state.recovery.targetPlaylistBindings}
          />
          <CountCard
            label="Logins alternativos"
            value={state.recovery.alternateOauthAccounts}
          />
        </div>

        {state.recovery.spotifyConnected ? (
          state.recovery.durableRecoveryReady ? (
            <div className="mt-5 rounded-2xl border border-line-dark/70 bg-surface-elevated/45 p-5">
              <div className="flex items-start gap-3">
                <UiIcon name="check" size={20} className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-black text-ink-inverse">
                    Caminho de recuperação disponível
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted-inverse">
                    Existe pelo menos outro OAuth vinculado à mesma conta Sonoriza. Mesmo depois de remover o grant Spotify, você mantém um caminho durável para entrar e reconectar o Spotify ao mesmo usuário.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-red-400/40 bg-red-500/10 p-5">
              <div className="flex items-start gap-3">
                <UiIcon name="warning" size={20} className="mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-black text-ink-inverse">
                    Desconexão bloqueada para evitar lockout
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted-inverse">
                    O Spotify é seu único login durável. Conecte o Google primeiro; depois a confirmação destrutiva será liberada.
                  </p>
                  <form action={connectGoogleRecoveryAction} className="mt-4">
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/70 px-5 py-3 text-sm font-black text-ink-inverse transition hover:bg-surface-elevated"
                    >
                      Conectar Google para recuperação
                      <UiIcon name="arrow-right" size={17} />
                    </button>
                  </form>
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="mt-5 rounded-2xl border border-brand-400/30 bg-brand/10 p-5">
            <div className="flex items-start gap-3">
              <UiIcon name="repeat" size={20} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-black text-ink-inverse">
                  Pronto para reconectar ao mesmo usuário
                </p>
                <p className="mt-1 text-sm leading-6 text-muted-inverse">
                  Seus bindings de fonte/destino e regras first-party permaneceram. Depois de remover o acesso antigo em Spotify Connected Apps, reconecte aqui; caches, nomes e snapshots operacionais serão reidratados pelas próximas leituras normais do Sonoriza.
                </p>
                <form action={reconnectSpotifyAction} className="mt-4">
                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 transition hover:bg-accent-400"
                  >
                    Reconectar Spotify
                    <UiIcon name="arrow-right" size={17} />
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="product-panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
              PRIVACY-01
            </p>
            <h2 className="mt-1 text-xl font-black text-ink-inverse">
              Desconectar Spotify
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-inverse">
              O Sonoriza preserva sua conta, Google Calendar, Last.fm e estado first-party. Dados e credenciais locais com lineage Spotify são apagados, sanitizados ou redigidos conforme o contrato v{state.contractVersion}.
            </p>
          </div>

          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${
              state.localDisconnectCompleted ? "status-success" : "status-warning"
            }`}
          >
            <UiIcon
              name={state.localDisconnectCompleted ? "check" : "warning"}
              size={14}
            />
            {state.localDisconnectCompleted
              ? "Limpeza local concluída"
              : "Aguardando confirmação"}
          </span>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <CountCard label="Excluir" value={state.counts.deleteRows} />
          <CountCard label="Sanitizar" value={state.counts.sanitizeRows} />
          <CountCard label="Redigir" value={state.counts.redactRows} />
          <CountCard label="Limpar payload" value={state.counts.clearPayloadRows} />
          <CountCard
            label="Preservar first-party"
            value={state.counts.retainedFirstPartyRows}
          />
          <CountCard
            label="Preservar independente"
            value={state.counts.retainedIndependentRows}
          />
        </div>

        {state.destructive && state.confirmationPhrase ? (
          <div className="mt-6 rounded-2xl border border-line-dark/70 bg-surface-elevated/45 p-5">
            <div className="flex items-start gap-3">
              <UiIcon name="warning" size={20} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-black text-ink-inverse">
                  Ação destrutiva e irreversível no banco local
                </p>
                <p className="mt-1 text-sm leading-6 text-muted-inverse">
                  Antes do commit, o executor reabre o inventário em transação SERIALIZABLE, compara o fingerprint e executa postcheck. Se algo mudou desde este preview, a operação falha sem aplicar o purge.
                </p>
              </div>
            </div>

            {!state.recovery.durableRecoveryReady ? (
              <p className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm font-bold text-ink-inverse">
                Execução bloqueada até existir um login OAuth alternativo para recuperar esta mesma conta Sonoriza.
              </p>
            ) : null}

            <p className="mt-5 text-xs font-black uppercase tracking-[0.14em] text-muted-inverse">
              Digite exatamente
            </p>
            <code className="mt-2 block overflow-x-auto rounded-xl border border-line-dark/70 bg-black/20 px-4 py-3 text-sm font-bold text-ink-inverse">
              {state.confirmationPhrase}
            </code>

            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="Cole a frase de confirmação"
              className="mt-3 w-full rounded-xl border border-line-dark/70 bg-surface-elevated/70 px-4 py-3 text-sm text-ink-inverse outline-none transition focus:border-accent-400"
            />

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={!canExecute}
                onClick={executeDisconnect}
                className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 text-sm font-black text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <UiIcon name="trash" size={17} />
                Executar desconexão local
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={refreshPreview}
                className="inline-flex items-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/55 px-5 py-3 text-sm font-black text-ink-inverse transition hover:bg-surface-elevated disabled:opacity-50"
              >
                <UiIcon name="repeat" size={17} />
                Atualizar preview
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-line-dark/70 bg-surface-elevated/45 p-5">
            <div className="flex items-start gap-3">
              <UiIcon name="check" size={20} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-black text-ink-inverse">
                  Nenhum resíduo local destrutivo pendente
                </p>
                <p className="mt-1 text-sm leading-6 text-muted-inverse">
                  O Sonoriza não consegue confirmar nem automatizar a revogação do acesso no lado do Spotify. Essa etapa é manual na página de apps conectados.
                </p>
              </div>
            </div>
          </div>
        )}

        {message ? <p className="mt-4 text-sm text-muted-inverse">{message}</p> : null}
      </section>

      <section className="product-panel p-6">
        <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
          Provider
        </p>
        <h2 className="mt-1 text-xl font-black text-ink-inverse">
          Revogar acesso no Spotify
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-inverse">
          O Gate 6C não encontrou endpoint oficial documentado para o Sonoriza revogar a autorização do app. Depois da limpeza local, abra os apps conectados do Spotify e escolha “Remover acesso” para o Sonoriza.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={state.providerRevocation.connectedAppsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 transition hover:bg-accent-400"
          >
            Abrir apps conectados do Spotify
            <UiIcon name="arrow-right" size={17} />
          </a>

          <a
            href={state.providerRevocation.supportUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/55 px-5 py-3 text-sm font-black text-ink-inverse transition hover:bg-surface-elevated"
          >
            Ver ajuda do Spotify
          </a>
        </div>
      </section>
    </div>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line-dark/60 bg-surface-elevated/40 px-4 py-3">
      <p className="text-xs font-black uppercase tracking-[0.12em] text-muted-inverse">
        {label}
      </p>
      <p className="mt-1 text-lg font-black text-ink-inverse">
        {numberFormatter.format(value)}
      </p>
    </div>
  );
}
