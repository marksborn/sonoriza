import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlaybackReserveTargetConsentForm } from "./PlaybackReserveTargetConsentForm";

type Fixture = Parameters<typeof PlaybackReserveTargetConsentForm>[0];

const base: Fixture = {
  targetPlaylistId: "fixture-target-001",
  enabled: true,
  spotifyPlaylistId: "fictional-spotify-playlist",
  updatePolicy: "REBUILD_DAILY",
  reserveMode: "MUSIC_TRACKS",
  activation: { enabled: false, confirmedAt: null },
  productAuthorizationEnabled: false,
  action: "/fixture/never-submit",
};

function render(overrides: Partial<Fixture> = {}) {
  return renderToStaticMarkup(
    <PlaybackReserveTargetConsentForm {...base} {...overrides} />,
  );
}

// Match an actual boolean HTML attribute, not Tailwind "disabled:" classes.
const disabledAttribute = /\sdisabled(?:="")?(?=\s|>)/;

function submitButton(html: string) {
  const match = html.match(/<button\b[^>]*>/);
  assert.ok(match, "expected visible submit button");
  return match[0];
}

test("B1.7: eligible REBUILD_DAILY shows explicit opt-in; product flag OFF is explained", () => {
  const html = render();
  assert.match(html, /Permissão para usar a margem/);
  assert.match(html, /Você ainda não autorizou esta playlist/);
  assert.match(html, /Autorizar margem nesta playlist/);
  assert.doesNotMatch(submitButton(html), disabledAttribute);
  assert.match(html, /name="targetPlaylistId" value="fixture-target-001"/);
  assert.match(html, /name="activationAction" value="enable"/);
  assert.doesNotMatch(html, /Nenhuma ativação produtiva/);
});

test("B1.7: eligible KEEP_FILLED also accepts opt-in preference", () => {
  const html = render({ updatePolicy: "KEEP_FILLED", reserveMode: "DURATION" });
  assert.doesNotMatch(submitButton(html), disabledAttribute);
});

test("B1.7: no new opt-in on disabled, unlinked, MANUAL or NONE destinations", () => {
  for (const changes of [
    { enabled: false },
    { spotifyPlaylistId: null },
    { updatePolicy: "MANUAL" },
    { reserveMode: "NONE" as const },
  ]) {
    const html = render(changes);
    assert.match(submitButton(html), disabledAttribute, JSON.stringify(changes));
    assert.match(html, /Para autorizar: habilite e vincule o destino/);
    assert.match(html, /name="activationAction" value="enable"/);
  }
});

test("B1.7: consent with technical rollout OFF is visibly pending and can be revoked", () => {
  const html = render({
    activation: { enabled: true, confirmedAt: new Date("2026-10-13T12:00:00Z") },
    productAuthorizationEnabled: false,
  });
  assert.match(html, /Sua autorização foi salva, mas o sistema ainda não liberou o uso/);
  assert.match(html, /Essa autorização, sozinha, não altera a reprodução/);
  assert.match(html, /Revogar autorização/);
  assert.match(html, /name="activationAction" value="disable"/);
  assert.doesNotMatch(submitButton(html), disabledAttribute);
});

test("B1.7: technical rollout ACTIVE never claims real execution without simulation", () => {
  const html = render({
    activation: { enabled: true, confirmedAt: new Date("2026-10-13T12:00:00Z") },
    productAuthorizationEnabled: true,
  });
  assert.match(html, /depois de uma simulação aprovada/);
  assert.doesNotMatch(html, /Reserva ativada na playlist/);
});

test("B1.7: revocation remains operable if target is later disabled or delinked", () => {
  const html = render({
    enabled: false,
    spotifyPlaylistId: null,
    activation: { enabled: true, confirmedAt: new Date("2026-10-13T12:00:00Z") },
  });
  assert.match(html, /Revogar autorização/);
  assert.doesNotMatch(submitButton(html), disabledAttribute);
});

test("B1.7: target ID is HTML-escaped in the hidden input, no raw markup injection", () => {
  const html = render({ targetPlaylistId: 'fixture-\"><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;/);
  assert.match(html, /&lt;script&gt;/);
});

test("B1.7: all cases remain ordinary semantic HTML; no Spotify or network calls", () => {
  for (const current of [
    {},
    { reserveMode: "NONE" as const },
    { activation: { enabled: true, confirmedAt: new Date("2026-10-13T12:00:00Z") } },
  ]) {
    const html = render(current);
    assert.match(html, /<form\b[^>]*action="\/fixture\/never-submit"/);
    assert.match(html, /<button\b[^>]*type="submit"/);
    assert.doesNotMatch(html, /<iframe|<script|access_token|refresh_token/i);
  }
});
