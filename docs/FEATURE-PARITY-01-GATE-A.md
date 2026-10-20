# FEATURE-PARITY-01 — Gate A: inventário inicial e matriz por capacidade

**Data:** 13/10/2026 · **Issue mãe:** [#458](https://github.com/marksborn/sonoriza/issues/458) · **Estado:** `SOURCE_AUDITED / HISTORICAL_TARGET_SNAPSHOT / LIVE_RUNTIME_PENDING`.

Este documento registra **evidência de código da branch `main`** e uma **fotografia operacional histórica de 10/10/2026** relatada na [#449](https://github.com/marksborn/sonoriza/issues/449). **Não contém um snapshot atual do banco, dos `.env` de produção ou dos `GenerationRun.summary` reais**, portanto não declara nenhum recurso globalmente ativo. Não autoriza alterar produção, configurar flags, gerar playlists, fazer Spotify writes, merge ou deploy.

## 1. Estados separados (não confundir)

- **COMPATÍVEL:** a forma/capacidade do destino permite usar o recurso.
- **CONFIGURÁVEL:** há controle de produto persistido e editável pela UI.
- **GATEADO:** a implementação existe, porém exige flag, allowlist, consentimento, simulação aprovada ou contexto operacional específico.
- **EFETIVO:** `GenerationRun.summary` de uma execução real prova `ACTIVE` naquele `target × trigger` sem abstention. Somente configuração no `.env` **não** basta.
- **PENDENTE:** ainda demanda implementação, testes e UX próprios; não ativar só por existir documentação, schema ou shadow.
- **NÃO APLICÁVEL:** incompatibilidade estrutural, explicada (e não ocultada) na UI.

## 2. Matriz histórica de destinos × capacidade

Evidência [#449](https://github.com/marksborn/sonoriza/issues/449): em **10/10/2026**, seis destinos, quatro habilitados com `SEQUENCE` e agendamento, dois desabilitados com `PROPORTION/MANUAL`. Não inferir que permaneçam iguais no dia 13.

| Destino (fotografia 10/10) | Ativo | Composição | Atualização | Podcast por slot | Reserva por política | Estado efetivo das features |
|---|---|---|---|---|---|---|
| Carro | Sim | SEQUENCE | KEEP_FILLED | Possível se houver slots/sources PODCAST | Potencial, sujeito a snapshot/preflight | **A verificar em runtime** |
| Trabalho | Sim | SEQUENCE | REBUILD_DAILY | Possível se houver slots/sources PODCAST | Potencial, sujeito a gates | **A verificar em runtime** |
| Academia | Sim | SEQUENCE | KEEP_FILLED | Possível se houver slots/sources PODCAST | Potencial, sujeito a snapshot/preflight | **A verificar em runtime** |
| Avulsa | Sim | SEQUENCE | REBUILD_DAILY | Possível se houver slots/sources PODCAST | Potencial, sujeito a gates | **A verificar em runtime**; identidade teve canary validado na #374 |
| Destino inativo A (nome não publicado) | Não | PROPORTION | MANUAL | **N/A** para bandas por slot | Não elegível ao runtime atual de Reserva | Sem geração ativa; exigir simulação interna isolada |
| Destino inativo B (nome não publicado) | Não | PROPORTION | MANUAL | **N/A** para bandas por slot | Não elegível ao runtime atual de Reserva | Sem geração ativa; exigir simulação interna isolada |

**Importante:** fontes como `Escutar` e `Adicionar` podem ser **fontes**, não presumir que sejam `TargetPlaylist`; verificar entidade e relações no banco. O código permite combinações novas além dos quatro nomes históricos.

## 3. Matriz de funcionalidades × elegibilidade × evidência

| Recurso | Compatibilidade de produto | Evidência da `main` | Situação de paridade / decisão |
|---|---|---|---|
| Composição `PROPORTION/SEQUENCE`, duração e ordem | Todos os destinos; sequência de slots somente em `SEQUENCE` | `prisma/schema.prisma`, `src/components/TargetPlaylistForm.tsx` | **Configuração geral existente**; testar por modo e fonte |
| Fonte global ou `SELECTED_ONLY`, exclusividade entre targets | Todos os destinos, respeitando fontes habilitadas | `TargetPlaylist.sourceScopeMode`, `sharingPolicy`, `TargetPlaylistSource`, `generate-playlists-incremental.ts` | **Configuração/guardas existentes**; não expandir fontes implicitamente |
| Música curtida / Saved Tracks no planner | Destinos com música, preferência habilitada e consentimento válido | #186; `NativeSourcePreference` no schema; flows de liked source/shadow | **Caminho existente com gate**; provar efetividade por usuário/destino/trigger e retirar dependência de listas fixas somente após validação |
| MUSIC-07 exposição/cooldown | Destinos elegíveis com música | #343; `MUSIC_07_ELIGIBILITY_MODE/SCOPE` (`ALLOWLIST/GLOBAL`) | **Global tecnicamente previsto**, mas `.env` real/`GenerationRun` não verificados; isolamento por target obrigatório |
| Discovery atual (3 intensidades, famílias) | Destinos com música e fonte/contexto válidos | `TargetDiscoveryForm`, `target-discovery-runtime-policy`, #376 | **Controles por destino existentes**, mas runtime requer master + allowlist de usuário; não inferir ativo a partir do toggle |
| Playback Reserve | `KEEP_FILLED`/`REBUILD_DAILY` com contexto válido; `MANUAL` não suportado pelo gate atual | `configuracao/reserva/page.tsx`, `playback-reserve-shadow-runtime.ts`, #354 | **UI global e override por destino existentes**; `ACTIVE` exige target único autorizado e, para `KEEP_FILLED`, snapshot/preflight; verificar por trigger |
| PODCAST-09 continuação `IN_PROGRESS` | Destinos com podcast e política elegível | `generate-playlists-podcast09.ts`, #421 | **Implementada com gates** separados para SIMULATION, MANUAL real e SCHEDULED real; validar `effectiveMode` por target/trigger |
| PODCAST-08 banda `ANY/SHORT/MEDIUM/LONG` por slot | Somente `SEQUENCE` contendo slots e fontes de PODCAST | `TargetPlaylist.podcastDurationSlotBands`, `TargetPlaylistForm` (editor gateado), #365 #448 #449 #451 | **Pendente** head-of-line/strict sequence, prévia efêmera e mobile; não ativar globalmente |
| MUSIC-IDENTITY canônica | Destinos de música compatíveis quando consumer específico estiver migrado | `canonical-dedupe-runtime.ts`, `generate-playlists-music-identity.ts`, #374 | **Canary Avulsa histórico**; exige par exato `user:target`; demais consumers e rollout não concluídos |
| Discovery Inbox e estratégias novas | Futuramente destinos de música opt-in | #375 #376 (ausência dos contratos finais) | **Pendente**; manter Discovery atual sem migração silenciosa |
| Álbum completo como bloco indivisível | Futuramente destinos com música/álbum opt-in | #377; fila `Adicionar` da #102 é separada | **Pendente**; não confundir fila/recomendação com unidade de planejamento |
| Atualizar só após uso (`AFTER_TARGET_USE`) | Destinos com atualização automática e evidência positiva adequada | #402; `updatePolicy` existente é como atualizar, não quando atualizar | **Pendente**; contrato de evidência do destino não implantado |
| Lease/redistribuição de conteúdo não consumido | Destinos com exclusividade e remoção remota comprovada | #403; docs arquiteturais | **Pendente**; nunca liberar só por expiração/ausência de scrobble |
| Outros backlogs: curadoria skips, Novidades, Fora da bolha, pesquisa de podcasts | Conforme tipo e consentimento | #319 #161 #203 #209 | **A rastrear separadamente**; não bloqueiam inventário de recursos existentes |

## 4. Lacunas operacionais que impedem concluir Gate A

1. **Banco de produção, agora:** enumerar todos os destinos reais (`enabled`, `compositionMode`, `sequencePattern`, slots/bandas, `updatePolicy`, sources, calendários, Discovery, exclusividade), **sem publicar IDs privados**. Dados da #449 têm data de 10/10, não são prova atual.
2. **Ambiente efetivo:** confirmar, sem divulgar os valores de allowlists ou secrets, master flags e presença de autorizações para MUSIC-07, MUSIC-IDENTITY, Liked, Discovery, Reserva, PODCAST-09 e PODCAST-08. Um modo solicitado não significa `ACTIVE` efetivo.
3. **Run summaries por target × trigger:** medir `MANUAL`, `SCHEDULED`, `SIMULATION` separadamente. `GenerationRun.summary` pode ser agregado; **não atribuir resultado multi-target a target individual**.
4. **Distinção funcional entre N/A, BLOQUEADA e DESLIGADA POR ESCOLHA:** um destino `PROPORTION` não recebe bandas por slot, mas pode ter podcasts; destino inativo continua configurável, porém **a UI pública `/api/generate` não permite simulação de disabled** (#449).
5. **Validação de interface:** verificar controles desktop/mobile, explicação do motivo da indisponibilidade e simulação isolada sem alterações no Spotify. A #448 mantém pendência de largura mobile.
6. **Gates de segurança:** preservar consentimento e data provenance, strict sequence, calendários, `KEEP_FILLED` snapshots, quota, source scope e não introduzir Spotify writes em auditoria.

## 5. Coleta operacional read-only preparada

Script: [`scripts/report-feature-parity-inventory.mjs`](../scripts/report-feature-parity-inventory.mjs).

No servidor (raiz do projeto Sonoriza, com `node` e `@prisma/client` já instalados), executar **somente após o PR ser disponibilizado no checkout desejado**:

```bash
SONORIZA_AUDIT_EMAIL='EMAIL_DA_CONTA_A_AUDITAR' \
  node --env-file=.env scripts/report-feature-parity-inventory.mjs \
  > /tmp/sonoriza-feature-parity-gate-a.json
```

### Execução sem checkout, merge ou deploy (preferida)

Como a PR permanece em draft, **não é necessário nem recomendado trocar o checkout de produção**. Executar via SSH no servidor, a partir da raiz do app, importando o script da própria branch draft apenas pela entrada-padrão do Node (sem gravar código no diretório do aplicativo):

```bash
cd /home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br || exit 1
set -euo pipefail
umask 077
read -r -p 'E-mail da conta Sonoriza que deve ser auditada: ' SONORIZA_AUDIT_EMAIL
export SONORIZA_AUDIT_EMAIL
REPORT="$(mktemp /tmp/sonoriza-feature-parity-gate-a.XXXXXX.json)"
gh api 'repos/marksborn/sonoriza/contents/scripts/report-feature-parity-inventory.mjs?ref=docs%2Ffeature-parity-458-gate-a' --jq '.content' | base64 -d | node --env-file=.env --input-type=module - > "$REPORT"
node -e 'const j=require(process.argv[1]);console.log(JSON.stringify({audit:j.audit,counts:j.counts,targets:j.targets.map(t=>({name:t.name,enabled:t.enabled,composition:t.composition,updatePolicy:t.updatePolicy})),runCount:j.recentRuns.length},null,2))' "$REPORT"
printf 'Relatório completo (privado): %s\n' "$REPORT"
```

Pré-requisitos: `gh` funcional no servidor, Node com suporte a `--env-file` e `@prisma/client` instalado no diretório do Sonoriza. O comando **não faz checkout nem executa build**; somente cria um JSON temporário privado em `/tmp`, realiza consultas read-only e exibe um resumo curto. **Não cole o JSON completo na issue/PR pública.** Encaminhe o relatório privadamente para a classificação final da matriz.

> Se `node` no shell root não estiver no PATH correto, execute usando o Node já utilizado pelo usuário do site; não instale ou atualize Node para realizar esta auditoria.

O script realiza apenas `Prisma.findFirst/findMany` e imprime relatório local com nomes dos destinos, dados por capacidade, flags solicitadas sem revelar allowlists e recorte de até 24 últimos runs. **Não chama Spotify/Google/Last.fm, não gera playlist, não grava banco e não altera `.env` ou PM2.** A extração de sumários é conservadora e não deve se passar por prova de paridade se não houver evidência `effectiveMode` individual. O arquivo em `/tmp` deve ser tratado como **privado**; ele contém nomes de playlists e não deve ser colado integralmente em issue pública.

## 6. Próximos critérios verificáveis

- [x] Levantamento do schema, UI, gates e dependências no código.
- [x] Matriz preliminar por capacidade com fotografia histórica identificada.
- [x] Instrumento de coleta somente leitura e sem IDs/allowlists no output preparado (**execução real pendente**).
- [ ] Executar leitura de produção e classificar cada destino e todos os gatilhos.
- [ ] Conferir `effectiveMode` e abstention dos runs recentes por recurso e destino.
- [ ] Homologar e registrar diferenças entre UI e runtime com evidência repetível.
- [ ] Consolidar matriz definitiva `feature × target × trigger × estado` e priorizar Gate B sem ativação massiva.

### Fontes principais

- [Schema `TargetPlaylist`/`GenerationRun`](https://github.com/marksborn/sonoriza/blob/main/prisma/schema.prisma)
- [Tela Configuração → Destinos](https://github.com/marksborn/sonoriza/blob/main/src/app/dashboard/configuracao/destinos/page.tsx)
- [Editor de playlists](https://github.com/marksborn/sonoriza/blob/main/src/components/TargetPlaylistForm.tsx)
- [Discovery: resolução de runtime](https://github.com/marksborn/sonoriza/blob/main/src/services/music-discovery/target-discovery-runtime-policy.ts)
- [Reserva: resolução de runtime](https://github.com/marksborn/sonoriza/blob/main/src/services/playback-reserve-shadow-runtime.ts)
- [PODCAST-09: gate por trigger](https://github.com/marksborn/sonoriza/blob/main/src/jobs/generate-playlists-podcast09.ts)
- [MUSIC-IDENTITY: rollout](https://github.com/marksborn/sonoriza/blob/main/src/jobs/generate-playlists-music-identity.ts)
- [PODCAST-08: editor gateado](https://github.com/marksborn/sonoriza/blob/main/src/components/TargetPlaylistForm.tsx)
- [Fotografia de produção de 10/10/2026](https://github.com/marksborn/sonoriza/issues/449)