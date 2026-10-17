# AUDIOBOOK-02 — Gate D.2: governança de destino + evidência remota inconclusiva

Issue #489; PR D.2 empilhado sobre #493 (D.1) → #492 (C) → #491 (B) → #490 (A). Não mergear, não fazer deploy, não migrar banco produtivo.

## Diagnóstico que motivou a alteração

O editor de destinos `src/app/dashboard/configuracao/destinos/page.tsx` podia mudar `spotifyPlaylistId`, `durationMode`, `fixedDurationSeconds`, `compositionMode`, `updatePolicy` e regras/fontes de um destino já vinculado a `TargetAudiobookOverlay`. Mesmo com a proteção do writer de playlist (Gate B), mudanças no próprio destino quebravam a identidade ou o orçamento virtual do livro.

A API pública do Spotify `GET /playlists/{id}/items` descreve itens como faixas/episódios. Na experiência deste projeto, um livro inteiro aparece como objeto opaco, com `item=null` e sem URI. Isso **não comprova a identidade do livro**; nem a presença de exatamente um `null` nem um snapshot estável autorizam acrescentar/remover itens.

Referências oficiais:
- https://developer.spotify.com/documentation/web-api/reference/get-playlists-items
- https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist

## Gate D.2: proteção local

`withAudiobookTargetSettingsAdmission`, no `write-admission-store.ts`, usa uma transação Prisma e o mesmo registro `TargetAudiobookWriteFence` que os binders e os writes externos:
1. Atualizar o fence dentro da transação para adquirir o lock de registro PostgreSQL.
2. Revalidar `userId`, `targetPlaylistId`, identidade Spotify esperada e que não haja write em andamento ou resultado incerto.
3. Verificar ausência de overlay; **qualquer edição completa de destino protegido falha**, inclusive rename, até existir uma allowlist de edições segura.
4. Executar a edição do destino, seleção de fontes e calendários dentro **da mesma transação e após o guard**. Uma vinculação concorrente no mesmo fence não pode passar simultaneamente ao guard.
5. Para destinos já vinculados, bloquear a edição antes de criar uma playlist nova no Spotify. Se outro processo vincular durante uma chamada remota de pré-validação, o guard transacional ainda aborta a edição local.
6. O mesmo guard cobre alterações de política de descoberta; essas mudanças alterariam candidatos da projeção.
7. A ação de **desativar** destino ainda é permitida (não escreve Spotify); a ação de reativar destino com overlay é bloqueada via filtro atômico.

**Importante:** a proteção é aplicada às rotas **auditadas** de interface de configuração. Exclusão de destino não está implementada nessa tela; cascatas de exclusão de usuário ainda exigem tratamento de privacidade, portanto não se instalou trigger que pudesse impedir exclusão legal de conta. Rotas futuras de atualização/exclusão precisam invocar este guard, com testes. Não afirmar cobertura irrestrita de comandos SQL externos ou acesso administrativo ao banco.

## Gate D.2: snapshot Spotify somente leitura

`POST /api/audiobooks/remote-observation`:
- Só está disponível com `AUDIOBOOK02_BIND_UI_MODE=PREVIEW`, **OFF por padrão**.
- Exige sessão, mesma origem, corpo estrito `targetPlaylistId` + `expectedRevision`, vínculo no usuário, identidade remota inalterada e revisão esperada.
- Usa `SpotifyClient.getTargetPlaylistState`, que lê os snapshots antes e depois de coletar os itens e falha se o conteúdo mudou entre leituras.
- Analisa em memória a quantidade/posição de itens opacos e o total de faixas/episódios conhecidos.
- Devolve sempre `status=BOOK_ID_UNVERIFIABLE`, `remoteBookPresenceVerified=false`, `safeToMutatePlaylist=false`, `eligibleForAutomaticReconciliation=false`. Se não houver item opaco, também **não conclui** que o livro foi removido.
- Revalida revisão, ownership e playlist ID após a consulta remota; erro gera código e nenhuma alteração.
- Exibe o resultado no editor experimental de capítulo; não gera tokens de autorização ou chama escrita Spotify.

## Matriz de cenários

| Cenário | Política Gate D.2 |
|---|---|
| Destino ainda não vinculado, sem write remoto em curso | Editável transacionalmente |
| Destino já vinculado a audiolivro opaco | Bloquear edição completa ou de discovery |
| Tentar trocar ID Spotify de destino vinculado | Bloquear |
| Tentar alterar duração fixa ou modo | Bloquear |
| Write Spotify ativo/resultado incerto | Bloquear configuração |
| Desativar um destino | Permitir sem tocar no Spotify |
| Reativar destino protegido | Bloquear |
| Outro usuário tenta editar target | Bloquear |
| Vínculo + edição concorrentes | Serializar no mesmo fence; só um resultado coerente |
| Snapshot com 1 `null` | Livro não identificado; manter bloqueio |
| Snapshot com 0 `null` | Livro não identificado; manter bloqueio |
| Snapshot mudou entre leituras | Abortado; nenhum provider write |
| Gerar conteúdo ao lado do livro em produção | **Não autorizado**; bloqueio de Gate D.1 continua |

## Limites para outro gate

- Ainda não é possível preencher a playlist automaticamente ao redor de um audiolivro opaco com garantias de não removê-lo. `POST /playlists/{id}/items` aceita URI de track/episode, mas isso não fornece prova da posição/identidade do item opaco nem cobre replay de capítulos.
- O estado real do Spotify pode mudar sem que Sonoriza saiba, mesmo depois de uma leitura estável; não existe garantia sobre futuros writes baseada só em snapshot.
- É necessário auditar outras mutações de destino e exclusões de conta; não bloquear procedimentos de privacidade com triggers gerais.
- O modo `SHADOW` não autoriza escrita e não garante reprodução por cinco minutos. Troca de capítulo segue manual.

## Validação

- [x] Guard transacional compartilha a mesma linha de fence que `withAudiobookOverlayBindAdmission`.
- [x] Configuração e discovery utilizam o guard.
- [x] A UI informa motivo da edição bloqueada; safe disable permanece disponível.
- [x] Endpoints e UI de observação remota são read-only e gated.
- [x] Testes unitários e integração com PostgreSQL descartável escritos para binds concorrentes, ownership, edição protegida e opacidade.
- [ ] CI específico D.2, compatibilidade Gates A/B/C/D e typecheck final.
- [ ] Revisar demais chamadas de mutação target e exclusão de usuário em auditoria futura.
- [ ] Validar visualmente a tela com dados em ambiente de homologação.
- [ ] Aprovação explícita antes de ativação/merge/deploy ou de qualquer escrita Spotify.

**Sem merge, sem deploy, sem alteração de banco produtivo, sem mutação de playlists reais.**
