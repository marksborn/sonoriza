# CALENDAR-05 (#553) — regenerar a playlist a cada evento

Gatilho, não composição: muda **quando** gerar e **qual evento** cobrir. O motor e as regras do destino são os mesmos.

## Contrato
- Opt-in por destino em *Composição por evento → Sequência por evento*, com antecedência de 5, 15 ou 30 min. Exige `SEQUENCE_PER_EVENT` e destino automático.
- Interruptor do operador: `CALENDAR_05_EVENT_REGENERATION_MODE=ACTIVE`. Sem ele, a opção fica salva e o horário diário continua. Essa é também a reversão.
- Com tudo ligado, o agendador avalia o calendário a cada 5 min e **não executa** o horário diário daquele destino. `dailyScheduleMinutes` fica salvo e volta a valer ao desligar.
- Um evento por vez, em ordem cronológica. Cada evento vira um `TargetScheduleRun` com chave por impressão digital (destino, evento, início, fim, fuso), que herda dedupe, retentativa e recuperação após reinício.
- Evento remarcado gera nova chave. Evento cancelado some da decisão. A geração revalida o evento ao ler o calendário e, se ele sumiu, não publica nem limpa a playlist, mesmo com "esvaziar playlist".
- Sem evento à frente: nada acontece e a playlist é mantida.
- Evento já publicado segura a playlist até terminar, mesmo que o seguinte entre na antecedência. Assim a troca não acontece durante um evento em uso. Consequência: em eventos colados, o seguinte é gerado depois que o anterior termina.
- Em destinos KEEP_FILLED, cada evento **substitui** a playlist (caminho de rebuild), porque os itens do evento anterior não valem para o próximo. A geração não reutiliza a evidência de ordem da simulação aprovada, que cobre o dia inteiro.

## Limites
- A validade do evento é conferida no início da geração, não no instante da escrita. Uma mudança no calendário durante a geração só é tratada no próximo evento avaliado.
- Sem debounce próprio: o intervalo de 5 min do agendador faz esse papel.
- **Custo:** cada evento é uma geração completa no Spotify (dezenas de chamadas). Dias com muitos eventos curtos multiplicam o consumo; avalie a cota antes de ligar.
