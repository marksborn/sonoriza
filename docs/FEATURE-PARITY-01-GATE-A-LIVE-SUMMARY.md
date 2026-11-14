# FEATURE-PARITY-01 — Gate A, auditoria operacional (resumo público)

Data: 13/10/2026. Referência: issue #458 e PR draft #459.

A execução somente leitura do inventário foi concluída na instalação Sonoriza. O relatório detalhado, que contém nomes e políticas individuais, foi preservado privadamente; não publicar no GitHub o JSON integral, IDs, e-mails, allowlists, segredos ou nomes de destinos da coleta.

## Constatações verificadas

- O inventário de destinos da conta auditada difere da fotografia histórica de 10/10/2026. A fotografia antiga não deve substituir a leitura atual.
- Existe evidência de runtime efetivo por destino para execuções SCHEDULED, com recursos globais maduros e outros dependentes de allowlists, gates e consentimento.
- Uma flag ACTIVE na configuração não basta: podem ocorrer ACTIVE com plannerInfluence=false, SHADOW por target não autorizado, ou preferências de destino desabilitadas.
- Sincronização operacional de Saved Tracks e utilização como fonte no planner são duas capacidades independentes.
- A ativação global do runtime Discovery não força Discovery habilitado em cada destino.
- As faixas de duração PODCAST-08 não foram generalizadas. Dados legados de banda devem ser interpretados como ANY quando válidos, e não automaticamente como corrupção.
- Os últimos runs não provam paridade completa entre MANUAL, SCHEDULED e SIMULATION. Multi-target não equivale a ACTIVE em execução individual.
- Falhas de run nos sumários compactos requerem inspeção separada de errors/logs antes de atribuir uma causa.

## Gate A — estado

**LIVE_SNAPSHOT_COLLECTED / SCHEDULED_EVIDENCE_REVIEWED / CROSS_TRIGGER_PARITY_PARTIAL**.

- [x] Snapshot de configuração e elegibilidade capturado sem escrita.
- [x] Evidência por destino para SCHEDULED classificada no relatório privado.
- [x] Lacunas de flags/consentimento e diferenciação configurado vs. efetivo identificadas.
- [ ] Cobertura por destino/trigger e evidência de aplicação real em manual e simulação.
- [ ] Confirmação de detalhes funcionais e UX mobile/desktop.
- [ ] Validação antes de remover quaisquer gates ou shadows.

## Próximo trabalho

Gate B: concluir gradualmente funcionalidades existentes por **capacidade do destino**, começando por Playback Reserve e continuando por identidade canônica, continuidade de podcasts, fonte de curtidas e Discovery. Disponibilidade global de controles **não implica ativação automática**. Preservar modo, política, consentimento, defaults, source scope, PREWRITE, snapshots e rollback; nenhuma mudança em produção é autorizada por este documento.

A PR #459 continua draft e a issue #458 permanece aberta.
