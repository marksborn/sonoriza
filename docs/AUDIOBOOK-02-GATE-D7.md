# AUDIOBOOK-02 — Gate D.7: caderno manual persistente + histórico de capítulos

Issue #489; stack D.7 → D.6 #498 → D.5 #497 → D.4 #496 → D.3 #495 → D.2 #494 → D.1 #493 → C #492 → B #491 → A #490.

## Decisão

Criar persistência opt-in **só para dados fornecidos pelo usuário**, isolada em duas tabelas próprias. **Não** transformar duração digitada em dado verificado pela API Spotify. **Não** alimentar `TargetAudiobookOverlay`, `GenerationRun`, Gate D SHADOW, `spotifyRequestAttempt` ou qualquer rota de escrita Spotify. Nenhuma alteração de playlist, reprodução ou capítulo remoto está autorizada.

A distinção `USER_DECLARED_UNVERIFIED` é obrigatória **no banco, DTO, UI e histórico**, mesmo após salvar. O termo “salvo” significa apenas “anotação local no Sonoriza”, nunca “verificado/associado no Spotify”.

## Dados persistidos (duas tabelas separadas)

- `TargetAudiobookManualNotebook`: owner `userId`, destino `targetPlaylistId`, revisão monotônica (1,2,...), livro/capítulo **textuais** (até 120 chars), duração declarada e consumo em ms, orçamento FIXED lido do banco, `evidenceSource='USER_DECLARED_UNVERIFIED'`, timestamps.
- `TargetAudiobookManualEntry`: histórico de snapshots por revisão, registro completo do estado informado. `@@unique([notebookId,revision])`, índice de consulta por usuário e trigger que impede **UPDATE** dos eventos existentes.
- Sem colunas `spotifyAudiobookId`, `selectedChapterId` ou relações com overlay, write fence ou GenerationRun. Cada notebook tem FK composta `[userId,targetPlaylistId]` para ownership. Excluir o destino/usuário apaga o caderno e histórico em cascata, conforme integridade do restante do produto.
- Restrições SQL: `evidenceSource` deve ser EXATAMENTE `USER_DECLARED_UNVERIFIED`; duração máxima 24h e positiva, consumo não negativo e inferior ao capítulo, capítulo virtual não pode ultrapassar tempo FIXED informado. Revision >= 1.
- Histórico é **append-only pela aplicação**: não há rota de update/delete de evento individual. A função/trigger SQL impede UPDATE retroativo. Delete da *coleção inteira* é intencional e expresso na UI, permitindo apagar dados por privacidade. Não afirmar que os eventos são irremovíveis por administradores SQL.

Migration: `prisma/migrations/20261017190000_audiobook_d7_manual_notebook/migration.sql`.

## Escrita e concorrência

`src/services/audiobooks/d7-manual-notebook-store.ts` usa `prisma.$transaction` e **CAS por revision**:
1. Exige dono autenticado do TargetPlaylist; FIXED, ID de playlist válido e orçamento positivo, sem overlay verificado já presente (não criar falso duplo vínculo).
2. Repete cálculo puro do D.6 com o orçamento **lido do banco**, nunca com duração escolhida pelo cliente.
3. Novo notebook exige `expectedRevision=0`; revisão inicial vira 1. Atualizar exige revisão exata, `updateMany` com CAS atômico e increment; stale/replay falha.
4. Na MESMA transação, insere no histórico um snapshot para a nova revision. Erro em qualquer etapa desfaz toda a operação.
5. GET só consulta dados do usuário e devolve últimas 50 revisões, nunca dados da conta Spotify.
6. Exclusão inteira exige revisão atual e consentimento `EXCLUIR_CADERNO_MANUAL_E_HISTORICO`; não tem método de delete parcial nem alcance de outras contas.

As restrições de provenance e budget são protegidas no SQL contra gravações acidentais/manuais que ignorem o serviço. O fluxo não tenta calcular orçamento em plano real, nem ativa a escrita de músicas do Spotify.

## API

`/api/audiobooks/manual-notebook`:
- `GET ?targetPlaylistId=<cuid>`: lê notebook atual e até 50 entradas da conta logada; no-store.
- `POST`: explicitamente salva com `expectedRevision`, `bookTitle`, `chapterLabel`, `chapterDurationMs`, `selection`, `confirmation='SALVAR_ANOTACAO_NAO_VERIFICADA'`. Validação de payload EXATA: rejeita Spotify IDs, duração-alvo do cliente e `durationEvidence` inseridos no request.
- `DELETE`: apaga caderno/histórico **do próprio usuário** com `targetPlaylistId`, `expectedRevision` e `confirmation='EXCLUIR_CADERNO_MANUAL_E_HISTORICO'`.
- POST/DELETE exigem sessão + Origin/Host idênticos. Todas as respostas são `no-store`. Erros genéricos não expõem credenciais. Nenhum GET/POST/PUT/DELETE ao Spotify.

## Flags: TODAS OFF por padrão

O endpoint e o botão de salvar só existem se três condições forem verdadeiras simultaneamente:
- `AUDIOBOOK02_BIND_UI_MODE=PREVIEW`
- `AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE=PREVIEW`
- `AUDIOBOOK02_MANUAL_NOTEBOOK_MODE=ACTIVE`

A flag de notebook é **independente** de `AUDIOBOOK02_BIND_MODE`, `AUDIOBOOK02_WRITE_FENCE_MODE` e `AUDIOBOOK02_PLANNER_MODE`; não as altera nem concede permissão de escrita Spotify. Não configurar em produção sem autorização expressa, nem rodar migrations no banco produtivo nesta fase.

## Interface

`AudiobookSelfReportedPreview` conserva a calculadora offline (D.6). Se o notebook experimental for liberado:
- botão “Salvar anotação manual (não verificada)” exige checkbox explícito;
- GET carrega revisão/histórico **somente do destino selecionado**, reseta o estado quando troca;
- em falha/conflito de revisão orienta a recarregar, sem sobrescrever silenciosamente;
- mostra últimas 50 revisões do livro/capítulo, duração e consumo;
- checkbox separado e botão **Apagar caderno e histórico** para exclusão integral dos dados;
- a prévia ainda é descartada a cada recarga. Só o registro *explicitamente salvo* persiste.

Quando flag de notebook OFF, a experiência D.6 conserva a mensagem “não salva nada no banco” e o botão não aparece.

## Validações

- [x] Schema + migração isolados e constraints PostgreSQL.
- [x] Contrato tipado, validação de origem e CAS transacional.
- [x] UI opt-in com consentimento para salvar e para excluir.
- [x] Testes unitários de payload, flag, SSR e write isolation.
- [ ] CI migração em PostgreSQL descartável + validação real de create, update revision 2, histórico 2→1, acesso de outro usuário, concorrência obsoleta, constraints, imutabilidade e exclusão em cascata.
- [ ] Typecheck completo e oito workflows herdados.
- [ ] Teste visual/browser Chrome e Android, contas Spotify reais, **não executados**.
- [ ] Revisão, aprovação do deploy/migration/flags; **NÃO AUTORIZADOS**.

## Gate seguinte (proposta)

D.8 — estudar leitura consultiva destes cadernos como orçamento **exclusivamente manual** em simulação separada do planner real, com revisão/provenance obrigatórios; jamais promover automaticamente a overlay verificado. A introdução de escrita Spotify continuaria vedada.
