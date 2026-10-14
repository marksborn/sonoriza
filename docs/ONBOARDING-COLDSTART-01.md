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
