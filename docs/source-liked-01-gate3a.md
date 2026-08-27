# SOURCE-LIKED-01 Gate 3A — duração canônica

Este gate adiciona `durationMs` ao estado canônico `LikedTrackPreference` e fornece um backfill explícito PREVIEW/APPLY.

Garantias do gate:

- Saved Tracks é somente leitura no provider;
- APPLY escreve apenas `LikedTrackPreference.durationMs` local;
- nenhuma playlist Spotify é escrita;
- `LIKED_TRACKS` continua com `plannerInfluence=false`;
- o backfill é idempotente;
- somente curtidas ativas são atualizadas;
- duração nula/inválida não é persistida;
- o relatório local só fica `plannerMaterialization.ready=true` quando todas as faixas atualmente `AVAILABLE` têm identidade local e duração válidas.

O Gate 3B só deve conectar a fonte ao planner em shadow após evidência produtiva de cobertura suficiente/total do Gate 3A.
