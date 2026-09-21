# MUSIC-IDENTITY-01 — Gate 4C consumer dedupe shadow

## Objetivo

O Gate 4C mede onde componentes de `RecordingIdentity` considerados seguros pelo Gate 4B realmente colidem no universo de candidatos dos consumers atuais, sem ativar dedupe canônico.

Modo:

`SHADOW_CANONICAL_CONSUMER_DEDUPE_READ_ONLY`

A comparação é somente de contagem/conjunto. O gate não escolhe qual `TrackProviderRef` sobreviveria a uma futura deduplicação.

## Autoridade reutilizada

O Gate 4C não cria uma nova regra de equivalência. Ele reconstrói o mesmo universo textual do Gate 3/Gate 4B e reutiliza diretamente:

- `analyzeGate4APair()` para strong-ID, duração live e preferência TRACK;
- `buildGate4BComponents()` para component closure, contradições internas, duração e preferência;
- `FirstPartyPlaybackPreference` com a chave `spotify:track:<id>`;
- `TARGET-SCOPE-01` para determinar fontes MUSIC alcançáveis por cada target habilitado;
- os decoders oficiais do source cache persistido.

A cardinalidade reconstruída precisa continuar idêntica a `textualPossibleMatchPairs + sameSongDifferentRecordingPairs` antes de qualquer chamada ao Spotify.

## Boundary do consumer medido

O input deste gate é explicitamente:

`TARGET_SOURCE_SCOPE_REACHABLE_PERSISTED_CACHE_PRE_SELECTION`

Isso representa o pool MUSIC persistido e alcançável pelo target antes da seleção final do planner. O Gate 4C não afirma que este seja um plano alternativo pós-cooldown, pós-diversidade ou pós-ORDER; ele mede a primeira fronteira compartilhada em que aliases de provider podem coexistir no mesmo universo de dedupe.

O snapshot precisa estar completo:

- todas as fontes MUSIC alcançáveis em `FULL_VALID`;
- `cacheUpdatedAt` presente;
- nenhuma fonte parcial/missing/invalid.

O fingerprint inclui target/source scope, IDs/URIs do cache, pair set, RecordingIdentity observada e preferências TRACK. Após as chamadas de provider, o input é relido; qualquer mudança durante a avaliação gera abstention.

## Comparação

Para cada source e target o relatório mede:

- ocorrências de candidatos;
- Spotify track IDs distintos;
- URIs distintas;
- tracks mapeadas para componente seguro;
- tracks de componentes bloqueados;
- tracks legacy-only;
- componentes seguros presentes;
- componentes com mais de um membro presente;
- tracks redundantes apenas sob a chave canônica de recording;
- contagem legada por Spotify track ID;
- contagem canônica hipotética por componente;
- redução hipotética;
- samples limitados das colisões.

Track sem componente seguro sempre permanece `legacy:<spotifyTrackId>` na projeção e nunca desaparece.

## Sem representative selection

Uma colisão segura pode produzir:

`WOULD_COLLAPSE_COMPONENT`

mas o relatório mantém:

- `representativeProviderTrackId = null`;
- `representativeSelection = NOT_SELECTED_IN_GATE4C`.

Escolha de representante é um checkpoint futuro e separado.

## Fronteiras semânticas

O Gate 4C opera no nível `RecordingIdentity` somente para componentes aprovados pelo Gate 4B. Ele não transforma `SongIdentity` em `RecordingIdentity` e não funde relações como studio/live, acoustic, remix ou demo quando essas gravações permanecem distintas.

Preferência também continua separada de identidade:

- unilateral `EXCLUDED` bloqueia no Gate 4B;
- presença/policy/source divergentes bloqueiam;
- preferência idêntica autoriza apenas a comparação;
- nenhuma preferência é propagada;
- `LikedTrackPreference` não substitui `FirstPartyPlaybackPreference`.

## Segurança

- migration/schema: não;
- canonical/identity writes: não;
- reassociation de provider refs: não;
- preference writes/propagation: não;
- source-cache writes: não;
- consumer activation: não;
- planner influence: não;
- Spotify playlist writes: não;
- ORDER/ORDER_HASH influence: não;
- representative selection: não;
- `--write`: rejeitado.

O stack Spotify existente pode continuar persistindo refresh de credencial e backoff operacional. Esses writes não são identity writes.

## CLI

```bash
npx tsx scripts/report-music-identity-consumer-dedupe-shadow.ts --user=<id> --json
```

## Saída do gate

O relatório produtivo deve responder, antes de qualquer ativação:

- se existem colisões canônicas reais;
- quantas por target/source;
- quais componentes aparecem em mais de uma representação;
- se algum componente seguro possui preferência explícita idêntica;
- qual seria a redução somente em contagem/conjunto.

Somente depois dessa evidência pode ser desenhada uma política de representante ou influência controlada em consumer.

Refs #374 #388 #389 #391.
