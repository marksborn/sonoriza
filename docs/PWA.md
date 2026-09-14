# PWA-01 — Sonoriza instalável

## Correção de integridade do ícone 512 — #85

A tentativa de instalação no Chrome Android em 10/09/2026 registrou
`WebAPK server returned response code 500`. O PNG 512 servido naquele teste
(SHA-256 `e9fc8ed1f77890f752b4cd6bb604b2ff21b5fc5397b2a2dd06c4b8587e37cd7a`)
tinha 13.581 bytes, mas declarava um bloco IDAT que terminaria no byte 13.590.
A descompressão e a leitura estrita pelo Sharp falharam. Os PNGs 180 e 192
passaram na validação de integridade.

O ícone 512 foi regenerado com Sharp 0.35.4 a partir de `public/sonoriza-mark.webp`:
marca redimensionada para caber em 320×320, centralizada em uma tela 512×512
com fundo `#0B021F`, exportada como PNG com compressão 9. A marca, a URL do
ícone, o manifest e o service worker foram preservados.

`npm run test:pwa` agora verifica limites dos blocos, CRC, IEND, descompressão
dos blocos IDAT concatenados e quantidade/filtros das linhas de pixels dos três
ícones. Antes da correção, o teste novo falhou em `truncated IDAT` no 512;
o teste anterior de assinatura/dimensões aceitava esse mesmo arquivo.

Isso corrige um arquivo comprovadamente inválido, mas ainda não comprova a
resolução do HTTP 500 remoto. Depois de merge/deploy autorizado, conferir o
hash do PNG público e repetir a instalação no Chrome Android com captura de
log. O aceite exige novo pacote em Configurações → Aplicativos, abertura
standalone e validação de links. Manter #85 aberta até essa evidência.

A PWA-01 torna o Sonoriza instalável em navegadores compatíveis sem alterar autenticação, Spotify, Google, planner ou scheduler.

## O que foi adicionado

- `src/app/manifest.ts`: Web App Manifest servido pelo App Router;
- `public/pwa-icon-180.png`, `public/pwa-icon-192.png` e `public/pwa-icon-512.png`: ícones rasterizados a partir da marca atual do Sonoriza sobre o fundo oficial escuro;
- `public/sw.js`: service worker mínimo para a base PWA;
- `PwaServiceWorker`: registro do worker somente em produção;
- headers específicos para atualização segura do service worker;
- Apple touch icon e metadata para execução standalone.

## Política de cache

A PWA-01 **não implementa cache offline**. Desde a PR #235, o service worker possui um `fetch` handler network-only para navegações GET da mesma origem, excluindo `/api/`. Não usa a Cache API e não persiste HTML, `/dashboard`, `/api`, `/auth` ou respostas autenticadas.

Isso é intencional: o Sonoriza trabalha com sessão e estado operacional mutável. Um cache offline genérico poderia apresentar configuração, autenticação ou resultados de playlist obsoletos.

Assets estáticos continuam sendo servidos normalmente pelo navegador/Next.js. O próprio `sw.js` é servido com `no-cache, no-store, must-revalidate` e registrado com `updateViaCache: "none"`.

## Instalação

Produção já usa HTTPS.

- Chrome/Edge/Android: use a opção de instalar/adicionar o Sonoriza oferecida pelo navegador;
- iOS/iPadOS: use Compartilhar → Adicionar à Tela de Início;
- desktop compatível: use a ação de instalação do navegador.

O app instalado inicia em `/dashboard`; sem sessão válida, o fluxo normal do Sonoriza redireciona para a tela de entrada.

## Validação

Além de `typecheck` e `build`, execute:

```bash
npx tsx --test src/services/pwa-contract.test.ts
```

Em ambiente servido, confirme com GET:

```bash
curl -D - -o /tmp/sw.js https://sonoriza.itsoft.com.br/sw.js
curl https://sonoriza.itsoft.com.br/manifest.webmanifest
curl -o /tmp/pwa-icon-192.png https://sonoriza.itsoft.com.br/pwa-icon-192.png
curl -o /tmp/pwa-icon-512.png https://sonoriza.itsoft.com.br/pwa-icon-512.png
```

Esperado:

- `sw.js` com JavaScript, `Service-Worker-Allowed: /` e sem cache;
- manifest disponível;
- ícones `image/png` nos tamanhos declarados;
- aplicação instalável e abrindo em modo `standalone`.

## Próxima etapa

A NOTIFY-01 poderá reutilizar este service worker para Web Push. A PWA-01 não solicita permissão de notificação e não cria VAPID/subscriptions.
