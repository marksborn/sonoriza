import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { destinationCompositionCardId } from "@/lib/destination-edit-link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_CALENDAR_SEQUENCE_PER_EVENT_STORAGE,
  loadCalendarEventCompositionPolicy,
  saveCalendarEventCompositionPolicy,
  type CalendarEventCompositionPolicySnapshot,
  type CalendarRemainderFallbackValue,
  type CalendarRemainderFillStrategyValue,
  type EventCompositionPolicyValue,
} from "@/services/calendar-event-composition-policy";
import {
  resolveCalendar03PlannerMode,
  resolveCalendar04PlannerMode,
} from "@/services/playlist-planner/calendar-event-composition-runtime";
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
      ) as EventCompositionPolicyValue,
      remainderFillStrategy: String(
        formData.get("remainderFillStrategy") ?? "",
      ) as CalendarRemainderFillStrategyValue,
      remainderPodcastPercent: Number(formData.get("remainderPodcastPercent")),
      remainderFallback: String(
        formData.get("remainderFallback") ?? "",
      ) as CalendarRemainderFallbackValue,
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
      compositionMode: true,
      sequencePattern: true,
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

  // Same resolution as the generation triggers, so the badge tells whether a
  // saved policy can change the real playlist or only appears in simulations.
  const calendar03Mode = resolveCalendar03PlannerMode({
    requestedMode: process.env.CALENDAR_03_PLANNER_MODE ?? "SHADOW",
    userEmail: session.user.email ?? null,
    activeEmailAllowlist: process.env.CALENDAR_03_PLANNER_EMAIL_ALLOWLIST ?? null,
    activeTargetIds: process.env.CALENDAR_03_PLANNER_TARGET_IDS ?? null,
  });
  const calendar04Mode = resolveCalendar04PlannerMode(
    process.env.CALENDAR_04_PLANNER_MODE,
    calendar03Mode.effectiveMode,
  ).effectiveMode;
  const effectiveStateFor = (
    policy: CalendarEventCompositionPolicySnapshot,
  ): EffectiveState => {
    if (policy.eventCompositionPolicy === "INHERIT_DESTINATION") return "NORMAL";
    const modeForPolicy =
      policy.eventCompositionPolicy === "SEQUENCE_PER_EVENT"
        ? calendar04Mode
        : calendar03Mode.effectiveMode;
    if (modeForPolicy === "OFF") return "OFF";
    return modeForPolicy === "ACTIVE" &&
      calendar03Mode.activeTargetAllowlist.has(policy.targetPlaylistId)
      ? "ACTIVE"
      : "SHADOW";
  };

  const errorMessage =
    params.error === "scope"
      ? "A composição por evento só pode ser editada em destinos baseados no calendário com estratégia Por evento."
      : params.error === "policy"
        ? "A política informada não passou pela validação canônica. Revise a proporção (0 a 100%) e, na configuração antiga, máximo por evento, margem, N e offset."
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
              CALENDAR-04
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
              Composição por evento
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
              Cada evento funciona como uma janela fechada. Com a sequência por evento, sua sequência de Música/Podcast recomeça no início de cada evento e você escolhe como preencher o tempo que sobrar. Nenhum podcast é cortado e nada atravessa para o evento seguinte.
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
                <article
                  key={target.id}
                  id={destinationCompositionCardId(target.id)}
                  className="product-card scroll-mt-6 overflow-hidden"
                >
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
                      <PolicyEditor
                        targetId={target.id}
                        policy={policy}
                        sequence={
                          target.compositionMode === "SEQUENCE"
                            ? parseSequence(target.sequencePattern)
                            : []
                        }
                        effectiveState={effectiveStateFor(policy)}
                      />
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

type EffectiveState = "NORMAL" | "ACTIVE" | "SHADOW" | "OFF";

const REMAINDER_OPTIONS: ReadonlyArray<{
  value: CalendarRemainderFillStrategyValue;
  label: string;
  help: string;
  needsPodcast: boolean;
}> = [
  {
    value: "MUSIC_ONLY",
    label: "Preencher com músicas",
    help: "Depois da sequência, só músicas até o fim do evento.",
    needsPodcast: false,
  },
  {
    value: "PODCAST_ONLY",
    label: "Preencher com podcasts",
    help: "Tenta episódios inteiros que caibam no tempo que sobrou.",
    needsPodcast: true,
  },
  {
    value: "MIX_RATIO",
    label: "Proporção personalizada",
    help: "Divide só o tempo que sobrou, por duração. É um alvo: episódios inteiros podem desviar.",
    needsPodcast: true,
  },
  {
    value: "REPEAT_SEQUENCE",
    label: "Repetir a sequência",
    help: "Recomeça a sequência dentro do mesmo evento enquanto couber.",
    needsPodcast: false,
  },
];

function PolicyEditor({
  targetId,
  policy,
  sequence,
  effectiveState,
}: {
  targetId: string;
  policy: CalendarEventCompositionPolicySnapshot;
  sequence: Array<"MUSIC" | "PODCAST">;
  effectiveState: EffectiveState;
}) {
  const isLegacy = policy.eventCompositionPolicy === "PODCAST_THEN_MUSIC";
  const settings = policy.sequencePerEvent;
  const strategy =
    settings?.remainderFillStrategy ??
    DEFAULT_CALENDAR_SEQUENCE_PER_EVENT_STORAGE.remainderFillStrategy;
  const fallback =
    settings?.remainderFallback ?? DEFAULT_CALENDAR_SEQUENCE_PER_EVENT_STORAGE.remainderFallback;
  const percent =
    settings?.remainderPodcastPercent ??
    DEFAULT_CALENDAR_SEQUENCE_PER_EVENT_STORAGE.remainderPodcastPercent;
  const hasSequence = sequence.length > 0;
  const sequenceHasPodcast = sequence.includes("PODCAST");
  const inputClass =
    "mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none focus:border-accent-400/70";
  const optionClass =
    "flex cursor-pointer items-start gap-3 rounded-2xl border border-line-dark/55 bg-surface-dark/55 p-3 text-sm has-[:checked]:border-accent-400/70 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50";

  return (
    <section className="border-b border-line-dark/55 p-5 sm:p-6 xl:border-b-0 xl:border-r">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
          Política da janela
        </p>
        <EffectiveStateBadge state={effectiveState} />
      </div>
      <h3 className="mt-1 text-lg font-black text-ink-inverse">O que colocar em cada evento?</h3>

      <form action={savePolicy} className="mt-5 space-y-5">
        <input type="hidden" name="targetPlaylistId" value={targetId} />

        <fieldset className="space-y-2">
          <legend className="text-sm font-bold text-ink-inverse">Composição</legend>
          <label className={optionClass}>
            <input
              type="radio"
              name="eventCompositionPolicy"
              value="INHERIT_DESTINATION"
              defaultChecked={policy.eventCompositionPolicy === "INHERIT_DESTINATION"}
              className="mt-1"
            />
            <span>
              <span className="font-bold text-ink-inverse">Usar a composição normal do destino</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-inverse">
                A sequência continua de um evento para o outro, como hoje.
              </span>
            </span>
          </label>
          <label className={optionClass}>
            <input
              type="radio"
              name="eventCompositionPolicy"
              value="SEQUENCE_PER_EVENT"
              defaultChecked={policy.eventCompositionPolicy === "SEQUENCE_PER_EVENT"}
              disabled={!hasSequence}
              className="mt-1"
            />
            <span>
              <span className="font-bold text-ink-inverse">Sequência por evento</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-inverse">
                {hasSequence
                  ? `Executa ${sequence.map(sequenceLabel).join(" → ")} no início de cada evento e depois preenche o restante como escolhido abaixo.`
                  : "Indisponível: defina no destino uma sequência de Música/Podcast."}
              </span>
            </span>
          </label>
          {isLegacy && (
            <label className={optionClass}>
              <input
                type="radio"
                name="eventCompositionPolicy"
                value="PODCAST_THEN_MUSIC"
                defaultChecked
                className="mt-1"
              />
              <span>
                <span className="font-bold text-ink-inverse">Configuração antiga (em uso)</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-inverse">
                  Podcast inteiro primeiro + música, com escolha de eventos. Continua funcionando até você trocar.
                </span>
              </span>
            </label>
          )}
        </fieldset>

        <fieldset className="space-y-2 rounded-2xl border border-line-dark/55 p-4">
          <legend className="px-1 text-sm font-bold text-ink-inverse">
            Sequência por evento: depois da sequência…
          </legend>
          {REMAINDER_OPTIONS.map((option) => {
            const unavailable = option.needsPodcast && !sequenceHasPodcast && hasSequence;
            return (
              <label key={option.value} className={optionClass}>
                <input
                  type="radio"
                  name="remainderFillStrategy"
                  value={option.value}
                  defaultChecked={strategy === option.value}
                  className="mt-1"
                />
                <span>
                  <span className="font-bold text-ink-inverse">{option.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-inverse">
                    {option.help}
                    {unavailable &&
                      " Sua sequência não tem podcast: só entra podcast se houver fonte de podcast elegível."}
                  </span>
                </span>
              </label>
            );
          })}

          <label className="block pt-2 text-sm font-bold text-ink-inverse">
            Podcast na proporção personalizada (%)
            <input
              type="number"
              name="remainderPodcastPercent"
              min={0}
              max={100}
              step={1}
              required
              defaultValue={percent}
              className={inputClass}
            />
            <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-inverse/65">
              Usado só na proporção personalizada. Ex.: 30 = cerca de 30% podcast e 70% música no tempo que sobrar.
            </span>
          </label>

          <div className="space-y-2 pt-2">
            <p className="text-sm font-bold text-ink-inverse">Se não couber ou faltar conteúdo</p>
            <label className={optionClass}>
              <input
                type="radio"
                name="remainderFallback"
                value="FILL_WITH_MUSIC"
                defaultChecked={fallback === "FILL_WITH_MUSIC"}
                className="mt-1"
              />
              <span className="font-bold text-ink-inverse">Completar com música</span>
            </label>
            <label className={optionClass}>
              <input
                type="radio"
                name="remainderFallback"
                value="LEAVE_GAP"
                defaultChecked={fallback === "LEAVE_GAP"}
                className="mt-1"
              />
              <span>
                <span className="font-bold text-ink-inverse">Não forçar preenchimento</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-inverse">
                  O evento pode terminar mais curto que o previsto.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {isLegacy ? (
          <details className="rounded-2xl border border-line-dark/55 p-4" open>
            <summary className="cursor-pointer text-sm font-bold text-ink-inverse">
              Ajustes da configuração antiga
            </summary>
            <p className="mt-2 text-xs leading-5 text-muted-inverse">
              Ao escolher “Sequência por evento” e salvar, estes ajustes deixam de valer. Simule antes: as voltas podem passar a receber podcast.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-bold text-ink-inverse">
                Máximo de podcasts por evento
                <input type="number" name="maxPodcastsPerEvent" min={1} step={1} required defaultValue={policy.maxPodcastsPerEvent} className={inputClass} />
              </label>
              <label className="text-sm font-bold text-ink-inverse">
                Margem de segurança (segundos)
                <input type="number" name="podcastEventSafetyMarginSeconds" min={0} step={1} required defaultValue={policy.podcastEventSafetyMarginSeconds} className={inputClass} />
              </label>
              <label className="text-sm font-bold text-ink-inverse sm:col-span-2">
                Em quais eventos tentar podcast?
                <select name="podcastEventDistribution" defaultValue={policy.podcastEventDistribution} className={inputClass}>
                  <option value="EVERY_EVENT">Em todos os eventos</option>
                  <option value="EVERY_N_EVENTS">A cada N eventos</option>
                </select>
              </label>
              <label className="text-sm font-bold text-ink-inverse">
                N
                <input type="number" name="podcastEveryNEvents" min={1} step={1} required defaultValue={policy.podcastEveryNEvents} className={inputClass} />
              </label>
              <label className="text-sm font-bold text-ink-inverse">
                Fase / offset
                <input type="number" name="podcastEventOffset" min={0} step={1} required defaultValue={policy.podcastEventOffset} className={inputClass} />
              </label>
            </div>
          </details>
        ) : (
          <>
            <input type="hidden" name="maxPodcastsPerEvent" value={policy.maxPodcastsPerEvent} />
            <input type="hidden" name="podcastEventSafetyMarginSeconds" value={policy.podcastEventSafetyMarginSeconds} />
            <input type="hidden" name="podcastEventDistribution" value={policy.podcastEventDistribution} />
            <input type="hidden" name="podcastEveryNEvents" value={policy.podcastEveryNEvents} />
            <input type="hidden" name="podcastEventOffset" value={policy.podcastEventOffset} />
          </>
        )}

        <div className="rounded-2xl border border-line-dark/55 bg-surface-dark/55 p-4 text-xs leading-5 text-muted-inverse">
          Salvar altera somente a configuração. Nada é gerado nem escrito no Spotify; rode uma nova simulação para ver o resultado por evento antes da próxima geração.
        </div>

        <button type="submit" className="primary-button w-full sm:w-auto">
          Salvar composição por evento
        </button>
      </form>
    </section>
  );
}

function EffectiveStateBadge({ state }: { state: EffectiveState }) {
  if (state === "NORMAL") return null;
  const label =
    state === "ACTIVE"
      ? "Ativa na playlist"
      : state === "SHADOW"
        ? "Em teste: só nas simulações"
        : "Desligada pelo operador";
  return (
    <span
      className={
        state === "ACTIVE"
          ? "status-success rounded-full border px-2.5 py-1 text-xs font-bold"
          : "status-warning rounded-full border px-2.5 py-1 text-xs font-bold"
      }
    >
      {label}
    </span>
  );
}

function sequenceLabel(type: "MUSIC" | "PODCAST") {
  return type === "PODCAST" ? "Podcast" : "Música";
}

function parseSequence(value: unknown): Array<"MUSIC" | "PODCAST"> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is "MUSIC" | "PODCAST" => entry === "MUSIC" || entry === "PODCAST",
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
          <p className="font-black text-ink-inverse">Ainda sem preview por evento</p>
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
                  {block.calendar04 ? (
                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-inverse">
                      <dt>Sequência inicial</dt>
                      <dd className="text-right font-bold text-ink-inverse">
                        {block.calendar04.initialSequenceFilledSlots}/{block.calendar04.initialSequenceSlots} itens
                      </dd>
                      <dt>Sobrou depois</dt>
                      <dd className="text-right font-bold text-ink-inverse">
                        {formatDuration(block.calendar04.remainderAfterSequenceMs)}
                      </dd>
                      <dt>{remainderLabel(block.calendar04.remainderFillStrategy)}</dt>
                      <dd className="text-right font-bold text-ink-inverse">
                        {formatDuration(block.calendar04.remainderMusicDurationMs)} música ·{" "}
                        {formatDuration(block.calendar04.remainderPodcastDurationMs)} podcast
                      </dd>
                      {block.calendar04.requestedRemainderPodcastPercent !== null && (
                        <>
                          <dt>Podcast pedido / obtido</dt>
                          <dd className="text-right font-bold text-ink-inverse">
                            {block.calendar04.requestedRemainderPodcastPercent}% /{" "}
                            {achievedPercent(block.calendar04)}%
                          </dd>
                        </>
                      )}
                      {block.calendar04.fallbackMusicDurationMs > 0 && (
                        <>
                          <dt>Completado com música</dt>
                          <dd className="text-right font-bold text-ink-inverse">
                            {formatDuration(block.calendar04.fallbackMusicDurationMs)}
                          </dd>
                        </>
                      )}
                      <dt>Total planejado</dt>
                      <dd className="text-right font-bold text-ink-inverse">
                        {formatDuration(block.calendar04.filledDurationMs)}
                        {block.calendar04.deficitMs > 0 &&
                          ` (faltam ${formatDuration(block.calendar04.deficitMs)})`}
                      </dd>
                    </dl>
                  ) : (
                    <p className="mt-3 text-xs font-bold text-muted-inverse">
                      Tempo útil para podcast: {formatDuration(block.podcastUsableDurationMs)}
                    </p>
                  )}
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

function remainderLabel(strategy: string) {
  return (
    REMAINDER_OPTIONS.find((option) => option.value === strategy)?.label ?? strategy
  );
}

function achievedPercent(block: {
  remainderMusicDurationMs: number;
  remainderPodcastDurationMs: number;
}) {
  const total = block.remainderMusicDurationMs + block.remainderPodcastDurationMs;
  return total > 0 ? Math.round((block.remainderPodcastDurationMs / total) * 100) : 0;
}

function diagnosticLabel(code: string) {
  const labels: Record<string, string> = {
    EVENT_SEQUENCE_COMPLETED: "Sequência completa",
    EVENT_SEQUENCE_SLOT_UNFILLED_PODCAST: "Podcast da sequência não coube",
    EVENT_SEQUENCE_SLOT_UNFILLED_MUSIC: "Música da sequência não coube",
    EVENT_REMAINDER_FILLED: "Restante preenchido",
    EVENT_REMAINDER_FALLBACK_MUSIC: "Completado com música",
    EVENT_REMAINDER_GAP_LEFT: "Sobrou tempo vazio",
    EVENT_PODCAST_SELECTED: "Podcast selecionado",
    EVENT_PODCAST_DISTRIBUTION_SKIPPED: "Pulou pela distribuição",
    EVENT_PODCAST_SKIPPED_BY_DISTRIBUTION: "Pulou pela distribuição",
    EVENT_PODCAST_NO_FITTING_CANDIDATE: "Nenhum podcast coube",
    EVENT_PODCAST_CAP_REACHED: "Limite do evento atingido",
    EVENT_SAFETY_MARGIN_APPLIED: "Margem de segurança aplicada",
  };
  return labels[code] ?? code.replaceAll("_", " ").toLowerCase();
}
