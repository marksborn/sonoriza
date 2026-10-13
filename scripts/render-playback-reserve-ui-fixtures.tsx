/**
 * B1.7 — standalone offline visual preview of the REAL Reserve consent component.
 * All scenarios use invented data; no DB, OAuth, NextAuth, Spotify or requests.
 * Preview buttons are intentionally prevented from submitting by CSP.
 *
 * Requires a sibling app.css generated from src/app/globals.css.
 * Usage: npx tsx scripts/render-playback-reserve-ui-fixtures.tsx /tmp/b17-preview
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlaybackReserveTargetConsentForm } from "../src/components/PlaybackReserveTargetConsentForm";

type Fixture = Parameters<typeof PlaybackReserveTargetConsentForm>[0];
const confirmedAt = new Date("2026-10-13T12:00:00.000Z");
const base: Fixture = {
  targetPlaylistId: "fixture-only-target",
  enabled: true,
  spotifyPlaylistId: "fixture-only-spotify",
  updatePolicy: "REBUILD_DAILY",
  reserveMode: "MUSIC_TRACKS",
  activation: { enabled: false, confirmedAt: null },
  productAuthorizationEnabled: false,
  action: "#",
};
const cases: Array<Readonly<{ title: string; description: string; changes: Partial<Fixture> }>> = [
  {
    title: "1. REBUILD_DAILY — destino elegível",
    description: "Autorização disponível. Gate técnico permanece desligado.",
    changes: {},
  },
  {
    title: "2. KEEP_FILLED — destino elegível",
    description: "Outra política de manutenção aceita pela mesma regra.",
    changes: { updatePolicy: "KEEP_FILLED", reserveMode: "DURATION" },
  },
  {
    title: "3. Sem reserva — opt-in indisponível",
    description: "O usuário deve ver uma instrução para ajustar a regra.",
    changes: { reserveMode: "NONE" },
  },
  {
    title: "4. Destino MANUAL — opt-in indisponível",
    description: "A regra de atualização exige KEEP_FILLED ou REBUILD_DAILY.",
    changes: { updatePolicy: "MANUAL" },
  },
  {
    title: "5. Destino desvinculado — opt-in indisponível",
    description: "Não pode haver nova autorização sem playlist Spotify.",
    changes: { spotifyPlaylistId: null },
  },
  {
    title: "6. Autorização salva, rollout técnico OFF",
    description: "A tela não deve afirmar que a Reserva já está publicada.",
    changes: {
      activation: { enabled: true, confirmedAt },
      productAuthorizationEnabled: false,
    },
  },
  {
    title: "7. Autorização salva, rollout técnico ACTIVE",
    description: "Mesmo assim a interface exige simulação aprovada antes de geração real.",
    changes: {
      activation: { enabled: true, confirmedAt },
      productAuthorizationEnabled: true,
    },
  },
  {
    title: "8. Destino desativado após opt-in",
    description: "Revogar autorização deve continuar disponível.",
    changes: {
      enabled: false,
      activation: { enabled: true, confirmedAt },
    },
  },
];

const dest = process.argv[2];
if (!dest) throw new Error("Missing destination directory; do not write to the production app.");
const dir = resolve(dest);
mkdirSync(dir, { recursive: true });
const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; form-action 'none'; base-uri 'none';">
<title>Sonoriza B1.7 — pré-visualização OFFLINE</title>
<link rel="stylesheet" href="./app.css">
</head>
<body>
<main class="product-shell px-5 py-8 sm:px-8 lg:px-10">
<div class="product-ambient"></div>
<div class="relative mx-auto max-w-5xl">
<p class="text-xs font-black uppercase tracking-widest text-accent-400">PLAYBACK-RESERVE-01 · Gate B1.7 · DADOS FICTÍCIOS</p>
<h1 class="mt-3 text-3xl font-black text-ink-inverse sm:text-4xl">Autorização de Reserva por destino</h1>
<p class="mt-3 max-w-3xl text-sm leading-6 text-muted-inverse">Preview estático OFFLINE do componente real. Este arquivo não contém login, back-end, Spotify ou gravação de preferências. Os formulários estão bloqueados por CSP. Não equivale a homologar a página completa em navegador autenticado.</p>
<div class="mt-7 space-y-6">
${cases.map(({ title, description, changes }) => `<article class="product-panel p-5 sm:p-6">
<h2 class="text-lg font-black text-ink-inverse">${title}</h2>
<p class="mt-2 text-sm text-muted-inverse">${description}</p>
${renderToStaticMarkup(<PlaybackReserveTargetConsentForm {...base} {...changes} />)}
</article>`).join("\n")}
</div>
</div>
</main>
</body>
</html>
`;
writeFileSync(resolve(dir, "index.html"), html, "utf8");
writeFileSync(resolve(dir, "LEIA-ME.txt"), `Sonoriza B1.7 — preview OFFLINE do componente de autorização.
Abrir index.html com app.css na mesma pasta, sem servidor web.
Dados são fictícios. Botões são inertes. Nenhuma credencial e nenhuma conexão externa.
Testar zoom 100% e viewports 1440, 1024, 390 e 320 px.
Avaliar foco, contraste, corte de texto, rolagem horizontal e cliques desabilitados.
Esta prévia não representa a página Next.js completa, sessão, server actions ou testes E2E.
`, "utf8");
process.stdout.write(`B1.7 fixture preview created: ${cases.length} fictitious states, no network, no real data.\n`);
