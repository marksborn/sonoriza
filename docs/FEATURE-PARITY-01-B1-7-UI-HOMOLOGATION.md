# FEATURE-PARITY-B1.7 — Homologação da UI de Reserva por destino

**Data:** 13/10/2026 · **Issue:** #460 · **Release candidate:** PR #466 (draft)
**Decisão:** gate de UI **automatizado parcialmente**, aguardando **navegador visual e autenticação em staging privado**.

## 1. Escopo da revisão

A página real `/dashboard/configuracao/reserva` continua server-rendered, autenticada e com ações server-side vinculadas ao usuário de sessão. A mudança B1.7 extrai **somente** a seção "Autorização de Reserva por destino" para `src/components/PlaybackReserveTargetConsentForm.tsx`, usando a mesma `saveProductActivation` server action, mesmas classes Tailwind, campo hidden `targetPlaylistId` e mesmo rótulo de status. Não modifica migrações, política de backend, scheduler ou interface Spotify.

A automação não simula OAuth, sessão de produção nem efetua uma alteração no Spotify. Ela renderiza HTML via `renderToStaticMarkup`, com ação fictícia e dados inventados, sem acesso a banco/serviços externos.

## 2. Matriz automatizada de UI (fixtures fictícias)

| Cenário | Contrato testado |
|---|---|
| Destino ligado, Spotify vinculado, `REBUILD_DAILY`, Reserva explícita | Botão "Autorizar Reserva neste destino" visível e habilitado |
| Mesmo contexto com `KEEP_FILLED` | Opt-in visualmente habilitado |
| Destino desativado | Habilitação bloqueada com orientação de correção |
| Destino sem `spotifyPlaylistId` | Habilitação bloqueada |
| Política de atualização `MANUAL` | Habilitação bloqueada |
| Regra efetiva `NONE` | Habilitação bloqueada |
| Opt-in salvo com gate de produto OFF | Mostra "aguardando liberação do sistema", sem afirmar ativação real |
| Opt-in salvo com gate de produto ACTIVE | Descreve que a execução ainda exige simulação aprovada |
| Consentimento já dado, destino posteriormente desativado/desvinculado | A opção **Revogar autorização** permanece habilitada |
| Payload com caracteres de marcação HTML no ID | Valor escapado na renderização |
| Estrutura semântica | Formulário, botão submit e campos hidden preservados, sem recursos externos |

**Comandos CI:** `npx tsx --test src/components/PlaybackReserveTargetConsentForm.test.tsx`; teste é executado no workflow `PLAYBACK-RESERVE-01 validation` antes de `typecheck` e `build`. Testes de ownership e persistência real continuam sob `src/services/playback-reserve-product-activation.integration.test.ts`, com PostgreSQL isolado.

## 3. Verificação manual necessária, ainda NÃO executada

Somente abrir a tela em staging **privado**, com **usuários e destinos fictícios**, após configurar autenticação de teste separada. Não carregar o dump de produção nem suas tabelas OAuth; não copiar `.env` produtivo; não usar o domínio real Spotify; não usar credenciais de produção.

Cenários a homologar:

1. Desktop 1440 e 1024 px: título, badge de política, texto de status e botões legíveis; nenhuma quebra/horizontal scroll, contraste coerente com tema do Sonoriza.
2. Mobile 390 e 320 px: card ajustado à largura, formulários acessíveis via toque, texto de orientação sem truncamento, ordem lógica, teclado/foco e acessibilidade.
3. Acesso como usuário deslogado: redireciona para login, sem exibir preferências.
4. Autenticado como usuário A: mostra somente seus destinos; ID arbitrário de B não autoriza alterações nas server actions.
5. Alternar o estado do consentimento: habilitar elegível, ver texto "Aguardando liberação", revogar, e confirmar leitura persistida; nenhuma escrita/playlist Spotify.
6. Após configurar `NONE`, `MANUAL`, desativar destino ou remover vínculo Spotify em fixture: exibir impedimento ao novo opt-in e **ainda permitir revogação anterior**.
7. `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE` ausente/OFF: o consentimento **não** implica execução de Reserva em runtime; simulações/produção não podem ser disparadas pelo teste visual.
8. No desktop/mobile, abrir/fechar "Editar margem deste destino"; comportamento de navegação e confirmação para global versus override (sem acionar geração real).

**Critérios de aceite:** evidências de navegador (capturas **da instância fictícia**), operador/revisor, dimensões, resultados e eventuais inconformidades anexados à PR #466 ou issue #460. CI verde é requisito, mas **não substitui** essa observação visual.

## 4. Restrições de homologação e implantação

- **Sem** nova instância criada pelo B1.7: preparar preview isolado exigirá configuração de host, autenticação, banco *sintético*, variáveis e isolamento de rede em gate separado; nenhuma autorização de staging produtivo está implícita.
- **Sem** merge, deploy, Prisma migration de produção, mudança de `.env` produtivo, cron, PM2 ou escrita Spotify.
- Não usar o banco temporário `sonoriza_b1_restore_20261013170624_1830493` como staging: contém dados reais, incluindo possíveis tokens OAuth.
- O pré-deploy e a recuperação continuam documentados em `docs/FEATURE-PARITY-01-B1-5-RELEASE-RUNBOOK.md`.
- As limitações da cerca de pré-escrita permanecem: revogação após envio HTTP não reverte mutação em trânsito.

**Estado B1.7:** revisão de contrato UI automatizada em CI, inspeção real desktop/mobile em staging pendente; não declarar `VISUAL_QA_PASSED` com base apenas em SSR.
