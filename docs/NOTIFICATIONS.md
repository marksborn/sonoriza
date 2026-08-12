# NOTIFY-01 — notificações operacionais

A NOTIFY-01 usa a PWA-01 para entregar Web Push após o resultado operacional já ter sido persistido. Push é um efeito colateral secundário: falha de entrega nunca altera o resultado de geração, manutenção ou limpeza e nunca repete uma mutação Spotify/Google.

## Eventos

- `KEEP_FILLED` e `REBUILD_DAILY`: usam `TargetScheduleRun` final como fonte canônica;
- geração manual real: usa `GenerationRun` e `GenerationItem` já persistidos;
- limpeza automática de música: usa `MusicSourceCleanupRun`;
- `BLOCKED`/`FAILED`: categoria de erro;
- `NOOP`: opt-in separado e desativado por padrão;
- simulações não geram push.

A geração agendada persiste também o detalhamento de músicas/podcasts adicionados e suas durações no resumo canônico do destino. A notificação apenas apresenta esses dados; ela não recalcula o planner.

## Opt-in

A tela `/dashboard/configuracao/notificacoes` não solicita permissão ao carregar. O prompt do navegador só é aberto após a ação explícita **Ativar notificações**.

Cada navegador/dispositivo mantém sua própria `PushSubscription`. A mesma conta pode ter vários dispositivos ativos. O endpoint da subscription é identificado no banco por SHA-256; `auth`, `p256dh` e endpoint nunca devem aparecer em logs.

## Preferências

Por usuário:

- geração/manutenção concluída: ligada por padrão;
- limpeza concluída: ligada por padrão;
- erro/bloqueio: ligada por padrão;
- nenhuma alteração (`NOOP`): desligada por padrão.

Desativar um dispositivo invalida somente a subscription daquele navegador. Desativar uma categoria também impede retries pendentes daquela categoria: a entrega é marcada como suprimida em vez de ser enviada depois.

## Idempotência e retry

`PushDelivery` é único por `(subscriptionId, eventKey)`.

Chaves de evento:

- agenda: `target-schedule:<runId>:<attempt>`;
- geração manual: `generation:<runId>`;
- limpeza: `music-cleanup:<runId>`.

O contador de `attempt` da agenda permite notificar uma nova tentativa real do mesmo slot sem duplicar uma mesma tentativa.

Erros `404`/`410` do provedor tornam a subscription stale e a desativam. Falhas transitórias usam retry independente com espera progressiva e limite de tentativas. O endpoint `/api/cron/notifications` pode executar apenas os retries, sem Spotify/Google.

Além disso, `/api/cron/generate` chama o retry antes de verificar backoff do Spotify. Como o dispatcher produtivo já chama esse endpoint periodicamente, não é necessário criar um segundo crontab para a NOTIFY-01.

## VAPID

A aplicação usa `web-push` 3.6.7. Gere o par VAPID uma única vez no ambiente administrativo:

```bash
npx web-push generate-vapid-keys --json
```

Configure somente no servidor:

```text
WEB_PUSH_VAPID_PUBLIC_KEY=...
WEB_PUSH_VAPID_PRIVATE_KEY=...
WEB_PUSH_VAPID_SUBJECT=mailto:operacao@example.com
```

A chave pública pode ser entregue ao navegador autenticado. A chave privada é secret de servidor e não pode ser enviada ao cliente, registrada em log ou commitada.

## Service worker

`public/sw.js` mantém a política da PWA-01:

- nenhum `fetch` handler;
- nenhuma Cache API;
- nenhum cache de `/dashboard`, `/api`, `/auth` ou HTML autenticado;
- listeners adicionais somente para `push` e `notificationclick`;
- clique aceita somente URLs internas sob `/dashboard`, com fallback para `/dashboard`.

## Deploy

Antes de ativar a funcionalidade em produção:

1. executar `prisma migrate deploy`;
2. configurar as três variáveis VAPID no ambiente do usuário da aplicação;
3. executar `npm ci` para instalar a dependência `web-push` travada no lockfile;
4. executar `npm run typecheck` e `npm run build`;
5. reiniciar o serviço como o usuário da aplicação;
6. confirmar `/dashboard/configuracao/notificacoes`;
7. ativar explicitamente uma subscription em um dispositivo;
8. validar um evento operacional real somente após autorização específica para esse teste.

O deploy não deve criar uma subscription automaticamente nem solicitar permissão de notificação.
