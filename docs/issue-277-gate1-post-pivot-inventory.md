# #277 — MUSIC-06 — Gate 1 pós-pivot — inventário read-only

## Status

Gate 1 concluído como inventário **read-only** sobre:

- base auditada: `main@e93c63d49dc51a495b3ce270489ceca553047685`;
- branch: `issue-277-gate1-post-pivot-inventory`;
- decisão vigente: Sonoriza pessoal/não comercial, com Spotify fora da evidência comportamental de MUSIC-06;
- nenhuma alteração de runtime, schema, migration, dados ou produção neste gate.

Este relatório substitui, para MUSIC-06, qualquer comentário anterior que sugerisse reativar Spotify Recently Played, Extended History ou classificação comportamental baseada em metadata Spotify. A issue #277 e o roadmap pós-pivot de #207 são a direção vigente.

---

# 1. Resumo executivo

O código atual já contém aproximadamente **metade da arquitetura necessária** para MUSIC-06 pós-pivot, mas as metades ainda estão desconectadas:

```text
ORDER-01 / GenerationItem.position
          ↓
algoritmo puro de unit-hole do MUSIC-05
          ↓
      reaproveitável

LastFmClient.user.getRecentTracks
          ↓
scrobbles timestamped + MBIDs/names
          ↓
      reaproveitável
```

O que **não existe ainda** é o contrato entre elas:

```text
ordem publicada
    +
observação Last.fm recente
    +
reconciliação de identidade
    +
cobertura confirmada
    ↓
LASTFM_PLANNED_SEQUENCE_GAP
```

Portanto, o próximo passo correto não é reativar MUSIC-05. É criar o **Gate 2 — coverage/evidence contract Last.fm**, ainda shadow/read-only.

---

# 2. MUSIC-05 produtivo atual

## 2.1 Algoritmo puro reutilizável

`src/services/music-preference/infer-skips.ts` implementa uma inferência conservadora sobre a subsequência de músicas de uma geração aplicada.

A regra central atual é:

```text
previous observado
candidate ausente
next observado
=> unit hole candidato a INFERRED_SKIP
```

Propriedades úteis já existentes:

- usa `GenerationItem.position` como ordem publicada;
- ignora podcasts ao construir a subsequência musical;
- só infere buraco unitário;
- não considera prefixo/sufixo como skip;
- exige âncora anterior e posterior temporalmente coerentes;
- não infere quando a identidade da faixa é instável;
- evita consolidar a observação mais recente como âncora final.

O algoritmo é conceitualmente reutilizável, mas seus tipos ainda são Spotify-shaped (`spotifyTrackId`, `spotifyUri`) e seu comentário de estabilização fala em Recently Played. No redesenho, o núcleo deve receber uma identidade canônica/operacional independente da origem da observação.

### Decisão

**MANTER A IDEIA / REFACTORAR O CONTRATO DE IDENTIDADE.**

Não copiar a dependência de Spotify do adapter legado.

---

## 2.2 Adapter produtivo está corretamente em quarentena

`src/services/music-preference/compliant-inferred-skips.ts` é a fronteira exportada para os jobs.

Ele classifica explicitamente o MUSIC-05 legado como lineage:

```text
SPOTIFY_RECENTLY_PLAYED
```

E exige `ALLOW` simultâneo para:

- behavioral analytics;
- user profiling;
- recommendation;
- planner eligibility.

Como a política atual não autoriza isso, os exports produtivos:

- não gravam novos skips derivados de Spotify;
- retornam listas vazias de pending skips;
- preservam o legado somente para diagnóstico/testes/auditoria.

### Decisão

**NÃO REMOVER O GUARD E NÃO REATIVAR O LEGADO.**

MUSIC-06 deve ganhar uma nova evidência Last.fm/first-party, não uma exceção no guard Spotify.

---

# 3. Onde `INFERRED_SKIP` é produzido hoje

O writer legado está em `src/services/music-preference/analyze.ts` + `signal-store.ts`.

Fluxo legado:

```text
GenerationRun mais recente
    ↓
GenerationItem ordenado por position
    ↓
TrackListeningEvent com spotifyTrackId após appliedAt
    ↓
inferInferredSkips()
    ↓
MusicPreferenceSignal(type = INFERRED_SKIP)
```

A gravação é idempotente pela ocorrência lógica:

```text
userId
+ sourceGenerationRunId
+ targetPlaylistId
+ position
```

O sinal guarda atualmente:

- `spotifyTrackId`;
- `spotifyUri`;
- generation run;
- target;
- position;
- confidence;
- evidence;
- lifecycle de consumo.

Isso é útil como referência de idempotência e auditabilidade, mas o model não expressa hoje, nesse domínio, um `DataOrigin`/`evidenceMethod` tipado para diferenciar o antigo Spotify inference do futuro Last.fm inference.

### Decisão

**REAPROVEITAR A SEMÂNTICA DE OCORRÊNCIA + IDEMPOTÊNCIA; NÃO TRATAR O SCHEMA ATUAL COMO CONTRATO FINAL DO MUSIC-06.**

Gate 2/3 deve decidir se `MusicPreferenceSignal` será estendido ou se MUSIC-06 terá uma ocorrência/evidence própria antes da projeção negativa.

---

# 4. Onde `INFERRED_SKIP` é consumido hoje

`src/jobs/generate-playlists-incremental.ts` importa os exports públicos de `@/services/music-preference`.

Antes do planejamento, o job:

1. chama `analyzeAndRecordInferredSkips()` em geração real;
2. chama `loadPendingInferredSkips()`;
3. transforma sinais pendentes em `blockedMusicTrackIdsByTargetId`;
4. passa esse bloqueio ao `collectIncrementally()`;
5. posteriormente o lifecycle pode consumir os sinais.

Como o `index.ts` exporta as versões de `compliant-inferred-skips.ts`, o Gate 5 faz esse caminho produzir **zero influência** enquanto a origem for Spotify Recently Played.

### Decisão pós-pivot

O futuro MUSIC-06 **não deve pular direto de uma primeira inferência Last.fm para hard block**.

A própria #277 exige:

```text
Gate 3 = detector shadow
Gate 4 = projeções negativas
Gate 5 = penalidade leve/configurável
```

Portanto o atual `blockedMusicTrackIdsByTargetId` é referência histórica, não o comportamento desejado da primeira versão pós-pivot.

---

# 5. Ordem realmente publicada pelo Sonoriza

Já existe evidência first-party suficiente para reconstruir a ordem publicada:

- `GenerationRun.id`;
- `GenerationRun.startedAt/finishedAt`;
- `GenerationRun.simulation`;
- `GenerationRun.status`;
- `GenerationItem.targetPlaylistId`;
- `GenerationItem.position`;
- `GenerationItem.contentType`;
- identidade operacional gravada no item.

O analyzer legado já consulta exatamente a geração real mais recente (`simulation=false`, `SUCCESS|PARTIAL`) com itens do target e ordena `GenerationItem` por `position`.

### O que isso significa

Não precisamos inferir a ordem a partir do Spotify.

A ordem publicada é um **fato first-party do Sonoriza**.

### Lacuna

A identidade dos itens ainda é fortemente provider-shaped (`spotifyTrackId`/URI). Para Gate 3, é aceitável usar essa identidade somente como **referência operacional de entidade**, desde que a evidência comportamental venha do Last.fm e a reconciliação preserve as origens. A direção de longo prazo de #207 continua sendo identidade canônica provider-agnostic.

---

# 6. Last.fm disponível hoje

## 6.1 Cliente já possui `user.getrecenttracks`

`LastFmClient.getRecentTracksPage()` já oferece:

- paginação;
- `from`/`to` por timestamp;
- máximo de 200 linhas por página;
- track/artist/album;
- track/artist/album MBID quando disponível;
- URL Last.fm;
- `loved`;
- timestamp do scrobble;
- contagem separada de now-playing;
- total/pages/perPage.

Eventos concluídos são mapeados para:

```text
source = LASTFM_SCROBBLE
sourceEventKey = hash(timestamp + artist + track)
playedAt
trackName
artistName
albumName
trackMbid / artistMbid / albumMbid
```

Isso é uma base adequada para um **reader recente read-only** de MUSIC-06.

---

## 6.2 Now-playing existe no payload, mas HISTORY-01 descarta de propósito

O cliente detecta:

```text
@attr.nowplaying = true
```

mas não cria `LastFmListeningEventInput` para essa linha; somente incrementa `nowPlayingCount`.

O teste `now-playing.test.ts` prova explicitamente que HISTORY-01 exclui a faixa atual, mesmo quando Last.fm envia `date.uts`.

### Decisão

Isso é correto para o histórico factual de scrobbles e deve permanecer assim.

MUSIC-06 pode futuramente usar **estado de cobertura/freshness** derivado da presença de now-playing, mas não deve transformar now-playing em scrobble/fato concluído.

---

# 7. HISTORY-01 não é sync contínuo

`importLastFmHistory()` documenta explicitamente Last.fm como:

> historical backfill source, not a second continuous truth

O fluxo atual:

- cria/retoma `LastFmBackfillRun`;
- usa janela histórica congelada;
- grava `LASTFM_SCROBBLE`;
- é resumível e idempotente;
- usa um handoff antigo Last.fm → Spotify;
- trata a conclusão do backfill como janela canônica.

`getCanonicalLastFmHistoryWindow()` também considera canônicos apenas scrobbles dentro de uma janela de backfill `SUCCESS`.

### Consequência pós-pivot

**Não reutilizar `importLastFmHistory()` como polling contínuo de MUSIC-06.**

Precisamos de um novo adapter de observação recente que use o mesmo `LastFmClient`, mas tenha lifecycle/freshness/cobertura próprios.

O conceito antigo de handoff “Last.fm histórico → Spotify contínuo” virou dívida do desenho anterior e não deve orientar MUSIC-06.

---

# 8. Reconciliação Last.fm ↔ identidade da faixa

## O que existe

O import Last.fm preserva nomes e MBIDs, mas grava deliberadamente:

```text
spotifyTrackId = null
spotifyUri = null
primaryArtistId = null
albumId = null
```

Logo, **o import Last.fm por si só não resolve a ocorrência para a identidade Spotify/canônica da faixa planejada**.

O MUSIC-05 legado, por outro lado, exige `spotifyTrackId` tanto para item planejado quanto para play observado.

Existe código histórico de reconciliação/enriquecimento ligado a Spotify Extended History, mas ele não pode ser usado como requisito do novo MUSIC-06: #277 exige funcionar sem Extended History e sem Spotify behavioral evidence.

### Lacuna obrigatória para Gate 2/3

Definir reconciliação independente e explicável, por ordem de força, por exemplo:

1. MBID forte quando ambos os lados possuírem;
2. identidade canônica Sonoriza futura (#207);
3. correspondência normalizada track + artist, com album somente como evidência auxiliar;
4. nenhuma reconciliação quando ambígua.

**Não resolver ambiguidade por chamada ao Spotify e depois relabelar o resultado como evidência Last.fm.** Se Spotify for usado apenas para resolução operacional de catálogo, essa lineage deve permanecer separada da observação comportamental.

---

# 9. Cobertura temporal disponível hoje

Já existem primitivas, mas **não existe ainda um contrato de coverage para MUSIC-06**.

Primitivas disponíveis:

- `playedAt` de cada scrobble;
- ordenação temporal;
- paginação/total do `getRecentTracks`;
- `nowPlayingCount`;
- `from`/`to` do request;
- retry do cliente/backfill;
- timestamps da geração publicada;
- posições adjacentes da geração.

O que falta persistir/calcular para a #277:

```text
LASTFM_COVERAGE_CONFIRMED
LASTFM_COVERAGE_PARTIAL
LASTFM_COVERAGE_UNKNOWN
LASTFM_UNAVAILABLE
```

E, no mínimo, evidência de:

- quando o reader consultou o provider;
- janela pedida;
- janela efetivamente coberta;
- última observação/scrobble;
- paginação completa ou truncada;
- erro/retry/provider unavailable;
- existência de anchors da mesma geração;
- gap geral incompatível com avaliação de uma faixa individual.

Sem isso, `B ausente` nunca pode significar skip por si só.

---

# 10. Limitações que o detector shadow deve assumir

## 10.1 Ausência de scrobble é ambígua

Pode significar:

- skip antes do limiar;
- playback interrompido;
- playlist não iniciada;
- troca de dispositivo/conta;
- scrobbling desligado;
- atraso do Last.fm;
- falha do conector;
- faixa tocada sem gerar scrobble por regra do protocolo.

Portanto ausência só entra no detector quando a cobertura for `CONFIRMED` e houver anchors fortes.

## 10.2 Scrobble não significa conclusão

Um scrobble é evidência de consumo suficiente para o protocolo, não de 100% da duração. MUSIC-06 não deve derivar completion ratio de Last.fm.

## 10.3 Now-playing é transitório

É útil para freshness/cobertura, não para declarar ocorrência concluída.

## 10.4 Reordenação/regeneração

Sempre associar a inferência ao `GenerationRun.id + targetId + position` da ordem realmente aplicada. Não comparar scrobbles com a configuração atual da playlist.

## 10.5 Múltiplas sessões/dispositivos

Apenas adjacência nominal não prova que A e C pertencem à mesma sessão. Gate 2 precisa definir janela/contexto máximo e condição de cobertura.

## 10.6 Repeats

A mesma faixa pode existir mais de uma vez ou ser tocada novamente. A reconciliação deve ser occurrence-aware; `trackId` isolado não é chave suficiente.

---

# 11. First-party já disponível

`FirstPartyPlaybackPreference` já separa explicitamente:

```text
USER_EXPLICIT
SONORIZA_INTERACTION
```

com policies:

```text
PREFERRED
NORMAL
REDUCED
EXCLUDED
```

E não aceita provider-derived source.

Isso já satisfaz a fronteira necessária para a regra da #277 de que **preferência explícita prevalece sobre inferência**.

### Direção

MUSIC-06 não deve converter automaticamente uma ocorrência inferida em `EXCLUDED`.

A projeção futura pode produzir score/penalidade leve; o usuário continua podendo registrar uma preferência explícita mais forte ou restaurar `NORMAL`.

---

# 12. LIVE / MUSIC-VERSION-01

Há comentário histórico na discussão de #277 sugerindo reaproveitar classificação de LIVE baseada em metadata Spotify.

**Esse comentário está superseded pela decisão pós-pivot.**

A regra vigente é:

- MUSIC-06 pode agrupar evidência por versão somente quando a classificação tiver provenance apropriada;
- comportamento Spotify nunca é usado para aprender aversão a LIVE;
- preferência explícita `EXCLUDE LIVE` continua first-party;
- a origem da classificação automática pertence ao redesenho de #200.

Nenhuma alteração em #200 é feita neste Gate 1.

---

# 13. Componentes classificados

| Componente | Estado pós-pivot | Ação |
|---|---|---|
| `infer-skips.ts` unit-hole algorithm | reaproveitável com dívida de identidade | REFACTORAR no Gate 3 |
| `analyze.ts` Spotify-shaped adapter | legado diagnóstico | NÃO REATIVAR |
| `compliant-inferred-skips.ts` guard | correto | MANTER |
| `MusicPreferenceSignal` idempotência/lifecycle | ideia útil | REAVALIAR schema no Gate 3/4 |
| planner hard block por pending skip | agressivo para nova v1 | NÃO USAR no shadow |
| `LastFmClient.getRecentTracksPage` | reutilizável | BASE DO GATE 2 |
| HISTORY-01 backfill orchestration | histórico, não contínuo | NÃO REUTILIZAR COMO POLLER |
| Last.fm MBIDs/names | evidência de identidade | USAR NO MATCHER |
| `GenerationRun/GenerationItem.position` | first-party published order | BASE DO DETECTOR |
| `FirstPartyPlaybackPreference` | contrato correto | MANTER |
| Spotify Recently Played | provider behavioral legacy | PROIBIDO EM MUSIC-06 |
| Spotify Extended History | arquivo/quarentena | NÃO É REQUISITO |
| LIVE classifier via Spotify metadata | premissa antiga | SUPERSEDED / #200 |

---

# 14. Arquitetura mínima proposta para Gate 2

Gate 2 deve implementar **contrato + relatório shadow de cobertura**, ainda sem `INFERRED_SKIP` produtivo.

Proposta mínima:

```text
LastFmRecentObservation
- observedAt
- requestedFrom / requestedTo
- providerFreshness
- pageCompleteness
- nowPlayingSeen
- scrobbles[]

LastFmCoverageAssessment
- status: CONFIRMED | PARTIAL | UNKNOWN | UNAVAILABLE
- windowStart / windowEnd
- reason[]
- observedScrobbleCount
- anchorsInPublishedRun

PublishedMusicOccurrence
- generationRunId
- targetPlaylistId
- generationItemId
- position
- canonical/operational identity
- publishedAt

LastFmOccurrenceMatch
- occurrence
- scrobble
- identityBasis
- matchConfidence
- lineage = LASTFM + FIRST_PARTY_ORDER
```

Nenhum desses tipos deve exigir Spotify Recently Played.

---

# 15. Gate 2 — critérios de entrada

Gate 2 pode começar porque o Gate 1 confirmou:

- [x] MUSIC-05 legado localizado;
- [x] produção e consumo de `INFERRED_SKIP` localizados;
- [x] guard produtivo Spotify confirmado;
- [x] Last.fm recent-tracks disponível;
- [x] HISTORY-01 identificado como backfill, não continuous sync;
- [x] `nowplaying` identificado e corretamente separado de scrobble factual;
- [x] runId/targetId/posição publicada disponíveis;
- [x] Last.fm import mantém MBIDs/names, mas não resolve diretamente para identidade planejada;
- [x] primitivas temporais existentes identificadas;
- [x] ausência de coverage contract confirmada;
- [x] first-party preference contract disponível;
- [x] comentário legado sobre LIVE marcado como superseded neste relatório.

---

# 16. Não feito neste Gate

- nenhuma chamada nova ao Last.fm;
- nenhum polling;
- nenhum cron/job;
- nenhum `INFERRED_SKIP` novo;
- nenhuma alteração em planner;
- nenhuma alteração em `MusicPreferenceSignal`;
- nenhuma migration;
- nenhuma alteração de OAuth/scopes Spotify;
- nenhuma reativação de Recently Played;
- nenhuma alteração em produção;
- nenhum merge/deploy.

---

# 17. Próximo gate

**Gate 2 — Last.fm coverage contract + shadow report**.

Objetivo do próximo gate:

1. criar reader recente read-only reaproveitando `LastFmClient`;
2. definir freshness/completeness/coverage;
3. reconciliar scrobbles com ocorrências publicadas sem usar Spotify behavioral data;
4. produzir relatório shadow de janelas avaliáveis;
5. ainda **não inferir nem persistir skip produtivo**.

Somente depois desse contrato estar medido com dados reais, Gate 3 implementa `LASTFM_PLANNED_SEQUENCE_GAP` em shadow.

Refs #277 #278 #89 #90 #103 #146 #200 #207
