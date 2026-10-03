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

// ---------- token de login guardado num IndexedDB próprio ----------
// o service worker não enxerga o localStorage da página (são mundos separados) — pra conseguir
// responder uma mensagem direto da notificação, sem abrir o app, precisa de um jeito próprio de
// saber o token de quem está logado. app.js escreve aqui a cada login/logout (ver salvarTokenSW
// em app.js); o service worker só lê.
const TOKEN_DB = 'proconecta-sw';
const TOKEN_STORE = 'auth';
function abrirTokenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TOKEN_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TOKEN_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function obterTokenSalvo() {
  try {
    const db = await abrirTokenDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TOKEN_STORE, 'readonly');
      const req = tx.objectStore(TOKEN_STORE).get('token');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
}

// notificação push (barra de notificação do celular) — o servidor manda um JSON
// { titulo, corpo, url, tipo, remetente_id } e aqui a gente transforma isso numa notificação de
// verdade. Mensagem do chat interno ganha um botão "Responder" com campo de texto — dá pra
// responder direto da notificação, sem abrir o app (funciona no Android; em navegadores/celulares
// sem suporte a isso, o toque na notificação simplesmente abre o app normalmente).
self.addEventListener('push', (event) => {
  let dados = { titulo: 'Pro Conecta', corpo: 'Você tem uma novidade no Pro Conecta.', url: '/' };
  try { dados = { ...dados, ...event.data.json() }; } catch (e) {}
  const opcoes = {
    body: dados.corpo,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: dados.url || '/', tipo: dados.tipo || null, remetente_id: dados.remetente_id || null },
  };
  if (dados.tipo === 'chat_interno' && dados.remetente_id) {
    opcoes.actions = [{ action: 'responder', title: 'Responder', type: 'text', placeholder: 'Digite sua resposta...' }];
  }
  event.waitUntil(self.registration.showNotification(dados.titulo, opcoes));
});

// ao tocar na notificação: se foi a resposta rápida do chat interno (texto digitado ali mesmo),
// manda a mensagem direto pra API, sem abrir janela nenhuma. Qualquer outro toque continua igual:
// foca uma aba já aberta do app (se tiver) ou abre uma nova na URL da notificação.
self.addEventListener('notificationclick', (event) => {
  const dados = event.notification.data || {};
  if (event.action === 'responder' && typeof event.reply === 'string' && event.reply.trim()) {
    event.notification.close();
    event.waitUntil(
      obterTokenSalvo().then((token) => {
        if (!token || !dados.remetente_id) return;
        return fetch(`/api/chat-interno/${dados.remetente_id}/mensagens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ texto: event.reply.trim() }),
        }).catch(() => {});
      })
    );
    return;
  }
  event.notification.close();
  const destino = dados.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const janela of lista) {
        if ('focus' in janela) return janela.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })
  );
});
