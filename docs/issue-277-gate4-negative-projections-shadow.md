# Issue #277 — Gate 4: negative projections shadow

## Status

Implementado em branch isolada, ainda sem merge/deploy.

Gate 4 transforma somente evidência já qualificada pelos Gates 2/3 em projeções negativas read-only por faixa e artista.

Não existe neste gate:

- persistência de perfil;
- `MusicPreferenceSignal` novo;
- influência no planner;
- threshold de penalidade;
- exclusão automática;
- leitura de Spotify Recently Played;
- uso de Spotify Extended History;
- IA/LLM.

## Input autorizado

O único input comportamental aceito é `Music06LastFmGapReport` do Gate 3.

Uma ocorrência entra no denominador somente quando:

1. o target tem coverage `CONFIRMED`;
2. a janela do centro tem `evaluable=true`;
3. o centro possui identidade track+artist projetável;
4. o timestamp de avaliação não está no futuro em relação ao `asOf` do relatório.

Assim, exposição sem cobertura continua fora do denominador.

## Negativo

Uma ocorrência avaliável é negativa somente quando o Gate 3 produziu:

```text
evidenceMethod = LASTFM_PLANNED_SEQUENCE_GAP
evidenceLevel  = INFERRED
```

Para centro reconciliado no Last.fm:

```text
assessed = true
negative = false
```

Para cobertura desconhecida/parcial/indisponível:

```text
assessed = false
negative = false
```

## Identidade da projeção

Gate 4 não usa `spotifyTrackId` como chave comportamental.

A chave shadow de faixa reutiliza a identidade conservadora do Gate 2:

```text
TRACK_ARTIST_NORMALIZED_EXACT
normalizedArtist + normalizedTrack
```

O Spotify pode continuar existindo como referência operacional no sistema, mas não determina o agrupamento negativo.

## Métricas por faixa

Cada faixa projetada expõe:

- `assessedOccurrenceCount`;
- `inferredSkipCount`;
- `negativeSignalCount`;
- `skipRate`;
- `recent30d` e `recent90d` com denominador/negativos/rate;
- `recent30dSkipRate`;
- `recent90dSkipRate`;
- `lastNegativeAt`;
- `distinctNegativeDays`.

No Gate 4 atual:

```text
negativeSignalCount == inferredSkipCount
```

porque não existe factual skip Last.fm retrospectivo e nenhuma outra evidência negativa foi adicionada.

## Métricas por artista

Cada artista projetado expõe:

- `assessedOccurrenceCount`;
- `negativeOccurrenceCount`;
- `inferredSkipCount`;
- `negativeSignalCount`;
- `skipRate`;
- janelas 30/90 dias;
- `distinctTracksAssessed`;
- `distinctTracksNegative`;
- `distinctNegativeDays`;
- `lastNegativeAt`.

Nenhuma dessas métricas reduz afinidade ou muda ranking neste gate.

## Dedupe / conflito

A identidade de ocorrência para dedupe é:

```text
runId + targetId + generationItemId
```

Reprocessar exatamente os mesmos fatos:

- não duplica denominador;
- não duplica negativo;
- incrementa apenas `duplicateOccurrenceCount` para diagnóstico.

Se a mesma ocorrência aparecer com fatos conflitantes entre relatórios (por exemplo, negativa em um e ouvida em outro), o Gate 4:

- remove a ocorrência do agregado;
- incrementa `conflictingOccurrenceCount`;
- não escolhe arbitrariamente um dos fatos.

Isso mantém comportamento fail-closed.

## Agregação multi-run

`buildMusic06NegativeProjectionShadowReport()` aceita uma lista explícita de `generationRunIds` e fixa um único `asOf` para todas as observações.

Isso permite medir várias gerações sem criar tabela de perfil.

O script:

```text
scripts/report-music-06-negative-projection-shadow.ts
```

aceita um ou vários:

```text
--run-id=<id>
```

ou IDs separados por vírgula.

## Regressões cobertas

1. coverage `UNKNOWN` não entra no denominador;
2. centro scrobblado entra como avaliado sem negativo;
3. `A✓ B✕ C✓` projeta um negativo inferido para B;
4. mesma faixa normalizada agrega entre runs;
5. 30/90 dias usam somente ocorrências avaliáveis no período;
6. artista agrega faixas distintas avaliadas e negativas;
7. reexecução idêntica é deduplicada;
8. fato conflitante para a mesma ocorrência falha fechado e é excluído.

## Decisões deliberadamente adiadas

Gate 4 não decide:

- volume mínimo por faixa;
- volume mínimo por artista;
- número mínimo de dias distintos;
- peso de recente vs histórico;
- penalidade final;
- threshold de planner;
- interação com preferência explícita além da precedência já definida na #277;
- atribuição específica a `LIVE`.

Essas decisões precisam de dados shadow reais antes do Gate 5.

## Próximo gate

Gate 5 — planner influence:

- calibrar thresholds a partir das projeções shadow;
- aplicar penalidade leve/configurável;
- preferência explícita continua mais forte;
- um único negativo nunca cria ban permanente;
- ativação produtiva continua separada de merge/deploy.
