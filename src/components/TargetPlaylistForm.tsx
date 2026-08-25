"use client";

import { useEffect, useState } from "react";

import { UiIcon } from "@/components/UiIcon";

type ContentType = "MUSIC" | "PODCAST";
type CompositionMode = "PROPORTION" | "SEQUENCE";
type MusicOrderMode = "STANDARD" | "RANDOMIZED";
type TargetUpdatePolicy = "MANUAL" | "KEEP_FILLED" | "REBUILD_DAILY";
type DurationMode = "FIXED" | "CALENDAR";
type EmptyCalendarBehavior = "CLEAR" | "KEEP" | "SKIP";
type CalendarEventFilterMode = "ALL" | "MARKER";
type CalendarDurationStrategy = "SUMMED" | "PER_EVENT";
type TargetCalendarMode = "LEGACY_GLOBAL" | "SELECTED" | "ALL_QUERYABLE";
type PodcastEpisodeMaxDurationMode = "NONE" | "FIXED" | "CALENDAR_MAX_EVENT";

export type SpotifyDestinationOption = {
  id: string;
  name: string;
};

export type CalendarOption = {
  id: string;
  googleCalendarId: string;
  name: string;
};

export type TargetPlaylistFormInitial = {
  id?: string;
  name: string;
  enabled: boolean;
  durationMode: DurationMode;
  fixedDurationMinutes: number;
  calendarMode: TargetCalendarMode;
  calendarSelectionIds: string[];
  allowLegacyCalendar: boolean;
  emptyCalendarBehavior: EmptyCalendarBehavior;
  calendarEventFilterMode: CalendarEventFilterMode;
  calendarEventMarker: string;
  calendarDurationStrategy: CalendarDurationStrategy;
  compositionMode: CompositionMode;
  musicOrderMode: MusicOrderMode;
  podcastPercent: number;
  podcastEpisodeMaxDurationMode: PodcastEpisodeMaxDurationMode;
  podcastEpisodeMaxDurationMinutes: number;
  sequencePattern: ContentType[];
  maxEpisodesPerProgram: number;
  maxTracksPerArtist: number | null;
  maxTracksPerAlbum: number | null;
  updatePolicy: TargetUpdatePolicy;
  dailyScheduleTime: string;
  scheduleTimezone: string;
  destinationValue: string;
  currentSpotifyName?: string;
  destinationUnavailable?: boolean;
};

type TargetPlaylistFormProps = {
  initial: TargetPlaylistFormInitial;
  spotifyOptions: SpotifyDestinationOption[];
  durationCalendarNames: string[];
  calendarOptions: CalendarOption[];
  saveAction: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
};

const DEFAULT_SEQUENCE: ContentType[] = [
  "MUSIC",
  "PODCAST",
  "MUSIC",
  "MUSIC",
  "PODCAST",
];

const inputClass =
  "mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse outline-none transition placeholder:text-muted-inverse/45 focus:border-accent-400/70 focus:ring-2 focus:ring-accent/15";
const fieldLabelClass = "text-sm font-bold text-ink-inverse";
const helperClass = "mt-1.5 block text-xs font-normal leading-5 text-muted-inverse/65";
const sectionClass = "rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4 sm:p-5";
const optionIdleClass =
  "border-line-dark/55 bg-surface-subtle/55 hover:border-brand-400/45 hover:bg-surface-elevated/65";
const optionActiveClass = "border-brand-400/65 bg-brand/15";

function contentLabel(type: ContentType) {
  return type === "MUSIC" ? "Música" : "Podcast";
}

function optionClass(active: boolean) {
  return `cursor-pointer rounded-2xl border p-4 transition ${
    active ? optionActiveClass : optionIdleClass
  }`;
}

export function TargetPlaylistForm({
  initial,
  spotifyOptions,
  durationCalendarNames,
  calendarOptions,
  saveAction,
  submitLabel,
}: TargetPlaylistFormProps) {
  const [durationMode, setDurationMode] = useState<DurationMode>(initial.durationMode);
  const [calendarMode, setCalendarMode] = useState<TargetCalendarMode>(initial.calendarMode);
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>(
    initial.calendarSelectionIds,
  );
  const [calendarEventFilterMode, setCalendarEventFilterMode] =
    useState<CalendarEventFilterMode>(initial.calendarEventFilterMode);
  const [calendarDurationStrategy, setCalendarDurationStrategy] =
    useState<CalendarDurationStrategy>(initial.calendarDurationStrategy);
  const [compositionMode, setCompositionMode] = useState<CompositionMode>(
    initial.compositionMode,
  );
  const [musicOrderMode, setMusicOrderMode] = useState<MusicOrderMode>(
    initial.musicOrderMode,
  );
  const [artistDiversityEnabled, setArtistDiversityEnabled] = useState(
    initial.maxTracksPerArtist !== null,
  );
  const [albumDiversityEnabled, setAlbumDiversityEnabled] = useState(
    initial.maxTracksPerAlbum !== null,
  );
  const [updatePolicy, setUpdatePolicy] = useState<TargetUpdatePolicy>(
    initial.updatePolicy,
  );
  const [scheduleTimezone, setScheduleTimezone] = useState(initial.scheduleTimezone);
  const [podcastPercent, setPodcastPercent] = useState(initial.podcastPercent);
  const [podcastEpisodeMaxDurationMode, setPodcastEpisodeMaxDurationMode] =
    useState<PodcastEpisodeMaxDurationMode>(initial.podcastEpisodeMaxDurationMode);
  const [sequence, setSequence] = useState<ContentType[]>(
    initial.sequencePattern.length > 0 ? initial.sequencePattern : DEFAULT_SEQUENCE,
  );

  const musicPercent = 100 - podcastPercent;
  const idPrefix = initial.id ?? "new-target";

  useEffect(() => {
    if (updatePolicy === "MANUAL" || scheduleTimezone) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) setScheduleTimezone(detected);
  }, [scheduleTimezone, updatePolicy]);

  function moveSequence(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= sequence.length) return;

    setSequence((current) => {
      const next = [...current];
      const currentValue = next[index]!;
      next[index] = next[nextIndex]!;
      next[nextIndex] = currentValue;
      return next;
    });
  }

  function removeSequence(index: number) {
    if (sequence.length <= 1) return;
    setSequence((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function addSequence(type: ContentType) {
    if (sequence.length >= 20) return;
    setSequence((current) => [...current, type]);
  }

  return (
    <form action={saveAction} className="space-y-6">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="sequencePattern" value={JSON.stringify(sequence)} />
      <input type="hidden" name="podcastPercent" value={podcastPercent} />

      <div className="grid gap-5 md:grid-cols-2">
        <label className={fieldLabelClass}>
          Nome no Sonoriza
          <input
            className={inputClass}
            name="name"
            required
            maxLength={100}
            defaultValue={initial.name}
            placeholder="Ex.: Carro, Trabalho, Academia"
          />
          <span className={helperClass}>
            É o nome que aparece no painel. Ao criar uma nova playlist no Spotify, este nome também será usado lá.
          </span>
        </label>

        <label className={fieldLabelClass}>
          Playlist no Spotify
          <select
            className={inputClass}
            name="destination"
            defaultValue={initial.destinationValue}
          >
            {initial.destinationValue === "__KEEP__" && (
              <option value="__KEEP__">
                {initial.currentSpotifyName
                  ? `Manter vinculada: ${initial.currentSpotifyName}`
                  : "Manter playlist vinculada atual"}
              </option>
            )}
            <option value="__NEW__">Criar uma nova playlist privada</option>
            {spotifyOptions.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                Usar existente: {playlist.name}
              </option>
            ))}
          </select>
          <span className={helperClass}>
            O Sonoriza não pede IDs. Playlists usadas como fonte ou já ligadas a outro destino ficam fora desta lista.
          </span>
          {initial.destinationUnavailable && (
            <span className="status-warning mt-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs font-semibold leading-5">
              <UiIcon name="warning" size={16} className="mt-0.5 shrink-0" />
              <span>
                A playlist atualmente vinculada não apareceu entre as playlists próprias da conta. Você pode manter a configuração, mas é recomendável substituí-la antes da próxima geração.
              </span>
            </span>
          )}
        </label>
      </div>

      <label className={`${sectionClass} flex items-start gap-3`}>
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={initial.enabled}
          className="mt-1 h-4 w-4 accent-accent"
        />
        <span>
          <span className="block text-sm font-black text-ink-inverse">Playlist ativa</span>
          <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
            Desativar mantém todas as regras salvas, mas tira este destino das próximas gerações.
          </span>
        </span>
      </label>

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Atualização automática
        </legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          A política é por destino. Salvar esta tela nunca executa a playlist imediatamente.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {(
            [
              ["MANUAL", "Somente manual", "Só muda quando você iniciar uma geração."],
              [
                "KEEP_FILLED",
                "Manter playlist completa",
                "Preserva o que ainda vale, remove o que deixou de valer e completa apenas o déficit.",
              ],
              [
                "REBUILD_DAILY",
                "Refazer diariamente",
                "Planeja do zero e substitui a playlist somente depois dos gates de segurança.",
              ],
            ] as const
          ).map(([value, title, description]) => (
            <label key={value} className={optionClass(updatePolicy === value)}>
              <input
                type="radio"
                name="updatePolicy"
                value={value}
                checked={updatePolicy === value}
                onChange={() => setUpdatePolicy(value)}
                className="sr-only"
              />
              <span className="block font-black text-ink-inverse">{title}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                {description}
              </span>
            </label>
          ))}
        </div>

        {updatePolicy !== "MANUAL" && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className={fieldLabelClass}>
              Horário diário
              <input
                className={inputClass}
                type="time"
                name="dailyScheduleTime"
                required
                defaultValue={initial.dailyScheduleTime || "04:30"}
              />
              <span className={helperClass}>
                Se o dispatcher perder o minuto exato, o Sonoriza ainda executa o slot pendente no mesmo dia.
              </span>
            </label>
            <label className={fieldLabelClass}>
              Fuso horário
              <input
                className={inputClass}
                name="scheduleTimezone"
                required
                value={scheduleTimezone}
                onChange={(event) => setScheduleTimezone(event.target.value)}
                placeholder="America/Sao_Paulo"
              />
              <span className={helperClass}>
                Use um fuso IANA. O navegador preenche automaticamente quando possível.
              </span>
            </label>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="text-sm font-black text-ink-inverse">Como definir a duração?</legend>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className={optionClass(durationMode === "FIXED")}>
            <input
              type="radio"
              name="durationMode"
              value="FIXED"
              checked={durationMode === "FIXED"}
              onChange={() => {
                setDurationMode("FIXED");
                if (podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT") {
                  setPodcastEpisodeMaxDurationMode("NONE");
                }
              }}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Duração fixa</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/70">
              Ex.: montar sempre cerca de 45 minutos ou 8 horas de conteúdo.
            </span>
          </label>

          <label className={optionClass(durationMode === "CALENDAR")}>
            <input
              type="radio"
              name="durationMode"
              value="CALENDAR"
              checked={durationMode === "CALENDAR"}
              onChange={() => setDurationMode("CALENDAR")}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Baseada no calendário</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/70">
              Cada playlist pode usar uma ou várias agendas, ou acompanhar automaticamente todas as agendas consultáveis.
            </span>
          </label>
        </div>
      </fieldset>

      {durationMode === "FIXED" ? (
        <label className={`block max-w-sm ${fieldLabelClass}`}>
          Duração em minutos
          <input
            className={inputClass}
            type="number"
            name="fixedDurationMinutes"
            min={1}
            max={1440}
            step={1}
            required
            defaultValue={initial.fixedDurationMinutes}
          />
          <span className={helperClass}>Entre 1 minuto e 24 horas.</span>
        </label>
      ) : (
        <div className="space-y-4">
          <fieldset className={sectionClass}>
            <legend className="px-1 text-sm font-black text-ink-inverse">
              Calendários desta playlist
            </legend>
            <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
              Escolha uma ou várias agendas, ou faça este destino acompanhar automaticamente todos os calendários marcados para consulta no CONFIG-01.
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className={optionClass(calendarMode === "SELECTED")}>
                <input
                  type="radio"
                  name="calendarMode"
                  value="SELECTED"
                  checked={calendarMode === "SELECTED"}
                  onChange={() => setCalendarMode("SELECTED")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Escolher calendários</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Use exatamente as agendas marcadas abaixo. Pode ser uma, três, cinco ou qualquer combinação.
                </span>
              </label>

              <label className={optionClass(calendarMode === "ALL_QUERYABLE")}>
                <input
                  type="radio"
                  name="calendarMode"
                  value="ALL_QUERYABLE"
                  checked={calendarMode === "ALL_QUERYABLE"}
                  onChange={() => setCalendarMode("ALL_QUERYABLE")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Todos os calendários consultáveis</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  É dinâmico: se uma nova agenda for marcada para consulta depois, ela passa a entrar automaticamente neste destino.
                </span>
              </label>
            </div>

            {calendarMode === "SELECTED" && (
              <div className="mt-4">
                {calendarOptions.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {calendarOptions.map((calendar) => {
                      const checked = selectedCalendarIds.includes(calendar.id);
                      return (
                        <label
                          key={calendar.id}
                          className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm font-bold transition ${
                            checked ? optionActiveClass : optionIdleClass
                          }`}
                        >
                          <input
                            type="checkbox"
                            name="calendarSelectionIds"
                            value={calendar.id}
                            checked={checked}
                            onChange={(event) =>
                              setSelectedCalendarIds((current) =>
                                event.target.checked
                                  ? [...new Set([...current, calendar.id])]
                                  : current.filter((id) => id !== calendar.id),
                              )
                            }
                            className="h-4 w-4 shrink-0 accent-accent"
                          />
                          <span>{calendar.name}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="status-warning flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold leading-5">
                    <UiIcon name="warning" size={16} className="mt-0.5 shrink-0" />
                    Nenhum calendário está marcado para consulta no CONFIG-01.
                  </p>
                )}
                <p className="mt-2 text-xs leading-5 text-muted-inverse/65">
                  {selectedCalendarIds.length === 0
                    ? "Selecione pelo menos um calendário."
                    : `${selectedCalendarIds.length} calendário${selectedCalendarIds.length === 1 ? "" : "s"} selecionado${selectedCalendarIds.length === 1 ? "" : "s"}.`}
                </p>
              </div>
            )}

            {calendarMode === "ALL_QUERYABLE" && (
              <p className="status-info mt-4 rounded-xl border p-3 text-xs font-semibold leading-5">
                Este destino usará {calendarOptions.length === 1 ? "o calendário atualmente consultável" : `todos os ${calendarOptions.length} calendários atualmente consultáveis`}. A lista acompanha o CONFIG-01 automaticamente.
              </p>
            )}

            {initial.allowLegacyCalendar && (
              <label className={`mt-4 block ${optionClass(calendarMode === "LEGACY_GLOBAL")}`}>
                <input
                  type="radio"
                  name="calendarMode"
                  value="LEGACY_GLOBAL"
                  checked={calendarMode === "LEGACY_GLOBAL"}
                  onChange={() => setCalendarMode("LEGACY_GLOBAL")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Compatibilidade temporária (legado)</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Mantém o conjunto global antigo somente até este destino ser migrado. Depois de salvar como seleção própria ou “Todos”, esta opção não volta.
                </span>
              </label>
            )}
          </fieldset>

          {initial.allowLegacyCalendar && calendarMode === "LEGACY_GLOBAL" && (
            <div
              className={`${sectionClass} ${
                durationCalendarNames.length > 0 ? "" : "status-warning"
              }`}
            >
              <p className="text-sm font-black text-ink-inverse">
                Calendários globais usados por este destino legado
              </p>
              {durationCalendarNames.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {durationCalendarNames.map((name) => (
                    <span key={name} className="product-badge">
                      {name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 flex items-start gap-2 text-xs font-semibold leading-5">
                  <UiIcon name="warning" size={16} className="mt-0.5 shrink-0" />
                  <span>
                    Nenhum calendário global está marcado para duração no CONFIG-01. Migre este destino para uma seleção própria.
                  </span>
                </p>
              )}
            </div>
          )}

          <fieldset className={sectionClass}>
            <legend className="px-1 text-sm font-black text-ink-inverse">
              Como usar a duração dos eventos
            </legend>

            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <label
                className={optionClass(
                  calendarDurationStrategy === "SUMMED",
                )}
              >
                <input
                  type="radio"
                  name="calendarDurationStrategy"
                  value="SUMMED"
                  checked={
                    calendarDurationStrategy === "SUMMED"
                  }
                  onChange={() =>
                    setCalendarDurationStrategy("SUMMED")
                  }
                  className="mr-2 accent-accent"
                />

                <span className="font-black text-ink-inverse">
                  Somar duração dos eventos
                </span>

                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Comportamento atual: por exemplo,
                  35 min + 36 min formam um orçamento
                  único de 71 min.
                </span>
              </label>

              <label
                className={optionClass(
                  calendarDurationStrategy === "PER_EVENT",
                )}
              >
                <input
                  type="radio"
                  name="calendarDurationStrategy"
                  value="PER_EVENT"
                  checked={
                    calendarDurationStrategy === "PER_EVENT"
                  }
                  onChange={() =>
                    setCalendarDurationStrategy("PER_EVENT")
                  }
                  className="mr-2 accent-accent"
                />

                <span className="font-black text-ink-inverse">
                  Restringir duração por evento
                </span>

                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Cada evento vira um bloco independente.
                  Um item nunca usa minutos disponíveis
                  no evento seguinte.
                </span>
              </label>
            </div>
          </fieldset>

          <fieldset className={sectionClass}>
            <legend className="px-1 text-sm font-black text-ink-inverse">Eventos usados no cálculo</legend>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <label className={optionClass(calendarEventFilterMode === "ALL")}>
                <input
                  type="radio"
                  name="calendarEventFilterMode"
                  value="ALL"
                  checked={calendarEventFilterMode === "ALL"}
                  onChange={() => setCalendarEventFilterMode("ALL")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Todos os eventos</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Preserva o comportamento atual: todo evento com horário entra na soma.
                </span>
              </label>

              <label className={optionClass(calendarEventFilterMode === "MARKER")}>
                <input
                  type="radio"
                  name="calendarEventFilterMode"
                  value="MARKER"
                  checked={calendarEventFilterMode === "MARKER"}
                  onChange={() => setCalendarEventFilterMode("MARKER")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Somente com marcador</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Use qualquer marcador que faça sentido para o calendário; por exemplo, #travel.
                </span>
              </label>
            </div>

            {calendarEventFilterMode === "MARKER" && (
              <label className={`mt-4 block max-w-sm ${fieldLabelClass}`}>
                Marcador do evento
                <input
                  className={inputClass}
                  name="calendarEventMarker"
                  required
                  maxLength={80}
                  defaultValue={initial.calendarEventMarker}
                  placeholder="#travel"
                />
                <span className={helperClass}>
                  O Sonoriza procura o marcador no título e na descrição, sem diferenciar maiúsculas de minúsculas. A duração do próprio evento entra no cálculo.
                </span>
              </label>
            )}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-black text-ink-inverse">Se nenhum evento elegível for encontrado</legend>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {(
                [
                  ["KEEP", "Manter playlist", "Não troca o conteúdo que já está no Spotify."],
                  ["CLEAR", "Esvaziar playlist", "Deixa a playlist sem itens para este dia."],
                  ["SKIP", "Não tocar na playlist", "Ignora este destino nesta execução."],
                ] as const
              ).map(([value, title, description]) => (
                <label key={value} className={optionClass(initial.emptyCalendarBehavior === value)}>
                  <input
                    type="radio"
                    name="emptyCalendarBehavior"
                    value={value}
                    defaultChecked={initial.emptyCalendarBehavior === value}
                    className="mr-2 accent-accent"
                  />
                  <span className="font-black text-ink-inverse">{title}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                    {description}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      <fieldset>
        <legend className="text-sm font-black text-ink-inverse">Como você quer montar esta playlist?</legend>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className={optionClass(compositionMode === "PROPORTION")}>
            <input
              type="radio"
              name="compositionMode"
              value="PROPORTION"
              checked={compositionMode === "PROPORTION"}
              onChange={() => setCompositionMode("PROPORTION")}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Por proporção de tempo</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/70">
              Defina quanto do tempo deve ser podcast e música. O Sonoriza decide a intercalação para se aproximar dessa meta.
            </span>
          </label>
          <label className={optionClass(compositionMode === "SEQUENCE")}>
            <input
              type="radio"
              name="compositionMode"
              value="SEQUENCE"
              checked={compositionMode === "SEQUENCE"}
              onChange={() => setCompositionMode("SEQUENCE")}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Por sequência</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/70">
              Repita uma ordem fixa. O percentual final será consequência da duração real dos itens, não uma segunda regra.
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Ordem das músicas
        </legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          A seleção continua a mesma. Esta opção muda apenas qual música ocupa cada slot de música; podcasts e a sequência de tipos não são alterados.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className={optionClass(musicOrderMode === "STANDARD")}>
            <input
              type="radio"
              name="musicOrderMode"
              value="STANDARD"
              checked={musicOrderMode === "STANDARD"}
              onChange={() => setMusicOrderMode("STANDARD")}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Ordem padrão</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
              Mantém a ordem musical produzida pelo planner.
            </span>
          </label>
          <label className={optionClass(musicOrderMode === "RANDOMIZED")}>
            <input
              type="radio"
              name="musicOrderMode"
              value="RANDOMIZED"
              checked={musicOrderMode === "RANDOMIZED"}
              onChange={() => setMusicOrderMode("RANDOMIZED")}
              className="sr-only"
            />
            <span className="block font-black text-ink-inverse">Randomizar músicas</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
              Cada execução recebe um seed auditável e pode produzir uma nova ordem, sem depender do Shuffle do Spotify.
            </span>
          </label>
        </div>
      </fieldset>


      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Diversidade das músicas
        </legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          Limite quantas músicas do mesmo artista principal ou do mesmo álbum podem entrar neste destino. As regras são combinadas quando ambas estão ativas.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className={optionClass(artistDiversityEnabled)}>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                name="limitTracksPerArtist"
                checked={artistDiversityEnabled}
                onChange={(event) => setArtistDiversityEnabled(event.target.checked)}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span>
                <span className="block font-black text-ink-inverse">
                  Limitar músicas do mesmo artista
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Considera o artista principal informado pelo Spotify.
                </span>
              </span>
            </label>
            <label className={`mt-3 block ${fieldLabelClass}`}>
              Máximo por artista
              <input
                className={inputClass}
                type="number"
                name="maxTracksPerArtist"
                min={1}
                max={50}
                step={1}
                required={artistDiversityEnabled}
                disabled={!artistDiversityEnabled}
                defaultValue={initial.maxTracksPerArtist ?? 1}
              />
            </label>
          </div>

          <div className={optionClass(albumDiversityEnabled)}>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                name="limitTracksPerAlbum"
                checked={albumDiversityEnabled}
                onChange={(event) => setAlbumDiversityEnabled(event.target.checked)}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span>
                <span className="block font-black text-ink-inverse">
                  Limitar músicas do mesmo álbum
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Usa o ID do álbum no Spotify, não apenas o nome.
                </span>
              </span>
            </label>
            <label className={`mt-3 block ${fieldLabelClass}`}>
              Máximo por álbum
              <input
                className={inputClass}
                type="number"
                name="maxTracksPerAlbum"
                min={1}
                max={50}
                step={1}
                required={albumDiversityEnabled}
                disabled={!albumDiversityEnabled}
                defaultValue={initial.maxTracksPerAlbum ?? 1}
              />
            </label>
          </div>
        </div>

        {(artistDiversityEnabled || albumDiversityEnabled) && (
          <p className="status-info mt-4 rounded-xl border p-3 text-xs font-semibold leading-5">
            {artistDiversityEnabled && albumDiversityEnabled
              ? "As duas regras precisam ser atendidas ao mesmo tempo. Ex.: 2 por artista + 1 por álbum permite duas músicas do mesmo artista somente se vierem de álbuns diferentes."
              : artistDiversityEnabled
                ? "O Sonoriza nunca ultrapassa o limite por artista para completar duração ou sequência."
                : "O Sonoriza nunca ultrapassa o limite por álbum para completar duração ou sequência."}
          </p>
        )}
      </fieldset>

      {compositionMode === "PROPORTION" && (
        <div className={sectionClass}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-black text-ink-inverse">Mistura de conteúdo</p>
              <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
                A proporção é um objetivo de duração. Se faltar conteúdo de um tipo, o motor pode completar com o outro.
              </p>
            </div>
            <span className="product-badge border-accent/30 bg-accent/10 text-accent-400">
              {podcastPercent}% podcast / {musicPercent}% música
            </span>
          </div>

          <input
            id={`${idPrefix}-podcast-percent`}
            className="mt-5 w-full accent-accent"
            type="range"
            min={0}
            max={100}
            step={5}
            value={podcastPercent}
            onChange={(event) => setPodcastPercent(Number(event.target.value))}
          />
          <div className="mt-1 flex justify-between text-xs font-bold text-muted-inverse/55">
            <span>Só música</span>
            <span>Equilibrado</span>
            <span>Só podcast</span>
          </div>
        </div>
      )}

      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Duração máxima por episódio de podcast
        </legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          O limite compara o tempo efetivo que ainda será ouvido. Um episódio longo parcialmente ouvido pode entrar se o tempo restante couber no limite.
        </p>

        <div className={`mt-4 grid gap-3 ${durationMode === "CALENDAR" ? "lg:grid-cols-3" : "md:grid-cols-2"}`}>
          <label className={optionClass(podcastEpisodeMaxDurationMode === "NONE")}>
            <input
              type="radio"
              name="podcastEpisodeMaxDurationMode"
              value="NONE"
              checked={podcastEpisodeMaxDurationMode === "NONE"}
              onChange={() => setPodcastEpisodeMaxDurationMode("NONE")}
              className="mr-2 accent-accent"
            />
            <span className="font-black text-ink-inverse">Sem limite</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
              Preserva o comportamento atual: qualquer duração continua elegível.
            </span>
          </label>

          <label className={optionClass(podcastEpisodeMaxDurationMode === "FIXED")}>
            <input
              type="radio"
              name="podcastEpisodeMaxDurationMode"
              value="FIXED"
              checked={podcastEpisodeMaxDurationMode === "FIXED"}
              onChange={() => setPodcastEpisodeMaxDurationMode("FIXED")}
              className="mr-2 accent-accent"
            />
            <span className="font-black text-ink-inverse">Limite fixo</span>
            <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
              Define o máximo permitido em minutos para cada episódio.
            </span>
          </label>

          {durationMode === "CALENDAR" && (
            <label className={optionClass(podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT")}>
              <input
                type="radio"
                name="podcastEpisodeMaxDurationMode"
                value="CALENDAR_MAX_EVENT"
                checked={podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT"}
                onChange={() => setPodcastEpisodeMaxDurationMode("CALENDAR_MAX_EVENT")}
                className="mr-2 accent-accent"
              />
              <span className="font-black text-ink-inverse">Maior evento do calendário</span>
              <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                Usa a maior duração individual entre os mesmos eventos elegíveis do cálculo; não usa a soma do dia.
              </span>
            </label>
          )}
        </div>

        {podcastEpisodeMaxDurationMode === "FIXED" && (
          <label className={`mt-4 block max-w-sm ${fieldLabelClass}`}>
            Máximo por episódio, em minutos
            <input
              className={inputClass}
              type="number"
              name="podcastEpisodeMaxDurationMinutes"
              min={1}
              max={1440}
              step={1}
              required
              defaultValue={initial.podcastEpisodeMaxDurationMinutes}
            />
            <span className={helperClass}>
              Entre 1 minuto e 24 horas, comparado ao tempo efetivo/restante do episódio.
            </span>
          </label>
        )}

        {podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT" && (
          <p className="status-info mt-4 rounded-xl border p-3 text-xs font-semibold leading-5">
            Se não houver evento elegível, o Sonoriza segue a regra configurada para calendário vazio e não inventa um limite de episódio.
          </p>
        )}
      </fieldset>

      {compositionMode === "SEQUENCE" && (
        <div className={sectionClass}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-black text-ink-inverse">Ordem Música / Podcast</p>
              <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
                O padrão abaixo se repete até atingir a duração desejada. Use os controles para reorganizar.
              </p>
            </div>
            <span className="text-xs font-bold text-muted-inverse/60">{sequence.length}/20 passos</span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {sequence.map((type, index) => (
              <div
                key={`${type}-${index}`}
                className={`flex items-center gap-1 rounded-xl border px-2 py-1.5 ${
                  type === "MUSIC"
                    ? "border-brand-400/35 bg-brand/15 text-ink-inverse"
                    : "border-accent/35 bg-accent/10 text-accent-400"
                }`}
              >
                <span className="px-1 text-xs font-black">{contentLabel(type)}</span>
                <button
                  type="button"
                  aria-label={`Mover ${contentLabel(type)} para a esquerda`}
                  disabled={index === 0}
                  onClick={() => moveSequence(index, -1)}
                  className="rounded p-1.5 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <UiIcon name="arrow-left" size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Mover ${contentLabel(type)} para a direita`}
                  disabled={index === sequence.length - 1}
                  onClick={() => moveSequence(index, 1)}
                  className="rounded p-1.5 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <UiIcon name="arrow-right" size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Remover ${contentLabel(type)}`}
                  disabled={sequence.length === 1}
                  onClick={() => removeSequence(index)}
                  className="rounded p-1.5 transition hover:bg-danger/15 hover:text-danger disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <UiIcon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={sequence.length >= 20}
              onClick={() => addSequence("MUSIC")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-brand-400/30 bg-brand/10 px-3 py-2 text-xs font-black text-ink-inverse transition hover:bg-brand/20 disabled:opacity-40"
            >
              <UiIcon name="plus" size={15} />
              Música
            </button>
            <button
              type="button"
              disabled={sequence.length >= 20}
              onClick={() => addSequence("PODCAST")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-black text-accent-400 transition hover:bg-accent/15 disabled:opacity-40"
            >
              <UiIcon name="plus" size={15} />
              Podcast
            </button>
          </div>
        </div>
      )}

      <label className={`block max-w-sm ${fieldLabelClass}`}>
        Máximo de episódios do mesmo programa
        <input
          className={inputClass}
          type="number"
          name="maxEpisodesPerProgram"
          min={1}
          max={50}
          step={1}
          required
          defaultValue={initial.maxEpisodesPerProgram}
        />
        <span className={helperClass}>Evita que um único podcast domine a playlist.</span>
      </label>

      <div className="flex flex-col gap-3 border-t border-line-dark/50 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-xs leading-5 text-muted-inverse/65">
          Salvar estas regras não inicia geração nem simulação. Se você escolher “Criar uma nova playlist”, o Sonoriza cria somente a playlist vazia no Spotify e guarda o vínculo.
        </p>
        <button
          type="submit"
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:-translate-y-0.5 hover:bg-accent-400"
        >
          <UiIcon name="check" size={18} strokeWidth={2.25} />
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
