import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = () =>
  readFileSync("src/app/dashboard/configuracao/fontes/podcasts/page.tsx", "utf8");
const clientSource = () =>
  readFileSync(
    "src/app/dashboard/configuracao/fontes/podcasts/podcast-policy-client.tsx",
    "utf8",
  );

test("Gate 6 keeps SAVED_EPISODES policy editing on the canonical podcasts page", () => {
  const page = pageSource();
  const client = clientSource();

  assert.match(page, /loadPodcastSavedEpisodesPolicy/);
  assert.match(page, /savePodcastSavedEpisodesPolicy/);
  assert.match(page, /updateSavedEpisodesPolicy/);
  assert.match(client, /Editar política/);
  assert.match(client, /Usar como política padrão de Seus episódios/);
  assert.match(client, /name="frequencyScope"/);
  assert.match(client, /value="PER_SHOW"/);
  assert.match(client, /value="GLOBAL_POOL"/);
  assert.match(client, /episódio\(s\) \/ semana/);
});

test("Gate 6 exposes the required SAVED_EPISODES order and random controls", () => {
  const client = clientSource();

  assert.match(client, /value="RANDOM">Aleatório/);
  assert.match(client, /value="OLDEST_FIRST">Mais antigos primeiro/);
  assert.match(client, /value="NEWEST_FIRST">Mais recentes primeiro/);
  assert.match(client, /value="WITHOUT_REPLACEMENT">Evitar repetir até percorrer a rodada/);
  assert.match(client, /value="WITH_REPLACEMENT">Permitir repetição/);
});

test("Gate 6 makes SHOW inheritance and episode scope explicit", () => {
  const page = pageSource();
  const client = clientSource();

  assert.match(page, /hasExplicitPolicy: show\.podcastShowPolicy !== null/);
  assert.match(page, /showEpisodeScope/);
  assert.match(client, /Herda Seus episódios/);
  assert.match(client, /Override próprio/);
  assert.match(client, /name="showEpisodeScope"/);
  assert.match(client, /value="ALL_EPISODES">Todos os episódios do programa/);
  assert.match(client, /value="SAVED_ONLY">Somente episódios salvos/);
});

test("Gate 6 save actions revalidate review so stale simulation state is visible", () => {
  const page = pageSource();

  assert.match(page, /revalidatePath\("\/dashboard\/configuracao\/revisao"\)/);
  assert.match(page, /A configuração mudou; faça uma nova simulação/);
});
