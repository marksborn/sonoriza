# #278 — Gate 6C: provider-side revocation contract

## Status

Branch: `issue-278-gate6c-provider-revocation-contract`.

Base: production/main `344dab74309391fe0dda90338230edf4b98ac9c2`, com Gate 6A/6B v2 já implantados e **não executados** contra a conta real.

## Decisão

O Sonoriza **não deve inventar uma chamada HTTP de revogação do Spotify**.

Na documentação oficial revisada em 2026-09-06:

- Spotify Web API documenta autorização, access token e refresh token;
- o suporte oficial orienta o usuário a remover a autorização de apps em `https://www.spotify.com/account/apps/` usando **REMOVER ACESSO**;
- não foi encontrado endpoint oficial/documentado para o próprio aplicativo revogar programaticamente a autorização do usuário.

Portanto o contrato deste gate é:

```text
providerRevocation.mode = MANUAL_USER_ACTION_REQUIRED
providerRevocation.reason = NO_DOCUMENTED_APPLICATION_REVOCATION_ENDPOINT
canAutomateProviderRevocation = false
providerRevocationVerifiedBySonoriza = false
```

## Fluxo recomendado

```text
1. prepareSpotifyDisconnect()
2. usuário revisa preview/fingerprint
3. executeSpotifyDisconnect() local, transacional, fail-closed
4. postcheck local confirma zero residue Spotify e preservação independente
5. Sonoriza orienta abrir https://www.spotify.com/account/apps/
6. usuário escolhe REMOVER ACESSO para o Sonoriza
```

O passo 3 não depende de chamada ao Spotify. Assim, mesmo que a autorização provider já tenha sido removida manualmente, o purge local continua tecnicamente possível; a ordem acima é apenas a ordem operacional preferida para manter o preview e o postcheck sob controle do Sonoriza antes de encerrar a autorização externa.

## Contrato implementado

Arquivo:

- `src/services/data-policy/spotify-provider-revocation.ts`

Exporta:

- `SPOTIFY_PROVIDER_REVOCATION_MODE = MANUAL_USER_ACTION_REQUIRED`;
- `SPOTIFY_PROVIDER_REVOCATION_REASON = NO_DOCUMENTED_APPLICATION_REVOCATION_ENDPOINT`;
- `SPOTIFY_CONNECTED_APPS_URL`;
- `SPOTIFY_PROVIDER_REVOCATION_SUPPORT_URL`;
- `buildSpotifyProviderRevocationPlan()`.

O plano é puro e não contém:

- access token;
- refresh token;
- client secret;
- endpoint `/api/token`;
- endpoint de revoke inventado;
- `fetch()`;
- mutation local.

## Estado antes/depois do local disconnect

Antes do local disconnect:

```text
nextAction = EXECUTE_LOCAL_DISCONNECT
```

Depois do local disconnect:

```text
nextAction = OPEN_SPOTIFY_CONNECTED_APPS
```

A aplicação pode futuramente usar este contrato para UI/rota, mas este Gate 6C **não expõe botão destrutivo nem executa a desconexão real**.

## Verificação provider-side

Neste gate o Sonoriza não declara automaticamente que a autorização externa foi removida.

```text
providerRevocationVerifiedBySonoriza = false
```

Isso é deliberado: sem endpoint oficial de revogação/verificação apropriado, não devemos transformar uma inferência em fato.

Uma UI futura pode solicitar confirmação explícita do usuário após ele remover o acesso no Spotify, mas essa confirmação será first-party de workflow, não prova criptográfica/provider-side.

## Referências oficiais revisadas

- Spotify Web API — Access Token: `https://developer.spotify.com/documentation/web-api/concepts/access-token`
- Spotify Web API — Refreshing tokens: `https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens`
- Spotify Support — Spotify em outros aplicativos: `https://support.spotify.com/br-pt/article/spotify-on-other-apps/`
- Spotify Connected Apps: `https://www.spotify.com/account/apps/`

## Fora de escopo

- executar `executeSpotifyDisconnect()` para a conta real;
- remover OAuth Spotify em produção;
- abrir automaticamente navegador/provider page;
- criar endpoint/UI destrutivo;
- alegar revogação provider-side sem ação explícita do usuário;
- adicionar dependência HTTP para revogação não documentada.

## Critério de aceite

- contrato fail-closed implementado e exportado;
- testes provam que não existe caminho automático de revogação neste gate;
- CI executa regressões Gate 6A/6B + Gate 6C + typecheck + build;
- nenhuma mutation/provider call em produção;
- documentação registra a decisão e as fontes oficiais.
