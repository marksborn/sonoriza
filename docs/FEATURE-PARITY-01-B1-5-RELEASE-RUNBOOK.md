# FEATURE-PARITY-B1.5 — Go/no-go, deploy e rollback da Reserva

**Data:** 13/10/2026 · **Issues:** #460 (execução), #458 (paridade) · **Estado:** documentação e ferramenta de verificação, **sem aprovação de deploy**.

## 1. Versões, dependências e critérios de escopo

| Bloco | PR draft | Entrega |
|---|---|---|
| B1.1 | #461 | UI distingue regra configurada de elegibilidade do runtime |
| B1.2 | #462 (base B1.1) | SIMULATION apenas por capacidade e opt-in técnico OFF por padrão |
| B1.3 | #463 (base B1.2) | opt-in individual persistido; migration de tabela nova; gate de produto OFF |
| B1.4 | #464 (base B1.3) | revalidação antes de mutações Spotify e testes de regressão |
| B1.5 | PR desta branch, base B1.4 | verificador read-only e este roteiro |

**Não mesclar os PRs cegamente em sequência:** estão empilhados em branches, não todos com base em `main`. Para o release, congelar os SHAs e revisar um **diff cumulativo da última branch contra o HEAD atual de `main`**; somente depois de revisão e aprovação definir uma PR consolidada para `main` ou rebase/retarget **sem commits duplicados**. Fechar PRs de etapas como superseded somente após a integração final confirmada. Não fazer merge de branch de feature em outra para autorizar automaticamente deploy.

**Fora de escopo:** ligar a Reserva nos outros destinos, mexer na reserva existente, mudar `PLAYBACK_RESERVE_ACTIVE_TARGET_IDS`, mexer em podcasts/discovery ou executar gerações Spotify.

## 2. Proteções que devem continuar válidas

1. `PLAYBACK_RESERVE_RUNTIME_MODE` e `PLAYBACK_RESERVE_ACTIVE_TARGET_IDS` devem conservar os valores efetivos do piloto legado: o novo código não pode alterar sua configuração/resultado.
2. **Novos modos OFF/unset no primeiro deploy:** `PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE` e `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE`. Se qualquer um estiver `ACTIVE`, abortar o deploy dormente e investigar; nunca mudar valores silenciosamente.
3. A ausência de `TargetPlaybackReserveActivation` é OFF por design. Não popular linha de opt-in como parte de migração ou instalação.
4. Simulação por capacidade não autoriza escrita real; `PRODUCT_OPT_IN` necessita opt-in explícito, master ACTIVE, kill switch de produto, destino isolado, política efetiva válida, snapshot/preflight e aprovação de simulação específica.
5. O fingerprint do piloto legado não pode mudar; o novo caminho de produto vincula autorização temporal, política/snapshot e `spotifyPlaylistId`.
6. A cerca B1.4 bloqueia a **próxima mutação** ao notar revogação/mudança; não cancela a requisição HTTP já enviada. Não prometer rollback atômico ou que uma escrita parcial em KEEP_FILLED será revertida automaticamente.
7. A funcionalidade não passa a ser aplicável a `MANUAL` por causa desta entrega. Também não se deve usar simulação multi-target como prova de ACTIVE single-target.

## 3. Gate verificável de deploy dormente

O arquivo `scripts/check-playback-reserve-release-readiness.mjs` é **read-only**, sem conexão DB/Spotify e sem revelar IDs. Ele inspeciona os valores efetivos de variáveis e reporta:

- `globalRuntimeMode`, `productAuthorizationMode` e `capabilitySimulationMode`;
- a quantidade de destinos no piloto legado e SHA-256 da allowlist normalizada (sem imprimir IDs);
- `ready` + `blockers`, com exit code 2 quando inadequado.

**Comparação pré/pós-release é obrigatória:** antes da intervenção autorizada, registrar em arquivo privado o baseline (global mode, count e SHA-256) com `--baseline`. Após instalar o novo código, antes de retomar tarefas agendadas, usar **exatamente** os valores do baseline com `--verify --expect-count=N --expect-hash=SHA256 --expect-runtime=ACTIVE` (substituir ACTIVE se o baseline tiver outro modo). O script passa somente quando os dois modos novos permanecem OFF/unset e o piloto legado é idêntico. A contagem sozinha não basta: ela permitiria substituir um ID por outro.

Exemplo **apenas em checkout de release já revisado**, como usuário do site:

```bash
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br || exit 1
umask 077
node --env-file=.env scripts/check-playback-reserve-release-readiness.mjs --baseline
# Guardar baseline privadamente, nunca postar .env, IDs ou DATABASE_URL
# Após a instalação: conferir com valores anotados
node --env-file=.env scripts/check-playback-reserve-release-readiness.mjs \
  --verify --expect-count=N --expect-hash=SHA256_DO_BASELINE --expect-runtime=ACTIVE
```

**Atenção:** esse arquivo ainda não existe no checkout atual de produção enquanto o PR for draft. Para o baseline antes do deploy, executar uma cópia **exatamente do commit revisado** em checkout de auditoria separado ou no arquivo temporário sob o usuário do site, depois de verificar SHA e conteúdo. Não mudar o checkout da aplicação só para capturar baseline; não assumir que `node` do shell é o mesmo da aplicação. Alternativamente registrar baseline por método read-only independente e reconciliar com a mesma normalização (IDs únicos, trim, sort e join com newline).

O checker não testa saúde, link real, banco, proteção de scheduler, persistência de papéis nem sucesso de geração. Ele é **uma condição necessária, não suficiente**.

## 4. Checklist GO/NO-GO **antes de autorizar o merge**

- [x] Código e estrutura revisados em B1.1–B1.4.
- [x] `PLAYBACK-RESERVE-01`, `CALENDAR-127` e `PODCAST-08` no último SHA do #464 passaram em 13/10/2026.
- [x] Check B1.5 unitário/CLI e testes incrementais externos no SHA de 13/10/2026 aprovados; revalidar se o SHA do release candidate mudar.
- [ ] Gate B1.6 operacional no banco real, após migração em janela aprovada, sem qualquer run/attempt pendente e sem opt-in inesperado.
- [ ] Diff cumulativo `main...B1.5` revisado; nenhuma mudança incidental; análise estática de segredos e migrations concluída.
- [ ] Plano de backup **testado**: backup do banco PostgreSQL consistente com timestamp, cópia da configuração/código ou release anterior e recuperação verificada; armazenados em local seguro.
- [ ] Confirmar release window sem geração agendada em execução. Cron/dispatcher só podem ser pausados com aprovação, anotando estado anterior e plano de retomada.
- [ ] Registrar `git rev-parse HEAD`, `git status --porcelain` (deve estar limpo), processo PM2, e migrações pendentes; manter SHAs e saídas em registro privado.
- [ ] Confirmar a allowlist legacy por hash/contagem e o modo global atual.
- [ ] Homologar UI em desktop e mobile: configurações, opt-in/desautorizar, compatibilidade por tipo de playlist; sem mexer em produção.
- [ ] Aprovação explícita de **merge** e autorização separada de **deploy**; nenhuma flag será ativada por implicação.

**NO-GO automático** para qualquer check falhando, working tree suja, backup não validado, jobs produtivos correndo sem controle, diferença na allowlist/mode, migrations divergentes, ou efeitos inesperados em outras playlists.

## 5. Sequência operacional de deploy (somente após aprovações)

Execução como **usuário CloudPanel do site**, não root, preservando processo existente. Usar janela fora da rotina automática; confirmar que não há run `RUNNING` ou tentativa Spotify em andamento. O exemplo abaixo **não é autorização para executar** e precisa ser adaptado ao checkout/release efetivo.

1. Congelar commit final aprovado e baseline privado; obter backup verificável do PostgreSQL; registrar `.env` e configuração PM2 sem imprimir segredos.
2. Para evitar concorrência com alterações de schema/build, controlar temporariamente o cron/dispatcher e verificar a ausência de writes em trânsito; retomar apenas após smoke e revisão de status.
3. Preparar o código revisado no checkout designado, sem `git pull` arbitrário; `npm ci`; `npx prisma validate`; `npx prisma migrate status` e, com backup confirmado, `npx prisma migrate deploy`.
4. Gerar Prisma Client (`npx prisma generate`) e compilar (`npm run build`); **não reiniciar PM2 se build falhou**. A migração B1.3 adiciona uma tabela, não faz backfill de autorização.
5. Conferir `--verify` com baseline do passo 1. Se o checker não puder rodar ou falhar, **NO-GO para recarregar o processo**.
6. Recarregar o processo pelo método operacional existente (`pm2 reload sonoriza`, verificando nome e usuário do PM2, `--update-env` se necessário). Não inferir nome real do processo sem `pm2 list`.
7. Smoke sem escrita Spotify: autenticação, dashboard, Configuração → Reserva, outros módulos, status PM2, logs, DB migration status e endpoints de leitura autenticados. Confirmar que nenhuma autorização nova foi ativada e que o piloto atual não foi alterado.
8. Retomar o cron controladamente e verificar `TargetScheduleRun`, `GenerationRun` e erros. O dispatcher pode tentar slots ainda devidos no mesmo dia; não retomar sem avaliar esse risco.
9. Registrar o resultado, URL/commit da release, janela de observação e responsável pelo rollback.

### Telemetria de aceitação

Conferir em amostras sem publicar dados pessoais: `playbackReserveRuntime.rolloutSource`, `effectiveMode`, `plannerInfluence`, `spotifyWriteInfluence`, `status`, `productPrewriteChecks`, `rolePersistenceStatus` e contagem de `RESERVE`; comparar com baseline do piloto. Um código carregado com novas flags OFF **não valida** que a reserva funciona em outros destinos.

## 6. Plano de rollback

**Rollback de ativação (preferido):** retornar `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE` e/ou `PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE` para OFF, **sem alterar** `PLAYBACK_RESERVE_RUNTIME_MODE` nem a allowlist legada; recarregar o processo com ambiente efetivo atualizado e provar pelas evidências que o novo caminho não está mais ativo. Alterar `.env` sem recarregar pode não afetar o processo já iniciado.

**Rollback de código:** se a versão nova causar regressão mesmo com novos modos OFF, parar o rollout, manter o cron sob controle, retornar ao **SHA anterior registrado** por procedimento de release aprovado, reconstruir o aplicativo/cliente compatível e recarregar PM2. Não usar `git reset --hard` cegamente e não apagar estado de produção desconhecido. **Não executar downgrade de migration automaticamente.** A tabela adicional inativa pode permanecer até uma mudança de schema revisada; restaurar DB de backup só por decisão explícita após analisar dados criados desde a cópia.

**Escrita externa ambígua ou parcial:** não fazer retry cego após `PROVIDER_WRITE_START`. Consultar estado real/snapshot Spotify, verificar roles e sequência, classificar `UNKNOWN_TIMEOUT` / `PARTIAL` / `FAILED`, e decidir reconciliação manual ou nova geração somente após autorização. Uma revogação não desfaz escrita já enviada.

## 6A. Gate B1.6 — auditoria operacional read-only pós-migração

**O CI da release candidate #466 passou nos nove workflows** no SHA auditado em 13/10/2026. A conclusão do CI não é aprovação automática de deploy e não substitui inspeção do servidor.

O B1.6 acrescenta o script `scripts/check-playback-reserve-operational-readiness.mjs`, executável **somente em checkout do release revisado depois de aplicar a migração B1.3 e gerar Prisma Client compatível**. O script faz apenas `count` no PostgreSQL e nunca lê/transmite nome de usuário, playlist, ID, histórico, credencial ou log.

```bash
# EXEMPLO PARA JANELA DE DEPLOY AUTORIZADA E POST-MIGRAÇÃO
# Executar como usuário CloudPanel da aplicação, após prisma generate:
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br || exit 1
node --env-file=.env scripts/check-playback-reserve-operational-readiness.mjs --check
```

A saída traz somente:
- `generationRunsRunning` e `generationRunsPending`;
- `targetScheduleRunsRunning` e `targetScheduleAttemptsRunning`;
- `productOptInsEnabled` e `productOptInsWithoutConfirmation`;
- `enabledTargets`, `totalTargets`, `ready` e `blockers`.

É **NO-GO** se existir qualquer run/tentativa em andamento ou pendente, consentimento de produto ON inesperado no baseline dormente, erro de consulta/schema ou contagem inconsistente. Um run `RUNNING` pode ser legado/preso, mas não deve ser declarado seguro sem análise; **não terminalizá-lo automaticamente só para passar na checagem**.

A consulta é uma **fotografia do instante**: uma execução pode começar após a leitura. O operador deve controlar o dispatcher e confirmar ausência de in-flight Spotify writes por fontes operacionais antes de executar build/reload. Executar de novo imediatamente antes do reload. O checker não substitui a verificação de lock/lease cron nem oferece garantia transacional contra concorrência.

O CI verifica a consulta e o contrato num banco isolado; **não houve execução desse script no servidor de produção**.

---

## 7. Critério para futura ativação de produto (separado do deploy)

1. Ativar **apenas** a simulação por capacidade, se desejado, em ambiente controlado; verificar que `spotifyWriteInfluence=false`, que não houve writes e que cada simulação é single-target.
2. Aprovar opt-in explícito de **um destino elegível** e validar fingerprint, snapshot, roles e prewrite com casos concorrentes, após testes no ambiente de homologação.
3. Em mudança futura e **separada**, ativar o kill switch de produto para piloto de um destino, supervisionar execução; reverter se qualquer invariável falhar.
4. Não habilitar todos os destinos nem remover allowlists antigas até conclusão dos critérios de paridade da #458 e decisão sobre a janela HTTP de revogação (aceite do risco residual ou protocolo transacional adicional).

**Decisão B1.5:** este artefato prepara o processo; não representa autorização para merge, deploy ou ativar as features.
