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

## Ações do contrato v5

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

### 2. MusicPreferenceSignal continua sendo legado Spotify

O `main` atual mantém MUSIC-05 em quarantine. `compliant-inferred-skips.ts` impede criação/uso produtivo de inferências Spotify enquanto a capability não é `ALLOW`.

Os `MusicPreferenceSignal` persistidos existentes continuam classificados conservadoramente como legado MUSIC-05 / Spotify Recently Played e entram em `DELETE`.

MUSIC-06 Last.fm atual não depende produtivamente dessa tabela.

### 3. GenerationRun possui explainability Last.fm que deve sobreviver

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

A contagem de mixed listening rows é adicionada ao dataset `TRACK_LISTENING_EVENT`, pois o futuro executor precisará sanitizar essas linhas em vez de deletá-las.

## Regressões obrigatórias do Gate 6A v2

1. contrato cobre cada dataset exatamente uma vez;
2. OAuth Spotify = DELETE;
3. OAuth de outro provider = RETAIN_INDEPENDENT_ORIGIN;
4. pure Last.fm = RETAIN_INDEPENDENT_ORIGIN;
5. mixed Last.fm + Spotify = SANITIZE_SPOTIFY_LINEAGE;
6. LastFmBackfillRun = RETAIN_INDEPENDENT_ORIGIN;
7. Google Calendar selection sobrevive;
8. legacy MusicPreferenceSignal = DELETE;
9. FirstPartyPlaybackPreference = RETAIN_FIRST_PARTY;
10. Generation audit exige selective redaction e preservação da explainability MUSIC-06 independente;
11. preview nunca executa mutation;
12. inventário SQL funciona contra o schema Prisma atual.

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

Depois de validar o 6A com CI e preview real read-only, reconstruir o executor transacional sobre o contrato v5:

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
