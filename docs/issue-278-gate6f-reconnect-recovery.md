# #278 — Gate 6F: reconnect / recovery

## Objetivo

Fechar o caminho de recuperação antes de qualquer desconexão real do Spotify.

O Gate 6F garante que um disconnect local não transforme a limpeza de dados em perda de configuração ou lockout da conta Sonoriza.

## Contrato

```text
Spotify conectado
   ↓
preview + confirmação exata
   ↓
limpeza local transacional
   ↓
bindings/configuração Sonoriza preservados
   ↓
revogação manual em Spotify Connected Apps
   ↓
OAuth autenticado novamente
   ↓
Account(provider=spotify) volta para o MESMO User
   ↓
caches/provider runtime reidratam nas leituras normais
```

## O que deve sobreviver

- `User` Sonoriza;
- OAuth de outros providers;
- seleções Google Calendar;
- Last.fm independente;
- `SourcePlaylist` binding (`kind`, `spotifyType`, `spotifyId`, enabled e regras first-party);
- `TargetPlaylist` e todas as regras de composição/duração/discovery/schedule;
- configuração de `MusicPlaybackPolicy`;
- configuração de `PodcastShowPolicy`;
- binding/configuração de `MusicIngestionRule`;
- preferências explicitamente first-party.

Payload/runtime Spotify continua seguindo o contrato v6: tokens, caches, snapshots, listening state e demais dados provider-derived aplicáveis são apagados, sanitizados ou redigidos.

## Prevenção de lockout

A UI bloqueia a execução destrutiva quando `unrelatedOauthAccount == 0`.

Motivo: uma sessão atual pode expirar. Para haver um caminho durável de retorno, o usuário deve manter ao menos outro OAuth vinculado ao mesmo `User` antes de remover o grant Spotify.

Quando não existe provider alternativo, a tela oferece conectar Google antes do disconnect.

## Reconexão

A reconexão usa `signIn("spotify")` a partir de uma sessão Sonoriza já autenticada. O callback/Auth.js existente vincula o grant ao usuário da sessão e não faz merge silencioso de usuários apenas por e-mail.

Depois do OAuth:

- o mesmo `User.id` permanece;
- os `SourcePlaylist.spotifyId` e `TargetPlaylist.spotifyPlaylistId` preservados continuam sendo os bindings da configuração;
- nomes, snapshots e caches apagados pelo disconnect são reidratáveis pelas próximas leituras normais do provider;
- nenhuma configuração precisa ser recriada manualmente só por causa do disconnect.

## Teste de recuperação

O teste de integração cria um usuário sintético com:

- Spotify OAuth;
- Google OAuth alternativo;
- 4 `SourcePlaylist`;
- 4 `TargetPlaylist`;
- `MusicPlaybackPolicy`;
- `PodcastShowPolicy`;
- `MusicIngestionRule`.

Fluxo validado:

1. captura configuração first-party;
2. executa Gate 6B com confirmação correta;
3. confirma `oauthAccount=0` e preservação de 4 fontes / 4 destinos;
4. compara os objetos de configuração antes/depois;
5. simula o resultado do relink Auth.js criando novamente `Account(provider=spotify)` no mesmo `User.id`;
6. compara novamente toda a configuração;
7. confirma que um novo preview vê Spotify conectado e os mesmos bindings.

O teste não chama Spotify e não usa a conta real.

## Não objetivos

- não executar desconexão real durante Gate 6F;
- não chamar endpoint de revogação inexistente;
- não restaurar listening history/provider analytics apagados pelo contrato v6;
- não criar migration;
- não mudar o `User.id`.

## Aceite

- recovery state exposto pela orchestration/UI;
- execução destrutiva bloqueada sem OAuth alternativo;
- botão para conectar Google como recuperação;
- botão `Reconectar Spotify` quando OAuth local Spotify não existe;
- 4 bindings de fonte e 4 destinos preservados no teste sintético;
- regras de música/podcast/ingestão preservadas;
- OAuth relink volta para o mesmo User;
- regressões Gates 6A–6F, typecheck e build verdes.
