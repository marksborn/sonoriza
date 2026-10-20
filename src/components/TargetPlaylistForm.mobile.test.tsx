import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TargetPlaylistForm } from "./TargetPlaylistForm";

type Props = Parameters<typeof TargetPlaylistForm>[0];

const base: Props = {
  initial: {
    id: "test-target",
    name: "Trabalho",
    enabled: true,
    sourceScopeMode: "INHERIT_GLOBAL",
    sourceSelectionIds: [],
    sharingPolicy: "INHERIT_GLOBAL",
    durationMode: "FIXED",
    fixedDurationMinutes: 45,
    calendarMode: "SELECTED",
    calendarSelectionIds: [],
    allowLegacyCalendar: false,
    emptyCalendarBehavior: "KEEP",
    calendarEventFilterMode: "ALL",
    calendarEventMarker: "",
    calendarDurationStrategy: "SUMMED",
    compositionMode: "SEQUENCE",
    musicOrderMode: "STANDARD",
    podcastPercent: 50,
    podcastEpisodeMaxDurationMode: "NONE",
    podcastEpisodeMaxDurationMinutes: 45,
    sequencePattern: ["MUSIC", "PODCAST", "MUSIC"],
    podcastDurationSlotBands: ["ANY", "ANY", "ANY"],
    maxEpisodesPerProgram: 1,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
    updatePolicy: "MANUAL",
    dailyScheduleTime: "07:00",
    scheduleTimezone: "America/Sao_Paulo",
    destinationValue: "__KEEP__",
  },
  spotifyOptions: [],
  durationCalendarNames: [],
  calendarOptions: [],
  sourceOptions: [],
  globalSharingPolicy: "EXCLUSIVE",
  durationBandEditingEnabled: false,
  saveAction: () => {},
  submitLabel: "Salvar alterações",
};

function render(durationBandEditingEnabled = false) {
  return renderToStaticMarkup(
    <TargetPlaylistForm {...base} durationBandEditingEnabled={durationBandEditingEnabled} />,
  );
}

test("#448: sequence slots use a full-width stacked mobile layout and compact desktop rows", () => {
  const html = render();
  assert.match(html, /flex w-full min-w-0 flex-col gap-2 rounded-xl border/);
  assert.match(html, /sm:w-auto sm:flex-row sm:items-center/);
  assert.match(html, /flex shrink-0 items-center justify-end gap-1 self-end sm:self-auto/);
  assert.match(html, /w-full min-w-0 max-w-full rounded-lg border/);
  assert.match(html, /inline-flex size-11 shrink-0 items-center justify-center/);
  assert.match(html, /sm:size-8/);
  assert.match(html, /focus-visible:outline/);
});

test("#448: each move/remove action identifies its sequence position", () => {
  const html = render();
  for (const action of [
    "Mover Podcast do passo 2 para a esquerda",
    "Mover Podcast do passo 2 para a direita",
    "Remover Podcast do passo 2",
  ]) {
    assert.ok(html.includes(`aria-label="${action}"`), action);
  }
});

test("#448: band selector stays disabled when the pilot flag is OFF", () => {
  const html = render();
  const select = html.match(/<select\b[^>]*aria-label="Duração do podcast no passo 2"[^>]*>/)?.[0];
  assert.ok(select, "expected a labeled podcast band selector");
  assert.match(select, /\sdisabled(?:="")?(?=\s|>)/);
  assert.match(html, /Faixas específicas em preparação/);
  assert.match(html, /name="sequencePattern"[^>]*value="\[&quot;MUSIC&quot;/);
  assert.match(html, /name="podcastDurationSlotBands"[^>]*value="\[&quot;ANY&quot;/);
});

test("#448: enabling the band editor changes only the selector admission, not the responsive structure", () => {
  const html = render(true);
  const select = html.match(/<select\b[^>]*aria-label="Duração do podcast no passo 2"[^>]*>/)?.[0];
  assert.ok(select);
  assert.doesNotMatch(select, /\sdisabled(?:="")?(?=\s|>)/);
  assert.match(html, /flex w-full min-w-0 flex-col gap-2 rounded-xl border/);
  assert.match(html, /sm:w-auto sm:flex-row/);
});
