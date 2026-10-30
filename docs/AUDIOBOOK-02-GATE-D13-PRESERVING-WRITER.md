# AUDIOBOOK-02 — D.13: gerar ao redor do livro (#489)

Sucede o D.12. Até aqui, toda playlist protegida por um livro da biblioteca tinha a geração **bloqueada**, porque o livro inteiro é um item opaco no Spotify (`item=null`) e uma substituição da playlist o apagaria.

## O que o D.13 faz
- **Escritor preservador:** nunca usa `PUT`/replace. Lê a playlist, apaga **somente** URIs `spotify:track:`/`spotify:episode:` e anexa o plano novo. Qualquer outro item (livro `item=null`, `spotify:audiobook:`, capítulo, objeto desconhecido) fica intocado. Como tudo o que é gerenciado é removido e reanexado, o livro fica **antes** do plano.
- **Verificação depois da escrita:** relê a playlist e exige o mesmo número de itens protegidos e as faixas e episódios exatamente na ordem do plano. Se falhar, o run termina com `AUDIOBOOK_D13_PROTECTED_ITEM_MISSING_AFTER_WRITE` (confira o livro no Spotify) ou `…_MANAGED_ORDER_MISMATCH…`. Não há desfazer remoto.
- **Orçamento virtual:** a duração restante do capítulo ativo (`chapterDurationMs - consumedMs`) sai do orçamento do destino antes do planejamento, também na simulação, para que a simulação aprovada e a geração real tenham o mesmo plano. Em destinos por evento, a reserva consome os eventos em ordem.
- **Travas:** a permissão é um contexto assíncrono restrito a um usuário e uma playlist, e só libera `DELETE`/`POST`. O guard do cliente Spotify só relaxa a checagem da biblioteca D.12; overlay legado, caderno manual e leitura arquivada continuam bloqueando. O fence transacional aceita a mesma permissão.

## Elegibilidade (todas obrigatórias)
- `AUDIOBOOK02_PRESERVING_WRITER_MODE=ACTIVE`;
- destino em `AUDIOBOOK02_PRESERVING_WRITER_TARGET_IDS`;
- política `MANUAL` ou `REBUILD_DAILY` (**KEEP_FILLED continua bloqueado**);
- protegido só pela biblioteca D.12 (sem overlay, caderno ou leitura arquivada);
- leitura **ativa** vinculada à playlist.

Fora disso, o comportamento anterior (bloqueio do lote real) não muda. O summary registra `audiobookPreservingWriter` com o motivo de cada destino e `audiobookPreservingWrite` com a verificação.

## Rollout seguro
1. Crie um destino **de teste** (MANUAL, duração fixa curta) com uma playlist Spotify descartável.
2. Ative o D.12 (`AUDIOBOOK02_MULTI_TARGET_MODE=ACTIVE`), inicie o livro, proteja a playlist de teste **antes** de adicionar o livro inteiro no Spotify e adicione-o manualmente.
3. Ligue `AUDIOBOOK02_PRESERVING_WRITER_MODE=ACTIVE` com **só** o ID do destino de teste na allowlist e reinicie.
4. Simule e gere o destino de teste. Confira no Spotify que o livro continua lá, no topo, e que o summary mostra `audiobookPreservingWrite.ok=true`.
5. Só depois coloque destinos reais na allowlist.

## Livro como slot de podcast (30/10/2026)
Em destinos D.13 com composição **por sequência** que tenha Podcast, o livro, que toca primeiro por estar no topo, **ocupa o 1º slot de Podcast** da sequência. O plano continua no slot seguinte (`RunTarget.sequenceStartOffset`), e a duração restante do capítulo continua sendo descontada do 1º evento ou do orçamento. As faixas PODCAST-08 acompanham o índice deslocado, então cada slot de podcast restante mantém a sua faixa. O guard de sequência pré-escrita recebe o mesmo deslocamento. Exemplo, Trabalho `M → P → M → P → M → P → M`: **Livro (P1)** → M → P (faixa do slot 4) → M → P → M → M → P….
Sequências só de música e composição por proporção não mudam (deslocamento 0).
