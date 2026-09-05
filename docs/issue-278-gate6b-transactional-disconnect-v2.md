# #278 — Gate 6B v2: executor transacional de disconnect Spotify

## Status

Branch: `issue-278-gate6b-transactional-disconnect-v2`.

Base: Gate 6A v2 final, contrato de retenção v6 (`511501b8d94af675f494a77397013f5fbc6bd53b`).

Este subgate implementa o **executor local transacional**. Não cria endpoint/UI, não chama endpoint de revogação do Spotify e não executa disconnect na conta real durante validação.

## Objetivo

Transformar o preview read-only do Gate 6A em uma operação local fail-closed que:

1. exige o mesmo contrato v6 mostrado ao usuário;
2. exige fingerprint SHA-256 do inventário mostrado no preview;
3. exige confirmação exata derivada desse fingerprint;
4. reabre o inventário dentro de uma transação `SERIALIZABLE`;
5. falha se o snapshot tiver mudado;
6. apaga/sanitiza/redige somente lineage/payload Spotify;
7. preserva Last.fm, Google e first-party Sonoriza;
8. remove a credencial Spotify local por último;
9. executa postcheck antes do commit.

## Confirmação

A preparação retorna:

```text
contractVersion = 6
fingerprint      = SHA-256(userId + contrato + inventário)
confirmation     = DISCONNECT SPOTIFY <12 primeiros hex do fingerprint em maiúsculas>
```

Não basta um texto genérico como `DISCONNECT SPOTIFY`.

Se a versão do contrato, fingerprint ou frase não coincidirem exatamente, nenhuma mutation é autorizada.

## Concorrência / atomicidade

O executor usa:

```text
Prisma.TransactionIsolationLevel.Serializable
maxWait = 10s
timeout = 120s
```

Durante a janela destrutiva também usa `SHARE ROW EXCLUSIVE` nas tabelas participantes. Isso bloqueia writers de cron/provider enquanto mantém leitores comuns disponíveis. Em seguida bloqueia explicitamente `User` e os `Account(provider=spotify)` do usuário com `FOR UPDATE`.

A escolha do lock global é deliberadamente conservadora: disconnect é raro e destrutivo; é preferível uma pequena pausa de escrita a permitir uma corrida entre preview, purge e postcheck.

## Snapshot stale

Fluxo obrigatório:

```text
prepare
  -> inventário
  -> preview
  -> fingerprint
  -> frase exata

execute
  -> SERIALIZABLE + locks
  -> inventário fresco
  -> fingerprint fresco
  -> compara com fingerprint apresentado
  -> só então mutations
```

Qualquer linha nova/removida que altere o inventário entre `prepare` e `execute` gera `DATA_POLICY_SPOTIFY_DISCONNECT_PREVIEW_CHANGED`.

## Preservação reforçada

Além de contagens, o executor calcula fingerprints de conteúdo para dados que **não podem ser alterados** por um Spotify-only disconnect:

- OAuth de outros providers;
- Google Calendar selections;
- evidência de listening com origem independente;
- `LastFmBackfillRun`;
- `FirstPartyPlaybackPreference`;
- `NativeSourcePreference`;
- identidade básica do usuário Sonoriza (`id`, `email`, `emailVerified`, `createdAt`).

Para listening independente, o fingerprint usa apenas o núcleo independente (`id`, source, sourceEventKey, faixa, artista, playedAt, ISRC/MBIDs). Assim uma linha mixed pode perder enriquecimento Spotify sem alterar a evidência Last.fm que precisa sobreviver.

## MUSIC-06 / GenerationRun

Gate 6A classificou `GENERATION_AUDIT` como selective redaction.

O executor não faz mais `summary = NULL` indiscriminadamente. Para `GenerationRun.summary`:

```text
music06PlannerInfluence  -> PRESERVA
outros componentes       -> REMOVE conservadoramente
error provider payload   -> REMOVE
```

`music06PlannerInfluence` é a explicabilidade aprovada da #277 baseada em Last.fm + ordem publicada Sonoriza.

Como o inventário do Gate 6A era deliberadamente conservador e contava qualquer summary não nulo para inspeção, o Gate 6B usa um **effective inventory**: summaries que já contêm somente `music06PlannerInfluence` são considerados limpos. Isso torna prepare/postcheck semanticamente idempotentes sem enfraquecer o inventário 6A.

`GenerationItem` e `GenerationLog` continuam redigidos porque seus campos persistidos carregam catálogo/URI/payload Spotify.

## Ordem de mutations

Em uma única transação:

```text
1. clear provider payload/runtime
2. redact operational audit
3. DELETE Spotify listening rows
4. SANITIZE mixed independent rows
5. DELETE Spotify playback/profile/legacy derived state
6. redact explicit-action audits preserving verdict/timing
7. selective GenerationRun redaction preserving MUSIC-06
8. redact GenerationItem / GenerationLog
9. DELETE Account(provider=spotify) por último
10. re-inventory + preservation fingerprints + postcheck
11. COMMIT somente se tudo estiver coerente
```

Não há revogação HTTP externa dentro da transação.

## Mixed Last.fm + Spotify

Contrato v6:

```text
Spotify-origin listening row        -> DELETE
Last.fm row com enrichment Spotify  -> SANITIZE_SPOTIFY_LINEAGE
Pure Last.fm row                    -> RETAIN_INDEPENDENT_ORIGIN
```

Na sanitização mixed são removidos:

- `spotifyTrackId`;
- `spotifyUri`;
- `primaryArtistId`;
- `albumId`;
- `albumName` (proveniência não tipada, portanto conservador);
- contexto `spotify:*`;
- `metadata.spotifyExtendedHistory`.

São preservados faixa/artista/playedAt/source/sourceEventKey e outros identificadores independentes.

## Postcheck

Antes do commit:

- todos os datasets `DELETE`, `CLEAR_PROVIDER_PAYLOAD`, `SANITIZE_SPOTIFY_LINEAGE` e `REDACT_PROVIDER_FIELDS` precisam resultar em zero residue no effective inventory;
- `Account(provider=spotify)` precisa ser zero;
- usuário Sonoriza precisa continuar existindo;
- contagens de OAuth não-Spotify, Google, Last.fm backfill e first-party não podem mudar;
- fingerprints de conteúdo de OAuth não-Spotify, Google, listening independente, Last.fm backfill e first-party precisam ser idênticos;
- contagens de rows estruturais/audit preservadas não podem mudar.

Qualquer divergência gera `DATA_POLICY_SPOTIFY_DISCONNECT_POSTCHECK_FAILED` e a transação inteira faz rollback.

## Idempotência

Depois de um disconnect bem-sucedido, um novo `prepare` deve produzir `preview.destructive = false`.

Um novo execute com o novo fingerprint não recria credenciais nem provider data e mantém o estado final limpo. A operação continua fail-closed caso algum provider residue reapareça antes da execução.

## Validação permitida neste gate

CI pode executar o disconnect **somente em usuários sintéticos** dentro de PostgreSQL descartável.

Validação em produção deve limitar-se a:

- `prepareSpotifyDisconnect`;
- fingerprint/preview real read-only;
- nenhuma chamada de `executeSpotifyDisconnect` para a conta real.

## Fora de escopo

- endpoint/UI de desconexão;
- botão/configuração de usuário;
- revogação HTTP do token no Spotify;
- desconectar a conta real do usuário durante validação;
- account deletion Sonoriza;
- merge/deploy sem autorização separada.
