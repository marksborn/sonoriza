# AUDIOBOOK-02 — Gate A: duração virtual de capítulos (#489)

**Escopo:** contrato e preview de cálculo local, somente leitura. Não faz parte do fluxo de geração, não altera `MUSIC`/`PODCAST`, não cria `Candidate`/`PlanResult` e não modifica nenhum destino Spotify, banco, player, autenticação, job, PM2 ou ambiente de produção.

## Contrato

Implementação: `src/services/audiobooks/virtual-chapter-duration.ts`, função pura `calculateAudiobookVirtualDuration`.

O caller deve fornecer explicitamente:
- `spotifyPlaylistId` e `spotifyAudiobookId` do vínculo **manual declarado** pelo usuário; jamais deduzir identidade a partir de `item=null` no GET da playlist.
- `selectedChapterId`, cuja pertinência ao livro e `duration_ms` deverão ser comprovados pelo catálogo read-only em gates seguintes (o Gate A não consulta o Spotify).
- `targetDurationMs` do planejamento do Sonoriza e `chapterDurationMs` do capítulo escolhido, inteiros seguros **positivos**, em milissegundos.
- `selection.mode=FULL_CHAPTER` quando a intenção declarada for planejar o capítulo inteiro desde o começo, ou `selection.mode=MANUAL_REMAINDER` com `consumedMs` explicitamente informado, de 0 até menos que a duração do capítulo. O sistema **não presume** posição atual do player Spotify.
- `providerDurationMs` é opcional e, quando conhecido, representa a duração do livro inteiro para exibição. Sua ausência é `null`; quando informado deve ser inteiro seguro positivo. **Nunca** entra no orçamento.

A função devolve `{status: "READY", ...}` com `effectivePlanningDurationMs`, `remainingPlanningDurationMs`, `chapterDurationMs`, `providerDurationMs`, IDs declarados, modo, progresso manual e `manualSpotifyControlRequired=true`; ou `{status:"BLOCKED",reason}` sem cálculo parcial aproveitável.

### Cálculo

```text
effectivePlanningDurationMs = chapterDurationMs - manualConsumedMs
remainingPlanningDurationMs = targetDurationMs - effectivePlanningDurationMs
```

Exemplo: *1984*, `Apresentação`, capítulo `71PKNrJrxgaYwUY6srGQ3L` com `duration_ms=20039`. Para 5 min = `300000` ms, modo `FULL_CHAPTER`, o preview retorna `effectivePlanningDurationMs=20039` e `remainingPlanningDurationMs=279961` (4min39,961s). A duração aproximada do livro inteiro (15h22) segue independente e continua exibida normalmente pelo Spotify.

Se o progresso manual do capítulo for 10.000 ms, o saldo virtual do capítulo passa a 10.039 ms, liberando 289.961 ms do plano. Isso não altera o capítulo nem a posição real do player.

### Falhas seguras

O preview é bloqueado quando faltam IDs explícitos, alvo ou capítulo têm duração inválida/zero/desconhecida, duração informada do livro inteiro é inválida, modo/progresso são ausentes ou conflitantes, capítulo já está completamente consumido, ou o tempo selecionado excede o orçamento. Nunca truncar o capítulo, permitir resultado negativo, inferir progresso ou substituir silenciosamente o capítulo por 15h22/zero.

Este gate valida apenas a **consistência local** dos dados: não verifica existência dos IDs, nem que o capítulo pertence ao livro ou que há uma associação real no Spotify.

### Limite operacional fundamental

Uma playlist de 5 minutos planejados **não será executada automaticamente em 5 minutos pelo Spotify**. O usuário deve escolher o capítulo no Spotify e, para avançar à próxima faixa ou outro capítulo, operar o app manualmente. O Sonoriza não controla tempo de reprodução, salto de faixa ou parada.

Gate A **não implementa a proteção de writers**: até o Gate B/D, nenhuma playlist com livro inteiro deverá ser habilitada em geração manual, KEEP_FILLED, REBUILD_DAILY, append/remove/reorder/replace pelo Sonoriza. A proteção fail-closed no limite de cada mutação de provider é obrigatória antes de qualquer rollout.

## Testes e aceite

```sh
npx tsx --test src/services/audiobooks/virtual-chapter-duration.test.ts
npm run typecheck
```

A suíte cobre caso real de 20.039/279.961 ms, duração total indiferente ao cálculo, capítulos com progresso manual, ajuste exato, capítulo maior que o alvo, validações de identidade, duração, limites, seleção explícita, conclusão, integridade e isolamento do módulo. Esses comandos exigem execução em clone/worktree/CI autorizado: **não confundir arquivo de teste criado com teste executado**.

## Sequência

- **A:** contrato e teste read-only em branch + PR Draft, sem merge/deploy.
- **B:** persistência isolada do vínculo e interdição efetiva de todos os escritores de playlists protegidas (inclusive geração manual e caminhos laterais).
- **C:** seleção manual de capítulo e exibição clara das duas durações, com aviso da operação manual no Spotify.
- **D:** integração ao orçamento e composição **somente após** prova de preservação dos objetos opacos e nova autorização.

Relação: [#489](https://github.com/marksborn/sonoriza/issues/489), [#482](https://github.com/marksborn/sonoriza/issues/482), [#487](https://github.com/marksborn/sonoriza/issues/487).
