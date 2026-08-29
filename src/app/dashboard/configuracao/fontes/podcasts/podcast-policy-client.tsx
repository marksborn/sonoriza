"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import { UiIcon } from "@/components/UiIcon";

export type PodcastPolicyClientValue = {
  sourcePlaylistId: string;
  episodeEligibility: "UNPLAYED_ONLY" | "PLAYED_ONLY" | "ALL";
  episodeOrder: "OLDEST_FIRST" | "NEWEST_FIRST" | "RANDOM";
  randomPolicy: "WITHOUT_REPLACEMENT" | "WITH_REPLACEMENT";
  startEpisodeId: string | null;
  strictSequence: boolean;
  maxReleaseAgeDays: number | null;
  expiryPolicy: "STRICT_EXPIRY" | "ALLOW_IN_PROGRESS_TO_FINISH";
  maxEpisodesPerCycle: number | null;
  publishedCount: number;
};

export type PodcastPolicyClientShow = {
  id: string;
  name: string;
  enabled: boolean;
  policy: PodcastPolicyClientValue;
};

type ServerFormAction = (formData: FormData) => Promise<void>;

const selectClass =
  "w-full rounded-xl border border-line-dark bg-surface-dark px-3 py-2.5 text-sm font-bold text-ink-inverse outline-none transition focus:border-accent/70";
const inputClass =
  "w-full rounded-xl border border-line-dark bg-surface-dark px-3 py-2.5 text-sm font-bold text-ink-inverse outline-none transition focus:border-accent/70";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-black text-brand-900 transition hover:bg-accent-400";
const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/70 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:border-brand-400/55";

export function PodcastPolicyClient({
  shows,
  initialOpenId,
  updateShowPolicyAction,
  resetShowProgressAction,
}: {
  shows: PodcastPolicyClientShow[];
  initialOpenId: string | null;
  updateShowPolicyAction: ServerFormAction;
  resetShowProgressAction: ServerFormAction;
}) {
  const directShow = initialOpenId
    ? shows.find((show) => show.id === initialOpenId) ?? null
    : null;
  const directMode = directShow !== null;

  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
  const filtered = useMemo(
    () =>
      normalizedQuery
        ? shows.filter((show) =>
            show.name.toLocaleLowerCase("pt-BR").includes(normalizedQuery),
          )
        : shows,
    [normalizedQuery, shows],
  );

  if (directShow) {
    return (
      <>
        <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-accent/25 bg-accent/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-accent-400">
              Editando agora
            </p>
            <p className="mt-1 truncate text-sm font-black text-ink-inverse">
              {directShow.name}
            </p>
          </div>
          <Link
            href="/dashboard/configuracao/fontes/podcasts"
            className={secondaryButtonClass}
          >
            <UiIcon name="list" size={16} />
            Ver todos os programas
          </Link>
        </div>

        <div className="mt-4">
          <PodcastPolicyCard
            show={directShow}
            open
            onToggle={() => undefined}
            directMode
            updateShowPolicyAction={updateShowPolicyAction}
            resetShowProgressAction={resetShowProgressAction}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Buscar programa</span>
          <UiIcon
            name="search"
            size={17}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-inverse"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar programa…"
            className="w-full rounded-xl border border-line-dark bg-surface-dark py-2.5 pl-10 pr-3 text-sm font-bold text-ink-inverse outline-none transition placeholder:text-muted-inverse/55 focus:border-accent/70"
          />
        </label>
        <div className="flex shrink-0 gap-2 text-xs font-black text-muted-inverse">
          <span className="product-badge">{filtered.length} exibidos</span>
          <span className="product-badge">{shows.length} programas</span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-line-dark bg-surface-subtle/45 p-6 text-center">
          <p className="font-black text-ink-inverse">Nenhum programa encontrado</p>
          <p className="mt-1 text-sm text-muted-inverse">Tente outro nome na busca.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {filtered.map((show) => (
            <PodcastPolicyCard
              key={show.id}
              show={show}
              open={openId === show.id}
              onToggle={() => setOpenId(openId === show.id ? null : show.id)}
              directMode={false}
              updateShowPolicyAction={updateShowPolicyAction}
              resetShowProgressAction={resetShowProgressAction}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PodcastPolicyCard({
  show,
  open,
  onToggle,
  directMode,
  updateShowPolicyAction,
  resetShowProgressAction,
}: {
  show: PodcastPolicyClientShow;
  open: boolean;
  onToggle: () => void;
  directMode: boolean;
  updateShowPolicyAction: ServerFormAction;
  resetShowProgressAction: ServerFormAction;
}) {
  const policy = show.policy;
  const [order, setOrder] = useState(policy.episodeOrder);
  const [releaseDays, setReleaseDays] = useState(
    policy.maxReleaseAgeDays == null ? "" : String(policy.maxReleaseAgeDays),
  );
  const random = order === "RANDOM";
  const hasExpiry = releaseDays.trim() !== "";

  return (
    <section className="product-panel overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="product-badge">Programa</span>
              <span
                className={
                  show.enabled
                    ? "status-success rounded-full border px-2.5 py-1 text-xs font-black"
                    : "product-badge"
                }
              >
                {show.enabled ? "Ativo" : "Desativado"}
              </span>
            </div>
            <h2 className="mt-2 truncate text-lg font-black text-ink-inverse sm:text-xl">
              {show.name}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {summaryChips(policy).map((chip) => (
                <span key={chip} className="product-badge">
                  {chip}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-inverse/70">
              {memoryDescription(policy)}
            </p>
          </div>

          {!directMode && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className={secondaryButtonClass}
            >
              <UiIcon name={open ? "close" : "settings"} size={16} />
              <span className="hidden sm:inline">{open ? "Fechar" : "Editar política"}</span>
              <span className="sm:hidden">{open ? "Fechar" : "Editar"}</span>
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-line-dark/55 bg-surface-subtle/30 p-4 sm:p-5">
          <form action={updateShowPolicyAction} className="grid gap-4 lg:grid-cols-2">
            <input type="hidden" name="sourcePlaylistId" value={show.id} />

            <Field label="Episódios" help="Define quais estados de escuta podem participar.">
              <select
                name="episodeEligibility"
                defaultValue={policy.episodeEligibility}
                className={selectClass}
              >
                <option value="UNPLAYED_ONLY">Somente não concluídos</option>
                <option value="PLAYED_ONLY">Somente já escutados</option>
                <option value="ALL">Escutados e não escutados</option>
              </select>
            </Field>

            <Field label="Ordem" help="Vale para o catálogo completo do programa.">
              <select
                name="episodeOrder"
                value={order}
                onChange={(event) =>
                  setOrder(
                    event.target.value as PodcastPolicyClientValue["episodeOrder"],
                  )
                }
                className={selectClass}
              >
                <option value="OLDEST_FIRST">Mais antigos primeiro</option>
                <option value="NEWEST_FIRST">Mais recentes primeiro</option>
                <option value="RANDOM">Aleatório</option>
              </select>
            </Field>

            {random ? (
              <Field
                label="Repetição do aleatório"
                help="Escolha se uma rodada precisa percorrer todos antes de repetir."
              >
                <select
                  name="randomPolicy"
                  defaultValue={policy.randomPolicy}
                  className={selectClass}
                >
                  <option value="WITHOUT_REPLACEMENT">
                    Evitar repetição até percorrer todos
                  </option>
                  <option value="WITH_REPLACEMENT">Permitir repetição</option>
                </select>
              </Field>
            ) : (
              <Field
                label="Começar a partir de"
                help="Opcional: ID, URI spotify:episode:… ou link do episódio."
              >
                <input
                  name="startEpisode"
                  defaultValue={policy.startEpisodeId ?? ""}
                  placeholder="Automático"
                  className={inputClass}
                />
              </Field>
            )}

            <Field
              label="Validade após lançamento"
              help="Vazio = sem expiração. Útil para notícias e conteúdo temporal."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  name="maxReleaseAgeDays"
                  min={0}
                  max={36500}
                  value={releaseDays}
                  onChange={(event) => setReleaseDays(event.target.value)}
                  placeholder="Sem limite"
                  className={inputClass}
                />
                <span className="shrink-0 text-xs font-bold text-muted-inverse">dias</span>
              </div>
            </Field>

            {hasExpiry && (
              <Field
                label="Quando vencer em andamento"
                help="Só importa quando existe uma janela de validade."
              >
                <select
                  name="expiryPolicy"
                  defaultValue={policy.expiryPolicy}
                  className={selectClass}
                >
                  <option value="STRICT_EXPIRY">Expirar mesmo em andamento</option>
                  <option value="ALLOW_IN_PROGRESS_TO_FINISH">
                    Deixar terminar se começou dentro da janela
                  </option>
                </select>
              </Field>
            )}

            <Field
              label="Máximo global por ciclo"
              help="Compartilhado entre todos os destinos do mesmo ciclo."
            >
              <input
                type="number"
                name="maxEpisodesPerCycle"
                min={1}
                max={100}
                defaultValue={policy.maxEpisodesPerCycle ?? ""}
                placeholder="Usar limite do destino"
                className={inputClass}
              />
            </Field>

            {!random && (
              <div className="rounded-xl border border-line-dark/55 bg-surface-dark/45 p-4">
                <label className="flex min-h-11 cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    name="strictSequence"
                    defaultChecked={policy.strictSequence}
                    className="mt-1 h-4 w-4"
                  />
                  <span>
                    <span className="block text-sm font-black text-ink-inverse">
                      Sequência estrita
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted-inverse">
                      Não pula o próximo episódio esperado só porque um posterior cabe no destino.
                    </span>
                  </span>
                </label>
              </div>
            )}

            <div className="flex flex-col gap-3 border-t border-line-dark/50 pt-4 lg:col-span-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-xs leading-5 text-muted-inverse">
                Salvar reinicia a memória de sequência/rodada deste programa, sem alterar o histórico de escuta ou a biblioteca no Spotify.
              </p>
              <button type="submit" className={buttonClass}>
                <UiIcon name="check" size={16} />
                Salvar política
              </button>
            </div>
          </form>

          <form action={resetShowProgressAction} className="mt-3 flex justify-end">
            <input type="hidden" name="sourcePlaylistId" value={show.id} />
            <button type="submit" className={secondaryButtonClass}>
              <UiIcon name="repeat" size={16} />
              Reiniciar sequência / rodada
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <label className="block rounded-xl border border-line-dark/55 bg-surface-dark/45 p-4">
      <span className="block text-sm font-black text-ink-inverse">{label}</span>
      <span className="mb-3 mt-1 block text-xs leading-5 text-muted-inverse">{help}</span>
      {children}
    </label>
  );
}

function summaryChips(policy: PodcastPolicyClientValue): string[] {
  const chips = [eligibilityLabel(policy.episodeEligibility), orderLabel(policy)];
  chips.push(
    policy.maxReleaseAgeDays == null
      ? "Sem validade"
      : `Até ${policy.maxReleaseAgeDays} dia${policy.maxReleaseAgeDays === 1 ? "" : "s"}`,
  );
  chips.push(
    policy.maxEpisodesPerCycle == null
      ? "Máx. do destino"
      : `Máx. ${policy.maxEpisodesPerCycle} / ciclo`,
  );
  if (policy.episodeOrder !== "RANDOM" && policy.strictSequence) {
    chips.push("Sequência estrita");
  }
  return chips;
}

function eligibilityLabel(value: PodcastPolicyClientValue["episodeEligibility"]): string {
  if (value === "PLAYED_ONLY") return "Já escutados";
  if (value === "ALL") return "Todos os episódios";
  return "Não concluídos";
}

function orderLabel(policy: PodcastPolicyClientValue): string {
  if (policy.episodeOrder === "OLDEST_FIRST") return "Antigos → novos";
  if (policy.episodeOrder === "NEWEST_FIRST") return "Novos → antigos";
  return policy.randomPolicy === "WITH_REPLACEMENT"
    ? "Aleatório · repete"
    : "Aleatório · sem repetir";
}

function memoryDescription(policy: PodcastPolicyClientValue): string {
  if (policy.episodeOrder === "RANDOM") {
    return policy.publishedCount > 0
      ? `${policy.publishedCount} seleção(ões) reais consideradas na rodada aleatória.`
      : "A rodada aleatória ainda não possui seleções reais registradas.";
  }
  if (policy.episodeEligibility !== "UNPLAYED_ONLY") {
    return policy.publishedCount > 0
      ? `${policy.publishedCount} seleção(ões) reais consideradas no cursor de replay.`
      : "O cursor de replay ainda não possui seleções reais registradas.";
  }
  return "O progresso normal é guiado pelo estado de escuta observado no Spotify.";
}
