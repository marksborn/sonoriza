# Issue #277 — Gate 2: contrato de cobertura Last.fm

Status: **IMPLEMENTADO NO BRANCH / VALIDAÇÃO DE CHECKOUT PENDENTE**

Branch: `issue-277-gate2-lastfm-coverage`

Base auditada: `e93c63d49dc51a495b3ce270489ceca553047685`

Gate 1: `71e9d707ec3653e14d59ce037fc853bf5347cf8d`

Implementation HEAD antes deste documento: `886ac058dea8960cce26edf41d0ad6a093ec92b4`

## Objetivo

Implementar o contrato de cobertura Last.fm exigido por MUSIC-06 antes de qualquer inferência de skip.

Este gate responde somente à pergunta:

> Existe evidência Last.fm suficientemente completa e reconciliada para considerar uma ocorrência publicada pelo Sonoriza **avaliável**?

Ele **não** responde se a faixa foi pulada e não cria sinal negativo.

## Limites do gate

Permitido:

- ler uma `GenerationRun` real já persistida pelo Sonoriza;
- ler `GenerationItem.position`, `title`, `subtitle`, target e identidade operacional;
- consultar `user.getrecenttracks` no Last.fm;
- reconciliar a ordem publicada com scrobbles Last.fm;
- classificar cobertura;
- produzir relatório shadow/read-only.

Proibido neste gate:

- criar `INFERRED_SKIP`;
- escrever `MusicPreferenceSignal`;
- alterar planner/candidatos;
- alterar playlist Spotify;
- usar Spotify Recently Played como evidência;
- usar Spotify Extended Streaming History como evidência;
- fazer fuzzy/catalog matching via Spotify;
- enviar qualquer dado a IA/LLM.

## Contrato de cobertura

Estados:

- `CONFIRMED`
- `PARTIAL`
- `UNKNOWN`
- `UNAVAILABLE`

Semântica:

### `CONFIRMED`

Existe ao menos uma janela de ocorrência publicada cuja avaliação é segura sob o contrato atual e a leitura Last.fm foi completa para a janela solicitada.

### `PARTIAL`

A leitura do provider foi truncada/incompleta. Mesmo que existam âncoras aparentemente úteis, a janela não recebe autorização para avaliação negativa.

### `UNKNOWN`

O Last.fm respondeu, mas não existe evidência suficiente para confirmar cobertura de uma ocorrência publicada.

Exemplos:

- nenhuma janela com duas âncoras reconciliadas;
- apenas `nowplaying`;
- identidade ambígua;
- ordem temporal incoerente;
- scrobble estranho entre âncoras.

### `UNAVAILABLE`

A observação Last.fm não pôde ser obtida. Nenhuma ocorrência é avaliável.

## Identidade

Gate 2 usa somente:

`normalized(trackName) + normalized(artistName)`

A normalização:

- aplica NFKD;
- remove diacríticos;
- faz lowercase;
- normaliza `&` para `and`;
- preserva letras/números Unicode;
- colapsa pontuação/espaços.

Não há chamada ao Spotify para resolver identidade.

A reconciliação é deliberadamente conservadora:

- identidade publicada repetida na mesma sequência → `AMBIGUOUS`;
- mais de um scrobble Last.fm compatível → `AMBIGUOUS`;
- nome/artista insuficiente → `UNMATCHABLE`;
- zero scrobbles compatíveis → `UNMATCHED`;
- exatamente um match em ambos os lados → `MATCHED`.

## Janela A → B → C

A ocorrência central B pode ser marcada como **avaliável**, mas não como skip, quando:

1. A está reconciliada;
2. C está reconciliada;
3. A ocorreu antes de C;
4. a paginação Last.fm está completa;
5. B não tem identidade ambígua/inválida;
6. se B tem scrobble, ele está temporalmente entre A e C;
7. não existe scrobble Last.fm não relacionado entre A e C.

O último item é importante para não interpretar como continuidade da playlist uma situação em que o usuário saiu da sequência e voltou depois.

Gate 3 poderá usar uma janela avaliável com B ausente como **um ingrediente** de `LASTFM_PLANNED_SEQUENCE_GAP`.

## Reader Last.fm

`lastfm-coverage-reader.ts` usa `LastFmClient.getRecentTracksPage()` e pagina a janela solicitada.

Propriedades:

- read-only;
- deduplicação por `sourceEventKey`;
- scrobbles ordenados por `playedAt`;
- contagem separada de `nowPlaying` e linhas inválidas;
- limite explícito de páginas;
- se `totalPages > pagesFetched`, `complete=false`.

Portanto um limite operacional de paginação nunca é transformado silenciosamente em cobertura confirmada.

## Ordem first-party publicada

`lastfm-coverage-prisma.ts` lê a geração persistida pelo Sonoriza.

A ordem vem de `GenerationItem.position`.

A publicação pertence ao domínio first-party do Sonoriza. IDs Spotify eventualmente armazenados no item continuam sendo apenas referências operacionais e não são usados como evidência comportamental Last.fm.

## Relatório shadow

Script:

`npx tsx scripts/report-music-06-lastfm-coverage.ts`

Argumentos obrigatórios:

- `--email=<Sonoriza user>`
- `--run-id=<GenerationRun id>`

Username Last.fm:

- `--username=<Last.fm user>`; ou
- `LASTFM_USERNAME`.

API key:

- `LASTFM_API_KEY`.

Argumentos opcionais:

- `--from=<ISO-8601>`
- `--to=<ISO-8601>`
- `--max-pages=<n>`
- `--window-hours=<n>`

O script termina explicitamente com a garantia:

`READ-ONLY: nenhum INFERRED_SKIP foi criado e nenhuma playlist foi alterada.`

## Regressões cobertas no branch

- normalização de identidade;
- match único;
- identidade publicada repetida → abstention;
- múltiplos scrobbles candidatos → abstention;
- A/C ordenadas em janela completa → janela central avaliável;
- B observado fora das âncoras → abstention;
- paginação incompleta → `PARTIAL`;
- provider indisponível → `UNAVAILABLE`;
- now-playing sem âncoras completas → `UNKNOWN`;
- scrobble não planejado entre A/C → abstention;
- paginação do reader e deduplicação por source event key.

## Persistência / schema

Gate 2:

- não altera `prisma/schema.prisma`;
- não adiciona migration;
- não grava TrackListeningEvent;
- não grava MusicPreferenceSignal;
- não altera FirstPartyPlaybackPreference;
- não altera Spotify OAuth/scopes;
- não altera planner/runtime de geração.

## Validação obrigatória antes de considerar o Gate 2 concluído

No checkout exato do HEAD:

```bash
npm ci
npx prisma generate
npx prisma validate
npm run test:lastfm
npm run test:music-preference
npm run typecheck
npm run build
```

Depois, executar um relatório real read-only sobre uma `GenerationRun` real e revisar:

- status de cobertura por target;
- quantidade de matches;
- ambiguidades;
- ocorrências não reconciliáveis;
- janelas avaliáveis;
- motivos de abstention.

Nenhum merge, deploy ou Gate 3 deve ser inferido automaticamente a partir deste documento.
