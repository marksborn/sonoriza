"use client";

import { useState } from "react";

type ContentType = "MUSIC" | "PODCAST";
type DurationMode = "FIXED" | "CALENDAR";
type EmptyCalendarBehavior = "CLEAR" | "KEEP" | "SKIP";
type CalendarEventFilterMode = "ALL" | "MARKER";
type PodcastEpisodeMaxDurationMode = "NONE" | "FIXED" | "CALENDAR_MAX_EVENT";

export type SpotifyDestinationOption = {
  id: string;
  name: string;
};

export type TargetPlaylistFormInitial = {
  id?: string;
  name: string;
  enabled: boolean;
  durationMode: DurationMode;
  fixedDurationMinutes: number;
  emptyCalendarBehavior: EmptyCalendarBehavior;
  calendarEventFilterMode: CalendarEventFilterMode;
  calendarEventMarker: string;
  podcastPercent: number;
  podcastEpisodeMaxDurationMode: PodcastEpisodeMaxDurationMode;
  podcastEpisodeMaxDurationMinutes: number;
  sequencePattern: ContentType[];
  maxEpisodesPerProgram: number;
  destinationValue: string;
  currentSpotifyName?: string;
  destinationUnavailable?: boolean;
};

type TargetPlaylistFormProps = {
  initial: TargetPlaylistFormInitial;
  spotifyOptions: SpotifyDestinationOption[];
  durationCalendarNames: string[];
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
  "mt-2 w-full rounded-xl border border-violet-400/25 bg-[#12052d] px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-violet-300/35 focus:border-orange-400/55 focus:ring-2 focus:ring-orange-400/10";

function contentLabel(type: ContentType) {
  return type === "MUSIC" ? "Música" : "Podcast";
}

export function TargetPlaylistForm({
  initial,
  spotifyOptions,
  durationCalendarNames,
  saveAction,
  submitLabel,
}: TargetPlaylistFormProps) {
  const [durationMode, setDurationMode] = useState<DurationMode>(initial.durationMode);
  const [calendarEventFilterMode, setCalendarEventFilterMode] =
    useState<CalendarEventFilterMode>(initial.calendarEventFilterMode);
  const [podcastPercent, setPodcastPercent] = useState(initial.podcastPercent);
  const [podcastEpisodeMaxDurationMode, setPodcastEpisodeMaxDurationMode] =
    useState<PodcastEpisodeMaxDurationMode>(initial.podcastEpisodeMaxDurationMode);
  const [sequence, setSequence] = useState<ContentType[]>(
    initial.sequencePattern.length > 0 ? initial.sequencePattern : DEFAULT_SEQUENCE,
  );

  const musicPercent = 100 - podcastPercent;
  const idPrefix = initial.id ?? "new-target";

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

      <div className="grid gap-5 md:grid-cols-2">
        <label className="text-sm font-bold text-violet-100">
          Nome no Sonoriza
          <input
            className={inputClass}
            name="name"
            required
            maxLength={100}
            defaultValue={initial.name}
            placeholder="Ex.: Carro, Trabalho, Academia"
          />
          <span className="mt-1.5 block text-xs font-normal leading-5 text-violet-300/55">
            É o nome que aparece no painel. Ao criar uma nova playlist no Spotify, este nome também será usado lá.
          </span>
        </label>

        <label className="text-sm font-bold text-violet-100">
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
          <span className="mt-1.5 block text-xs font-normal leading-5 text-violet-300/55">
            O Sonoriza não pede IDs. Playlists usadas como fonte ou já ligadas a outro destino ficam fora desta lista.
          </span>
          {initial.destinationUnavailable && (
            <span className="mt-2 block rounded-xl border border-orange-400/25 bg-orange-400/10 px-3 py-2 text-xs font-semibold leading-5 text-orange-200">
              A playlist atualmente vinculada não apareceu entre as playlists próprias da conta. Você pode manter a configuração, mas é recomendável substituí-la antes da próxima geração.
            </span>
          )}
        </label>
      </div>

      <label className="flex items-start gap-3 rounded-2xl border border-violet-400/20 bg-violet-950/35 p-4">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={initial.enabled}
          className="mt-1 h-4 w-4 accent-orange-500"
        />
        <span>
          <span className="block text-sm font-black text-white">Playlist ativa</span>
          <span className="mt-1 block text-xs leading-5 text-violet-300/60">
            Desativar mantém todas as regras salvas, mas tira este destino das próximas gerações.
          </span>
        </span>
      </label>

      <fieldset>
        <legend className="text-sm font-black text-white">Como definir a duração?</legend>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label
            className={`cursor-pointer rounded-2xl border p-4 transition ${
              durationMode === "FIXED"
                ? "border-orange-400/45 bg-orange-400/10"
                : "border-violet-400/20 bg-violet-950/30 hover:border-violet-300/35"
            }`}
          >
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
            <span className="block font-black text-white">Duração fixa</span>
            <span className="mt-1 block text-xs leading-5 text-violet-200/65">
              Ex.: montar sempre cerca de 45 minutos ou 8 horas de conteúdo.
            </span>
          </label>

          <label
            className={`cursor-pointer rounded-2xl border p-4 transition ${
              durationMode === "CALENDAR"
                ? "border-orange-400/45 bg-orange-400/10"
                : "border-violet-400/20 bg-violet-950/30 hover:border-violet-300/35"
            }`}
          >
            <input
              type="radio"
              name="durationMode"
              value="CALENDAR"
              checked={durationMode === "CALENDAR"}
              onChange={() => setDurationMode("CALENDAR")}
              className="sr-only"
            />
            <span className="block font-black text-white">Baseada no calendário</span>
            <span className="mt-1 block text-xs leading-5 text-violet-200/65">
              Soma a duração dos eventos elegíveis dos calendários habilitados no CONFIG-01.
            </span>
          </label>
        </div>
      </fieldset>

      {durationMode === "FIXED" ? (
        <label className="block max-w-sm text-sm font-bold text-violet-100">
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
          <span className="mt-1.5 block text-xs font-normal text-violet-300/55">
            Entre 1 minuto e 24 horas.
          </span>
        </label>
      ) : (
        <div className="space-y-4">
          <div
            className={`rounded-2xl border p-4 ${
              durationCalendarNames.length > 0
                ? "border-violet-400/20 bg-violet-950/35"
                : "border-orange-400/30 bg-orange-400/10"
            }`}
          >
            <p className="text-sm font-black text-white">Calendários usados na duração</p>
            {durationCalendarNames.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {durationCalendarNames.map((name) => (
                  <span
                    key={name}
                    className="rounded-full border border-violet-300/20 bg-violet-400/10 px-2.5 py-1 text-xs font-bold text-violet-200"
                  >
                    {name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs font-semibold leading-5 text-orange-200">
                Nenhum calendário está habilitado para duração. Configure isso no CONFIG-01 antes de salvar este modo.
              </p>
            )}
          </div>

          <fieldset className="rounded-2xl border border-violet-400/20 bg-violet-950/30 p-4">
            <legend className="px-1 text-sm font-black text-white">Eventos usados no cálculo</legend>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <label
                className={`cursor-pointer rounded-xl border p-3 transition ${
                  calendarEventFilterMode === "ALL"
                    ? "border-orange-400/40 bg-orange-400/10"
                    : "border-violet-400/20 bg-black/10 hover:border-violet-300/35"
                }`}
              >
                <input
                  type="radio"
                  name="calendarEventFilterMode"
                  value="ALL"
                  checked={calendarEventFilterMode === "ALL"}
                  onChange={() => setCalendarEventFilterMode("ALL")}
                  className="mr-2 accent-orange-500"
                />
                <span className="font-black text-white">Todos os eventos</span>
                <span className="mt-1 block text-xs leading-5 text-violet-200/60">
                  Preserva o comportamento atual: todo evento com horário entra na soma.
                </span>
              </label>

              <label
                className={`cursor-pointer rounded-xl border p-3 transition ${
                  calendarEventFilterMode === "MARKER"
                    ? "border-orange-400/40 bg-orange-400/10"
                    : "border-violet-400/20 bg-black/10 hover:border-violet-300/35"
                }`}
              >
                <input
                  type="radio"
                  name="calendarEventFilterMode"
                  value="MARKER"
                  checked={calendarEventFilterMode === "MARKER"}
                  onChange={() => setCalendarEventFilterMode("MARKER")}
                  className="mr-2 accent-orange-500"
                />
                <span className="font-black text-white">Somente com marcador</span>
                <span className="mt-1 block text-xs leading-5 text-violet-200/60">
                  Use qualquer marcador que faça sentido para o calendário; por exemplo, #travel.
                </span>
              </label>
            </div>

            {calendarEventFilterMode === "MARKER" && (
              <label className="mt-4 block max-w-sm text-sm font-bold text-violet-100">
                Marcador do evento
                <input
                  className={inputClass}
                  name="calendarEventMarker"
                  required
                  maxLength={80}
                  defaultValue={initial.calendarEventMarker}
                  placeholder="#travel"
                />
                <span className="mt-1.5 block text-xs font-normal leading-5 text-violet-300/55">
                  O Sonoriza procura o marcador no título e na descrição, sem diferenciar maiúsculas de minúsculas. A duração do próprio evento entra no cálculo.
                </span>
              </label>
            )}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-black text-white">Se nenhum evento elegível for encontrado</legend>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {(
                [
                  ["KEEP", "Manter playlist", "Não troca o conteúdo que já está no Spotify."],
                  ["CLEAR", "Esvaziar playlist", "Deixa a playlist sem itens para este dia."],
                  ["SKIP", "Não tocar na playlist", "Ignora este destino nesta execução."],
                ] as const
              ).map(([value, title, description]) => (
                <label
                  key={value}
                  className="cursor-pointer rounded-2xl border border-violet-400/20 bg-violet-950/30 p-4 transition hover:border-violet-300/35"
                >
                  <input
                    type="radio"
                    name="emptyCalendarBehavior"
                    value={value}
                    defaultChecked={initial.emptyCalendarBehavior === value}
                    className="mr-2 accent-orange-500"
                  />
                  <span className="font-black text-white">{title}</span>
                  <span className="mt-1 block text-xs leading-5 text-violet-200/60">
                    {description}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      <div className="rounded-2xl border border-violet-400/20 bg-violet-950/30 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-black text-white">Mistura de conteúdo</p>
            <p className="mt-1 text-xs leading-5 text-violet-200/60">
              A proporção é um objetivo de duração. Se faltar conteúdo de um tipo, o motor pode completar com o outro.
            </p>
          </div>
          <span className="w-fit rounded-full border border-orange-400/25 bg-orange-400/10 px-3 py-1.5 text-sm font-black text-orange-200">
            {podcastPercent}% podcast / {musicPercent}% música
          </span>
        </div>

        <input
          id={`${idPrefix}-podcast-percent`}
          className="mt-5 w-full accent-orange-500"
          type="range"
          name="podcastPercent"
          min={0}
          max={100}
          step={5}
          value={podcastPercent}
          onChange={(event) => setPodcastPercent(Number(event.target.value))}
        />
        <div className="mt-1 flex justify-between text-xs font-bold text-violet-300/50">
          <span>Só música</span>
          <span>Equilibrado</span>
          <span>Só podcast</span>
        </div>
      </div>

      <fieldset className="rounded-2xl border border-violet-400/20 bg-violet-950/30 p-4 sm:p-5">
        <legend className="px-1 text-sm font-black text-white">
          Duração máxima por episódio de podcast
        </legend>
        <p className="mt-1 text-xs leading-5 text-violet-200/60">
          O limite compara o tempo efetivo que ainda será ouvido. Um episódio longo parcialmente ouvido pode entrar se o tempo restante couber no limite.
        </p>

        <div className={`mt-4 grid gap-3 ${durationMode === "CALENDAR" ? "lg:grid-cols-3" : "md:grid-cols-2"}`}>
          <label
            className={`cursor-pointer rounded-xl border p-3 transition ${
              podcastEpisodeMaxDurationMode === "NONE"
                ? "border-orange-400/40 bg-orange-400/10"
                : "border-violet-400/20 bg-black/10 hover:border-violet-300/35"
            }`}
          >
            <input
              type="radio"
              name="podcastEpisodeMaxDurationMode"
              value="NONE"
              checked={podcastEpisodeMaxDurationMode === "NONE"}
              onChange={() => setPodcastEpisodeMaxDurationMode("NONE")}
              className="mr-2 accent-orange-500"
            />
            <span className="font-black text-white">Sem limite</span>
            <span className="mt-1 block text-xs leading-5 text-violet-200/60">
              Preserva o comportamento atual: qualquer duração continua elegível.
            </span>
          </label>

          <label
            className={`cursor-pointer rounded-xl border p-3 transition ${
              podcastEpisodeMaxDurationMode === "FIXED"
                ? "border-orange-400/40 bg-orange-400/10"
                : "border-violet-400/20 bg-black/10 hover:border-violet-300/35"
            }`}
          >
            <input
              type="radio"
              name="podcastEpisodeMaxDurationMode"
              value="FIXED"
              checked={podcastEpisodeMaxDurationMode === "FIXED"}
              onChange={() => setPodcastEpisodeMaxDurationMode("FIXED")}
              className="mr-2 accent-orange-500"
            />
            <span className="font-black text-white">Limite fixo</span>
            <span className="mt-1 block text-xs leading-5 text-violet-200/60">
              Define o máximo permitido em minutos para cada episódio.
            </span>
          </label>

          {durationMode === "CALENDAR" && (
            <label
              className={`cursor-pointer rounded-xl border p-3 transition ${
                podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT"
                  ? "border-orange-400/40 bg-orange-400/10"
                  : "border-violet-400/20 bg-black/10 hover:border-violet-300/35"
              }`}
            >
              <input
                type="radio"
                name="podcastEpisodeMaxDurationMode"
                value="CALENDAR_MAX_EVENT"
                checked={podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT"}
                onChange={() => setPodcastEpisodeMaxDurationMode("CALENDAR_MAX_EVENT")}
                className="mr-2 accent-orange-500"
              />
              <span className="font-black text-white">Maior evento do calendário</span>
              <span className="mt-1 block text-xs leading-5 text-violet-200/60">
                Usa a maior duração individual entre os mesmos eventos elegíveis do cálculo; não usa a soma do dia.
              </span>
            </label>
          )}
        </div>

        {podcastEpisodeMaxDurationMode === "FIXED" && (
          <label className="mt-4 block max-w-sm text-sm font-bold text-violet-100">
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
            <span className="mt-1.5 block text-xs font-normal leading-5 text-violet-300/55">
              Entre 1 minuto e 24 horas, comparado ao tempo efetivo/restante do episódio.
            </span>
          </label>
        )}

        {podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT" && (
          <p className="mt-4 rounded-xl border border-violet-300/15 bg-black/10 p-3 text-xs font-semibold leading-5 text-violet-200/70">
            Se não houver evento elegível, o Sonoriza segue a regra configurada para calendário vazio e não inventa um limite de episódio.
          </p>
        )}
      </fieldset>

      <div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-black text-white">Ordem Música / Podcast</p>
            <p className="mt-1 text-xs leading-5 text-violet-200/60">
              O padrão abaixo se repete até atingir a duração desejada. Use as setas para reorganizar.
            </p>
          </div>
          <span className="text-xs font-bold text-violet-300/55">{sequence.length}/20 passos</span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {sequence.map((type, index) => (
            <div
              key={`${type}-${index}`}
              className={`flex items-center gap-1 rounded-xl border px-2 py-1.5 ${
                type === "MUSIC"
                  ? "border-violet-300/25 bg-violet-500/15 text-violet-100"
                  : "border-orange-300/25 bg-orange-400/10 text-orange-100"
              }`}
            >
              <span className="px-1 text-xs font-black">{contentLabel(type)}</span>
              <button
                type="button"
                aria-label={`Mover ${contentLabel(type)} para a esquerda`}
                disabled={index === 0}
                onClick={() => moveSequence(index, -1)}
                className="rounded px-1.5 py-0.5 text-xs font-black transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-25"
              >
                ←
              </button>
              <button
                type="button"
                aria-label={`Mover ${contentLabel(type)} para a direita`}
                disabled={index === sequence.length - 1}
                onClick={() => moveSequence(index, 1)}
                className="rounded px-1.5 py-0.5 text-xs font-black transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-25"
              >
                →
              </button>
              <button
                type="button"
                aria-label={`Remover ${contentLabel(type)}`}
                disabled={sequence.length === 1}
                onClick={() => removeSequence(index)}
                className="rounded px-1.5 py-0.5 text-xs font-black transition hover:bg-red-400/15 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-25"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={sequence.length >= 20}
            onClick={() => addSequence("MUSIC")}
            className="rounded-xl border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-xs font-black text-violet-100 transition hover:bg-violet-500/20 disabled:opacity-40"
          >
            + Música
          </button>
          <button
            type="button"
            disabled={sequence.length >= 20}
            onClick={() => addSequence("PODCAST")}
            className="rounded-xl border border-orange-400/25 bg-orange-400/10 px-3 py-2 text-xs font-black text-orange-100 transition hover:bg-orange-400/20 disabled:opacity-40"
          >
            + Podcast
          </button>
        </div>
      </div>

      <label className="block max-w-sm text-sm font-bold text-violet-100">
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
        <span className="mt-1.5 block text-xs font-normal leading-5 text-violet-300/55">
          Evita que um único podcast domine a playlist.
        </span>
      </label>

      <div className="flex flex-col gap-3 border-t border-violet-400/15 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-xs leading-5 text-violet-300/55">
          Salvar estas regras não inicia geração nem simulação. Se você escolher “Criar uma nova playlist”, o Sonoriza cria somente a playlist vazia no Spotify e guarda o vínculo.
        </p>
        <button
          type="submit"
          className="shrink-0 rounded-xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-5 py-3 text-sm font-black text-white shadow-[0_16px_34px_-18px_rgba(255,107,0,0.95)] transition hover:-translate-y-0.5 hover:brightness-110"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
