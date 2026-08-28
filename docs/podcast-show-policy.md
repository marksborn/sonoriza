# PODCAST-05 — política de seleção por show

## Objetivo

PODCAST-05 transforma um `SHOW` configurado no Sonoriza em uma fonte de catálogo com política própria. O episódio não precisa estar salvo em **Seus episódios** para participar: a fonte `SHOW` consulta o catálogo do próprio programa e aplica as regras antes de entregar candidatos ao planner.

A política resolve quatro famílias de uso:

- séries narrativas / áudio dramas, onde a ordem importa;
- reescuta de um catálogo já concluído;
- podcasts comuns que podem ser revisitados aleatoriamente;
- conteúdo temporal, como notícias, que perde valor após uma janela de lançamento.

## Separação de responsabilidades

### Spotify / `EpisodeListeningState`

Continua sendo a verdade canônica sobre o estado observado de um episódio:

- `NOT_STARTED`;
- `IN_PROGRESS`;
- `COMPLETED`.

`COMPLETED` permanece sticky conforme PODCAST-04. Replay não apaga nem reescreve o histórico original.

PODCAST-05 acrescenta `firstProgressObservedAt`, usado somente para responder se um episódio em andamento começou enquanto ainda estava dentro da sua janela de validade.

### `PodcastShowPolicy`

Guarda somente preferência de produto e reset de rodada:

- universo elegível;
- ordem;
- política de repetição aleatória;
- episódio inicial opcional;
- sequência estrita;
- janela de lançamento;
- comportamento de expiração em andamento;
- cap global por ciclo.

### `GenerationItem`

Gerações reais publicadas são o audit log usado para reconstruir a memória de travessia/repetição. Runs de simulação são explicitamente excluídos dessa memória.

Isso impede que uma simulação ou uma simples leitura de catálogo “gaste” um episódio ou avance uma rodada.

## Política por show

### Episódios elegíveis

- `UNPLAYED_ONLY`: exclui `COMPLETED`; `NOT_STARTED` e `IN_PROGRESS` continuam elegíveis.
- `PLAYED_ONLY`: somente `COMPLETED`.
- `ALL`: mistura concluídos e não concluídos.

### Ordem

- `OLDEST_FIRST`;
- `NEWEST_FIRST`;
- `RANDOM`.

Ordens cronológicas são globais ao catálogo inteiro, nunca dependentes da paginação devolvida pelo Spotify. Empates usam URI como desempate estável.

### Aleatório

`WITHOUT_REPLACEMENT` percorre o conjunto elegível antes de abrir uma nova rodada. Os episódios consumidos da rodada são reconstruídos a partir das seleções publicadas em runs reais.

`WITH_REPLACEMENT` permite que qualquer episódio elegível volte a concorrer a cada ciclo.

O shuffle é determinístico para a mesma política/rodada, facilitando teste e auditoria.

### Ponto inicial

Em ordem cronológica, `startEpisodeId` pode receber um ID, URI `spotify:episode:...` ou link de episódio do Spotify pela UI.

Sem ponto explícito, a política começa pelo primeiro episódio elegível da ordem escolhida.

### Janela de validade

`maxReleaseAgeDays = N` remove episódios cuja publicação já ultrapassou a janela.

Para datas Spotify com precisão `year` ou `month`, o Sonoriza usa o último instante possível do período informado. Assim uma data imprecisa nunca expira cedo demais.

`STRICT_EXPIRY` remove o episódio mesmo se estiver em andamento.

`ALLOW_IN_PROGRESS_TO_FINISH` mantém um episódio vencido apenas quando existe evidência de que o primeiro progresso foi observado antes do fim da janela.

### Sequência estrita

Para uma ordem cronológica estrita, o planner não oferece um episódio posterior do mesmo show apenas para contornar o próximo episódio esperado.

Se o próximo episódio não cabe naquele destino, outro destino posterior do mesmo ciclo ainda pode recebê-lo. A ordem não é furada.

### Cap global por show

`maxEpisodesPerCycle` é compartilhado entre todos os destinos planejados no mesmo `GenerationRun`.

Exemplo:

```text
Night Vale.maxEpisodesPerCycle = 1
Destinos = Carro, Trabalho, Casa, Academia, Viagem
```

Depois que um episódio de Night Vale é reservado por um desses destinos, o show fica sem orçamento para os outros quatro naquele ciclo.

O planner também carrega o `maxEpisodesPerProgram` legado entre destinos, eliminando o comportamento anterior em que o contador era reiniciado para cada playlist.

## Ordem do pipeline

```text
catálogo SHOW completo
  -> estado canônico do episódio
  -> filtro de estado
  -> janela de validade
  -> ponto inicial / memória de rodada
  -> ordem ou shuffle
  -> cap global do show no GenerationRun
  -> regras de duração/composição do destino
  -> planner
```

## Replay e duração restante

PODCAST-04 continua valendo: quando um episódio historicamente `COMPLETED` é reescutado e o Spotify fornece uma posição atual explícita (`fully_played=false` + `resume_position_ms > 0`), o Sonoriza usa apenas a duração restante desse replay no orçamento.

A política de travessia não transforma o episódio em `NOT_STARTED` nem apaga o histórico do Spotify.

## Reset

Salvar uma política ou usar **Reiniciar sequência / rodada** atualiza o marco da política. Gerações reais anteriores a esse marco deixam de participar da memória de travessia.

O reset não:

- altera `EpisodeListeningState`;
- remove episódios da biblioteca;
- escreve no Spotify;
- gera playlists.

## Segurança operacional

- fonte/política é lida no contexto do `userId` autenticado;
- simulação não consome memória de travessia;
- testes usam fixtures/mocks e não escrevem playlists reais;
- migration deve ser aplicada antes do runtime novo;
- merge, deploy e ativação produtiva são gates separados.

## Limitação do provider para replay

Spotify não oferece um `Recently Played` equivalente para podcasts. Por isso, o Sonoriza não trata uma lista de reproduções históricas de episódios como fonte de verdade.

`resume_point` continua sendo usado quando exposto pelo provider — inclusive para calcular o restante de um replay em andamento — enquanto a memória de distribuição/rodada do Sonoriza é auditada pelas gerações reais publicadas. Isso mantém a lógica determinística sem inventar eventos de escuta que o provider não forneceu.
