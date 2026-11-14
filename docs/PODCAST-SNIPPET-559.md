# PODCAST-SNIPPET (#559): episódios de até 5 min em posição de música

Um único checkbox por destino, **Permitir Podcast Snippet**, sem controle de quantidade, percentual ou intervalo. O Snippet continua sendo podcast para identidade, fonte, política do programa, cadência, limite por programa, estado de escuta e histórico. Muda só a posição que ele ocupa na composição.

## Contrato
- **Snippet** é um episódio com duração **total** conhecida de até `300_000 ms`, inclusive. 5:00 é Snippet e 5:00.001 não é. Um episódio de 1 h com 4 min restantes (`IN_PROGRESS`) não é Snippet. Um episódio retomado sem duração total conhecida também não. Duração ausente, zero ou inválida nunca é Snippet. As faixas SHORT/MEDIUM/LONG da PODCAST-08 não mudam.
- **Interruptor do operador:** `PODCAST_SNIPPET_MODE=ACTIVE`. Com OFF (padrão), o checkbox fica salvo e **o planejamento é idêntico ao legado**: episódios curtos continuam elegíveis em posições de podcast, como hoje. Desligar o modo também é a reversão.
- **ACTIVE + marcado (`MUSIC_ROLE`):** um Snippet pode ocupar uma posição de música, inclusive em playlist 100% música, `MUSIC_ONLY`, `SEQUENCE` só com Música, `PROPORTION` e sequência por evento (CALENDAR-04/03). Ele continua elegível em posições de podcast pelas regras tradicionais. O mesmo episódio nunca entra duas vezes.
- **ACTIVE + desmarcado (`EXCLUDE`):** nenhum Snippet entra no destino, nem em posições de podcast. Um programa ordenado (sequência estrita ou com estado) cujo próximo episódio é um Snippet **espera**: os episódios seguintes não passam na frente dele.
- **Espaçamento fixo interno:** pelo menos 3 músicas reais antes de cada Snippet em posição de música (`PODCAST_SNIPPET_MIN_TRACKS_BETWEEN`). O contador continua entre os blocos de evento. Não existe frequência mínima prometida: sem Snippet elegível, entram músicas.
- **Regras preservadas:** fonte/escopo do destino, limite por programa no destino e na execução, limite de duração por podcast, cadência PODCAST-06/07, estados PODCAST-04 e ordem de programas ordenados (a proteção de cabeça de fila é aplicada sobre o pool completo de podcasts). Um Snippet em posição de música não conta para diversidade por artista/álbum, Discovery, cooldown de música, Last.fm ou estatísticas de faixa. Prévia e simulação não consomem cadência.
- **Estatísticas de composição** (`musicDurationMs`, `actualPodcastPercent`, contagens) seguem a posição. O tipo factual (`contentType=PODCAST`) e a URI de episódio não mudam. `GenerationItem.compositionRole = MUSIC` registra a posição, e a prévia mostra "Podcast Snippet — posição musical".
- **Pré-escrita:** a guarda de sequência compara a posição, não o tipo, e bloqueia (`INVALID_COMPOSITION_ROLE`) qualquer papel musical em item que não seja Snippet comprovado. Em execução real com ACTIVE, se o checkbox mudar durante a geração, nada é escrito no Spotify (`podcastSnippetPrewrite.status = BLOCKED_PREFERENCE_CHANGED`).
- **KEEP_FILLED:** com `MUSIC_ROLE`, um Snippet já publicado numa posição de música é preservado nesse papel. Desmarcar não apaga nada na hora; a próxima geração aplica a configuração atual.
- **Fingerprint:** só um checkbox **marcado** entra no fingerprint de configuração. Destinos existentes (todos desmarcados) mantêm o fingerprint e a aprovação de simulação atuais.

## Risco de migração e checkpoint A (baseline)
O padrão pedido é desmarcado, e desmarcado sob ACTIVE **retira** Snippets que hoje entram em posições de podcast. Por isso o deploy entra com OFF. Toda geração (simulação, manual ou agendada) grava em `GenerationRun.summary.podcastSnippet`:

```json
{ "mode": "OFF", "targets": [{ "targetPlaylistId": "...", "policy": null,
  "allowPodcastSnippets": false, "snippetsInPodcastRole": 2, "snippetsInMusicRole": 0 }] }
```

Com OFF, `snippetsInPodcastRole` é exatamente o que cada destino desmarcado deixaria de receber ao ligar ACTIVE. Consulta somente leitura:

```sql
SELECT "startedAt", "simulation", t->>'targetPlaylistId' AS target,
       (t->>'snippetsInPodcastRole')::int AS snippets_que_sairiam
FROM "GenerationRun", jsonb_array_elements("summary"::jsonb->'podcastSnippet'->'targets') t
WHERE "startedAt" > now() - interval '14 days'
ORDER BY "startedAt" DESC;
```

## Ativação (operador)
1. Deploy com `PODCAST_SNIPPET_MODE` ausente (OFF). Confirmar que as gerações seguem iguais e coletar o baseline acima por alguns dias.
2. Com o delta registrado, decidir a migração. Se algum destino perderia Snippets que o usuário quer manter, marcar o checkbox nele **antes** de ligar ACTIVE.
3. Marcar o checkbox no destino piloto e definir `PODCAST_SNIPPET_MODE=ACTIVE` no `.env`, reiniciando o PM2. Rodar uma **simulação** do piloto e conferir a ordem na revisão ("Podcast Snippet — posição musical").
4. Gerar de verdade no piloto e registrar o efeito na #559. Reverter removendo a variável e reiniciando.
5. Depois da homologação, registrar o status por destino na matriz da #458.

Nenhum deploy liga a feature sozinho. Ligar o modo é decisão do operador.

## Limites desta versão
- No PROPORTION com KEEP_FILLED, a posição de um Snippet já publicado não é recuperável do Spotify. Ele é preservado como podcast, o que só afeta as estatísticas de proporção.
- Na sequência por evento, a contagem do prefixo preservado (`initialFilledSlots`) continua por tipo. Um Snippet preservado em posição de música faz a sequência do evento recomeçar do slot seguinte por tipo.
