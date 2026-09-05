# #278 — Gate 6A v2: Spotify retention / deletion / disconnect contract

## Status

Retomada em branch nova `issue-278-gate6a-retention-contract-v2`, criada a partir de `main@0b6bbe114aac299a0b754cabf6d46d647c99720c` após a conclusão da #277 / MUSIC-06.

A branch histórica `issue-278-gate6-retention-disconnect` não será merged/rebased diretamente: ela divergiu significativamente do `main` atual e nasceu antes do redesenho MUSIC-06 com Last.fm.

Gate 6A v2 continua deliberadamente **read-only**. Ele define o contrato e o inventário/preview. Não remove conta OAuth, não apaga linhas, não revoga token, não chama Spotify e não muda schema.

## Motivo da retomada

A implementação histórica do Gate 6 já tinha um bom desenho de retenção e um executor transacional, mas foi congelada antes do pivot pessoal/não comercial e antes da conclusão da MUSIC-06.

O `main` atual agora contém:

- provenance/capabilities da #278 Gates 2–5;
- hard guard para IA;
- preferências first-party explícitas;
- MUSIC-05 Spotify inferido em quarentena;
- MUSIC-06 produtivo usando Last.fm + ordem publicada pelo Sonoriza;
- UI de explicabilidade MUSIC-06 em `GenerationRun.summary.music06PlannerInfluence`.

Por isso, o contrato de disconnect precisa preservar explicitamente evidência Last.fm independente e não pode tratar todo dado não-first-party como descartável junto com Spotify.

## Regra central

```text
DISCONNECT SPOTIFY
  -> remover credenciais Spotify
  -> remover/sanitizar/redigir somente lineage/payload Spotify
  -> preservar first-party Sonoriza
  -> preservar providers/origens independentes
  -> não apagar a conta Sonoriza
```

Spotify disconnect é provider-scoped. Não é account deletion nem provider-global reset.

## Ações do contrato v6

### `DELETE`

O dataset é credencial, estado ou derivado de lineage Spotify e não deve sobreviver ao disconnect.

### `CLEAR_PROVIDER_PAYLOAD`

A linha/configuração é preservada, mas cache/runtime/provider payload deve ser removido.

### `SANITIZE_SPOTIFY_LINEAGE`

A linha possui valor independente, mas foi enriquecida com Spotify. Remove-se apenas o componente Spotify.

### `REDACT_PROVIDER_FIELDS`

Preserva-se audit/estrutura first-party, removendo campos Spotify. A futura implementação deve ser seletiva por lineage e não apagar conteúdo independente Last.fm/first-party.

### `RETAIN_FIRST_PARTY`

Configuração, preferência explícita e conta Sonoriza sobrevivem.

### `RETAIN_INDEPENDENT_ORIGIN`

Dados de uma origem diferente de Spotify sobrevivem a um Spotify-only disconnect.

Casos explicitamente cobertos nesta retomada:

- OAuth de outro provider;
- Google Calendar selection;
- scrobble Last.fm puro;
- `LastFmBackfillRun`.

## Delta importante em relação ao Gate 6 histórico

### 1. Last.fm agora é dependência produtiva da MUSIC-06

Pure Last.fm evidence é preservada. Uma linha `LASTFM_SCROBBLE` com enriquecimento Spotify é considerada mixed:

```text
Last.fm evidence       -> preserve
Spotify enrichment     -> sanitize
```

A linha não é apagada por inteiro.

### 2. Eventos Spotify puros e mixed são datasets distintos no contrato

O primeiro preview real mostrou uma ambiguidade importante no contrato v5: `TRACK_LISTENING_EVENT` tinha uma única ação `SANITIZE_SPOTIFY_LINEAGE`, mas agregava duas operações diferentes:

```text
Spotify-origin row        -> DELETE
Last.fm + Spotify mixed   -> SANITIZE_SPOTIFY_LINEAGE
```

Isso fazia o total do preview classificar eventos Spotify puros como `SANITIZE`, embora o executor futuro devesse deletá-los.

O contrato v6 corrige isso com datasets explícitos:

```text
SPOTIFY_LISTENING_EVENT -> DELETE
MIXED_LISTENING_EVENT   -> SANITIZE_SPOTIFY_LINEAGE
LASTFM_LISTENING_EVENT  -> RETAIN_INDEPENDENT_ORIGIN
```

Assim os totais do preview passam a representar exatamente o tipo de mutação que o Gate 6B poderá executar.

### 3. MusicPreferenceSignal continua sendo legado Spotify

O `main` atual mantém MUSIC-05 em quarantine. `compliant-inferred-skips.ts` impede criação/uso produtivo de inferências Spotify enquanto a capability não é `ALLOW`.

Os `MusicPreferenceSignal` persistidos existentes continuam classificados conservadoramente como legado MUSIC-05 / Spotify Recently Played e entram em `DELETE`.

MUSIC-06 Last.fm atual não depende produtivamente dessa tabela.

### 4. GenerationRun possui explainability Last.fm que deve sobreviver

`GenerationRun.summary.music06PlannerInfluence` contém explicabilidade Last.fm/first-party aprovada da #277.

`GENERATION_AUDIT = REDACT_PROVIDER_FIELDS` não significa `summary = null` indiscriminadamente.

O Gate 6B v2 deve preservar:

- timing/status/run structure first-party;
- `music06PlannerInfluence` independente;
- outros componentes cuja lineage seja comprovadamente não-Spotify.

E remover somente Spotify URI/id/catalog/payload/error ou derivados que não possam permanecer.

## Inventário read-only

`PrismaSpotifyDisconnectInventoryStore` mede para um usuário:

- OAuth Spotify;
- OAuth de outros providers;
- Google Calendar selections;
- cache/runtime Spotify;
- Spotify listening state/events;
- mixed non-Spotify rows com enriquecimento Spotify;
- pure Last.fm scrobbles;
- Last.fm backfill audit;
- Spotify Extended History import audit;
- podcast playback state;
- Saved Tracks / affinity / legacy similarity/profile rows;
- legacy MusicPreferenceSignal;
- first-party preferences;
- provider-bearing operational audit.

Nenhuma query do inventário faz provider call ou mutation.

## Preview

O preview separa contagens em:

```text
deleteRows
sanitizeRows
redactRows
clearPayloadRows
retainedFirstPartyRows
retainedIndependentRows
```

Eventos Spotify puros e mixed possuem itens separados, para que `deleteRows` e `sanitizeRows` coincidam com as operações reais esperadas do executor.

## Primeiro preview real de produção

Usuário: `nascimento@itscontrol.com.br`.

O preview read-only comprovou:

- Spotify OAuth: 1;
- outro OAuth: 1;
- Google Calendar selections: 22;
- Spotify listening events: 43.376;
- mixed Last.fm + Spotify: 40.287;
- pure Last.fm events: 19.952;
- Last.fm backfill runs: 2;
- `Inventory before == after`;
- nenhuma mutation;
- nenhuma chamada Spotify;
- nenhum disconnect.

O preview v5 inicialmente reportou:

```text
DELETE   27.117
SANITIZE 83.663
```

Esse resumo revelou a ambiguidade descrita acima, pois `83.663 = 43.376 Spotify puros + 40.287 mixed`.

Com o contrato v6, usando o mesmo snapshot observado, o total semanticamente correto é:

```text
DELETE   70.493   # 27.117 + 43.376 Spotify-origin listening rows
SANITIZE 40.287   # somente mixed Last.fm + Spotify
REDACT   19.297
CLEAR         8
RETAIN FIRST-PARTY 13
RETAIN INDEPENDENT 19.977
```

Esses números precisam ser reconfirmados por um segundo preview real no SHA final v6 antes de fechar o 6A.

## Regressões obrigatórias do Gate 6A v2

1. contrato cobre cada dataset exatamente uma vez;
2. OAuth Spotify = DELETE;
3. OAuth de outro provider = RETAIN_INDEPENDENT_ORIGIN;
4. pure Last.fm = RETAIN_INDEPENDENT_ORIGIN;
5. Spotify-origin listening event = DELETE;
6. mixed Last.fm + Spotify = SANITIZE_SPOTIFY_LINEAGE;
7. LastFmBackfillRun = RETAIN_INDEPENDENT_ORIGIN;
8. Google Calendar selection sobrevive;
9. legacy MusicPreferenceSignal = DELETE;
10. FirstPartyPlaybackPreference = RETAIN_FIRST_PARTY;
11. Generation audit exige selective redaction e preservação da explainability MUSIC-06 independente;
12. preview nunca executa mutation;
13. inventário SQL funciona contra o schema Prisma atual;
14. totais DELETE/SANITIZE não podem agrupar operações semanticamente diferentes.

## Fora de escopo deste subgate

- executor destrutivo;
- endpoint/UI de disconnect;
- revogação HTTP no Spotify;
- desconectar a conta de produção;
- account deletion do Sonoriza;
- remover OAuth scopes;
- migration/schema;
- merge/deploy sem autorização separada.

## Gate 6B v2 — próximo

Depois de validar o 6A com CI e segundo preview real read-only, reconstruir o executor transacional sobre o contrato v6:

1. prepare/preview fingerprint;
2. confirmation phrase exata;
3. `SERIALIZABLE` + locking;
4. stale-preview fail closed;
5. remoção local das credenciais Spotify por último;
6. selective Spotify deletion/sanitize/redaction;
7. proteção explícita de Last.fm/Google/first-party;
8. postcheck por dataset e preservation snapshot;
9. nenhum disconnect real em teste/dev.

A branch histórica 6B será usada como referência de algoritmo e testes, não como código implicitamente confiável.
