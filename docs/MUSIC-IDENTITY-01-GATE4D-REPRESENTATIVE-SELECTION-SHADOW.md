# MUSIC-IDENTITY-01 — Gate 4D representative selection shadow

## Objetivo

O Gate 4D escolhe, apenas em shadow, qual `TrackProviderRef` seria mantido quando dois ou mais Spotify track IDs pertencentes ao mesmo componente seguro de `RecordingIdentity` colidem no input de um target.

Modo:

`SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY`

A escolha é hipotética. Não ativa dedupe, não altera planner, ORDER/ORDER_HASH ou playlist e não reassocia provider refs.

## Autoridade herdada

O Gate 4D não redefine identidade nem o universo de colisão:

- identidade: `SAFE_CANONICAL_COMPONENT` do Gate 4B;
- colisão no consumer: Gate 4C;
- boundary: `TARGET_SOURCE_SCOPE_REACHABLE_PERSISTED_CACHE_PRE_SELECTION`;
- preferência TRACK: a compatibilidade já exigida por Gate 4A/4B;
- provider lookup/backoff: o mesmo stack executado pelo Gate 4C.

O Gate 4D executa Gate 4C uma única vez e reutiliza seu relatório validado. Não faz uma segunda rodada de provider lookup.

## Prova de ordenação

Antes de escolher um representante, o Gate 4D depende de duas ordens explícitas já existentes no boundary medido:

1. `resolveTargetSourceScope()` devolve `effectiveSourceIds` em ordem lexicográfica determinística;
2. `decodeMusicSourceCache()` preserva a ordem do array persistido de candidates.

A política registra essas autoridades como:

- `TARGET_SCOPE_EFFECTIVE_SOURCE_IDS_LEXICOGRAPHIC`;
- `PERSISTED_SOURCE_CACHE_CANDIDATE_ARRAY_INDEX`.

O input ordenado é relido antes e depois da seleção e recebe fingerprint próprio. Mudança durante a seleção gera abstention.

## Política v1

`LEGACY_FIRST_OCCURRENCE_V1`

Para cada componente que colide em um target:

1. considerar somente member provider track IDs presentes no target;
2. obter a primeira ocorrência de cada member pela ordem efetiva das sources;
3. dentro da source, usar a posição persistida do candidate no cache;
4. usar `providerTrackId` apenas como tie-break final estável.

O primeiro member nessa ordem é o `representativeProviderTrackId` hipotético. Os demais ficam em `droppedProviderTrackIds` hipotéticos.

A política não usa preferência como favoritismo. Preferência idêntica é apenas evidência carregada do componente; preferência incompatível já bloqueia o componente antes deste gate.

## Guard de completude do Gate 4C

Gate 4C limita samples por target. Gate 4D só executa representative selection quando `collisionSamples.length == collisionComponents` para cada target. Se os detalhes necessários estiverem truncados, o run abstém em vez de inferir membros ausentes.

Para cada componente, o Gate 4D também compara os members presentes no relatório Gate 4C com a ocupação atual do cache. Qualquer divergência gera abstention.

## Reconciliação

Quando todas as colisões forem selecionáveis:

`sum(hypotheticalDrops) == Gate4C.targetHypotheticalReduction`

Divergência gera `GATE4C_REDUCTION_MISMATCH`.

No snapshot produtivo que abriu este gate, o valor esperado é 144, mas o código não fixa esse número; ele sempre usa a redução declarada pelo Gate 4C da execução atual.

## Abstentions

O Gate 4D falha fechado em:

- Gate 4C abstained;
- detalhes de colisão Gate 4C incompletos;
- source/cache sem ordenação reproduzível;
- target/source scope diferente do snapshot Gate 4C;
- ocupação atual de um componente diferente do Gate 4C;
- mudança do input ordenado durante a seleção;
- redução KEEP/DROP que não reconcilia com Gate 4C.

Não há fallback aleatório, timestamp-based selection ou dependência de ordem implícita de SQL/Map/object iteration.

## Saída

Para cada target/component selecionável o relatório inclui:

- member provider track IDs presentes;
- primeira ocorrência de cada member;
- source order e cache position;
- representative provider track ID;
- dropped provider track IDs;
- critério decisivo;
- reason chain;
- estado de preferência do componente;
- indicação de representative presente em múltiplas sources;
- hypothetical drops.

Métricas globais e por target incluem quantidade de escolhas decididas por source order, cache position ou provider-ID tie-break.

## Segurança

- migration/schema: não;
- identity/canonical writes: não;
- provider-ref reassociation: não;
- preference writes/propagation: não;
- source-cache writes: não;
- consumer activation: não;
- planner influence: não;
- Spotify playlist writes: não;
- ORDER/ORDER_HASH influence: não;
- productive representative selection: não;
- `--write`: rejeitado.

Refresh de credencial e ProviderBackoff existentes no stack Spotify podem escrever operacionalmente, assim como no Gate 4C; não são identity/consumer writes.

## CLI

```bash
npx tsx scripts/report-music-identity-representative-selection-shadow.ts --user=<id> --json
```

## Próximo checkpoint

Antes de qualquer influência produtiva precisamos executar Gate 4D em produção e responder:

- quantas das colisões Gate 4C são selecionáveis deterministicamente;
- quais critérios decidiram os representatives;
- se existem abstentions/ambiguidades;
- se os hypothetical drops reconciliam integralmente com Gate 4C;
- qual seria o churn de provider IDs por target.

Somente depois desse relatório produtivo pode ser especificado um gate separado de influência controlada no primeiro consumer.

Refs #374 #391 #392 #393.
