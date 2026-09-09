import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  loadCalendarEventCompositionPolicy,
  saveCalendarEventCompositionPolicy,
  type CalendarEventCompositionPolicySnapshot,
} from "@/services/calendar-event-composition-policy";
import {
  calendar03TargetPreviewFromSummary,
  type Calendar03TargetPreview,
} from "@/services/calendar-event-composition-ux";

const PAGE_PATH = "/dashboard/configuracao/destinos/composicao-eventos";
const DESTINATIONS_PATH = "/dashboard/configuracao/destinos";
const REVIEW_PATH = "/dashboard/configuracao/revisao";

async function savePolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const targetPlaylistId = String(formData.get("targetPlaylistId") ?? "").trim();
  if (!targetPlaylistId) redirect(`${PAGE_PATH}?error=invalid`);

  const target = await prisma.targetPlaylist.findFirst({
    where: { id: targetPlaylistId, userId: session.user.id },
    select: {
      id: true,
      durationMode: true,
      calendarDurationStrategy: true,
    },
  });

  if (
    !target ||
    target.durationMode !== "CALENDAR" ||
    target.calendarDurationStrategy !== "PER_EVENT"
  ) {
    redirect(`${PAGE_PATH}?error=scope`);
  }

  try {
    await saveCalendarEventCompositionPolicy(session.user.id, target.id, {
      eventCompositionPolicy: String(
        formData.get("eventCompositionPolicy") ?? "",
      ) as "INHERIT_DESTINATION" | "PODCAST_THEN_MUSIC",
      maxPodcastsPerEvent: Number(formData.get("maxPodcastsPerEvent")),
      podcastEventSafetyMarginSeconds: Number(
        formData.get("podcastEventSafetyMarginSeconds"),
      ),
      podcastEventDistribution: String(
        formData.get("podcastEventDistribution") ?? "",
      ) as "EVERY_EVENT" | "EVERY_N_EVENTS",
      podcastEveryNEvents: Number(formData.get("podcastEveryNEvents")),
      podcastEventOffset: Number(formData.get("podcastEventOffset")),
    });
  } catch {
    redirect(`${PAGE_PATH}?error=policy`);
  }

  revalidatePath(PAGE_PATH);
  revalidatePath(DESTINATIONS_PATH);
  revalidatePath(REVIEW_PATH);
  revalidatePath("/dashboard/configuracao");
  revalidatePath("/dashboard");
  redirect(`${PAGE_PATH}?saved=${encodeURIComponent(target.id)}`);
}

type PageProps = {
  searchParams: Promise<{
    saved?: string;
    error?: string;
  }>;
};

type PreviewEvidence = Readonly<{
  runId: string;
  startedAt: Date;
  runStatus: string;
  preview: Calendar03TargetPreview;
}>;

export default async function CalendarEventCompositionPage({
  searchParams,
}: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = await searchParams;
  const targets = await prisma.targetPlaylist.findMany({
    where: { userId: session.user.id },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      enabled: true,
      durationMode: true,
      calendarDurationStrategy: true,
      calendarEventFilterMode: true,
      calendarEventMarker: true,
      calendarMode: true,
    },
  });

  const eligibleTargets = targets.filter(
    (target) =>
      target.durationMode === "CALENDAR" &&
      target.calendarDurationStrategy === "PER_EVENT",
  );

  const [policies, recentSimulations] = await Promise.all([
    Promise.all(
      eligibleTargets.map((target) =>
        loadCalendarEventCompositionPolicy(session.user.id, target.id),
      ),
    ),
    prisma.generationRun.findMany({
      where: {
        userId: session.user.id,
        simulation: true,
      },
      orderBy: { startedAt: "desc" },
      take: 40,
      select: {
        id: true,
        startedAt: true,
        status: true,
        summary: true,
      },
    }),
  ]);

  const policyByTargetId = new Map(
    policies.map((policy) => [policy.targetPlaylistId, policy]),
  );
  const previewByTargetId = new Map<string, PreviewEvidence>();

  for (const target of eligibleTargets) {
    for (const run of recentSimulations) {
      const preview = calendar03TargetPreviewFromSummary(run.summary, target.id);
      if (!preview) continue;
      previewByTargetId.set(target.id, {
        runId: run.id,
        startedAt: run.startedAt,
        runStatus: run.status,
        preview,
      });
      break;
    }
  }

  const errorMessage =
    params.error === "scope"
      ? "A composição por evento só pode ser editada em destinos baseados no calendário com estratégia Por evento."
      : params.error === "policy"
        ? "A política informada não passou pela validação canônica. Revise máximo por evento, margem, N e offset."
        : params.error
          ? "Não foi possível salvar a política. Revise os campos e tente novamente."
          : null;

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-6xl">
        <Link href={DESTINATIONS_PATH} className="product-link">
          <UiIcon name="arrow-left" size={18} />
          Destinos e regras
        </Link>

        <header className="mt-6 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">
              CALENDAR-03 · Gate 7
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
              Composição por evento
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
              Cada evento pode funcionar como uma janela fechada. O Sonoriza só inicia um podcast quando ele cabe inteiro no tempo útil daquele bloco e usa música para preencher o restante.
            </p>
          </div>

          <Link
            href={REVIEW_PATH}
            className="inline-flex w-fit items-center gap-2 rounded-full border border-brand-400/30 bg-brand/15 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:bg-brand/25"
          >
            <UiIcon name="check" size={17} />
            Revisar e simular
          </Link>
        </header>

        {params.saved && (
          <div className="status-success mt-6 rounded-2xl border px-4 py-3 text-sm font-bold">
            Política salva. Nenhuma geração foi iniciada; uma nova simulação será necessária quando a mudança alterar o plano possível.
          </div>
        )}

        {errorMessage && (
          <div className="status-danger mt-6 flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-bold leading-6">
            <UiIcon name="warning" size={18} className="mt-0.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <section className="product-panel mt-6 p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Como funciona
              </p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Policy por destino, preview por bloco
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-inverse">
                Esta tela lê somente configuração e simulações já persistidas. Ela não consulta o Spotify e não dispara geração ao abrir ou salvar.
              </p>
            </div>
            <span className="product-badge">
              <UiIcon name="calendar" size={15} />
              {eligibleTargets.length} por evento
            </span>
          </div>
        </section>

        {targets.length === 0 ? (
          <section className="product-panel mt-5 p-7 text-center">
            <p className="font-black text-ink-inverse">Nenhum destino configurado</p>
            <p className="mt-2 text-sm text-muted-inverse">
              Crie primeiro uma playlist de destino e escolha duração baseada no calendário.
            </p>
            <Link href={DESTINATIONS_PATH} className="product-link mt-4">
              Configurar destinos
              <UiIcon name="arrow-right" size={18} />
            </Link>
          </section>
        ) : (
          <div className="mt-5 space-y-5">
            {targets.map((target, index) => {
              const eligible =
                target.durationMode === "CALENDAR" &&
                target.calendarDurationStrategy === "PER_EVENT";
              const policy = eligible ? policyByTargetId.get(target.id) : null;
              const evidence = eligible ? previewByTargetId.get(target.id) : null;

              return (
                <article key={target.id} className="product-card overflow-hidden">
                  <div className="border-b border-line-dark/55 p-5 sm:p-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="product-badge">{index + 1}ª na geração</span>
                          <span className={target.enabled ? "status-success rounded-full border px-2.5 py-1 text-xs font-bold" : "product-badge"}>
                            {target.enabled ? "Ativa" : "Desativada"}
                          </span>
                          {eligible && (
                            <span className="status-info rounded-full border px-2.5 py-1 text-xs font-bold">
                              CALENDAR · PER_EVENT
                            </span>
                          )}
                        </div>
                        <h2 className="mt-3 text-2xl font-black tracking-tight text-ink-inverse">
                          {target.name}
                        </h2>
                        <p className="mt-1 text-sm text-muted-inverse">
                          {target.durationMode === "CALENDAR"
                            ? target.calendarDurationStrategy === "PER_EVENT"
                              ? "Cada evento é uma janela independente de planejamento."
                              : "Calendário somado em uma duração única."
                            : "Destino com duração fixa."}
                        </p>
                      </div>
                      <Link
                        href={DESTINATIONS_PATH}
                        className="product-link w-fit"
                      >
                        Editar destino
                        <UiIcon name="arrow-right" size={17} />
                      </Link>
                    </div>
                  </div>

                  {!eligible ? (
                    <div className="p-5 sm:p-6">
                      <div className="status-warning flex items-start gap-3 rounded-2xl border px-4 py-4 text-sm leading-6">
                        <UiIcon name="warning" size={18} className="mt-0.5 shrink-0" />
                        <div>
                          <p className="font-black">Composição por evento indisponível neste destino</p>
                          <p className="mt-1 opacity-80">
                            Escolha “Baseada no calendário” e estratégia “Por evento” em Destinos e regras. O Sonoriza não ativa CALENDAR-03 silenciosamente em duração fixa ou `SUMMED`.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : policy ? (
                    <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
                      <PolicyEditor targetId={target.id} policy={policy} />
                      <BlockPreview evidence={evidence ?? null} />
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function PolicyEditor({
  targetId,
  policy,
}: {
  targetId: string;
  policy: CalendarEventCompositionPolicySnapshot;
}) {
  return (
    <section className="border-b border-line-dark/55 p-5 sm:p-6 xl:border-b-0 xl:border-r">
      <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
        Política da janela
      </p>
      <h3 className="mt-1 text-lg font-black text-ink-inverse">O que colocar em cada evento?</h3>

      <form action={savePolicy} className="mt-5 space-y-5">
        <input type="hidden" name="targetPlaylistId" value={targetId} />

        <label className="block text-sm font-bold text-ink-inverse">
          Composição
          <select
            name="eventCompositionPolicy"
            defaultValue={policy.eventCompositionPolicy}
            className="mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none focus:border-accent-400/70"
          >
            <option value="INHERIT_DESTINATION">Usar a composição normal do destino</option>
            <option value="PODCAST_THEN_MUSIC">Podcast inteiro primeiro + música no restante</option>
          </select>
          <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-inverse/65">
            “Podcast inteiro” nunca atravessa a fronteira do evento. Se nenhum episódio couber, o bloco pode ficar somente com música.
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-bold text-ink-inverse">
            Máximo de podcasts por evento
            <input
              type="number"
              name="maxPodcastsPerEvent"
              min={1}
              step={1}
              required
              defaultValue={policy.maxPodcastsPerEvent}
              className="mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none focus:border-accent-400/70"
            />
            <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-inverse/65">
              Para Carro, o padrão recomendado é 1.
            </span>
          </label>

          <label className="text-sm font-bold text-ink-inverse">
            Margem de segurança (segundos)
            <input
              type="number"
              name="podcastEventSafetyMarginSeconds"
              min={0}
              step={1}
              required
              defaultValue={policy.podcastEventSafetyMarginSeconds}
              className="mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none focus:border-accent-400/70"
            />
            <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-inverse/65">
              Ex.: 120 segundos reservam 2 minutos antes do fim previsto.
            </span>
          </label>
        </div>

        <label className="block text-sm font-bold text-ink-inverse">
          Em quais eventos tentar podcast?
          <select
            name="podcastEventDistribution"
            defaultValue={policy.podcastEventDistribution}
            className="mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none focus:border-accent-400/70"
          >
            <option value="EVERY_EVENT">Em todos os eventos</option>
            <option value="EVERY_N_EVENTS">A cada N eventos</option>
          </select>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-bold text-ink-inverse">
            N
            <input
              type="number"
              name="podcastEveryNEvents"
              min={1}
              step={1}
              required
              defaultValue={policy.podcastEveryNEvents}
              className="mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none focus:border-accent-400/70"
            />
            <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-inverse/65">
              N=2 alterna eventos. Em “todos”, o contrato normaliza automaticamente para N=1.
            </span>
          </label>

          <label className="text-sm font-bold text-ink-inverse">
            Fase / offset
            <input
              type="number"
              name="podcastEventOffset"
              min={0}
              step={1}
              required
              defaultValue={policy.podcastEventOffset}
              className="mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none focus:border-accent-400/70"
            />
            <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-inverse/65">
              Com N=2: offset 0 tenta E1/E3; offset 1 tenta E2/E4. O offset deve ser menor que N.
            </span>
          </label>
        </div>

        <div className="rounded-2xl border border-line-dark/55 bg-surface-dark/55 p-4 text-xs leading-5 text-muted-inverse">
          Salvar altera somente a configuração persistida. O fingerprint muda quando a policy pode afetar o plano, portanto valide uma nova simulação antes de gerar de verdade.
        </div>

        <button type="submit" className="primary-button w-full sm:w-auto">
          Salvar composição por evento
        </button>
      </form>
    </section>
  );
}

function BlockPreview({ evidence }: { evidence: PreviewEvidence | null }) {
  return (
    <section className="p-5 sm:p-6">
      <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
        Preview por bloco
      </p>
      <h3 className="mt-1 text-lg font-black text-ink-inverse">Última simulação com evidência deste destino</h3>

      {!evidence ? (
        <div className="mt-5 rounded-2xl border border-dashed border-line-dark/60 bg-surface-subtle/45 p-5">
          <p className="font-black text-ink-inverse">Ainda sem preview CALENDAR-03</p>
          <p className="mt-2 text-sm leading-6 text-muted-inverse">
            Execute uma simulação em “Revisar e testar”. Esta tela não dispara simulação automaticamente e nunca escreve no Spotify.
          </p>
          <Link href={REVIEW_PATH} className="product-link mt-4">
            Ir para revisão e simulação
            <UiIcon name="arrow-right" size={17} />
          </Link>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="rounded-2xl border border-line-dark/55 bg-surface-dark/55 p-4">
            <div className="flex flex-wrap gap-2">
              <span className={evidence.runStatus === "SUCCESS" ? "status-success rounded-full border px-2.5 py-1 text-xs font-bold" : "product-badge"}>
                Run {evidence.runStatus}
              </span>
              <span className="product-badge">{evidence.preview.effectiveMode}</span>
              <span className={evidence.preview.plannerInfluence ? "status-info rounded-full border px-2.5 py-1 text-xs font-bold" : "product-badge"}>
                {evidence.preview.plannerInfluence ? "Influenciou o plano" : "Sem influência"}
              </span>
              <span className="product-badge">{evidence.preview.status}</span>
            </div>
            <p className="mt-3 break-all text-xs text-muted-inverse">
              Run <code className="text-ink-inverse">{evidence.runId}</code>
            </p>
            <p className="mt-1 text-xs text-muted-inverse/70">
              {formatDate(evidence.startedAt)} · {evidence.preview.activationReason}
            </p>
          </div>

          {evidence.preview.blocks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-dark/60 p-4 text-sm text-muted-inverse">
              A simulação registrou o target, mas não trouxe diagnostics de blocos utilizáveis.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {evidence.preview.blocks.map((block) => (
                <article
                  key={`${block.index}:${block.key}`}
                  className="rounded-2xl border border-line-dark/55 bg-surface-subtle/45 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-black text-ink-inverse">Evento {block.index + 1}</p>
                    <span className="product-badge">{formatDuration(block.targetDurationMs)}</span>
                  </div>
                  <p className="mt-3 text-xs font-bold text-muted-inverse">
                    Tempo útil para podcast: {formatDuration(block.podcastUsableDurationMs)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {block.diagnosticCodes.length > 0 ? (
                      block.diagnosticCodes.map((code) => (
                        <span key={code} className="status-info rounded-full border px-2.5 py-1 text-[11px] font-bold">
                          {diagnosticLabel(code)}
                        </span>
                      ))
                    ) : (
                      <span className="product-badge">Sem diagnóstico</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="rounded-2xl border border-line-dark/55 bg-surface-dark/55 p-4">
            <p className="text-xs font-black uppercase tracking-[0.12em] text-muted-inverse">
              Podcasts selecionados na projeção
            </p>
            {evidence.preview.selectedPodcastUris.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {evidence.preview.selectedPodcastUris.map((uri) => (
                  <li key={uri} className="break-all rounded-xl bg-surface-subtle/60 px-3 py-2 text-xs text-ink-inverse">
                    {uri}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-inverse">
                Nenhum podcast foi selecionado nesta projeção.
              </p>
            )}
            <p className="mt-3 text-xs leading-5 text-muted-inverse/65">
              A evidência atual do runtime registra as URIs selecionadas no target e os diagnostics por bloco, mas não persiste ainda a associação nominal episódio → bloco. A UI não inventa essa relação.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} min`;
  return `${minutes}m ${seconds}s`;
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

function diagnosticLabel(code: string) {
  const labels: Record<string, string> = {
    EVENT_PODCAST_SELECTED: "Podcast selecionado",
    EVENT_PODCAST_DISTRIBUTION_SKIPPED: "Pulou pela distribuição",
    EVENT_PODCAST_SKIPPED_BY_DISTRIBUTION: "Pulou pela distribuição",
    EVENT_PODCAST_NO_FITTING_CANDIDATE: "Nenhum podcast coube",
    EVENT_PODCAST_CAP_REACHED: "Limite do evento atingido",
    EVENT_SAFETY_MARGIN_APPLIED: "Margem de segurança aplicada",
  };
  return labels[code] ?? code.replaceAll("_", " ").toLowerCase();
}
