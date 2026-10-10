# PODCAST-08 (#365) — Gate 1/2: contrato de duração, sem influência produtiva

## Status e limites
- Este documento e os arquivos `src/services/playlist-planner/podcast-duration-bands.ts` / `.test.ts` entregam **somente contratos puros/read-only**.
- **Não há** alteração de schema Prisma, de `sequencePattern` persistido, de UI, de fingerprint ativo, de `planPlaylist`, de `planRun`, do scheduler ou de qualquer chamada Spotify. Não ativar nem declarar #365 concluída.
- O novo helper **não está importado pela geração produtiva**. Merge deste Gate 1/2 sozinho deve manter os mesmos planos e ORDER_HASH das playlists existentes.

## Inventário do sistema atual (main conferida em 09/10/2026 BRT)
| Elemento | Código/contrato existente |
|---|---|
| Tipo de sequência | `PlaylistRules.sequencePattern: ContentType[]`, com `MUSIC` e `PODCAST` em `src/services/playlist-planner/types.ts` |
| Persistência atual | `TargetPlaylist.sequencePattern` JSON no Prisma, lida por `parseSequencePattern` de `src/services/playlist-planner/index.ts` |
| Editor | `src/components/TargetPlaylistForm.tsx` usa `ContentType[]` e serializa o campo oculto `sequencePattern` |
| Salvamento | `saveTarget()` em `src/app/dashboard/configuracao/destinos/page.tsx` chama `readSequence` e valida a sequência antes de salvar |
| Autoridade | `src/services/playlist-planner/planner.ts`: sequência escolhe um tipo por posição, usando `pickCandidate`; se não encontra um candidato do tipo que caiba, encerra a sequência |
| Cálculo por evento | `src/services/playlist-planner/plan-run.ts` usa `sequenceStartIndex`, `preserved`, `constraintSeed` e `strictDurationBoundary` |
| Duração efetiva | `Candidate.durationMs` e `podcast-fit.ts` já representam o tempo efetivo restante quando o episódio está em andamento; reutilizar esse valor |
| Política existente | Estado de escuta, replay, ordem, cadência, source scope, limite de duração por destino, calendar fit e exclusividade continuam dominantes |

## Contrato futuro, ainda não aplicado
- Limites **globais** (não por destino): `shortMaxMinutes=30`, `mediumMaxMinutes=60` como valores iniciais, com validação de inteiros positivos, ordem estrita e teto de 1440 minutos.
- Classificação de `Candidate.durationMs`: SHORT <= primeiro divisor; MEDIUM > primeiro e <= segundo; LONG > segundo; duração ausente/zero/inválida => UNKNOWN.
- Slots `PODCAST`: `ANY | SHORT | MEDIUM | LONG`, com `ANY` como default de compatibilidade para os arrays legados de strings.
- `MUSIC`: não aceita banda; payload desconhecido/inválido deve falhar fechado antes de persistência, nunca ser silenciosamente rebaixado para ANY.
- `ANY`: não filtra por duração, porém **não contorna** os filtros canônicos já existentes. Um candidato UNKNOWN pode satisfazer um filtro de banda ANY, mas ainda pode ser vetado por outras políticas.
- Fallback de v1 para avaliação read-only:
  - SHORT → MEDIUM → ANY;
  - MEDIUM → SHORT → LONG → ANY (**decisão proposta, favorece episódios curtos antes de longos; revisão de produto antes do Gate 5**);
  - LONG → MEDIUM → ANY.
- Fallback é somente entre candidatos **já elegíveis**. Regras canônicas de cadência, estado, replay, show cap, ordenação, calendário, prioridade e source scope não podem ser ignoradas para buscar outro candidato.
- A função `previewPodcastDurationSlot` preserva a ordem do pool de entrada em cada etapa de fallback, retorna razão/etapa/banda escolhida e **não é ligada ao planner**.

## Por que NÃO alteramos o JSON persistido agora
O parser ativo `parseSequencePattern` recebe `ContentType[]` e interpreta strings. Salvar objetos novos antes de atualizar **todos** os leitores/writers, prewrite, fingerprints, simulation, manual e scheduler poderia **perder os slots** ou invalidar planos. O Gate 1/2 prepara as regras puras; não habilita gravação do formato novo.

## Próximos gates
1. **Gate 3:** tipar/normalizar os slots persistidos com compatibilidade explícita, criar configuração global Prisma e mecanismo de fingerprint coerente; provar que `ANY` e sequências legadas mantêm equivalência, sem ativação do filtro de banda.
2. **Gate 4:** gerar comparação `SHADOW` em dados/snapshot elegíveis já carregados, sem provider reads extras e sem influenciar o writer. Confirmar cobertura e semântica de `IN_PROGRESS`.
3. **Gate 5:** aplicar seleção/fallback com **mesma autoridade canônica** e guardas de SEQUENCE, cap de episódio/show, regras de SourceScope, estado/cadência e CALENDAR-03. O pool já elegível da função pura não substitui as verificações dinâmicas de programa/URI consumidos por slots anteriores. Registrar reasons e métricas limitadas; provar paridade simulação/manual/scheduler.
4. **Gate 6:** apresentar editor de dois divisores em Configuração→Podcasts e bandas por slot em `TargetPlaylistForm`, junto de preview com fallback legível.
5. **Gate 7:** piloto allowlisted no destino Trabalho, só após revisão de PR, testes e autorização explícita para merge/deploy/ativação.

## Testes neste gate
O workflow `PODCAST-08 duration bands validation` executa testes dedicados de 17 cenários, o planner legado, `npm run typecheck` e `npm run build` com banco de CI; não exige API Spotify produtiva. Testes incluem limites 30/60, boundaries, limites customizados, duração efetiva IN_PROGRESS, UNKNOWN, parser legado ANY, payload inválido, preferências de fallback, ordem canônica e ausência segura de candidato.

## Cuidados de implantação
- Não executar migrations, Spotify writes, gerações manuais/simuladas ou testes com dados produtivos por este gate.
- PR, aprovação de merge, deploy e ativação do comportamento por target continuam separados.
- A issue #365 somente poderá ser fechada quando os gates operacionais e critérios de aceite completos estiverem comprovados.


## Gate 3 — persistência aditiva e fingerprint sem efeito para usuários legados

Implementação no mesmo branch/PR #447, **não mergeada nem aplicada em produção**.

- `prisma/schema.prisma`: novo `PodcastDurationBandSettings` 1:1 com usuário (`shortMaxMinutes=30`, `mediumMaxMinutes=60`); `TargetPlaylist.podcastDurationSlotBands Json?` como **sidecar** da sequência atual, sem alterar `sequencePattern` existente.
- `prisma/migrations/20261010013000_podcast08_duration_band_settings/migration.sql`: migração aditiva `ADD COLUMN`, `CREATE TABLE`, FK CASCADE e constraint SQL `1 <= short < medium <= 1440`; **sem backfill e sem reescrever arrays legados**.
- `src/services/playlist-planner/podcast-duration-persistence.ts`: parser fail-closed para sidecars 1:1, `MUSIC` sempre `ANY`, ausência de sidecar => `ANY` para todos os slots; fingerprint decorator canônico é **exatamente neutro** quando nenhum slot de podcast exige banda específica. Mudanças efetivas de bandas ou divisores alteram o fingerprint; ordenação de targets não altera o hash.
- `src/services/configuration-readiness.ts`: assessment lê somente os novos campos e a configuração de limites; metadados inconsistentes geram issues de configuração e bloqueiam a geração real via CONFIG-04. Fingerprint antigo é preservado quando as bandas são todas `ANY` ou metadata é nula.
- Testes: `podcast-duration-persistence.test.ts` prova neutralidade e detecção de inconsistências; `podcast-duration-persistence.integration.test.ts` usa **Postgres efêmero no CI** para verificar criação dos limites e gravação do sidecar sem modificar a sequência legada. O CI também executa testes CONFIG-04, planner, TypeScript e build.

### Restrições de Gate 3
- Novos campos de banco e leitura do fingerprint **não significam ativação**: nenhum editor escreve o sidecar neste gate e o planner continua usando apenas `ContentType[]`. Ainda não há UI para alterar os divisores.
- Não aplicar esta migração isoladamente antes do merge aprovado. O binário Next/Prisma que lê esses campos exige a migração aplicada **antes do restart/deploy**.
- **Gate 4/5/6 ainda pendentes:** captura e comparação shadow sem mutações, decisão de fallback, runtime e UI com gravação **atômica e validada** do par `sequencePattern`/`podcastDurationSlotBands`. O formulário atual não conhece esse sidecar; para permitir edição de slots com bandas, precisará gravar ambos num único fluxo e prevenir desalinhamento de índices.
- A sequência antiga com `ANY` não muda os planos. A paridade de ORDER_HASH produtivo continua uma obrigação dos próximos gates; não declarar que este PR implementou seleção por faixa.


## Gate 4 — counterfactual *shadow* em memória (sem integração produtiva)

Arquivos:
- `src/services/playlist-planner/planner.ts`: a função produtiva `planPlaylist()` mantém o caminho anterior sem opções novas. `projectPodcastDurationPlan()` é um **entrypoint separado e explícito** para planejamento hipotético, usando a mesma função `pickCandidate`, mesmos guardas de URI, duração/cabimento e limite por programa. Bandas são aplicadas somente nesse entrypoint, com fallback determinístico por slot.
- `src/services/playlist-planner/podcast-duration-shadow.ts`: `comparePodcastDurationShadow()` executa no máximo dois planejamentos **puramente em memória** a partir do mesmo `PlanPlaylistInput` já autorizado/filtrado, preserva o resultado `actual` e registra ordem hipotética, número de posições alteradas, requested/selected, fallback e motivos. Não toca APIs de Spotify/Google, banco nem arquivos.
- `src/services/playlist-planner/podcast-duration-shadow.test.ts`: regressão de **14 cenários**: paridade ANY, seleção SHORT/LONG, fallback, ordem, show cap, limite de destino, fit CALENDAR-03, duração restante IN_PROGRESS, prefixo preserved, strict sequence abstention, proporção abstention e continuidade de índice CALENDAR-02.

### Semântica e limites da evidência

- `READY_SHADOW` **não é** um plano produtivo aprovado, nem prova de playlist inteira. O escopo é **um único bloco de planejamento com candidatos já elegíveis**, sem atribuição de reservas entre destinos, paginação adicional, ou remanejamento de blocos de calendário.
- Os pools **devem** ter passado por política de show, source scope, cadência, estado, replay, disponibilidade e compartilhamento **antes** da comparação. O simulador não reconstitui essas políticas a partir de um catálogo Spotify bruto.
- Para shows com `podcastStrictSequence`, a projeção **abstém** `ABSTAIN_STRICT_SEQUENCE` em vez de apresentar um resultado possivelmente enganoso ao saltar episódios canônicos.
- `ABSTAIN_UNSUPPORTED_COMPOSITION` em `PROPORTION`. `ABSTAIN_INVALID_CONFIGURATION` em bandas/limites inconsistentes. A geração produtiva **nunca recebe** `projectPodcastDurationPlan` neste gate.
- `actualSelectionUnchanged=true`, `plannerInfluence=false`, `spotifyWrites=false`, `databaseReads=false`, `providerReads=false`: atributos estruturais do **módulo puro**, não uma afirmação de que outra parte da aplicação deixou de usar o banco.
- Ainda falta a **ligação ao pipeline de simulação real** com contexto completo de fontes, identidade, estado, compartilhamento e segmentos. Não habilitar uma tela de preview nem prometer comparativo por destino antes desse gate de integração. Caso o contexto completo não esteja disponível, abstain ao invés de publicar sugestões imprecisas.

**Gate de aprovação:** CI verde no código de projeção isolada; depois conectar `SHADOW` no pipeline usando snapshots elegíveis reais, com comparação de `ORDER_HASH` e prova de que os planos produtivos/simulações anteriores não foram alterados. Só o Gate 5 poderá estudar influência real do filtro nos itens selecionados, sob nova aprovação.


## Gate 4B — integração opt-in com a simulação incremental real

Implementado em branch de PR #447, **ainda não implantado**.

- O `planRun` canônico expõe um callback opcional `onPodcast08SingleBlockContext` que recebe **o pool por destino já filtrado**, com política de sharing/URI, scope de fontes, cap de programa, estado de preservação e duração resolvidos pelo fluxo real. O callback não recalcula nada.
- `collectIncrementally` encaminha esse callback nas rodadas normais/replan; o chamador **sobrescreve as referências da última rodada**, evitando executar shadow por página e piorar o pico de memória #442.
- `generate-playlists-incremental.ts` liga esse comportamento exclusivamente quando **`simulate === true` E `PODCAST08_SHADOW_MODE=SHADOW`**, e pelo menos um destino `SEQUENCE` possui sidecar com banda não-`ANY`. Caso contrário, não captura nada nem consulta limites.
- Após a coleta, uma leitura adicional de limites por usuário (`PodcastDurationBandSettings`) e a rotina pura `evaluatePodcast08FinalSimulationShadow` executam um comparativo. O comparativo **abstém** se não há bloco único, se o resultado-base replay não corresponde ao resultado autoritativo (p.ex. por wrappers PODCAST-09 ou reserva), ou em qualquer caso já bloqueado pelo comparador puro.
- O `GenerationRun.summary.podcast08Shadow` recebe dados **limitados**: SHA de ordem real e hipotética, número de posições diferentes, quantidade de fallback, bandas e no máximo 40 slots resumidos. Nunca substitui `plan.targets`, `qualityPassed`, a escrita Spotify ou a ordem final.
- O campo `scope = FINAL_INCREMENTAL_SINGLE_BLOCK_PRE_POSTPROCESS` deixa claro que os hashes são de **antes** do pós-processamento de ordem (MUSIC-06 etc). Essa saída NÃO equivale ao ORDER_HASH final aprovado de publicação e NÃO autoriza seleção por banda.
- Novo teste `podcast-duration-simulation-shadow.test.ts` cobre integração com `planRun` real, exclusão por fonte, reservas entre destinos, mismatch de baseline, abstention e ativação apenas em simulação opt-in. O CI executa esse teste junto aos Gates 1–4 e regressões.
- Não rodar `PODCAST08_SHADOW_MODE=SHADOW` em produção sem autorização e janela de observação; faltam fluxos de escrita validada no editor para bandas específicas e contexto de reprodução com dados reais antes de um piloto.

### O que ainda NÃO está feito
- Não existe UI/editor para salvar bandas por slot ou configurar limites globais; Gate 6 pendente.
- Não existe nova política **produtiva** de fallback. Gate 5 pendente.
- Não há tentativa de coletar páginas Spotify adicionais para satisfazer uma banda: a evidência avalia só candidatos já coletados pela seleção anterior.
- Destinos PER_EVENT e podcasts com sequência estrita não são projetados no Gate 4B; retornam abstention.


## Gate 6A — configuração preparatória da interface, SEM ativação produtiva

Este gate foi adicionado ao PR Draft #447 em 10/10/2026. Embora tenha telas e ações de salvar, **não é um piloto ativado**.

### Configuração global (usuário)
- `/dashboard/configuracao/fontes/podcasts`: painel de limites globais Curto/Médio com apresentação de Longo como > Médio, preenchido por `PodcastDurationBandSettings` (fallback 30/60).
- `saveGlobalDurationBands`: ação servidor autenticada, valida entradas numéricas inteiras e `short < medium <= 1440`, faz `upsert` por `userId` e revalida página/revisão. A alteração não muda a seleção de nenhum destino enquanto suas bandas permanecerem `ANY`.

### Sequência por destino
- `TargetPlaylistForm` mantém agora o estado como **array único de pares** `{type,band}`, e não dois arrays sincronizados. Reordenar/remover/adicionar movimenta o mesmo par; o servidor recebe `sequencePattern` e `podcastDurationSlotBands` da mesma serialização.
- `saveTarget` continua uma **única transação** e grava ambos os campos na mesma instrução `update/create`. `parsePersistedPodcastDurationSlots` rejeita quantidades inconsistentes, MUSIC com banda específica e qualquer payload desconhecido; formulários antigos não podem apagar bandas persistidas.
- UI mostra as quatro opções Qualquer/Curto/Médio/Longo por slot de Podcast e aviso explícito de que a seleção ainda não atua na produção.
- **Trava dupla:** se `PODCAST08_DURATION_EDITOR_ENABLED !== "1"`, os selects estão desabilitados **e a ação servidor também proíbe** gravar bandas específicas novas ou mover a posição de bandas existentes. Ainda permite livremente editar sequências antigas `ANY`.
- O modo `PODCAST08_SHADOW_MODE=SHADOW` é outro gate **independente** e por si só não ativa editor nem seleção produtiva. Não mudar variáveis de ambiente nem ativar em produção sem autorização.

### Validação
- `podcast-duration-sequence-editor.test.ts` verifica pares inseparáveis em reorder/remove/add, serialização consistente, limites 1–20 passos, hidratação legada e guarda de gravação inativa.
- Workflow PODCAST-08 observa agora os arquivos da UI/formulários e executa os testes + typecheck + build.
- Gate 5 de influência autoritativa e Gate 7 de piloto monitorado ainda estão **pendentes**. Não fechar #365 nem fazer merge/deploy por causa deste gate isolado.

### Atenção para homologação
Salvar limites globais e sequências neutras `ANY` é seguro; **não habilitar o editor para gravar bandas não-ANY** antes que a seleção do planner produtivo trate essas bandas corretamente e que o gate CONFIG-04 aprove uma nova simulação. O preview SHADOW 4B ainda abstém para PER_EVENT e sequência estrita. Testes de regressão são condição necessária, mas não substituem testes de UI reais (Android e desktop).


## Gate 5A — seletor por faixa no planner, piloto de **simulação** com autorização explícita

Implementado no PR #447, ainda em Draft, sem merge nem deploy.

- Corrigido o bloqueio de CI do Gate 6A: `src/app/dashboard/configuracao/destinos/page.tsx` agora passa uma cópia mutável ao formulário. Todos os 11 workflows anteriores falharam em `TS4104` no mesmo local; a correção é isolada e será retestada com esta entrega.
- O algoritmo de faixa usa `projectPodcastDurationPlan` no **ponto canônico** de seleção de um destino: aplica as bandas sobre a mesma função `pickCandidate` (reservas de URI, cap por programa, duração máxima, cabimento, estado e ordenação da pool já filtrada). Não cria uma rota de seleção paralela nem novas consultas Spotify.
- `RunTarget.podcast08ActivePolicy` é **opcional e ausente** nos fluxos atuais. Quando não fornecido, `planRun` continua chamando `planPlaylist` sem filtros e preserva `ORDER_HASH` legado.
- `resolvePodcast08ActiveTargetPolicy`: só aprova um destino em `SEQUENCE`, com sidecar específico válido, configuração de limites válida, destino explicitamente allowlisted por ID e ausência de `durationBlocks`.
- Proteções obrigatórias: podcasts `podcastStrictSequence` ou `podcastSequenceStateful` fazem o destino **abster** e usar a seleção legada. Destinos `PER_EVENT` continuam no caminho antigo. Preservação, exclusividade e prioridades originais continuam sob o próprio `planRun`.
- O gate de orquestração exige `PODCAST08_ACTIVE_MODE=ACTIVE` e `PODCAST08_ACTIVE_TARGET_IDS` não vazio. **Apenas simulação pode ativar o novo seletor neste gate.** No código, `productiveWritesApproved: false` está deliberadamente fixo; nem um operador que configure as variáveis em produção consegue usar o novo algoritmo para escrever playlists. Uma migração de Gate 7 e evidência de aprovação explícita serão necessárias antes de permitir essa alteração.
- Evidências resumidas em `GenerationRun.summary.podcast08ActiveGate` quando modo ACTIVE solicitado: destinos autorizados/abstidos, status do último planejamento, quantidade de fallbacks, `spotifyWritesEnabled:false`. O resultado real de simulação pode refletir a seleção por banda apenas para destinos autorizados.
- Testes Gate 5: `podcast-duration-active-gate.test.ts` valida modo, allowlist, write veto, banda/limites inválidos, eventos e estado estrito. `podcast-duration-active-planner.test.ts` compara seleção real em memória, paridade OFF, fallback, show cap, reservas, sequência rígida, eventos, bloqueio de escrita e qualidade. Ambos executados no CI PODCAST-08 junto ao planner legado, CONFIG-04 e build.

### Restrições e Gate 7
- **NÃO habilitar variáveis de ambiente em produção.** A aprovação de simulação não aprova Spotify writes.
- Antes de um rollout produtivo: provar fidelidade de simulação/manual/scheduler, snapshot do destino, composição e authority gates; adicionar revalidação prewrite de bands + limites + config fingerprint e allowlist ativo; monitorar fontes e picos de memória; rodar um único destino piloto e ter rollback.
- A issue #365 permanece aberta. **A PR #447 não deve ser mergeada/deployada automaticamente** enquanto não passar CI e revisão operacional.
