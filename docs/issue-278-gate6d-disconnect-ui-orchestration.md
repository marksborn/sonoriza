# #278 — Gate 6D: UI/API segura para disconnect Spotify

## Status

Branch: `issue-278-gate6d-disconnect-ui-orchestration`.

Base: Gate 6C (`e700e14138101158bcf2f4c418966e2fa2108cbf`).

O Gate 6D conecta os contratos dos Gates 6A/6B/6C a uma experiência autenticada de usuário sem reduzir nenhuma garantia de segurança.

## Fluxo

```text
Configuração > Conta e privacidade
        ↓
prepareSpotifyDisconnect(user da sessão)
        ↓
preview + fingerprint + frase exata
        ↓
usuário digita a frase exata
        ↓
POST autenticado sem userId fornecido pelo cliente
        ↓
executeSpotifyDisconnect(user da sessão)
        ↓
SERIALIZABLE + locks + stale-preview + mutations + postcheck
        ↓
limpeza local concluída
        ↓
Spotify Connected Apps
        ↓
usuário remove o acesso manualmente
```

## Boundary de identidade

O endpoint nunca aceita `userId` no payload. O alvo destrutivo é sempre:

```text
session.user.id
```

Isso impede que um usuário autenticado tente fornecer o ID de outra conta ao executor.

## Preview

`GET /api/account/spotify-disconnect` retorna apenas o estado necessário para decisão do usuário:

- versão do contrato;
- fingerprint;
- frase de confirmação quando ainda existe trabalho destrutivo local;
- totais DELETE / SANITIZE / REDACT / CLEAR PAYLOAD;
- totais preservados first-party e independent-origin;
- plano do Gate 6C para revogação no provider.

Nenhum token, refresh token, provider payload bruto ou registro individual é retornado.

Respostas usam `Cache-Control: no-store`.

## Execução

`POST /api/account/spotify-disconnect` aceita somente:

```json
{
  "contractVersion": 6,
  "expectedFingerprint": "<sha256>",
  "confirmation": "DISCONNECT SPOTIFY <12 HEX>"
}
```

O servidor injeta `session.user.id` e delega toda a autorização destrutiva ao executor do Gate 6B.

O botão na UI só habilita quando a frase digitada coincide exatamente com a frase do preview. Isso é somente ergonomia; a proteção autoritativa continua no servidor.

## Stale preview

Se qualquer linha relevante mudar entre preview e execução:

```text
DATA_POLICY_SPOTIFY_DISCONNECT_PREVIEW_CHANGED
```

A UI limpa a confirmação e exige um novo preview. Nenhuma mutation é aplicada porque o Gate 6B faz a comparação dentro da transação antes do purge.

## Estado preservado

A UI deixa explícito que a operação local preserva, conforme o postcheck do Gate 6B:

- usuário Sonoriza;
- OAuth de outros providers;
- Google Calendar selections;
- Last.fm independente e backfills;
- preferências first-party;
- bindings/configuração Sonoriza classificados como first-party.

## Sessão

O Auth.js usa sessão em banco separada da tabela `Account`. Remover `Account(provider=spotify)` não é tratado como `signOut` da conta Sonoriza.

A conta pode continuar acessível pela sessão atual e por outros providers preservados, sujeito às regras normais de autenticação/allowlist.

## Provider revocation

O Gate 6D não adiciona chamada HTTP de revogação ao Spotify.

Após o postcheck local, a UI mostra:

- link para Spotify Connected Apps;
- instrução para `Remover acesso` do Sonoriza;
- link para suporte oficial;
- indicação explícita de que o Sonoriza não consegue verificar a revogação provider-side.

## Arquivos principais

- `src/app/api/account/spotify-disconnect/route.ts`
- `src/app/dashboard/configuracao/conta/page.tsx`
- `src/components/SpotifyDisconnectSettings.tsx`
- `src/services/data-policy/spotify-disconnect-orchestration.ts`
- `src/services/data-policy/spotify-disconnect-orchestration.test.ts`

## Segurança de validação

Durante desenvolvimento/CI:

- nenhuma execução contra o usuário real;
- regressão destrutiva do Gate 6B somente em PostgreSQL descartável/usuário sintético;
- build da rota e UI;
- testes puros do contrato de orquestração;
- nenhum fetch para Spotify;
- nenhuma revogação provider-side;
- nenhuma migration nova prevista.

## Fora de escopo

- executar o disconnect real da conta de produção durante este gate;
- afirmar que o acesso provider-side foi removido automaticamente;
- excluir a conta Sonoriza;
- remover Google/Last.fm;
- alterar a política de retenção v6;
- alterar scopes OAuth neste gate.
