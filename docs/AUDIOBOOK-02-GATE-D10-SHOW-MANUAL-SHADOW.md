# AUDIOBOOK-02 D.10 — Spotify /show/ como referência manual e cálculo SHADOW

Issue #489. Referência previamente validada: `https://open.spotify.com/show/5E76EUAq7or1ncd4QNyHjI` é o livro narrado **1984** no Spotify (apresentado como `/show/`), com capítulos que o usuário controla manualmente. **Não reclassificar como podcast convencional no Sonoriza.** O Spotify pode representar o conteúdo como um show, mas a UX primária pertence a Audiolivros.

## Entrega

- Parser estrito para URLs HTTPS `open.spotify.com/show/{22-char-id}` ou URI `spotify:show:{id}`; `si` e `utm_` removidos na canonicalização. Não confundir com `spotify:audiobook:`, episódio ou IDs de catálogo. A proveniência permanece `USER_DECLARED_UNVERIFIED`.
- D.6/D.7: formulário manual recebe referência do show **opcional**. D.7 valida e persiste `spotifyShowId` com a revisão do livro, e recusa trocar por outro show durante a mesma leitura. D.9 preserva a referência também em TODAS as revisões arquivadas. Migração aditiva, antiga base recebe `NULL`.
- Ao reler a anotação existente, UI preenche link e dá atalho de abrir no Spotify. O usuário permanece responsável por trocar capítulos e pela presença do livro inteiro na playlist.
- D.10 shadow: nova flag `AUDIOBOOK02_MANUAL_PLANNER_MODE=SHADOW`, **OFF por padrão**, exige `AUDIOBOOK02_SINGLE_READING_MODE=ACTIVE` e gates D.7/fence. Apenas durante simulação, projeta capítulo manual sobre **pools reais já coletados, respeitando fontes configuradas** e chama a função puramente local `planPlaylist` com orçamento `targetDurationMs - (chapterDurationMs-consumedMs)`. Resultado no resumo `audiobookD10ManualShadow`; nenhum item/cálculo D.10 é enviado à escrita Spotify.
- A projeção exige uma leitura ativa válida por usuário, show ID, destino FIXED + MANUAL + PROPORTION, sem blocos de calendário e exatamente o orçamento confirmado. Em outros casos, **ABSTAIN**.
- Simulações com caderno manual **nunca autorizam geração real**. O guard B/D bloqueia real antes de coletar dados ou gravar Spotify, independente da flag D.10. Backstop no cliente Spotify e write fence continuam ativos, inclusive para livros concluídos.

## Limite explícito (próximo gate)

Este **não** é um deploy de composição automática em uma playlist que contém livro opaco. Há diferença entre (1) reservar o capítulo virtual em uma projeção com candidaturas reais, **implementado aqui**, e (2) publicar/remover/reordenar outras faixas **sem jamais remover o livro inteiro do Spotify**. A etapa (2) exige evidência adequada do estado remoto, snapshot revalidado, identificação inequívoca dos itens mutáveis, algoritmo conservador de patch não destrutivo, e homologação em destino piloto. Sem isso, o writer continua bloqueado. Não alegar integração produtiva completa.

## Rollout

1. Deploy de código+migração via launcher oficial com flags inalteradas.
2. Conferir backups e estado de cadernos por usuário antes de ligar D.7/D.9.
3. Testar referência manual e histórico primeiro. Habilitar SHADOW em seguida apenas com aprovação explícita e validação da simulação.
4. Não habilitar `AUDIOBOOK02_BIND_MODE`, `AUDIOBOOK02_CHAPTER_UPDATE_MODE`, `AUDIOBOOK02_PLANNER_MODE` como ACTIVE nem permitir Spotify writes.
