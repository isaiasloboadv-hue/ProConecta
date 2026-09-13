// Service worker do Pro Conecta — permite instalar como app e funcionar offline
// pras páginas já visitadas. Estratégia "rede primeiro": sempre busca a versão mais
// nova quando há internet (pra nunca travar alguém numa versão antiga depois de um
// deploy), e só usa o que está guardado quando o celular está sem conexão.

const CACHE = 'proconecta-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json', '/logo.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // dados da API nunca são cacheados

  event.respondWith(
    fetch(event.request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copia));
        return resposta;
      })
      .catch(() => caches.match(event.request))
  );
});
