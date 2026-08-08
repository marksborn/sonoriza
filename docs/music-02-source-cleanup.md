# MUSIC-02 — limpeza de playlists-inbox

## Contrato de segurança

- Fontes existentes migram como `KEEP_ALL`.
- A automação periódica migra desligada.
- `REMOVE_AFTER_PLAYED` usa somente histórico persistido de reprodução do Spotify.
- Preview sincroniza o histórico e lê a playlist, mas não remove itens.
- O preview persiste `snapshot_id`, hash do plano e contagens auditáveis.
- A confirmação sincroniza e lê tudo novamente; qualquer mudança de snapshot ou plano torna o preview `STALE` e bloqueia a remoção.
- A primeira limpeza real exige confirmação manual explícita.
- A rotina periódica só pode ser ligada depois de uma primeira limpeza manual `SUCCESS`.
- Remoções usam `DELETE /playlists/{id}/items`, em lotes de até 100 URIs, propagando o `snapshot_id` retornado entre lotes.
- Após mutação, a playlist é relida para verificar itens planejados que eventualmente permaneceram.
- Falhas parciais são registradas como `PARTIAL`; o sistema não declara sucesso total silenciosamente.
- O cache da fonte é invalidado após tentativa de mutação para que a próxima geração revalide o conteúdo atual.

## Observabilidade

Cada preview/execução registra:

- fonte e usuário;
- snapshot anterior e posterior;
- hash do plano;
- itens examinados;
- faixas únicas planejadas;
- ocorrências planejadas;
- itens que permaneceriam;
- URIs planejadas;
- URIs removidas/falhas quando aplicável;
- status `PREVIEW`, `SUCCESS`, `PARTIAL`, `FAILED` ou `STALE`;
- timestamps e erro resumido quando aplicável.

## Operação produtiva

Deploy e migration não habilitam limpeza em nenhuma fonte. Depois do deploy, o fluxo produtivo permanece separado:

1. escolher explicitamente uma fonte como inbox;
2. gerar preview;
3. revisar contagens;
4. autorizar e confirmar a primeira limpeza;
5. somente depois, se desejado, habilitar a rotina periódica.
