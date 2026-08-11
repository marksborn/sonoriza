# PWA-01 — Sonoriza instalável

A PWA-01 torna o Sonoriza instalável em navegadores compatíveis sem alterar autenticação, Spotify, Google, planner ou scheduler.

## O que foi adicionado

- `src/app/manifest.ts`: Web App Manifest servido pelo App Router;
- `public/pwa-icon-180.png`, `public/pwa-icon-192.png` e `public/pwa-icon-512.png`: ícones rasterizados a partir da marca atual do Sonoriza sobre o fundo oficial escuro;
- `public/sw.js`: service worker mínimo para a base PWA;
- `PwaServiceWorker`: registro do worker somente em produção;
- headers específicos para atualização segura do service worker;
- Apple touch icon e metadata para execução standalone.

## Política de cache

A PWA-01 **não implementa cache offline**. O service worker não possui `fetch` handler, não usa a Cache API e não persiste HTML, `/dashboard`, `/api`, `/auth` ou respostas autenticadas.

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
