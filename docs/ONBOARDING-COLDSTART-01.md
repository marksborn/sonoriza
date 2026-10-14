# ONBOARDING-COLDSTART-01 — Primeira escuta sem histórico (#473)

**Estado em 14/10/2026:** Gate A iniciado em branch isolada; contrato puro e testes unitários. **Sem integração de UI, migrations, chamadas externas, escrita Spotify, geração real ou deploy.**

## Problema real

Usuário piloto com Spotify sem músicas curtidas, sem playlists, sem Last.fm e sem histórico. O onboarding #205 chega a `SOURCES` e exige ao menos uma `SourcePlaylist`. Precisa haver caminho alternativo **iniciado por preferências declaradas**, preservando o onboarding legado.

## Decisões de produto

- **Sem IA:** sem LLM, Tião Brain, embeddings ou inferência de comportamento a partir de Spotify User Data.
- Escolhas manuais: **estilo** (Rock, MPB, Samba etc.), **artistas**, **temas de podcasts**, **programas** e idioma (pt-BR inicialmente), com chips, busca e edição posterior.
- Três experiências: **música**, **podcasts**, **mista**, sem exigir música na opção podcast-only.
- Tags Last.fm são *candidatos*, não fatos sobre o usuário. Taxonomia pt-BR é curada, mapeada a tags e versionável; pesquisar `tag.getTopArtists`, `tag.getTopTracks` e similares com cache.
- Podcasts pesquisados pelo nome/tema via Spotify `GET /search?type=show` (limitar a 10 por página em Development Mode). Apple/Podcast Index são opcionais para descoberta, não são providers de reprodução; validar correspondência e disponibilidade no Spotify.
- Mostrar candidatos e razões, colher `Gostei/Não combina comigo` first-party, e **simular antes de qualquer gravação**.
- Aplicar as opções existentes de composição, ordem, cadência, prioridade, estado de reprodução e escopo do planner; não criar um planner secundário.

## Botão Seguir — três intenções diferentes

**1. Seguir no Sonoriza (botão principal):** com confirmação, cadastrar/ativar `SourcePlaylist { spotifyType: SHOW, kind: PODCAST }` apenas do usuário; este SHOW passa a oferecer episódios elegíveis ao planner, respeitando as políticas de programa/destino. **Não é equivalente a marcar episódios como salvos ou ouvidos.**

**2. Seguir também no Spotify (opt-in separado):** usar `PUT /me/library?uris=spotify:show:<id>` (API 2026), com scope `user-library-modify`, confirmação específica, tratamento de 401/403/429 e checagem idempotente por `GET /me/library/contains`. Não usar legado `PUT /me/shows` no Development Mode. O projeto já solicita `user-library-modify` na configuração OAuth; verificar permissão efetivamente concedida por usuário.

**3. Salvar episódios em "Seus episódios" do Spotify (ação separada):** salvar `spotify:episode:<id>` por episódio, também via `PUT /me/library` e consentimento. **Seguir o show não faz os episódios aparecerem automaticamente em `GET /me/episodes`.** O Sonoriza atualmente tem uma fonte `SAVED_EPISODES` (Spotify ID `me`) que lê justamente essa biblioteca. Nunca prometer que seguiu o show e preencheu essa lista automaticamente.

Uma futura política **"Salvar novos episódios automaticamente em Seus episódios"** precisaria de outra autorização explícita, filtros por programa, prazo/frequência/quantidade, dedupe, idempotência, quotas e desligamento; **não ativar no MVP**. Para alcançar o objetivo funcional de ouvir episódios no destino principal, basta seguir a fonte `SHOW` no Sonoriza e habilitá-la para o destino correspondente.

### Bloqueio atual identificado

`src/services/source-configuration.ts` valida qualquer `SHOW` contra `SpotifyClient.listSavedShows()`, ou seja, exige que o show já esteja seguido no Spotify. **Seguir apenas no Sonoriza não funciona hoje usando diretamente essa action.** Antes de liberar a nova UI, criar uma action dedicada para SHOW descoberto que valide ID, metadados e disponibilidade por `GET /shows/{id}`, permissionamento e fonte user-scoped, sem depender de `listSavedShows()` nem contornar as validações atuais de configuração geral. Alternativa é seguir no Spotify primeiro com opt-in e reaproveitar a persistência existente, mas isso não pode ser obrigatório quando o usuário escolheu Sonoriza-only.

## Fluxo de implantação

1. **Gate A — contrato + regressões** (este PR): catálogo curado de gêneros e temas, seleção explícita/normalização, detector `sem fonte` e planos seguros para seguir `SHOW` sem save de episódios. Sem I/O. Testes.
2. **Gate B — aquisição em shadow/read-only:** interfaces para seleção; Last.fm tags/artistas/faixas; Spotify shows por nome/tema e detalhes por ID, caching, locale, limite por página e backoff. Validação de plausibilidade com o piloto.
3. **Gate C — persistência e prévia:** preferência versionada first-party por usuário, lifecycle retomável, confirmação de follow, source `SHOW` validada, sem writes Spotify; simulação música/podcast/misto conforme capabilidades.
4. **Gate D — ações explícitas Spotify:** opção separada de seguir no Spotify (e salvar episódio individualmente, caso solicitado); correta autorização `PUT /me/library`, checagem `GET /me/library/contains`, idempotência/recovery, sem salvar em massa por padrão; ativação da playlist só após simulação aprovada.
5. **Gate E — piloto real:** Nathan com Spotify vazio e sem Last.fm; caminho só música, só podcast e misto; `SHOW` versus `SAVED_EPISODES`; usuário antigo não afetado; typecheck/build/test/quotas/429; aprovação de merge e deploy.

## Critérios de aceite centrais

- [ ] Pessoa sem nenhuma playlist/favorito/Last.fm escolhe um estilo e recebe candidatos úteis sem IA.
- [ ] Pessoa sem música escolhe tema e segue um `SHOW` pelo Sonoriza.
- [ ] Shows escolhidos chegam como fontes elegíveis à geração da playlist principal **sem obrigar a salvar episódios**.
- [ ] Seguir no Spotify só ocorre com consentimento independente.
- [ ] "Seus episódios" não é modificado por "Seguir" simples; ações de salvar episódios são independentes e limitadas.
- [ ] Modo misto simula e intercala `track` e `episode` usando o planner atual.
- [ ] Nada altera `Escutar` ou os destinos existentes; preserva #278 (compliance), #374 (identidade), #205 (onboarding), #275/#299 (políticas de podcast), #209 (descoberta externa opcional).

### Validação deste Gate A

- Typecheck isolado de `cold-start-contract.ts` com TypeScript: **aprovado localmente**.
- Testes de contrato com Node 22 (`--experimental-strip-types`) usando uma cópia com extensão explícita no import: **7/7 passaram localmente**.
- **Ainda não executados na árvore inteira do repositório:** `npm run typecheck`, build, testes de integração com Prisma/Spotify. A PR permanece em rascunho para avançar nesses checkpoints.


---

## Gate B — descoberta de catálogos em modo somente leitura (14/10/2026)

**Implementação proposta na branch `feat/473-coldstart-gate-b`, empilhada sobre Gate A, ainda sem integração com as páginas do onboarding.** Não altera produção, configurações existentes, playlists ou biblioteca Spotify.

### Música pública via Last.fm

Foram adicionados ao `LastFmClient` métodos públicos somente leitura:

- `getPublicTagTopArtists(tag, limit)` — `tag.gettopartists`;
- `getPublicTagTopTracks(tag, limit)` — `tag.gettoptracks`;
- `getPublicArtistTopTracks(artist, limit)` — `artist.gettoptracks`;
- `getPublicSimilarArtists(artist, limit)` — `artist.getsimilar`.

Reutilizam `getJson`/API key/User-Agent/tratamento de erro existentes. Não requerem autenticação do usuário, Last.fm username, scrobble ou IA. Inputs validados, limite máximo de 20 itens por consulta, resultados deduplicados por identidade textual, sem fabricar dados históricos. Falhas do provider propagadas.

### Podcasts pelo Spotify

`SpotifyClient.searchShows({ query, market, limit })` usa `GET /search?type=show` com `market=BR` e limite **1 a 10** (Development Mode). `getDiscoveredShow({ id, market })` usa `GET /shows/{id}` com validação de ID. Ambos atravessam o **cliente Spotify já instrumentado** (`request`, timeout, backoff e quota), com memoization por instância. Normalização tipada e conservadora evita resultados sem ID/nome e deduplica IDs.

Este gate **não usa** `GET /shows` em lote, removido para o Development Mode em fevereiro de 2026, nem Spotify Recommendations/Spotify Browse Categories.

### Preview centralizado

`ColdStartPreviewService` implementa:

- `previewGenre(genreId)`: tags curadas do Gate A → artistas + músicas Last.fm;
- `previewArtist(name)`: faixas e artistas semelhantes;
- `previewPodcastTopic(topicId)`: tema curado em pt-BR → Spotify show search;
- `searchPodcasts(query)`: pesquisa livre de podcast;
- `inspectShow(showId)`: detalhes do show Spotify.

Todos os resultados trazem **proveniência**. Artistas e faixas Last.fm retornam `spotifyResolved=false` — não estão automaticamente disponíveis como músicas reproduzíveis no Spotify. Shows retornam `followed=false` e `episodesSaved=false`; a busca não é inscrição nem prova de existência de um episódio reproduzível. O preview opera sobre interfaces de leitura e **não dispõe de métodos para criar fontes, seguir programas ou salvar episódios**.

Cache público Last.fm em memória: TTL 15 minutos, no máximo 64 chaves, compartilhando pedidos simultâneos da mesma tag/artista e removendo falhas sem cachear erros. Sem Spotify User Data no cache público; chamadas Spotify reaproveitam memoization user-scoped já existente. **Não** introduzir cache persistente de contas Spotify fora dos mecanismos atuais.

### Testes e validação

- Novos testes unitários de composição e separação de leitura de podcasts: `src/services/onboarding/cold-start-preview.test.ts`.
- Novos testes para query limitada e dados incompletos do Spotify: `src/services/spotify/cold-start-show-search.test.ts`.
- Testes Last.fm com `fetchImpl` simulado acrescentados a `src/services/lastfm/client.test.ts`.
- Novo script `npm run test:cold-start`.
- **Validação runtime real ainda pendente:** executar o script, `npm run test:lastfm`, `npm run typecheck`, `npm run build`, revisar CI, depois um smoke **read-only** autorizado com Spotify do piloto e chave Last.fm configurada. Não inventar resultados reais nem chamar API externa sem ambiente/conta configurados.

### Próximo gate (C)

Adicionar telas/ações de onboarding retomáveis e persistência das preferências first-party, buscar catálogo a pedido (lazy-load), selecionar artista/show e **confirmar** seguir o show no Sonoriza com validação `GET /shows/{id}` sem exigir `listSavedShows`. Criar `SHOW` user-scoped com idempotência e regras atuais, sem fazer `Spotify Follow` nem salvar episódios. Para música, resolver as faixas Last.fm no catálogo Spotify com confiança, sem gravação da playlist antes de simulação/aprovação.

**Observação:** API de catálogo externa e Spotify podem falhar/limitar chamadas (401/403/429, Last.fm erro 29); a UI deverá oferecer recuperação em linguagem amigável, sem mostrar um perfil inventado.
