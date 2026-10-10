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
