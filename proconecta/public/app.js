// app.js — frontend real do Pro Conecta. Tudo aqui chama a API de verdade (fetch),
// sem dados inventados: o que aparece na tela veio do servidor.

let TOKEN = localStorage.getItem('pc_token') || null;
let USER = null;
let paginaAtual = null;
let navAbertos = new Set();
let sinoTimer = null;
let procDraft = [{ texto: '', fotos: [] }];
let relatorioDraft = null;
let relatorioAgendaAtual = null;

const PAPEL_LABEL = { suporte: 'Suporte', administrador: 'Administrador', cliente: 'Cliente', producao: 'Produção', pos_venda: 'Pós-venda', estoque: 'Estoque' };
// setores que têm administrador próprio (cada um só cadastra gente do próprio setor + clientes) —
// Produção fica de fora porque usa um único login compartilhado, sem administrador dedicado.
const DEPARTAMENTO_ADMIN_LABEL = { suporte: 'Suporte', pos_venda: 'Pós-venda' };
const TIPO_OS_LABEL = {
  corretiva: 'Corretiva', preventiva: 'Preventiva', treinamento_online: 'Treinamento online',
  treinamento_presencial: 'Treinamento presencial', demonstracao_tecnica: 'Demonstração Técnica',
  atendimento: 'Atendimento',
};
// versão curta pro topo do card de O.S. — cabe ao lado da tag do técnico sem quebrar linha
const TIPO_OS_LABEL_CURTO = {
  corretiva: 'Corretiva', preventiva: 'Preventiva', treinamento_online: 'Trein. online',
  treinamento_presencial: 'Trein. presencial', demonstracao_tecnica: 'Demo. técnica',
  atendimento: 'Atendimento',
};
const TIPO_OS_COR = {
  corretiva: 'falha', preventiva: 'green', treinamento_online: 'blue',
  treinamento_presencial: 'amber', demonstracao_tecnica: 'orange', atendimento: 'purple',
};
// laudo técnico (diagnóstico + serviço + peças + fotos, sem checklist/assinatura) — "atendimento"
// (O.S. aberta automaticamente quando um técnico assume um chamado do chat) usa o mesmo laudo
const TIPOS_LAUDO_TECNICO = ['corretiva', 'preventiva', 'atendimento'];
// termo de aceite com checklist/assinatura — hoje só treinamento presencial, enquanto
// o modelo de referência específico dele não chega
const TIPOS_TERMO_ACEITE = ['treinamento_presencial'];

const CHECKLIST_CORRETIVA = [
  'Instalação mecânica', 'Instalação elétrica', 'Instalação software', 'Sistema de segurança',
  'Tryout', 'Utilização de nobreak', 'Aterramento da máquina', 'Tomada dedicada', 'Lente',
  'I/O da máquina', 'Sistema de refrigeração', 'Acompanhamento da linha',
  'Treinamento operacional', 'Treinamento configuração', 'Treinamento manutenção', 'Entrega de documentação',
];
// check-lists do Termo de Manutenção Preventiva (Relatório > Manual > Preventiva), um por
// família de equipamento — o técnico ainda pode adicionar, renomear ou remover itens antes de
// enviar, pra ajustar a algum caso fora do padrão; isso aqui é só o ponto de partida de cada um.
const CHECKLIST_PREVENTIVA_LASER = [
  'Fonte', 'CPA-D', 'CLP', 'Contator', 'Relé', 'Fonte tripla', 'Filtro de linha',
  'Placa de controle', 'Pré-filtro', 'Filtro cooler', 'Filtro intermediário', 'Filtro principal',
  'Lente para refração', 'Lente de sacrifício', 'Calibração', 'Projeção', 'Ressonador',
  'Utilização de nobreak', 'Aterramento da máquina', 'Tomada dedicada', 'USB do fabricante',
  'Chiller', 'Computador', 'Válvula', 'Regulador de pressão', 'Sistema de segurança',
  'Comando Pneumático', 'Comando Elétrico',
];
const CHECKLIST_PREVENTIVA_PLACA = [
  'Limpeza da placa principal', 'Limpeza da placa do eletroimã', 'Limpeza da placa do driver',
  'Limpeza da placa de frequência', 'Limpeza da placa do touch', 'Medição da fonte de tensão',
  'Calibração do touch', 'Verificação do fusível de entrada', 'Troca dos filtros',
  'Continuidade cabo de comunicação', 'Limpeza do fuso e castanha', 'Limpeza das guias',
  'Limpeza do porta punção', 'Lubrificação do porta punção', 'Limpeza do motor de passo',
  'Teste de movimentação eixo X e Y', 'Teste de marcação', 'Teste do fim de curso', 'Limpeza externa',
];
const CHECKLIST_PREVENTIVA_FLYMARKER = [
  'Limpeza da placa principal', 'Limpeza da placa de marcação', 'Verificação componentes eletrônicos',
  'Limpeza das guias e castanhas', 'Teste de continuidade do Eletroimã', 'Atualização do software',
  'Tensão de saída da bateria', 'Tensão de saída do carregador', 'Teste do sensor de fim de curso',
  'Teste de movimentação do eixo X e Y', 'Teste de marcação', 'Verificação do punção',
  'Limpeza e descontaminação externa',
];
const CHECKLIST_PREVENTIVA_INSTALACAO = [
  'Instalação mecânica', 'Instalação elétrica', 'Instalação pneumática', 'Instalação software',
  'Sistema de segurança', 'Tryout', 'Acompanhamento da linha', 'Treinamento operacional',
  'Treinamento configuração', 'Treinamento manutenção', 'Entrega de documentação',
];
// grupos de fotos do Termo de Manutenção Preventiva — cada grupo vira um bloco {comentario,
// fotos} igual ao relatório completo, com o rótulo já preenchido no comentário (esse aqui não é
// editável pelo técnico, é só o título do grupo). Em todo equipamento o último grupo ("Fotos
// adicionais") é opcional — todos os anteriores são obrigatórios.
const FOTOS_PREVENTIVA_LASER = [
  'Etiqueta de NS do equipamento', 'Painel elétrico do equipamento', 'Equipamento',
  'Tensões de entrada e saída da fonte tripla', 'Potência antes de executar o serviço',
  'Potência após executar o serviço', 'Fotos adicionais',
];
const FOTOS_PREVENTIVA_GENERICO = [
  'Etiqueta de NS do equipamento', 'Equipamento', 'Equipamento antes de executar o serviço',
  'Equipamento após de executar o serviço', 'Fotos adicionais',
];
// cada modelo de máquina indica qual check-list e qual conjunto de fotos usar — "Outro" (fora
// desta lista) começa com o check-list em branco e o conjunto de fotos genérico.
const EQUIPAMENTOS_PREVENTIVA = {
  'Smartbox': { checklist: CHECKLIST_PREVENTIVA_LASER, fotos: FOTOS_PREVENTIVA_LASER },
  'OEM': { checklist: CHECKLIST_PREVENTIVA_LASER, fotos: FOTOS_PREVENTIVA_LASER },
  'Custom': { checklist: CHECKLIST_PREVENTIVA_LASER, fotos: FOTOS_PREVENTIVA_LASER },
  'Easybox': { checklist: CHECKLIST_PREVENTIVA_LASER, fotos: FOTOS_PREVENTIVA_LASER },
  'UV': { checklist: CHECKLIST_PREVENTIVA_LASER, fotos: FOTOS_PREVENTIVA_LASER },
  'KT': { checklist: CHECKLIST_PREVENTIVA_PLACA, fotos: FOTOS_PREVENTIVA_GENERICO },
  'MP5': { checklist: CHECKLIST_PREVENTIVA_PLACA, fotos: FOTOS_PREVENTIVA_GENERICO },
  'FlyMarker': { checklist: CHECKLIST_PREVENTIVA_FLYMARKER, fotos: FOTOS_PREVENTIVA_GENERICO },
  'Limpeza a laser': { checklist: CHECKLIST_PREVENTIVA_INSTALACAO, fotos: FOTOS_PREVENTIVA_GENERICO },
  'Solda a Laser': { checklist: CHECKLIST_PREVENTIVA_INSTALACAO, fotos: FOTOS_PREVENTIVA_GENERICO },
};
const UF_REGIAO = {
  AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
  AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste', PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
  DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
  ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
  PR: 'Sul', RS: 'Sul', SC: 'Sul',
};

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  async function tentar() {
    const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let corpoInvalido = false;
    const data = await res.json().catch(() => { corpoInvalido = true; return {}; });
    if (!res.ok) {
      const erro = new Error(data.erro || 'Erro na requisição');
      erro.status = res.status;
      // resposta sem JSON válido (ou sem campo erro) não veio do nosso backend — é sintoma de
      // instabilidade da hospedagem (ex: "acordando" após período inativo no plano gratuito),
      // não um erro de validação de verdade
      erro.falhaTransitoria = corpoInvalido || !data.erro || [502, 503, 504].includes(res.status);
      throw erro;
    }
    return data;
  }
  try {
    return await tentar();
  } catch (e) {
    // instabilidade passageira da hospedagem: tenta mais uma vez sozinho antes de mostrar erro
    // pro usuário — evita ter que clicar de novo em qualquer botão da tela por causa disso
    if (!e.falhaTransitoria) throw e;
    await new Promise((r) => setTimeout(r, 2500));
    return await tentar();
  }
}

// dados de marca da empresa dona da instalação (nome, contato) — buscados uma vez no boot,
// antes até do login, e usados em vez de texto fixo nos PDFs/Word e telas de contato. Assim
// instalar o sistema pra outra empresa não exige mexer em código, só nas variáveis de ambiente
// (ver db.js). Os valores de fallback abaixo só entram em jogo se a busca falhar.
window._empresa = null;
async function carregarEmpresa() {
  try { window._empresa = (await api('/api/empresa')).empresa; } catch (e) {}
}
function empresaNome() { return (window._empresa && window._empresa.nome) || 'PRO Marking'; }
function empresaSite() { return (window._empresa && window._empresa.site) || 'promarking.com.br'; }
function empresaWhatsapp() { return (window._empresa && window._empresa.whatsapp) || '12 99718-7506'; }
function empresaTelefone() { return (window._empresa && window._empresa.telefone) || '12 3902-3453'; }
function empresaEmails() {
  return (window._empresa && Array.isArray(window._empresa.emails) && window._empresa.emails.length)
    ? window._empresa.emails
    : ['suporte@promarking.com.br', 'atendimento@promarking.com.br', 'tecnico@promarking.com.br', 'posvenda@promarking.com.br'];
}

// o service worker não enxerga o localStorage da página (mundos separados) — pra conseguir
// responder uma mensagem do chat interno direto pela notificação, sem abrir o app, ele precisa
// do token de um jeito que também dê pra ler de lá. Mesmo banco/loja que o sw.js usa (ver
// obterTokenSalvo em sw.js) — só a página escreve, só o service worker lê.
function abrirTokenSWDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('proconecta-sw', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('auth');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function salvarTokenSW(token) {
  try {
    const db = await abrirTokenSWDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('auth', 'readwrite');
      const store = tx.objectStore('auth');
      if (token) store.put(token, 'token'); else store.delete('token');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* sem IndexedDB — resposta pela notificação simplesmente não funciona */ }
}

async function fazerLogin() {
  const email = document.getElementById('login-email').value;
  const senha = document.getElementById('login-senha').value;
  const erroEl = document.getElementById('login-erro');
  erroEl.classList.add('hidden');
  try {
    const data = await api('/api/login', { method: 'POST', body: { email, senha } });
    TOKEN = data.token;
    USER = data.usuario;
    localStorage.setItem('pc_token', TOKEN);
    salvarTokenSW(TOKEN);
    entrarNoApp();
  } catch (e) {
    erroEl.textContent = e.message;
    erroEl.classList.remove('hidden');
  }
}

function sair() {
  TOKEN = null; USER = null; navAbertos = new Set();
  if (sinoTimer) clearInterval(sinoTimer);
  desmontarWidgetChatInterno();
  localStorage.removeItem('pc_token');
  salvarTokenSW(null);
  document.getElementById('appView').style.display = 'none';
  document.getElementById('authView').style.display = 'flex';
}

async function tentarSessaoExistente() {
  if (!TOKEN) return;
  try {
    const data = await api('/api/me');
    USER = data.usuario;
    salvarTokenSW(TOKEN);
    entrarNoApp();
  } catch (e) {
    TOKEN = null; localStorage.removeItem('pc_token');
  }
}

// ---------- fila de envio offline (relatórios do técnico) ----------
// quando o técnico conclui um relatório sem internet, o envio é guardado no aparelho (com
// fotos e tudo — por isso IndexedDB, não localStorage, que tem pouco espaço) em vez de dar
// erro. Assim que a conexão voltar (evento 'online', abrir o app de novo, ou tocar em
// Sincronizar) a fila é reenviada sozinha, na ordem em que foi criada.
const IDB_NOME = 'proconecta_offline';
const IDB_STORE = 'fila_visitas';
const MSG_ENFILEIRADO = 'Sem conexão no momento — o relatório foi guardado neste aparelho e será enviado automaticamente assim que a internet voltar (ou toque em Sincronizar).';

function abrirFilaOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NOME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function filaOfflineAdicionar(item) {
  const db = await abrirFilaOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(item);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function filaOfflineListar() {
  const db = await abrirFilaOfflineDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.criado_em.localeCompare(b.criado_em)));
    req.onerror = () => reject(req.error);
  });
}
async function filaOfflineRemover(id) {
  const db = await abrirFilaOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

// fetch() lança TypeError quando não há rede (sem chegar a ter resposta do servidor); erros
// vindos do backend (validação, 403...) chegam como Error normal com mensagem própria — só o
// primeiro caso deve cair na fila offline, o segundo é um erro de verdade pra tela tratar.
function ehErroDeConexao(e) { return e instanceof TypeError; }

// tenta enviar o relatório; se falhar por falta de conexão, guarda na fila em vez de propagar
// o erro. `extra` carrega o que for preciso pra terminar o pós-processamento (PDF/e-mail) do
// termo de aceite quando esse item sincronizar mais tarde. Falhas transitórias do servidor já
// são reprocessadas sozinhas dentro de api().
async function enviarVisitaOuEnfileirar(body, extra) {
  try {
    const resp = await api('/api/visitas', { method: 'POST', body });
    return { enviado: true, visita: resp.visita };
  } catch (e) {
    if (!ehErroDeConexao(e)) throw e;
    await filaOfflineAdicionar({ id: 'off-' + Date.now() + '-' + Math.random().toString(36).slice(2), body, criado_em: new Date().toISOString(), ...(extra || {}) });
    await atualizarBadgeSincronizar();
    return { enviado: false, enfileirado: true };
  }
}

let sincronizandoFilaOffline = false;
async function sincronizarFilaOffline() {
  if (sincronizandoFilaOffline || !TOKEN) return;
  if (!('indexedDB' in window)) return;
  let fila;
  try { fila = await filaOfflineListar(); } catch (e) { return; }
  if (!fila.length) return;
  sincronizandoFilaOffline = true;
  let enviados = 0;
  for (const item of fila) {
    try {
      const resp = await api('/api/visitas', { method: 'POST', body: item.body });
      await filaOfflineRemover(item.id);
      if (item.chaveRascunho) localStorage.removeItem(item.chaveRascunho);
      if (item.pdfTermoAceite && resp.visita) {
        try {
          const pdfDataUri = gerarPdfRelatorio(item.pdfTermoAceite.dados, item.pdfTermoAceite.agendaItem);
          const pdfBase64 = pdfDataUri.split(',')[1];
          await api(`/api/visitas/${resp.visita.id}/enviar-relatorio`, { method: 'POST', body: { pdf_base64: pdfBase64, emails: item.pdfTermoAceite.emails } });
        } catch (e2) { console.error('PDF/e-mail do relatório sincronizado depois falhou:', e2.message); }
      }
      enviados++;
    } catch (e) {
      if (ehErroDeConexao(e)) break; // sem rede de novo — tenta o resto na próxima
      console.error('Descartando item pendente que o servidor rejeitou:', e.message);
      await filaOfflineRemover(item.id);
    }
  }
  sincronizandoFilaOffline = false;
  await atualizarBadgeSincronizar();
  if (enviados > 0) {
    mostrarToast(`${enviados} relatório${enviados === 1 ? '' : 's'} pendente${enviados === 1 ? '' : 's'} sincronizado${enviados === 1 ? '' : 's'} com sucesso.`);
    if (paginaAtual === 'agenda') renderAgenda();
  }
}

async function atualizarBadgeSincronizar() {
  const badge = document.getElementById('sync-badge');
  if (!badge) return;
  if (!('indexedDB' in window)) { badge.classList.add('hidden'); return; }
  let fila = [];
  try { fila = await filaOfflineListar(); } catch (e) {}
  badge.textContent = fila.length;
  badge.classList.toggle('hidden', fila.length === 0);
}

window.addEventListener('online', sincronizarFilaOffline);

// ---------- notificação push (barra de notificação do celular) ----------
// pede permissão ao navegador e inscreve este aparelho pra receber notificação de verdade
// (O.S. atribuída, cliente confirmou, técnico a caminho) mesmo com o app fechado. Silencioso:
// se o navegador não suportar, ou a pessoa negar a permissão, o app continua funcionando
// normalmente — só sem a notificação na barra (o sino dentro do app continua funcionando).
function urlBase64ParaUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bruto = atob(base64);
  const saida = new Uint8Array(bruto.length);
  for (let i = 0; i < bruto.length; i++) saida[i] = bruto.charCodeAt(i);
  return saida;
}

async function ativarNotificacoesPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission === 'denied') return;
    const registration = await navigator.serviceWorker.ready;
    let inscricao = await registration.pushManager.getSubscription();
    if (!inscricao) {
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') return;
      const { chave } = await api('/api/push/chave-publica');
      inscricao = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ParaUint8Array(chave),
      });
    }
    const json = inscricao.toJSON();
    await api('/api/push/inscrever', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
  } catch (e) { /* notificação push é um extra — nunca deve travar o login */ }
}

function entrarNoApp() {
  document.getElementById('authView').style.display = 'none';
  document.getElementById('appView').style.display = 'block';
  montarSidebar();
  atualizarSino();
  sinoTimer = setInterval(atualizarSino, 15000);
  atualizarBadgeSincronizar();
  sincronizarFilaOffline();
  montarWidgetChatInterno();
  if (['suporte', 'administrador', 'producao', 'cliente', 'pos_venda', 'estoque'].includes(USER.papel)) ativarNotificacoesPush();
  const primeiraPaginaPermitida = (function primeiraPagina(nodes) {
    for (const node of nodes) {
      if (node.page) return node.page;
      if (node.children) { const p = primeiraPagina(node.children); if (p) return p; }
    }
    return null;
  })(navDoUsuario());
  const paginaInicial = { administrador: 'agenda', cliente: 'biblioteca-defeitos', producao: 'biblioteca-defeitos', pos_venda: 'fila-pos-venda', estoque: 'fila-estoque' }[USER.papel] || primeiraPaginaPermitida || 'agenda';
  ir(paginaInicial);
}

function initials(nome) {
  return (nome || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

function renderHeaderRight() {
  const el = document.getElementById('headerRight');
  el.innerHTML = `
    ${USER.papel === 'suporte' ? `
    <button class="btn-presenca ${USER.online ? 'online' : 'offline'}" id="btn-presenca" onclick="alternarPresenca()" title="Ficar online pra receber atendimentos na fila">
      <span class="presenca-bolinha"></span><span class="presenca-label">${USER.online ? 'Online' : 'Offline'}</span>
    </button>` : ''}
    <div class="user-chip">
      <div class="user-avatar">${initials(USER.nome)}</div>
      <div class="user-meta">
        <span class="u-name">${esc(USER.nome)}</span>
        <span class="u-role">${PAPEL_LABEL[USER.papel] || USER.papel}</span>
      </div>
    </div>
    <button class="btn-bell" id="btn-sync" onclick="sincronizarApp()" title="Sincronizar — buscar as atualizações mais recentes">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="bell-badge hidden" id="sync-badge">0</span>
    </button>
    <div class="bell-wrap">
      <button class="btn-bell" id="btn-bell" onclick="alternarSino()">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 3a6 6 0 0 0-6 6v3.3c0 .6-.2 1.2-.6 1.7L4 16h16l-1.4-2a2.6 2.6 0 0 1-.6-1.7V9a6 6 0 0 0-6-6Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 19a2.5 2.5 0 0 0 5 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <span class="bell-badge hidden" id="bell-badge">0</span>
      </button>
      <div class="bell-panel" id="bell-panel"></div>
    </div>
    <button class="btn-logout" onclick="sair()">Sair</button>
  `;
}

// liga/desliga a presença do técnico na fila de atendimento — só quem está online entra
// no rodízio (round-robin) que distribui os atendimentos novos.
async function alternarPresenca() {
  const btn = document.getElementById('btn-presenca');
  if (btn) btn.disabled = true;
  try {
    const { usuario } = await api('/api/tecnico/online', { method: 'POST', body: { online: !USER.online } });
    USER.online = usuario.online;
    USER.online_desde = usuario.online_desde;
    renderHeaderRight();
  } catch (e) { alert('Erro: ' + e.message); }
  finally { if (btn) btn.disabled = false; }
}

// força buscar a versão mais nova do sistema e dos dados — útil no app instalado (PWA),
// que pode ficar aberto em segundo plano por dias sem recarregar sozinho.
function sincronizarApp() {
  const btn = document.getElementById('btn-sync');
  if (btn) btn.classList.add('girando');
  location.reload();
}

// ---------- menu em cascata ----------

// menus de topo (ver NAV logo abaixo) que cada tipo de acesso pode ter — usado tanto pra montar o
// sidebar de fato (navDoUsuario) quanto pela tela de cadastro, que mostra essa mesma lista como
// caixinhas de acesso (ver campo-menus-acesso em mostrarFormUsuario). Quem cadastra o usuário
// escolhe se libera tudo ou só alguns desses itens.
const MENUS_LABEL_POR_PAPEL = {
  suporte: {
    'agenda': 'Minha agenda',
    'fila-atendimento': 'Fila de Atendimento',
    'relatorio-manutencao': 'Relatório',
    'calendario-tecnico': 'Calendário',
    'biblioteca': 'Biblioteca',
    'fila-reparo': 'Setor Reparo',
    'chat-interno': 'Mensagens',
  },
  administrador: {
    'agenda': 'Agenda geral',
    'painel-atendimentos': 'Atendimentos',
    'solicitacao-atendimento': 'Solicitação de Atendimento',
    'aprovacoes-visitas': 'Ordem de Serviço',
    'biblioteca': 'Biblioteca',
    'clientes': 'Clientes',
    'equipamentos': 'Equipamentos',
    'usuarios': 'Usuários',
    'chat-interno': 'Mensagens',
  },
  cliente: {
    'biblioteca': 'Biblioteca',
    'equipamentos': 'Meus equipamentos',
    'chamados': 'Atendimento',
  },
  producao: {
    'biblioteca': 'Biblioteca',
    'clientes': 'Clientes',
    'equipamentos': 'Equipamentos',
    'chat-interno': 'Mensagens',
  },
  pos_venda: { 'fila-pos-venda': 'Pós-venda', 'chat-interno': 'Mensagens' },
  estoque: { 'fila-estoque': 'Estoque', 'chat-interno': 'Mensagens' },
};

const NAV = {
  suporte: [
    { key: 'agenda', label: 'Minha agenda', page: 'agenda' },
    { key: 'fila-atendimento', label: 'Fila de Atendimento', page: 'fila-atendimento' },
    { key: 'relatorio-manutencao', label: 'Relatório', children: [
      { key: 'relatorio-manual', label: 'Manual', page: 'relatorio-manutencao' },
      { key: 'relatorio-automatico', label: 'Automático', page: 'relatorio-automatico' },
      { key: 'relatorio-ciclagem', label: 'Ensaio de Ciclagem', page: 'relatorio-ciclagem' },
    ]},
    { key: 'calendario-tecnico', label: 'Calendário', page: 'calendario-tecnico' },
    { key: 'biblioteca', label: 'Biblioteca', children: [
      { key: 'acessar', label: 'Acessar biblioteca', children: [
        { key: 'acessar-defeitos', label: 'Defeitos/Falhas', page: 'biblioteca-defeitos' },
        { key: 'acessar-procedimentos', label: 'Manual de Procedimentos', page: 'biblioteca-procedimentos' },
      ]},
      { key: 'adicionar', label: 'Adicionar', children: [
        { key: 'adicionar-defeito', label: 'Defeitos/Falhas', page: 'add-defeito' },
        { key: 'adicionar-procedimento', label: 'Manual de Procedimentos', page: 'add-procedimento' },
      ]},
      { key: 'meus-registros', label: 'Meus registros', page: 'meus-registros' },
      { key: 'ranking', label: 'Ranking de técnicos', page: 'biblioteca-ranking' },
    ]},
    { key: 'fila-reparo', label: 'Setor Reparo', page: 'fila-reparo' },
  ],
  administrador: [
    { key: 'agenda', label: 'Agenda geral', page: 'agenda' },
    { key: 'painel-atendimentos', label: 'Atendimentos', page: 'painel-atendimentos' },
    { key: 'solicitacao-atendimento', label: 'Solicitação de Atendimento', page: 'fila-solicitacao-atendimento' },
    { key: 'aprovacoes-visitas', label: 'Ordem de Serviço', page: 'aprovacoes-visitas' },
    { key: 'biblioteca', label: 'Biblioteca', children: [
      { key: 'acessar', label: 'Acessar biblioteca', children: [
        { key: 'acessar-defeitos', label: 'Defeitos/Falhas', page: 'biblioteca-defeitos' },
        { key: 'acessar-procedimentos', label: 'Manual de Procedimentos', page: 'biblioteca-procedimentos' },
      ]},
      { key: 'aprovacao', label: 'Aprovação', page: 'aprovacoes-biblioteca' },
      { key: 'solicitacoes-edicao', label: 'Solicitações de edição', page: 'solicitacoes-edicao-biblioteca' },
      { key: 'adicionar', label: 'Adicionar', children: [
        { key: 'adicionar-defeito', label: 'Defeitos/Falhas', page: 'add-defeito' },
        { key: 'adicionar-procedimento', label: 'Manual de Procedimentos', page: 'add-procedimento' },
      ]},
      { key: 'ranking', label: 'Ranking de técnicos', page: 'biblioteca-ranking' },
    ]},
    { key: 'clientes', label: 'Clientes', page: 'clientes' },
    { key: 'equipamentos', label: 'Equipamentos', children: [
      { key: 'cadastrar', label: 'Cadastrar equipamento', page: 'equipamentos-cadastrar' },
      { key: 'atrelar', label: 'Atrelar equipamento', page: 'equipamentos-atrelar' },
    ]},
    { key: 'usuarios', label: 'Usuários', page: 'usuarios' },
  ],
  cliente: [
    { key: 'biblioteca', label: 'Biblioteca', children: [
      { key: 'acessar', label: 'Acessar biblioteca', children: [
        { key: 'acessar-defeitos', label: 'Defeitos/Falhas', page: 'biblioteca-defeitos' },
        { key: 'acessar-procedimentos', label: 'Manual de Procedimentos', page: 'biblioteca-procedimentos' },
      ]},
      { key: 'ranking', label: 'Ranking de técnicos', page: 'biblioteca-ranking' },
    ]},
    { key: 'equipamentos', label: 'Meus equipamentos', page: 'equipamentos' },
    { key: 'chamados', label: 'Atendimento', page: 'chamados' },
  ],
  producao: [
    { key: 'biblioteca', label: 'Biblioteca', children: [
      { key: 'acessar', label: 'Acessar biblioteca', children: [
        { key: 'acessar-defeitos', label: 'Defeitos/Falhas', page: 'biblioteca-defeitos' },
        { key: 'acessar-procedimentos', label: 'Manual de Procedimentos', page: 'biblioteca-procedimentos' },
      ]},
      { key: 'adicionar', label: 'Adicionar', children: [
        { key: 'adicionar-defeito', label: 'Defeitos/Falhas', page: 'add-defeito' },
        { key: 'adicionar-procedimento', label: 'Manual de Procedimentos', page: 'add-procedimento' },
      ]},
      { key: 'meus-registros', label: 'Meus registros', page: 'meus-registros' },
      { key: 'ranking', label: 'Ranking de técnicos', page: 'biblioteca-ranking' },
    ]},
    { key: 'clientes', label: 'Clientes', page: 'clientes' },
    { key: 'equipamentos', label: 'Equipamentos', children: [
      { key: 'cadastrar', label: 'Cadastrar equipamento', page: 'equipamentos-cadastrar' },
      { key: 'atrelar', label: 'Atrelar equipamento', page: 'equipamentos-atrelar' },
    ]},
  ],
  pos_venda: [
    { key: 'fila-pos-venda', label: 'Pós-venda', page: 'fila-pos-venda' },
  ],
  estoque: [
    { key: 'fila-estoque', label: 'Estoque', page: 'fila-estoque' },
  ],
};

// lista de menu de fato disponível pro usuário logado — igual ao NAV do papel, exceto quando não
// tem acesso_total, que aí só vê os itens de topo marcados em `menus` (ver MENUS_LABEL_POR_PAPEL /
// checkboxes no cadastro). Vale pra qualquer tipo de acesso, não só suporte.
function navDoUsuario() {
  const nav = NAV[USER.papel] || [];
  if (USER.acesso_total !== false) return nav;
  const menus = Array.isArray(USER.menus) ? USER.menus : [];
  return nav.filter((node) => menus.includes(node.key));
}

function buscarCaminho(nodes, pagina, caminho) {
  for (const node of nodes) {
    if (node.page === pagina) return caminho;
    if (node.children) {
      const r = buscarCaminho(node.children, pagina, [...caminho, node.key]);
      if (r) return r;
    }
  }
  return null;
}

function renderNavNodes(nodes, nivel) {
  return nodes.map((node) => {
    const indent = 12 + nivel * 14;
    if (node.children) {
      const aberto = navAbertos.has(node.key);
      return `
        <button class="nav-group-header" style="padding-left:${indent}px" onclick="alternarGrupo('${node.key}')">
          <span class="chevron ${aberto ? 'open' : ''}">▸</span>${node.label}
        </button>
        ${aberto ? renderNavNodes(node.children, nivel + 1) : ''}
      `;
    }
    const ativo = paginaAtual === node.page;
    return `<button class="nav-leaf ${ativo ? 'active' : ''}" style="padding-left:${indent}px" onclick="ir('${node.page}')"><span class="dot"></span>${node.label}</button>`;
  }).join('');
}

function montarSidebar() {
  const label = 'Acesso ' + (PAPEL_LABEL[USER.papel] || 'cliente').toLowerCase();
  const nav = navDoUsuario();
  document.getElementById('sideNav').innerHTML = `<span class="tag">${label}</span>` + renderNavNodes(nav, 0);
  renderHeaderRight();
  aplicarEstadoMenuMobile();
}

function alternarGrupo(key) {
  if (navAbertos.has(key)) navAbertos.delete(key); else navAbertos.add(key);
  montarSidebar();
}

// menu lateral vira uma gaveta deslizante no celular (aberta pelo botão hamburger no cabeçalho)
let menuMobileAberto = false;
function aplicarEstadoMenuMobile() {
  const nav = document.getElementById('sideNav');
  const backdrop = document.getElementById('navBackdrop');
  if (nav) nav.classList.toggle('open', menuMobileAberto);
  if (backdrop) backdrop.classList.toggle('show', menuMobileAberto);
}
function alternarMenuMobile() {
  menuMobileAberto = !menuMobileAberto;
  aplicarEstadoMenuMobile();
}
function fecharMenuMobile() {
  menuMobileAberto = false;
  aplicarEstadoMenuMobile();
}

async function ir(pagina) {
  // os pollers dos chats de atendimento (cliente/técnico/pós-venda) só têm sentido enquanto a
  // tela deles está aberta em #main — como #main é substituído embaixo, sem isso eles ficavam
  // rodando pra sempre em segundo plano (a cada 4s, pra sempre) mesmo depois de sair da tela,
  // gastando dado e batendo no servidor à toa. O widget de chat interno flutua por cima de
  // #main (não é afetado pela troca de página) e continua com o poll dele normalmente.
  clearInterval(_atClientePoll);
  clearInterval(_atTecPoll);
  clearInterval(_atPvPoll);
  paginaAtual = pagina;
  const caminho = buscarCaminho(navDoUsuario(), pagina, []);
  if (caminho) caminho.forEach((k) => navAbertos.add(k));
  fecharMenuMobile();
  montarSidebar();
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Carregando...</div>';
  try {
    if (pagina === 'agenda') return renderAgenda();
    if (pagina === 'relatorio-manutencao') return renderRelatorioManutencao();
    if (pagina === 'relatorio-automatico') return renderRelatorioAutomatico();
    if (pagina === 'relatorio-ciclagem') return mostrarFormCiclagem();
    if (pagina === 'calendario-tecnico') return renderCalendarioTecnico();
    if (pagina === 'aprovacoes-visitas') return renderAprovacoesVisitas();
    if (pagina === 'biblioteca-defeitos') return renderBibliotecaDefeitos();
    if (pagina === 'biblioteca-procedimentos') return renderBibliotecaProcedimentos();
    if (pagina === 'biblioteca-ranking') return renderRankingTecnicos();
    if (pagina === 'add-defeito') return renderFormDefeito(main, null);
    if (pagina === 'add-procedimento') return renderFormProcedimento(main, null);
    if (pagina === 'meus-registros') return renderMeusRegistros();
    if (pagina === 'aprovacoes-biblioteca') return renderAprovacoesBiblioteca();
    if (pagina === 'solicitacoes-edicao-biblioteca') return renderSolicitacoesEdicao();
    if (pagina === 'clientes') return renderClientes();
    if (pagina === 'equipamentos') return renderMeusEquipamentos();
    if (pagina === 'equipamentos-cadastrar') return renderEquipamentosCadastrar();
    if (pagina === 'equipamentos-atrelar') return renderEquipamentosAtrelar();
    if (pagina === 'usuarios') return renderUsuarios();
    if (pagina === 'chamados') return renderChamados();
    if (pagina === 'fila-atendimento') return renderFilaAtendimento();
    if (pagina === 'painel-atendimentos') return renderPainelAtendimentos();
    if (pagina === 'fila-pos-venda') return renderFilaPosVenda();
    if (pagina === 'fila-reparo') return renderFilaReparo();
    if (pagina === 'fila-estoque') return renderFilaEstoque();
    if (pagina === 'fila-solicitacao-atendimento') return renderFilaSolicitacaoAtendimento();
  } catch (e) {
    main.innerHTML = `<div class="empty">Erro: ${e.message}</div>`;
  }
}

function tag(texto, cor) { return `<span class="tag tag-${cor}">${texto}</span>`; }
// datas "só dia" (ex.: "2026-09-21", vindas de <input type="date">) não têm hora — o construtor
// Date as interpreta como meia-noite UTC, que o toLocaleString depois converte pro fuso local e
// pode voltar um dia (ex.: 21/09 meia-noite UTC vira 20/09 21h no horário de Brasília). Formata
// esse caso direto da string, sem passar por Date, pra nunca errar o dia; datas com hora (com "T",
// de <input type="datetime-local"> ou timestamps do servidor) seguem pelo caminho de sempre.
function fmtData(iso) {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { const [ano, mes, dia] = iso.split('-'); return `${dia}/${mes}`; }
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function badgeStatus(status) {
  if (status === 'aprovado') return `<span class="badge badge-aprovado">Aprovado</span>`;
  if (status === 'alteracao_sugerida') return `<span class="badge badge-alteracao">Alteração sugerida</span>`;
  return `<span class="badge badge-pendente">Em análise</span>`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// as fontes padrão do jsPDF (Helvetica) só sabem desenhar o intervalo Latin-1 — emoji e outros
// símbolos fora dele (digitados por autocorreção do teclado do celular, por ex.) viram
// caracteres corrompidos no PDF em vez de sumirem, então tiram esses símbolos antes de imprimir.
function limparPdf(s) {
  return String(s == null ? '' : s)
    .replace(/[✅✓•]/g, '-')
    .replace(/[^\x00-\xFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function numeroOS(a) { return a.numero_os || `OS-${String(a.id).padStart(6, '0')}`; }

// campo de empresa/cliente com dropdown pesquisável (combobox) — em vez de um <select> puro.
// idPrefix vira "<idPrefix>-nome" (o que o usuário digita/vê) + "<idPrefix>" (hidden com o id resolvido)
// + "<idPrefix>-lista" (o menu suspenso). Clicar no campo mostra todas as empresas em ordem
// alfabética; digitar filtra pelas que começam com o texto digitado.
function campoClienteHTML(idPrefix, clientes, placeholder, onResolved) {
  return `
    <div class="combo-cliente" id="${idPrefix}-wrap">
      <input id="${idPrefix}-nome" autocomplete="off" placeholder="${esc(placeholder || 'Clique para escolher a empresa...')}"
        oninput="filtrarComboCliente('${idPrefix}'${onResolved ? `, '${onResolved}'` : ''})"
        onfocus="this.select(); abrirComboCliente('${idPrefix}'${onResolved ? `, '${onResolved}'` : ''})"
        onblur="setTimeout(() => resolverClienteDigitado('${idPrefix}'${onResolved ? `, '${onResolved}'` : ''}), 250)">
      <div class="combo-lista" id="${idPrefix}-lista"></div>
      <input type="hidden" id="${idPrefix}">
    </div>`;
}

function todosClientesOrdenados() {
  return (window._clientesCache || []).slice().sort((a, b) => a.nome_empresa.localeCompare(b.nome_empresa, 'pt-BR'));
}

function renderComboClienteLista(idPrefix, itens, onResolved) {
  const lista = document.getElementById(idPrefix + '-lista');
  if (!lista) return;
  lista.innerHTML = itens.length
    ? itens.map((c) => `<button type="button" class="combo-item" onmousedown="event.preventDefault(); selecionarClienteCombo('${idPrefix}', ${c.id}${onResolved ? `, '${onResolved}'` : ''})">${esc(c.nome_empresa)}</button>`).join('')
    : `<div class="combo-empty">Nenhuma empresa encontrada — cadastre em Clientes.</div>`;
  lista.classList.add('show');
}

// abre o menu mostrando SEMPRE a lista completa (ignora o texto atual do campo, que pode ser
// o nome já selecionado) — clicar na caixa é sempre um convite a navegar/pesquisar do zero.
function abrirComboCliente(idPrefix, onResolved) {
  renderComboClienteLista(idPrefix, todosClientesOrdenados(), onResolved);
}

function filtrarComboCliente(idPrefix, onResolved) {
  document.getElementById(idPrefix).value = '';
  const termo = document.getElementById(idPrefix + '-nome').value.trim().toLowerCase();
  const itens = termo ? todosClientesOrdenados().filter((c) => c.nome_empresa.trim().toLowerCase().startsWith(termo)) : todosClientesOrdenados();
  renderComboClienteLista(idPrefix, itens, onResolved);
}

function selecionarClienteCombo(idPrefix, clienteId, onResolved) {
  const cliente = (window._clientesCache || []).find((c) => c.id === clienteId);
  if (!cliente) return;
  document.getElementById(idPrefix + '-nome').value = cliente.nome_empresa;
  document.getElementById(idPrefix).value = cliente.id;
  document.getElementById(idPrefix + '-lista').classList.remove('show');
  if (onResolved && typeof window[onResolved] === 'function') window[onResolved]();
}

// se o admin digitou/colou o nome da empresa (ou o navegador autopreencheu o campo) sem
// clicar numa sugestão da lista, o id oculto fica vazio mesmo com o texto certo na tela —
// ao sair do campo, tenta casar o texto com uma empresa cadastrada e resolve sozinho.
function resolverClienteDigitado(idPrefix, onResolved) {
  // o formulário pode já ter sido salvo/fechado antes do atraso de 250ms acabar — se os
  // campos não existem mais no DOM, não há nada a resolver.
  const campoOculto = document.getElementById(idPrefix);
  const campoNome = document.getElementById(idPrefix + '-nome');
  if (!campoOculto || !campoNome) return;
  if (campoOculto.value) return;
  const texto = campoNome.value.trim().toLowerCase();
  if (!texto) return;
  const cliente = (window._clientesCache || []).find((c) => c.nome_empresa.trim().toLowerCase() === texto);
  if (cliente) {
    selecionarClienteCombo(idPrefix, cliente.id, onResolved);
  } else {
    campoNome.value = '';
  }
}

document.addEventListener('click', (e) => {
  document.querySelectorAll('.combo-cliente .combo-lista.show').forEach((lista) => {
    if (!lista.parentElement.contains(e.target)) lista.classList.remove('show');
  });
});

// ---------- sino de notificações ----------

async function atualizarSino() {
  try {
    const { notificacoes, contador } = await api('/api/notificacoes');
    const badge = document.getElementById('bell-badge');
    if (!badge) return;
    badge.textContent = contador;
    badge.classList.toggle('hidden', contador === 0);
    document.getElementById('bell-panel').innerHTML = `
      <div class="bell-title">Notificações</div>
      ${notificacoes.length ? notificacoes.map((n) => `<button class="bell-item" onclick="clicarNotificacao(${n.registro_id}, '${n.tipo}')">${esc(n.texto)}</button>`).join('') : '<div class="bell-empty">Nenhuma notificação no momento.</div>'}
    `;
  } catch (e) { /* silencioso: não interrompe a navegação por causa do sino */ }
}

function alternarSino() {
  document.getElementById('bell-panel').classList.toggle('show');
  atualizarSino();
}

async function clicarNotificacao(registroId, tipo) {
  document.getElementById('bell-panel').classList.remove('show');
  if (tipo === 'alteracao_sugerida') {
    try { await api(`/api/registros/${registroId}/marcar-lida`, { method: 'POST' }); } catch (e) {}
    ir('meus-registros');
  } else if (tipo === 'os_aprovada' || tipo === 'os_reprovada' || tipo === 'os_edicao_sugerida') {
    try { await api(`/api/visitas/${registroId}/marcar-lida`, { method: 'POST' }); } catch (e) {}
    ir('agenda');
  } else if (tipo === 'os_atribuida') {
    try { await api(`/api/agenda/${registroId}/marcar-lida`, { method: 'POST' }); } catch (e) {}
    ir('agenda');
  } else if (tipo === 'relatorio_pendente') {
    ir('aprovacoes-visitas');
  } else if (tipo === 'edicao_solicitada_biblioteca') {
    ir('solicitacoes-edicao-biblioteca');
  } else if (tipo === 'chamado_fila') {
    ir('fila-atendimento');
  } else if (tipo === 'chamado_mensagem') {
    paginaAtual = 'fila-atendimento';
    montarSidebar();
    abrirChatAtendimentoTecnico(registroId);
  } else if (tipo === 'chamado_mensagem_cliente') {
    ir('chamados');
  } else {
    ir('aprovacoes-biblioteca');
  }
  atualizarSino();
}

document.addEventListener('click', (e) => {
  const painel = document.getElementById('bell-panel');
  const sino = document.getElementById('btn-bell');
  if (painel && !painel.contains(e.target) && sino && !sino.contains(e.target)) painel.classList.remove('show');
});

// ---------- AGENDA ----------
let minhaAgendaDetalheId = null;
async function carregarAgendaComVisitas() {
  const [{ agenda }, { visitas }] = await Promise.all([api('/api/agenda'), api('/api/visitas')]);
  window._agendaCache = agenda;
  window._visitasPorAgenda = {};
  window._visitasRetornoPorAgenda = {};
  visitas.forEach((v) => {
    if ((v.rodada || 1) === 1) window._visitasPorAgenda[v.agenda_id] = v;
    else window._visitasRetornoPorAgenda[v.agenda_id] = v;
  });
}

// filtro Ativos/Finalizados reaproveitado em toda tela de cards de O.S. — o padrão é sempre
// "Ativos" (as finalizadas ficam escondidas, disponíveis pelo próprio filtro) pra não acumular
// card antigo nas telas principais, pra nenhum papel de usuário.
function botoesFiltroStatusOS(valor, funcaoOnClick) {
  const ativoStyle = 'background:var(--blue); color:#fff; border-color:var(--blue);';
  return `
    <div style="display:flex; gap:6px;">
      <button class="btn-outline-sm" style="${valor === 'ativos' ? ativoStyle : ''}" onclick="${funcaoOnClick}('ativos')">Ativos</button>
      <button class="btn-outline-sm" style="${valor === 'finalizados' ? ativoStyle : ''}" onclick="${funcaoOnClick}('finalizados')">Finalizados</button>
    </div>`;
}
function filtrarPorStatusOS(lista, filtro) {
  return (lista || []).filter((a) => (filtro === 'finalizados') === !!a.finalizada);
}

let minhaAgendaFiltro = 'ativos';

async function renderAgenda() {
  if (USER.papel === 'administrador') {
    await carregarAgendaComVisitas();
    return renderAgendaCalendario();
  }
  minhaAgendaDetalheId = null;
  await carregarAgendaComVisitas();
  desenharMinhaAgenda();
}

function alternarFiltroMinhaAgenda(valor) {
  minhaAgendaFiltro = valor;
  desenharMinhaAgenda();
}

function desenharMinhaAgenda() {
  const agenda = filtrarPorStatusOS(window._agendaCache, minhaAgendaFiltro);
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Minha agenda</h1><p>${agenda.length} atividade(s)</p></div>
      ${botoesFiltroStatusOS(minhaAgendaFiltro, 'alternarFiltroMinhaAgenda')}
    </div>
    ${agenda.length ? `<div class="os-grid">${agenda.map((a) => cardOSMinhaAgenda(a)).join('')}</div>` : `<div class="empty">Nenhuma atividade ${minhaAgendaFiltro === 'finalizados' ? 'finalizada' : 'ativa'} no momento.</div>`}
    <div id="diario-form"></div>
  `;
}

// card da própria O.S. do técnico na "Minha agenda" — mesmo layout de card usado em todo o
// resto do sistema (osCardCorpo), pra ficar igual em qualquer tamanho de tela (PC ou app) e
// já trazer o selo de retrabalho, a tarja de fase etc.
function cardOSMinhaAgenda(a) {
  return `
    <div class="os-card${a.finalizada ? ' os-card-finalizada' : ''}" onclick="abrirDetalheOSMinhaAgenda(${a.id})" style="cursor:pointer;">
      ${osCardCorpo(a)}
      <div class="os-card-actions" onclick="event.stopPropagation()">
        <button class="os-card-toggle" onclick="abrirDetalheOSMinhaAgenda(${a.id})">Abrir</button>
      </div>
    </div>`;
}

function abrirDetalheOSMinhaAgenda(id) {
  minhaAgendaDetalheId = id;
  const a = (window._agendaCache || []).find((x) => x.id === id);
  if (!a) return;
  const visita = (window._visitasPorAgenda || {})[id];
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(numeroOS(a))}</h1><p>${esc(a.cliente_nome || '—')}</p></div>
      <button class="btn-outline-sm" onclick="renderAgenda()">‹ Voltar</button>
    </div>
    <div class="panel">
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">${acoesOSCalendarioTecnico(a, visita)}</div>
      ${detalheCompletoOS(a, visita)}
    </div>`;
}

// ---------- AGENDA GERAL (admin): calendário mensal ----------
const MES_LABEL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DOW_LABEL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
let calAno = new Date().getFullYear();
let calMes = new Date().getMonth();
let calDiaSelecionado = null;
let calFiltro = 'ativos';

function dataISOLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderAgendaCalendario() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Agenda geral</h1><p>${(window._agendaCache || []).length} atividade(s) no total</p></div>
      <button class="btn btn-primary btn-sm" onclick="mostrarFormNovaAtividade()">+ Nova Ordem de Serviço</button>
    </div>
    <div id="form-nova-atividade"></div>
    <div class="panel">
      <div class="cal-head">
        <div class="cal-nav">
          <button onclick="mudarMesCalendario(-1)">‹</button>
          <div class="cal-mes-label" id="cal-mes-label"></div>
          <button onclick="mudarMesCalendario(1)">›</button>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          ${botoesFiltroStatusOS(calFiltro, 'alternarFiltroCalendario')}
          <button class="btn-outline-sm" onclick="irParaHojeCalendario()">Hoje</button>
        </div>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
    </div>
  `;
  desenharGradeCalendario();
}

function alternarFiltroCalendario(valor) {
  calFiltro = valor;
  desenharGradeCalendario();
}

function mudarMesCalendario(delta) {
  calMes += delta;
  if (calMes < 0) { calMes = 11; calAno--; }
  if (calMes > 11) { calMes = 0; calAno++; }
  desenharGradeCalendario();
}

function irParaHojeCalendario() {
  const hoje = new Date();
  calAno = hoje.getFullYear();
  calMes = hoje.getMonth();
  calDiaSelecionado = dataISOLocal(hoje);
  desenharGradeCalendario();
}

function desenharGradeCalendario() {
  const label = document.getElementById('cal-mes-label');
  if (label) label.textContent = `${MES_LABEL[calMes]} de ${calAno}`;
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  const agenda = filtrarPorStatusOS(window._agendaCache, calFiltro);
  const contagemPorDia = {};
  agenda.forEach((a) => {
    const dia = (a.data_hora_inicio || '').slice(0, 10);
    if (!dia) return;
    contagemPorDia[dia] = (contagemPorDia[dia] || 0) + 1;
  });

  const inicioSemana = new Date(calAno, calMes, 1).getDay();
  const diasNoMes = new Date(calAno, calMes + 1, 0).getDate();
  const hojeISO = dataISOLocal(new Date());

  const celulas = [];
  for (let i = 0; i < inicioSemana; i++) celulas.push(new Date(calAno, calMes, 1 - (inicioSemana - i)));
  for (let dia = 1; dia <= diasNoMes; dia++) celulas.push(new Date(calAno, calMes, dia));
  while (celulas.length % 7 !== 0) {
    const ultima = celulas[celulas.length - 1];
    celulas.push(new Date(ultima.getFullYear(), ultima.getMonth(), ultima.getDate() + 1));
  }

  grid.innerHTML = DOW_LABEL.map((d) => `<div class="cal-dow">${d}</div>`).join('') +
    celulas.map((data) => {
      const iso = dataISOLocal(data);
      const qtd = contagemPorDia[iso] || 0;
      const classes = ['cal-day'];
      if (data.getMonth() !== calMes) classes.push('fora-mes');
      if (iso === hojeISO) classes.push('hoje');
      if (iso === calDiaSelecionado) classes.push('selecionado');
      return `<div class="${classes.join(' ')}" onclick="selecionarDiaCalendario('${iso}')">
        <div class="cal-day-num">${data.getDate()}</div>
        ${qtd ? `<div class="cal-day-badge">${qtd}</div>` : ''}
      </div>`;
    }).join('');
}

function selecionarDiaCalendario(iso) {
  calDiaSelecionado = iso;
  renderDiaCalendario(iso);
}

// tela separada (substitui o calendário) com só os cards de O.S. do dia escolhido
function alternarFiltroCalendarioDia(valor, iso) {
  calFiltro = valor;
  renderDiaCalendario(iso);
}

function renderDiaCalendario(iso) {
  const agenda = filtrarPorStatusOS(window._agendaCache, calFiltro)
    .filter((a) => (a.data_hora_inicio || '').slice(0, 10) === iso)
    .sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  const [y, m, d] = iso.split('-');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Ordens de serviço em ${d}/${m}/${y}</h1><p>${agenda.length} O.S. agendada(s) para este dia</p></div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        ${botoesFiltroStatusOS(calFiltro, `((valor) => alternarFiltroCalendarioDia(valor, '${iso}'))`)}
        <button class="btn-outline-sm" onclick="renderAgendaCalendario()">‹ Voltar ao calendário</button>
      </div>
    </div>
    ${agenda.length ? `<div class="os-grid">${agenda.map((a) => cardOS(a)).join('')}</div>` : `<div class="empty">Nenhuma O.S. agendada para este dia.</div>`}
  `;
}

// tela separada (substitui a lista do dia) com só os detalhes de uma O.S.
function abrirDetalheOSCalendario(id) {
  const a = (window._agendaCache || []).find((x) => x.id === id);
  if (!a) return;
  const visita = (window._visitasPorAgenda || {})[id];
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(numeroOS(a))}</h1><p>${esc(a.cliente_nome || '—')}</p></div>
      <button class="btn-outline-sm" onclick="renderDiaCalendario('${calDiaSelecionado}')">‹ Voltar para o dia</button>
    </div>
    <div id="form-nova-atividade"></div>
    <div class="panel">
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">${acoesOS(a, visita)}</div>
      ${detalheCompletoOS(a, visita)}
    </div>
  `;
}

const STATUS_OS_LABEL = { agendado: 'Agendado', pendente: 'Pendente', concluido: 'Concluído', finalizada: 'Finalizada' };

function statusOS(a) {
  if (a.finalizada) return 'finalizada';
  if (a.status === 'concluida') return a.visita_status === 'aprovado' ? 'concluido' : 'pendente';
  const hojeISO = dataISOLocal(new Date());
  const diaAtendimento = (a.data_hora_inicio || '').slice(0, 10);
  return diaAtendimento > hojeISO ? 'agendado' : 'pendente';
}

function diasEntre(isoInicio, isoFim) {
  const a = new Date(isoInicio + 'T00:00:00');
  const b = new Date(isoFim + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// diz em que ponto da linha do tempo a O.S. está agora — vira a tarja horizontal
// no topo do card, pra dar pra ver o andamento de todos os cards sem abrir um por um
// cada tarja corresponde exatamente a uma etapa em aberto da linha do tempo (timelineOS) —
// mostra sempre a etapa mais adiantada que ainda está pendente.
const FASE_ATENDIMENTO_TARJA = {
  em_atendimento: { label: 'Em atendimento', cor: 'blue' },
  aguardando_pos_venda: { label: 'Aguardando pós-venda', cor: 'purple' },
  aguardando_equipamento: { label: 'Aguardando equipamento', cor: 'amber' },
  em_diagnostico_reparo: { label: 'Em diagnóstico (reparo)', cor: 'orange' },
  orcamento_enviado: { label: 'Orçamento enviado', cor: 'pink' },
  executando_reparo: { label: 'Executando reparo', cor: 'teal' },
  aguardando_saida_estoque: { label: 'Aguardando saída (estoque)', cor: 'navy' },
  aguardando_criacao_os: { label: 'Aguardando criação da O.S.', cor: 'red' },
};

function faseAtualOS(a) {
  const visita = (window._visitasPorAgenda || {})[a.id];
  if (a.finalizada) return { label: 'Finalizada', cor: 'green' };
  // O.S. de atendimento (nascida do chat) segue o fluxo de pós-venda/reparo, não o fluxo normal
  // de deslocamento/orçamento/feedback do cliente
  if (a.tipo === 'atendimento' && a.fase_atendimento) return FASE_ATENDIMENTO_TARJA[a.fase_atendimento] || FASE_ATENDIMENTO_TARJA.em_atendimento;
  if (visita && visita.status_aprovacao === 'aprovado' && a.visita_tem_pecas && !a.orcamento_aprovado_em) return { label: 'Orçamento', cor: 'orange' };
  if (visita && visita.status_aprovacao === 'aprovado' && a.retorno_pendente_tecnico) {
    if (a.retorno_chegada_confirmada_em) return { label: 'Chegou (retorno)', cor: 'teal' };
    if (a.retorno_deslocamento_iniciado_em) return { label: 'Técnico a caminho', cor: 'blue' };
    if (a.retorno_confirmado_cliente_em) return { label: 'Aguardando deslocamento', cor: 'amber' };
    return { label: 'Confirmar cliente (retorno)', cor: 'red' };
  }
  if (visita && visita.status_aprovacao === 'aprovado' && !a.feedback_cliente_em) return { label: 'Aguardando feedback', cor: 'pink' };
  if (visita && visita.status_aprovacao === 'aprovado') return { label: 'Aguardando finalização', cor: 'teal' };
  if (visita && visita.status_aprovacao === 'reprovado') return { label: 'Relatório reprovado', cor: 'red' };
  if (visita) return { label: 'Relatório em análise', cor: 'orange' };
  if (a.chegada_confirmada_em) return { label: 'Chegou', cor: 'teal' };
  if (a.deslocamento_iniciado_em) return { label: 'Técnico a caminho', cor: 'blue' };
  if (!a.confirmado_cliente_em) return { label: 'Confirmação cliente', cor: 'purple' };
  return { label: 'Aguardando deslocamento', cor: 'amber' };
}

function osCardCorpo(a) {
  const status = statusOS(a);
  const fase = faseAtualOS(a);
  const hojeISO = dataISOLocal(new Date());
  const diaAtendimento = (a.data_hora_inicio || '').slice(0, 10);
  const diaAbertura = (a.criado_em || a.data_hora_inicio || '').slice(0, 10);
  const diffVenc = diasEntre(hojeISO, diaAtendimento);
  const vencRelativo = diffVenc === 0 ? 'hoje' : diffVenc > 0 ? `em ${diffVenc} dia${diffVenc === 1 ? '' : 's'}` : `há ${-diffVenc} dia${diffVenc === -1 ? '' : 's'}`;
  const vencClasse = diffVenc < 0 ? 'os-venc-vencido' : diffVenc === 0 ? 'os-venc-hoje' : 'os-venc-futuro';
  const [vy, vm, vd] = diaAtendimento.split('-');
  const diasAbertura = Math.max(0, diasEntre(diaAbertura, hojeISO));
  return `
      ${a.retrabalho ? `<div class="os-badge-retrabalho" title="Retrabalho">R</div>` : ''}
      <div class="os-fase-banner os-fase-${fase.cor}">${esc(fase.label)}</div>
      <div class="os-tarja os-tarja-${status}">${STATUS_OS_LABEL[status]}</div>
      <div class="os-card-top">
        <span class="tag tag-${TIPO_OS_COR[a.tipo] || 'blue'} os-tag-tipo" title="${esc(TIPO_OS_LABEL[a.tipo] || a.tipo)}">${esc(TIPO_OS_LABEL_CURTO[a.tipo] || TIPO_OS_LABEL[a.tipo] || a.tipo)}</span>
        ${tagSla(a)}
        <span class="tag os-tag-tecnico" title="${esc(a.tecnico_nome || '—')}">${esc(a.tecnico_nome || '—')}</span>
      </div>
      <div class="os-card-title">${esc(a.cliente_nome || '—')}</div>
      <div class="os-card-fields">
        <div class="os-field"><span class="os-field-label"># Nº da O.S.</span><span class="os-field-value">${esc(numeroOS(a))}</span></div>
        <div class="os-field"><span class="os-field-label">Contato</span><span class="os-field-value">${esc(a.contato || a.cliente_contato || '—')}</span></div>
        <div class="os-field"><span class="os-field-label">E-mail</span><span class="os-field-value">${esc(a.email || a.cliente_email || '—')}</span></div>
        <div class="os-field"><span class="os-field-label">Telefone</span><span class="os-field-value">${esc(a.telefone || a.cliente_telefone || '—')}</span></div>
      </div>
      <div class="os-card-footer">
        <span class="os-venc ${vencClasse}">Venc ${vd}/${vm} · ${vencRelativo}</span>
        <span class="os-dias-abertura">${diasAbertura} dia${diasAbertura === 1 ? '' : 's'} desde a abertura</span>
      </div>`;
}

function cardOS(a) {
  return `
    <div class="os-card${a.finalizada ? ' os-card-finalizada' : ''}" onclick="abrirDetalheOSCalendario(${a.id})" style="cursor:pointer;">
      ${osCardCorpo(a)}
      <div class="os-card-actions" onclick="event.stopPropagation()">
        <button class="os-card-toggle" onclick="abrirDetalheOSCalendario(${a.id})">Abrir</button>
      </div>
    </div>`;
}

let agendaEmEdicaoId = null;
async function mostrarFormNovaAtividade(agendaItem, origemSolicitacao) {
  agendaEmEdicaoId = agendaItem ? agendaItem.id : null;
  window._origemSolicitacaoId = origemSolicitacao ? origemSolicitacao.id : null;
  const [{ usuarios }, { equipamentos }, { clientes }, sugestaoNumero] = await Promise.all([
    api('/api/usuarios'), api('/api/equipamentos'), api('/api/clientes'),
    agendaItem ? Promise.resolve(null) : api('/api/agenda/proximo-numero'),
  ]);
  const tecnicos = usuarios.filter((u) => u.papel === 'suporte');
  window._clientesCache = clientes;
  window._equipamentosCache = equipamentos;
  document.getElementById('form-nova-atividade').innerHTML = `
    <div class="panel"><div class="panel-head">${agendaItem ? 'Editar Ordem de Serviço' : origemSolicitacao ? 'Nova O.S. — a partir da Solicitação de Atendimento' : 'Nova Ordem de Serviço'}</div>
      <h2 style="margin-top:0;">Tipo de serviço</h2>
      <div class="form-grid">
        <div><label>Nº da O.S.</label><input id="na-numero-os" value="${esc(agendaItem ? numeroOS(agendaItem) : sugestaoNumero.numero)}"></div>
        <div><label>Tipo</label><select id="na-tipo" onchange="atualizarTipoNovaAtividade()">
          <option value="corretiva" ${agendaItem && agendaItem.tipo === 'corretiva' ? 'selected' : ''}>Corretiva</option>
          <option value="preventiva" ${agendaItem && agendaItem.tipo === 'preventiva' ? 'selected' : ''}>Preventiva</option>
          <option value="treinamento_online" ${agendaItem && agendaItem.tipo === 'treinamento_online' ? 'selected' : ''}>Treinamento online</option>
          <option value="treinamento_presencial" ${agendaItem && agendaItem.tipo === 'treinamento_presencial' ? 'selected' : ''}>Treinamento presencial</option>
          <option value="demonstracao_tecnica" ${agendaItem && agendaItem.tipo === 'demonstracao_tecnica' ? 'selected' : ''}>Demonstração Técnica</option>
        </select></div>
      </div>

      <h2>Dados do cliente</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Pré-preenchido a partir do cadastro do cliente — ajuste se for diferente para este atendimento. Fica travado para o técnico.</p>
      <div class="form-grid">
        <div class="full"><label>Empresa (cliente)</label>${campoClienteHTML('na-cliente', clientes, 'Clique para escolher a empresa...', 'preencherClienteNovaAtividade')}</div>
        <div><label>Contato*</label><input id="na-contato" placeholder="Nome do funcionário responsável por receber o técnico" value="${agendaItem ? esc(agendaItem.contato || '') : ''}"></div>
        <div><label>Telefone*</label><input id="na-telefone" value="${agendaItem ? esc(agendaItem.telefone || '') : ''}"></div>
        <div><label>E-mail*</label><input id="na-email" value="${agendaItem ? esc(agendaItem.email || '') : ''}"></div>
        <div><label>Setor do cliente</label><input id="na-setor-cliente" value="${agendaItem ? esc(agendaItem.setor_cliente || '') : ''}"></div>
      </div>
      <div class="form-grid" id="na-endereco-wrap">
        <div class="full"><label>Endereço*</label><input id="na-endereco" value="${agendaItem ? esc(agendaItem.endereco || '') : ''}"></div>
        <div><label>Número*</label><input id="na-numero" value="${agendaItem ? esc(agendaItem.numero || '') : ''}"></div>
        <div><label>Bairro*</label><input id="na-bairro" value="${agendaItem ? esc(agendaItem.bairro || '') : ''}"></div>
        <div><label>CEP*</label><input id="na-cep" value="${agendaItem ? esc(agendaItem.cep || '') : ''}"></div>
        <div><label>Cidade*</label><input id="na-cidade" value="${agendaItem ? esc(agendaItem.cidade || '') : ''}"></div>
        <div><label>Estado*</label><select id="na-estado"><option value="">Selecione</option>${Object.keys(UF_REGIAO).map((uf) => `<option value="${uf}" ${agendaItem && agendaItem.estado === uf ? 'selected' : ''}>${uf}</option>`).join('')}</select></div>
      </div>

      <h2>Dados do equipamento</h2>
      <div class="form-grid">
        <div class="full"><label>Equipamento</label><select id="na-equip" onchange="preencherNumeroSerieNovaAtividade()"></select></div>
        <div class="full"><label>Problema relatado / serviço</label><textarea id="na-problema" placeholder="Descreva o problema relatado pelo cliente ou o serviço a ser feito...">${agendaItem ? esc(agendaItem.problema || '') : ''}</textarea></div>
      </div>
      <div class="form-grid" id="na-laudo-equip-wrap">
        <div><label>Número de série</label><input id="na-numero-serie" disabled></div>
        <div><label>Data de fabricação</label><input id="na-data-fabricacao" disabled></div>
        <div class="full">
          <label>Está na garantia?*</label>
          <div style="display:flex; gap:18px; margin-bottom:10px;">
            <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="na-garantia" value="sim" onchange="atualizarGarantiaNovaAtividade()" ${agendaItem && agendaItem.garantia === 'sim' ? 'checked' : ''} style="width:auto;"> Sim</label>
            <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="na-garantia" value="nao" onchange="atualizarGarantiaNovaAtividade()" ${agendaItem && agendaItem.garantia === 'nao' ? 'checked' : ''} style="width:auto;"> Não</label>
            <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="na-garantia" value="na" onchange="atualizarGarantiaNovaAtividade()" ${agendaItem && agendaItem.garantia === 'na' ? 'checked' : ''} style="width:auto;"> N/A</label>
          </div>
          <div id="na-garantia-hint" style="color:var(--ink-soft); font-size:13px; margin-top:-8px; margin-bottom:10px;"></div>
        </div>
        <div class="full ${agendaItem && agendaItem.garantia === 'na' ? '' : 'hidden'}" id="na-garantia-obs-wrap"><label>Especifique*</label><input id="na-garantia-obs" placeholder="Explique o motivo do N/A..." value="${agendaItem ? esc(agendaItem.garantia_obs || '') : ''}"></div>
      </div>

      ${(() => {
        // SLA não é definido aqui — é o técnico (ou o pós-venda) quem responde o questionário
        // ao encaminhar o atendimento; o administrador só visualiza e se baseia nele. Ao criar a
        // O.S. de visita técnica a partir de uma Solicitação de Atendimento, o SLA já definido
        // é aplicado automaticamente na nova O.S. (ver finalizar-solicitacao em server.js).
        const origemSla = (agendaItem && agendaItem.sla_nivel) ? agendaItem : (origemSolicitacao && origemSolicitacao.sla_nivel ? origemSolicitacao : null);
        if (!origemSla) return '';
        return `
      <h2>SLA</h2>
      <div class="panel" style="padding:14px 16px;">
        ${tagSla(origemSla)}
        <p style="color:var(--ink-soft); font-size:13px; margin:8px 0 0;">Definido pelo técnico/pós-venda ao encaminhar o atendimento${origemSolicitacao ? ' — será aplicado a esta O.S. automaticamente ao salvar.' : '.'}</p>
      </div>`;
      })()}

      <h2>Data e horário</h2>
      <div class="form-grid">
        <div><label>Início</label><input type="datetime-local" id="na-inicio" value="${agendaItem ? (agendaItem.data_hora_inicio || '').slice(0, 16) : ''}"></div>
        <div><label>Fim previsto</label><input type="datetime-local" id="na-fim" value="${agendaItem ? (agendaItem.data_hora_fim || '').slice(0, 16) : ''}"></div>
      </div>

      <h2>Técnico designado</h2>
      <div class="form-grid">
        <div class="full"><label>Técnico</label><select id="na-tecnico">${tecnicos.map((t) => `<option value="${t.id}" ${agendaItem && agendaItem.tecnico_id === t.id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></div>
      </div>

      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary btn-sm" onclick="salvarNovaAtividade()">${agendaItem ? 'Salvar alterações' : 'Salvar Ordem de Serviço'}</button>
        ${agendaItem ? `<button class="btn btn-ghost btn-sm" onclick="cancelarEdicaoOS()">Cancelar</button>` : ''}
      </div>
    </div>`;
  if (agendaItem) {
    const clienteAtual = clientes.find((c) => c.id === agendaItem.cliente_id);
    if (clienteAtual) {
      document.getElementById('na-cliente-nome').value = clienteAtual.nome_empresa;
      document.getElementById('na-cliente').value = clienteAtual.id;
    }
    preencherClienteNovaAtividade(false);
    document.getElementById('na-equip').value = agendaItem.equipamento_id;
    preencherNumeroSerieNovaAtividade();
  } else if (origemSolicitacao) {
    // puxa empresa/contato/equipamento/problema do atendimento original — o admin ajusta
    // apenas data/horário e confirma o técnico antes de salvar
    const clienteAtual = clientes.find((c) => c.id === origemSolicitacao.cliente_id);
    if (clienteAtual) {
      document.getElementById('na-cliente-nome').value = clienteAtual.nome_empresa;
      document.getElementById('na-cliente').value = clienteAtual.id;
    }
    preencherClienteNovaAtividade(false);
    document.getElementById('na-contato').value = origemSolicitacao.contato || '';
    document.getElementById('na-telefone').value = origemSolicitacao.telefone || '';
    document.getElementById('na-email').value = origemSolicitacao.email || '';
    document.getElementById('na-setor-cliente').value = origemSolicitacao.setor_cliente || '';
    document.getElementById('na-endereco').value = origemSolicitacao.endereco || '';
    document.getElementById('na-numero').value = origemSolicitacao.numero || '';
    document.getElementById('na-bairro').value = origemSolicitacao.bairro || '';
    document.getElementById('na-cep').value = origemSolicitacao.cep || '';
    document.getElementById('na-cidade').value = origemSolicitacao.cidade || '';
    document.getElementById('na-estado').value = origemSolicitacao.estado || '';
    document.getElementById('na-problema').value = origemSolicitacao.problema || '';
    if (origemSolicitacao.equipamento_id) {
      document.getElementById('na-equip').value = origemSolicitacao.equipamento_id;
      preencherNumeroSerieNovaAtividade();
    }
  } else {
    preencherClienteNovaAtividade();
  }
  atualizarTipoNovaAtividade();
  atualizarGarantiaNovaAtividade();
}

function cancelarEdicaoOS() {
  agendaEmEdicaoId = null;
  document.getElementById('form-nova-atividade').innerHTML = '';
}

function atualizarTipoNovaAtividade() {
  const tipo = document.getElementById('na-tipo').value;
  document.getElementById('na-endereco-wrap').classList.toggle('hidden', tipo === 'treinamento_online');
  document.getElementById('na-laudo-equip-wrap').classList.toggle('hidden', !TIPOS_LAUDO_TECNICO.includes(tipo));
}

function atualizarGarantiaNovaAtividade() {
  const garantia = document.querySelector('input[name="na-garantia"]:checked');
  document.getElementById('na-garantia-obs-wrap').classList.toggle('hidden', !garantia || garantia.value !== 'na');
}

function preencherNumeroSerieNovaAtividade() {
  const equipId = Number(document.getElementById('na-equip').value);
  const equip = (window._equipamentosCache || []).find((e) => e.id === equipId);
  document.getElementById('na-numero-serie').value = equip ? equip.numero_serie : '';
  document.getElementById('na-data-fabricacao').value = equip ? (equip.data_fabricacao || '—') : '';
  atualizarGarantiaAutomatica(equip ? equip.data_fabricacao : '');
}

// garantia de fábrica: 1 ano a partir da data de fabricação (MM/AAAA). Dentro desse prazo,
// a garantia é automática — trava em "Sim" pra evitar erro de preenchimento. Passado o prazo,
// libera pro admin escolher (pode ter sido feita uma corretiva com um novo prazo de garantia).
function dentroDaGarantiaDeFabrica(dataFabricacao) {
  const m = /^(\d{2})\/(\d{4})$/.exec((dataFabricacao || '').trim());
  if (!m) return null;
  const limite = new Date(Number(m[2]), Number(m[1]) - 1, 1);
  limite.setFullYear(limite.getFullYear() + 1);
  return new Date() <= limite;
}

function atualizarGarantiaAutomatica(dataFabricacao) {
  const radios = document.querySelectorAll('input[name="na-garantia"]');
  if (!radios.length) return;
  const dentroDoAno = dentroDaGarantiaDeFabrica(dataFabricacao);
  const radioSim = document.querySelector('input[name="na-garantia"][value="sim"]');
  if (dentroDoAno) {
    radios.forEach((r) => { r.disabled = true; });
    if (radioSim) { radioSim.checked = true; radioSim.dataset.auto = '1'; }
  } else {
    radios.forEach((r) => { r.disabled = false; });
    // só limpa o "Sim" se ele veio do preenchimento automático (equipamento anterior) —
    // se já era uma escolha manual salva (ex: editando uma O.S. existente), preserva.
    if (radioSim && radioSim.dataset.auto === '1') {
      radioSim.checked = false;
      delete radioSim.dataset.auto;
    }
  }
  const hint = document.getElementById('na-garantia-hint');
  if (hint) hint.textContent = dentroDoAno ? 'Preenchido automaticamente: equipamento ainda dentro de 1 ano de fabricação.' : '';
  atualizarGarantiaNovaAtividade();
}

function preencherClienteNovaAtividade(sobrescreverContato) {
  if (sobrescreverContato === undefined) sobrescreverContato = true;
  const clienteId = Number(document.getElementById('na-cliente').value);
  const cliente = (window._clientesCache || []).find((c) => c.id === clienteId) || {};
  if (sobrescreverContato) {
    document.getElementById('na-contato').value = cliente.contato || '';
    document.getElementById('na-telefone').value = cliente.telefone || '';
    document.getElementById('na-email').value = cliente.email || '';
    document.getElementById('na-setor-cliente').value = cliente.setor || '';
    document.getElementById('na-endereco').value = cliente.endereco || '';
    document.getElementById('na-numero').value = cliente.numero || '';
    document.getElementById('na-bairro').value = cliente.bairro || '';
    document.getElementById('na-cep').value = cliente.cep || '';
    document.getElementById('na-cidade').value = cliente.cidade || '';
    document.getElementById('na-estado').value = cliente.estado || '';
  }

  const equipDoCliente = clienteId ? (window._equipamentosCache || []).filter((e) => e.cliente_id === clienteId) : [];
  document.getElementById('na-equip').innerHTML = !clienteId
    ? `<option value="">Escolha uma empresa primeiro</option>`
    : equipDoCliente.length
      ? equipDoCliente.map((e) => `<option value="${e.id}">${esc(e.tipo)} — ${esc(e.modelo)}</option>`).join('')
      : `<option value="">Nenhum equipamento cadastrado para este cliente</option>`;
  preencherNumeroSerieNovaAtividade();
}

async function salvarNovaAtividade() {
  if (!document.getElementById('na-cliente').value) return alert('Escolha uma empresa cadastrada na lista.');
  const equipId = document.getElementById('na-equip').value;
  if (!equipId) return alert('Nenhum equipamento disponível para esta empresa.');
  const tipoOS = document.getElementById('na-tipo').value;
  if (TIPOS_LAUDO_TECNICO.includes(tipoOS)) {
    const equip = (window._equipamentosCache || []).find((e) => e.id === Number(equipId));
    if (!equip || !equip.numero_serie) return alert('Este equipamento ainda não tem número de série atrelado. Atrele-o em Equipamentos > Atrelar equipamento antes de abrir esta O.S.');
  }
  const body = {
    numero_os: document.getElementById('na-numero-os').value,
    tecnico_id: document.getElementById('na-tecnico').value,
    equipamento_id: document.getElementById('na-equip').value,
    cliente_id: document.getElementById('na-cliente').value,
    tipo: document.getElementById('na-tipo').value,
    data_hora_inicio: document.getElementById('na-inicio').value,
    data_hora_fim: document.getElementById('na-fim').value,
    problema: document.getElementById('na-problema').value,
    contato: document.getElementById('na-contato').value,
    telefone: document.getElementById('na-telefone').value,
    email: document.getElementById('na-email').value,
    setor_cliente: document.getElementById('na-setor-cliente').value,
    endereco: document.getElementById('na-endereco').value,
    numero: document.getElementById('na-numero').value,
    bairro: document.getElementById('na-bairro').value,
    cep: document.getElementById('na-cep').value,
    cidade: document.getElementById('na-cidade').value,
    estado: document.getElementById('na-estado').value,
    garantia: (document.querySelector('input[name="na-garantia"]:checked') || {}).value || '',
    garantia_obs: document.getElementById('na-garantia-obs').value,
  };
  try {
    if (agendaEmEdicaoId) {
      await api(`/api/agenda/${agendaEmEdicaoId}`, { method: 'PUT', body });
      agendaEmEdicaoId = null;
      mostrarToast('Ordem de serviço atualizada.');
    } else {
      const { agenda: novaOS } = await api('/api/agenda', { method: 'POST', body });
      if (window._origemSolicitacaoId) {
        const origemId = window._origemSolicitacaoId;
        window._origemSolicitacaoId = null;
        await api(`/api/agenda/${origemId}/finalizar-solicitacao`, { method: 'POST', body: { nova_os_id: novaOS.id } });
        mostrarToast('O.S. criada — atendimento original encerrado.');
        return ir('fila-solicitacao-atendimento');
      }
    }
    if (paginaAtual === 'aprovacoes-visitas') renderAprovacoesVisitas();
    else renderAgenda();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

function abrirDiario(agendaId) {
  const item = (window._agendaCache || []).find((a) => a.id === agendaId);
  if (!item) return;
  if (TIPOS_LAUDO_TECNICO.includes(item.tipo)) return renderLaudoTecnico(item);
  if (TIPOS_TERMO_ACEITE.includes(item.tipo)) return renderRelatorioCorretiva(item);
  if (item.tipo === 'treinamento_online') return renderRelatorioSimples(item, true);
  if (item.tipo === 'demonstracao_tecnica') return renderRelatorioSimples(item, false);
  document.getElementById('diario-form').innerHTML = `
    <div class="panel"><div class="panel-head">Diário técnico — atividade #${agendaId}</div>
      <div class="form-grid">
        <div class="full"><label>O que foi analisado / encontrado</label><textarea id="dt-causa" placeholder="Causa do defeito..."></textarea></div>
        <div class="full"><label>Correção realizada</label><textarea id="dt-correcao" placeholder="O que foi feito para corrigir..."></textarea></div>
        <div><label>Resultado</label>
          <select id="dt-resultado">
            <option value="solucionado">Solucionado</option>
            <option value="parcial">Parcial</option>
            <option value="nao_solucionado">Não solucionado</option>
            <option value="aguardando_peca">Aguardando peça</option>
          </select>
        </div>
        <div><label>Relevante para a biblioteca?</label>
          <select id="dt-relevante"><option value="true">Sim</option><option value="false">Não</option></select>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="finalizarDiario(${agendaId})">Finalizar atividade</button>
    </div>`;
}

async function finalizarDiario(agendaId) {
  const body = {
    agenda_id: agendaId,
    causa: document.getElementById('dt-causa').value,
    correcao: document.getElementById('dt-correcao').value,
    resultado: document.getElementById('dt-resultado').value,
    relevante_biblioteca: document.getElementById('dt-relevante').value === 'true',
  };
  try {
    const r = await enviarVisitaOuEnfileirar(body);
    mostrarModalSucesso(r.enfileirado ? MSG_ENFILEIRADO : 'Atividade finalizada e enviada para aprovação do administrador.');
    renderAgenda();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- RELATÓRIO TÉCNICO (atendimento corretivo) ----------

function chaveRascunho(agendaId) { return `pc_rascunho_relatorio_${agendaId}`; }

function relatorioPadrao(item) {
  return {
    agenda_id: item.id,
    empresa: item.cliente_nome || '',
    contato: item.contato || item.cliente_contato || '',
    telefone: item.telefone || item.cliente_telefone || '',
    setor_cliente: item.setor_cliente || item.cliente_setor || '',
    endereco: item.endereco || item.cliente_endereco || '',
    numero: item.numero || item.cliente_numero || '',
    bairro: item.bairro || item.cliente_bairro || '',
    cep: item.cep || item.cliente_cep || '',
    cidade: item.cidade || item.cliente_cidade || '',
    estado: item.estado || item.cliente_estado || '',
    data_inicial: (item.data_hora_inicio || '').slice(0, 10),
    data_final: (item.data_hora_fim || '').slice(0, 10),
    modelo_maquina: item.equipamento_modelo || '',
    numero_serie: item.equipamento_serie || '',
    servico: item.problema || '',
    tecnico_nome: USER.nome,
    checklist: CHECKLIST_CORRETIVA.map((label) => ({ item: label, resposta: '', observacao: '' })),
    observacoes: '',
    aceite: '',
    avaliacao: { estrelas: 0, duvidas_sanadas: '', apto_operar: '' },
    assinatura_cliente_nome: '',
    assinatura_cliente_img: null,
    assinatura_tecnico_nome: USER.nome,
    assinatura_tecnico_img: null,
    emails_copia: [''],
    relevante_biblioteca: false,
  };
}

async function renderRelatorioCorretiva(item) {
  relatorioAgendaAtual = item;
  let salvoEm = null;
  try {
    const bruto = localStorage.getItem(chaveRascunho(item.id));
    if (bruto) {
      const salvo = JSON.parse(bruto);
      relatorioDraft = salvo.draft;
      salvoEm = salvo.em;
    } else if (item.visita_id) {
      // atividade reaberta: reaproveita o que o técnico já tinha preenchido antes
      const { visita } = await api(`/api/visitas/${item.visita_id}`);
      relatorioDraft = visita.relatorio ? { ...relatorioPadrao(item), ...visita.relatorio } : relatorioPadrao(item);
    } else {
      relatorioDraft = relatorioPadrao(item);
    }
  } catch (e) { relatorioDraft = relatorioPadrao(item); }
  relatorioDraft.agenda_id = item.id;

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Relatório técnico — ${esc(TIPO_OS_LABEL[item.tipo] || item.tipo)}</h1><p>Preenchimento presencial no cliente. Campos com * são obrigatórios.</p></div>
    <div class="panel">
      <h2>Dados do atendimento</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Definidos pelo administrador na abertura desta OS — não podem ser alterados aqui.</p>
      <div class="form-grid">
        <div><label>Empresa</label><input id="rc-empresa" disabled></div>
        <div><label>Contato</label><input id="rc-contato" disabled></div>
        <div><label>Telefone</label><input id="rc-telefone" disabled></div>
        <div><label>Setor do cliente</label><input id="rc-setor_cliente" disabled></div>
        <div class="full"><label>Endereço</label><input id="rc-endereco" disabled></div>
        <div><label>Número</label><input id="rc-numero" disabled></div>
        <div><label>Bairro</label><input id="rc-bairro" disabled></div>
        <div><label>CEP</label><input id="rc-cep" disabled></div>
        <div><label>Cidade</label><input id="rc-cidade" disabled></div>
        <div><label>Estado</label><input id="rc-estado" disabled></div>
        <div><label>Região</label><input id="rc-regiao" disabled></div>
        <div><label>Data inicial</label><input id="rc-data_inicial" disabled></div>
        <div><label>Data final</label><input id="rc-data_final" disabled></div>
        <div><label>Modelo da máquina</label><input id="rc-modelo_maquina" disabled></div>
        <div><label>Nº de série</label><input id="rc-numero_serie" disabled></div>
        <div><label>Serviço</label><input id="rc-servico" disabled></div>
        <div><label>Técnico</label><input id="rc-tecnico_nome" disabled></div>
      </div>
    </div>

    <div class="panel">
      <h2>Item / entrega / observação*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Marque Sim, Não ou N/A para cada item. Use a observação para detalhar qualquer pendência.</p>
      <div id="rc-checklist"></div>
    </div>

    <div class="panel">
      <h2>Sobre o equipamento</h2>
      <p style="font-size:13.5px; line-height:1.6;">
        O equipamento <b>${esc(item.equipamento_modelo || item.equipamento_tipo || '')}</b> está coberto por uma garantia de 1 ano a partir da data de entrega.
        Esta garantia cobre defeitos de fabricação e mão de obra. Para obter assistência durante o período de garantia, entre em contato conosco através dos seguintes meios:<br><br>
        <b>WhatsApp:</b> ${empresaWhatsapp()} &nbsp; <b>Telefone:</b> ${empresaTelefone()}<br>
        <b>E-mail:</b> ${empresaEmails().slice(0, 2).join(' / ')}
      </p>
    </div>

    <div class="panel">
      <h2>Observações*</h2>
      <textarea id="rc-observacoes" placeholder="Observações adicionais sobre o atendimento (obrigatório — escreva N/A se não houver)" oninput="atualizarRascunho()"></textarea>
    </div>

    <div class="panel">
      <h2>Aceite*</h2>
      <p style="font-size:13.5px; color:var(--ink-soft); line-height:1.6;">Por meio da assinatura deste termo, formalizamos o aceite da entrega técnica final deste serviço em ${esc(item.equipamento_modelo || item.equipamento_tipo || 'equipamento')}.</p>
      <label style="display:flex; align-items:center; gap:8px; font-weight:600; text-transform:none; margin-bottom:8px;"><input type="radio" name="rc-aceite" value="aceito" onchange="atualizarRascunho()" style="width:auto;"> Li e aceito os termos acima</label>
      <label style="display:flex; align-items:center; gap:8px; font-weight:600; text-transform:none;"><input type="radio" name="rc-aceite" value="nao_aceito" onchange="atualizarRascunho()" style="width:auto;"> Não aceito</label>
    </div>

    <div class="panel">
      <h2>Avaliação de desempenho*</h2>
      <label>Em uma escala de 1 a 5, qual a sua satisfação com a entrega técnica?</label>
      <div id="rc-estrelas" style="margin-bottom:18px;"></div>
      <label>O técnico sanou todas as dúvidas na entrega?</label>
      <div style="display:flex; gap:18px; margin-bottom:18px;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rc-duvidas" value="sim" onchange="atualizarRascunho()" style="width:auto;"> Sim</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rc-duvidas" value="nao" onchange="atualizarRascunho()" style="width:auto;"> Não</label>
      </div>
      <label>Você se julga apto a operar o equipamento?</label>
      <div style="display:flex; gap:18px;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rc-apto" value="sim" onchange="atualizarRascunho()" style="width:auto;"> Sim</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rc-apto" value="nao" onchange="atualizarRascunho()" style="width:auto;"> Não</label>
      </div>
    </div>

    <div class="panel">
      <h2>Assinatura*</h2>
      <div class="row2">
        ${blocoAssinatura('cliente', 'Cliente')}
        ${blocoAssinatura('tecnico', 'Técnico')}
      </div>
    </div>

    <div class="panel">
      <h2>Envio do termo*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">E-mails que devem receber uma cópia deste termo assim que ele for concluído e assinado.</p>
      <div id="rc-emails"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarEmailRelatorio()">+ Adicionar e-mail</button>
    </div>

    <div class="panel">
      <h2>Biblioteca de conhecimento</h2>
      <label style="display:flex; align-items:center; gap:10px; font-weight:600; text-transform:none; font-size:13.5px;">
        <input type="checkbox" id="rc-relevante-biblioteca" onchange="atualizarRascunho()" style="width:auto; accent-color:var(--blue);">
        Este atendimento é relevante para a Biblioteca de Defeitos/Falhas — ao ser aprovado pelo administrador, entra na biblioteca com seu nome como autor.
      </label>
    </div>

    <div class="panel">
      <p style="font-size:12.5px; color:var(--ink-soft);">Ao concluir, o PDF do relatório preenchido é gerado e baixado automaticamente.</p>
      <p id="rc-rascunho-status" style="font-size:12px; color:var(--green);">${salvoEm ? `Rascunho salvo automaticamente neste dispositivo às ${salvoEm}` : ''}</p>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="limparRelatorio(${item.id})">Limpar formulário</button>
        <button class="btn btn-primary btn-sm" onclick="concluirRelatorio()">Concluir e gerar PDF</button>
      </div>
    </div>
  `;
  preencherCamposRelatorio();
  renderChecklistRelatorio();
  renderEstrelas();
  renderEmailsRelatorio();
  montarAssinatura('cliente');
  montarAssinatura('tecnico');
}

function blocoAssinatura(chave, titulo) {
  return `
    <div>
      <label>${titulo}</label>
      <input id="rc-assinatura-${chave}-nome" placeholder="Nome do ${titulo.toLowerCase()}" oninput="atualizarRascunho()" style="margin-bottom:8px;">
      <canvas id="rc-canvas-${chave}" width="360" height="150" style="width:100%; max-width:360px; height:150px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div id="rc-assinatura-${chave}-status" style="font-size:12px; color:var(--ink-soft); margin:6px 0;">Assinatura pendente</div>
      <div style="display:flex; gap:8px;">
        <button class="btn-outline-sm" onclick="ampliarAssinatura('${chave}')">⤢ Ampliar para assinar</button>
        <button class="btn-outline-sm" onclick="limparAssinatura('${chave}')">Limpar</button>
      </div>
    </div>`;
}

function preencherCamposRelatorio() {
  const d = relatorioDraft;
  ['empresa', 'contato', 'telefone', 'setor_cliente', 'endereco', 'numero', 'bairro', 'cep', 'cidade', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie', 'servico', 'tecnico_nome', 'observacoes'].forEach((campo) => {
    const el = document.getElementById('rc-' + campo);
    if (el) el.value = d[campo] || '';
  });
  document.getElementById('rc-estado').value = d.estado || '';
  atualizarRegiao();
  if (d.aceite) { const r = document.querySelector(`input[name="rc-aceite"][value="${d.aceite}"]`); if (r) r.checked = true; }
  if (d.avaliacao.duvidas_sanadas) { const r = document.querySelector(`input[name="rc-duvidas"][value="${d.avaliacao.duvidas_sanadas}"]`); if (r) r.checked = true; }
  if (d.avaliacao.apto_operar) { const r = document.querySelector(`input[name="rc-apto"][value="${d.avaliacao.apto_operar}"]`); if (r) r.checked = true; }
  document.getElementById('rc-assinatura-cliente-nome').value = d.assinatura_cliente_nome || '';
  document.getElementById('rc-assinatura-tecnico-nome').value = d.assinatura_tecnico_nome || '';
  document.getElementById('rc-relevante-biblioteca').checked = !!d.relevante_biblioteca;
}

function atualizarRegiao() {
  const uf = document.getElementById('rc-estado').value;
  document.getElementById('rc-regiao').value = UF_REGIAO[uf] || '—';
}

function renderChecklistRelatorio() {
  document.getElementById('rc-checklist').innerHTML = relatorioDraft.checklist.map((c, i) => `
    <div class="step-item" style="margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
        <b style="color:var(--navy); font-size:13.5px;">${String(i + 1).padStart(2, '0')} ${esc(c.item)}</b>
        <div style="display:flex; gap:6px;">
          ${['sim', 'nao', 'na'].map((v) => `<button type="button" class="btn-outline-sm" style="${c.resposta === v ? 'background:var(--blue); color:#fff; border-color:var(--blue);' : ''}" onclick="marcarChecklist(${i}, '${v}')">${v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : 'N/A'}</button>`).join('')}
        </div>
      </div>
      <input placeholder="Observação (opcional)" value="${esc(c.observacao)}" oninput="relatorioDraft.checklist[${i}].observacao=this.value; atualizarRascunho(true);">
    </div>`).join('');
}
function marcarChecklist(i, valor) {
  relatorioDraft.checklist[i].resposta = valor;
  renderChecklistRelatorio();
  atualizarRascunho();
}

function renderEstrelas() {
  document.getElementById('rc-estrelas').innerHTML = [1, 2, 3, 4, 5].map((n) => `
    <button type="button" onclick="marcarEstrela(${n})" style="background:none; border:none; cursor:pointer; font-size:28px; color:${n <= relatorioDraft.avaliacao.estrelas ? 'var(--blue)' : '#D8E2EF'};">★</button>
  `).join('');
}
function marcarEstrela(n) {
  relatorioDraft.avaliacao.estrelas = n;
  renderEstrelas();
  atualizarRascunho();
}

function renderEmailsRelatorio() {
  document.getElementById('rc-emails').innerHTML = relatorioDraft.emails_copia.map((em, i) => `
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <input placeholder="nome@empresa.com" value="${esc(em)}" oninput="relatorioDraft.emails_copia[${i}]=this.value; atualizarRascunho(true);">
      ${relatorioDraft.emails_copia.length > 1 ? `<button class="btn-outline-sm" onclick="removerEmailRelatorio(${i})">×</button>` : ''}
    </div>`).join('');
}
function adicionarEmailRelatorio() { relatorioDraft.emails_copia.push(''); renderEmailsRelatorio(); atualizarRascunho(); }
function removerEmailRelatorio(i) { relatorioDraft.emails_copia.splice(i, 1); renderEmailsRelatorio(); atualizarRascunho(); }

function atualizarRascunho(semLerCampos) {
  if (!semLerCampos) {
    const d = relatorioDraft;
    ['empresa', 'contato', 'telefone', 'setor_cliente', 'endereco', 'numero', 'bairro', 'cep', 'cidade', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie', 'servico', 'tecnico_nome', 'observacoes'].forEach((campo) => {
      const el = document.getElementById('rc-' + campo);
      if (el) d[campo] = el.value;
    });
    d.estado = document.getElementById('rc-estado').value;
    atualizarRegiao();
    const aceite = document.querySelector('input[name="rc-aceite"]:checked');
    d.aceite = aceite ? aceite.value : '';
    const duvidas = document.querySelector('input[name="rc-duvidas"]:checked');
    d.avaliacao.duvidas_sanadas = duvidas ? duvidas.value : '';
    const apto = document.querySelector('input[name="rc-apto"]:checked');
    d.avaliacao.apto_operar = apto ? apto.value : '';
    d.assinatura_cliente_nome = document.getElementById('rc-assinatura-cliente-nome').value;
    d.assinatura_tecnico_nome = document.getElementById('rc-assinatura-tecnico-nome').value;
    d.relevante_biblioteca = document.getElementById('rc-relevante-biblioteca').checked;
  }
  try {
    localStorage.setItem(chaveRascunho(relatorioDraft.agenda_id), JSON.stringify({ draft: relatorioDraft, em: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }));
    const status = document.getElementById('rc-rascunho-status');
    if (status) status.textContent = `Rascunho salvo automaticamente neste dispositivo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {}
}

function limparRelatorio(agendaId) {
  if (!confirm('Limpar todo o formulário e apagar o rascunho salvo?')) return;
  localStorage.removeItem(chaveRascunho(agendaId));
  renderRelatorioCorretiva(relatorioAgendaAtual);
}

// ---------- assinatura (canvas, sem dependências externas) ----------
const assinaturaEstado = {};
function montarAssinatura(chave) {
  const canvas = document.getElementById('rc-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  assinaturaEstado[chave] = { desenhando: false, temTraco: false };
  if (relatorioDraft['assinatura_' + chave + '_img']) {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); assinaturaEstado[chave].temTraco = true; atualizarStatusAssinatura(chave); };
    img.src = relatorioDraft['assinatura_' + chave + '_img'];
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); assinaturaEstado[chave].desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!assinaturaEstado[chave].desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); assinaturaEstado[chave].temTraco = true; }
  function parar() {
    if (!assinaturaEstado[chave].desenhando) return;
    assinaturaEstado[chave].desenhando = false;
    if (assinaturaEstado[chave].temTraco) {
      relatorioDraft['assinatura_' + chave + '_img'] = canvas.toDataURL('image/png');
      atualizarStatusAssinatura(chave);
      atualizarRascunho(true);
    }
  }
  canvas.addEventListener('mousedown', iniciar);
  canvas.addEventListener('mousemove', mover);
  window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false });
  canvas.addEventListener('touchmove', mover, { passive: false });
  canvas.addEventListener('touchend', parar);
}
function atualizarStatusAssinatura(chave) {
  const el = document.getElementById(`rc-assinatura-${chave}-status`);
  if (el) { el.textContent = assinaturaEstado[chave].temTraco ? 'Assinatura registrada' : 'Assinatura pendente'; el.style.color = assinaturaEstado[chave].temTraco ? 'var(--green)' : 'var(--ink-soft)'; }
}
function limparAssinatura(chave) {
  const canvas = document.getElementById('rc-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  assinaturaEstado[chave].temTraco = false;
  relatorioDraft['assinatura_' + chave + '_img'] = null;
  atualizarStatusAssinatura(chave);
  atualizarRascunho(true);
}

function ampliarAssinatura(chave) {
  let modal = document.getElementById('modal-assinatura');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-assinatura';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;">
      <h3>Assinar</h3>
      <p>Desenhe a assinatura com o dedo ou o mouse.</p>
      <canvas id="modal-canvas" width="900" height="380" style="width:100%; height:260px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-canvas').getContext('2d').clearRect(0,0,900,380)">Limpar</button>
        <button class="btn btn-primary" onclick="confirmarAssinaturaModal('${chave}')">Usar esta assinatura</button>
        <button class="btn-outline-sm" onclick="document.getElementById('modal-assinatura').classList.remove('show')">Cancelar</button>
      </div>
    </div>`;
  const canvas = document.getElementById('modal-canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  let desenhando = false;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function parar() { desenhando = false; }
  canvas.addEventListener('mousedown', iniciar); canvas.addEventListener('mousemove', mover); window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false }); canvas.addEventListener('touchmove', mover, { passive: false }); canvas.addEventListener('touchend', parar);
}
function confirmarAssinaturaModal(chave) {
  const modalCanvas = document.getElementById('modal-canvas');
  const destino = document.getElementById('rc-canvas-' + chave);
  const ctxDestino = destino.getContext('2d');
  ctxDestino.clearRect(0, 0, destino.width, destino.height);
  ctxDestino.drawImage(modalCanvas, 0, 0, destino.width, destino.height);
  assinaturaEstado[chave].temTraco = true;
  relatorioDraft['assinatura_' + chave + '_img'] = destino.toDataURL('image/png');
  atualizarStatusAssinatura(chave);
  atualizarRascunho(true);
  document.getElementById('modal-assinatura').classList.remove('show');
}

// ---------- concluir: validar, salvar, gerar PDF, enviar por e-mail ----------
async function concluirRelatorio() {
  atualizarRascunho();
  const d = relatorioDraft;
  const obrigatorios = ['empresa', 'contato', 'telefone', 'endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie', 'servico', 'tecnico_nome', 'observacoes'];
  for (const campo of obrigatorios) {
    if (!String(d[campo] || '').trim()) return alert('Preencha todos os campos obrigatórios de "Dados do atendimento".');
  }
  if (d.checklist.some((c) => !c.resposta)) return alert('Responda todos os itens do checklist (Sim/Não/N-A).');
  if (!d.aceite) return alert('Selecione o aceite do cliente.');
  if (!d.avaliacao.estrelas) return alert('Selecione a avaliação por estrelas.');
  if (!d.avaliacao.duvidas_sanadas || !d.avaliacao.apto_operar) return alert('Responda as duas perguntas da avaliação de desempenho.');
  if (!d.assinatura_cliente_nome || !d.assinatura_cliente_img) return alert('Colete o nome e a assinatura do cliente.');
  if (!d.assinatura_tecnico_nome || !d.assinatura_tecnico_img) return alert('Colete o nome e a assinatura do técnico.');
  const emails = d.emails_copia.map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) return alert('Informe ao menos um e-mail para envio do termo.');

  const body = { agenda_id: d.agenda_id, relatorio: { ...d, emails_copia: emails }, relevante_biblioteca: d.relevante_biblioteca };
  let visita, r;
  try {
    r = await enviarVisitaOuEnfileirar(body, { chaveRascunho: chaveRascunho(d.agenda_id), pdfTermoAceite: { dados: d, agendaItem: relatorioAgendaAtual, emails } });
    visita = r.visita;
  } catch (e) {
    alert('Erro ao concluir: ' + e.message);
    return;
  }
  if (r.enfileirado) {
    mostrarModalSucesso(MSG_ENFILEIRADO);
    renderAgenda();
    return;
  }
  // A partir daqui a visita já foi salva e enviada para aprovação — isso não pode mais falhar
  // pro técnico. PDF e envio por e-mail são best-effort: se falharem, avisa mas não trava.
  localStorage.removeItem(chaveRascunho(d.agenda_id));
  let avisoExtra = '';
  try {
    const pdfDataUri = gerarPdfRelatorio(d, relatorioAgendaAtual);
    const link = document.createElement('a');
    link.href = pdfDataUri;
    link.download = `relatorio-tecnico-${visita.id}.pdf`;
    document.body.appendChild(link); link.click(); link.remove();
    const pdfBase64 = pdfDataUri.split(',')[1];
    try { await api(`/api/visitas/${visita.id}/enviar-relatorio`, { method: 'POST', body: { pdf_base64: pdfBase64, emails } }); }
    catch (e) { avisoExtra = ' O PDF foi gerado, mas o envio por e-mail falhou — tente reenviar depois.'; }
  } catch (e) {
    console.error('Falha ao gerar o PDF localmente:', e);
    avisoExtra = ' O relatório foi salvo, mas não foi possível gerar o PDF neste dispositivo.';
  }
  mostrarModalSucesso('Relatório concluído e enviado para aprovação do administrador.' + avisoExtra);
  renderAgenda();
}

function gerarPdfRelatorio(d, item) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margem = 40; let y = 50;
  const largura = doc.internal.pageSize.getWidth() - margem * 2;
  function titulo(t) { doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(10, 38, 71); doc.text(t, margem, y); y += 18; doc.setDrawColor(20, 103, 214); doc.line(margem, y - 12, margem + largura, y - 12); }
  function linha(rotulo, valor) {
    if (y > 760) { doc.addPage(); y = 50; }
    doc.setFontSize(10); doc.setFont(undefined, 'bold'); doc.setTextColor(74, 85, 104); doc.text(rotulo + ':', margem, y);
    doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38);
    const linhas = doc.splitTextToSize(limparPdf(valor) || '—', largura - 130);
    doc.text(linhas, margem + 130, y);
    y += Math.max(14, linhas.length * 12);
  }
  doc.setFontSize(18); doc.setFont(undefined, 'bold'); doc.setTextColor(10, 38, 71);
  doc.text('Relatório Técnico — Pro Conecta', margem, y); y += 22;
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(74, 85, 104);
  doc.text(`Elaborado: ${new Date().toLocaleDateString('pt-BR')} · Setor: ${USER.setor || 'Suporte Técnico'}`, margem, y); y += 24;

  titulo('Dados do atendimento');
  linha('Empresa', d.empresa); linha('Contato', d.contato); linha('Telefone', d.telefone);
  linha('Endereço', `${d.endereco}, ${d.numero} — ${d.bairro}, ${d.cidade}/${d.estado} — CEP ${d.cep}`);
  linha('Data inicial', d.data_inicial); linha('Data final', d.data_final);
  linha('Modelo da máquina', d.modelo_maquina); linha('Nº de série', d.numero_serie);
  linha('Serviço', d.servico); linha('Técnico', d.tecnico_nome);
  y += 8;

  titulo('Item / entrega / observação');
  d.checklist.forEach((c, i) => {
    if (y > 760) { doc.addPage(); y = 50; }
    const r = c.resposta === 'sim' ? 'Sim' : c.resposta === 'nao' ? 'Não' : 'N/A';
    doc.setFontSize(10); doc.setFont(undefined, 'bold'); doc.setTextColor(16, 24, 38);
    doc.text(limparPdf(`${String(i + 1).padStart(2, '0')}. ${c.item} — ${r}`), margem, y); y += 13;
    if (c.observacao) { doc.setFont(undefined, 'normal'); doc.setTextColor(74, 85, 104); const linhas = doc.splitTextToSize(limparPdf('Obs: ' + c.observacao), largura - 10); doc.text(linhas, margem + 12, y); y += linhas.length * 12; }
  });
  y += 8;

  titulo('Observações');
  { if (y > 740) { doc.addPage(); y = 50; } doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38); const linhas = doc.splitTextToSize(limparPdf(d.observacoes), largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8; }

  titulo('Aceite e avaliação');
  linha('Aceite', d.aceite === 'aceito' ? 'Li e aceito os termos' : 'Não aceito');
  linha('Satisfação', `${d.avaliacao.estrelas}/5 estrelas`);
  linha('Dúvidas sanadas', d.avaliacao.duvidas_sanadas === 'sim' ? 'Sim' : 'Não');
  linha('Apto a operar', d.avaliacao.apto_operar === 'sim' ? 'Sim' : 'Não');
  y += 8;

  if (y > 560) { doc.addPage(); y = 50; }
  titulo('Assinaturas');
  const wImg = 220, hImg = 90;
  doc.setFontSize(10); doc.setTextColor(16, 24, 38);
  doc.text(limparPdf(`Cliente: ${d.assinatura_cliente_nome}`), margem, y);
  doc.text(limparPdf(`Técnico: ${d.assinatura_tecnico_nome}`), margem + largura / 2, y);
  y += 8;
  try { doc.addImage(d.assinatura_cliente_img, 'PNG', margem, y, wImg, hImg); } catch (e) {}
  try { doc.addImage(d.assinatura_tecnico_img, 'PNG', margem + largura / 2, y, wImg, hImg); } catch (e) {}

  return doc.output('datauristring');
}

// ---------- RELATÓRIO SIMPLES (treinamento online / demonstração técnica) ----------
async function renderRelatorioSimples(item, exigirSerie) {
  relatorioAgendaAtual = item;
  let r = {
    empresa: item.cliente_nome || '', contato: item.contato || item.cliente_contato || '', telefone: item.telefone || item.cliente_telefone || '',
    tecnico_nome: USER.nome, equipamento_tipo: item.equipamento_tipo || '', equipamento_modelo: item.equipamento_modelo || '',
    numero_serie: item.equipamento_serie || '', observacoes: '',
  };
  if (item.visita_id) {
    try { const { visita } = await api(`/api/visitas/${item.visita_id}`); if (visita.relatorio_simples) r = { ...r, observacoes: visita.relatorio_simples.observacoes || '' }; } catch (e) {}
  }
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Relatório — ${esc(TIPO_OS_LABEL[item.tipo] || item.tipo)}</h1><p>Dados do cliente e do equipamento definidos pelo administrador. Preencha as observações abaixo.</p></div>
    <div class="panel">
      <div class="form-grid">
        <div><label>Empresa</label><input id="rs-empresa" value="${esc(r.empresa)}" disabled></div>
        <div><label>Contato</label><input id="rs-contato" value="${esc(r.contato)}" disabled></div>
        <div><label>Telefone</label><input id="rs-telefone" value="${esc(r.telefone)}" disabled></div>
        <div><label>Data</label><input id="rs-data" value="${esc((item.data_hora_inicio || '').slice(0, 10))}" disabled></div>
        <div><label>Técnico</label><input id="rs-tecnico" value="${esc(r.tecnico_nome)}" disabled></div>
        <div><label>Equipamento</label><input id="rs-equip-tipo" value="${esc(r.equipamento_tipo)}" disabled></div>
        <div><label>Modelo</label><input id="rs-equip-modelo" value="${esc(r.equipamento_modelo)}" disabled></div>
        ${exigirSerie ? `<div><label>Nº de série</label><input id="rs-serie" value="${esc(r.numero_serie)}" disabled></div>` : ''}
      </div>
      <label>Observações*</label>
      <textarea id="rs-observacoes" placeholder="O que foi feito / observado no atendimento...">${esc(r.observacoes)}</textarea>
      <button class="btn btn-primary btn-sm" style="margin-top:16px;" onclick="concluirRelatorioSimples(${exigirSerie})">Concluir atendimento</button>
    </div>`;
}

async function concluirRelatorioSimples(exigirSerie) {
  const relatorio_simples = {
    empresa: document.getElementById('rs-empresa').value,
    contato: document.getElementById('rs-contato').value,
    telefone: document.getElementById('rs-telefone').value,
    tecnico_nome: document.getElementById('rs-tecnico').value,
    equipamento_tipo: document.getElementById('rs-equip-tipo').value,
    equipamento_modelo: document.getElementById('rs-equip-modelo').value,
    numero_serie: exigirSerie ? document.getElementById('rs-serie').value : '',
    observacoes: document.getElementById('rs-observacoes').value,
  };
  const obrig = ['empresa', 'contato', 'telefone', 'equipamento_tipo', 'equipamento_modelo', 'observacoes'];
  if (exigirSerie) obrig.push('numero_serie');
  for (const c of obrig) {
    if (!String(relatorio_simples[c] || '').trim()) return alert('Preencha todos os campos obrigatórios.');
  }
  try {
    const r = await enviarVisitaOuEnfileirar({ agenda_id: relatorioAgendaAtual.id, relatorio_simples });
    mostrarModalSucesso(r.enfileirado ? MSG_ENFILEIRADO : 'Atendimento concluído e enviado para aprovação do administrador.');
    renderAgenda();
  } catch (e) { alert('Erro ao concluir: ' + e.message); }
}

// ---------- LAUDO TÉCNICO (corretiva / preventiva) ----------
let laudoDraft = null;
let laudoAgendaAtual = null;
function chaveRascunhoLaudo(agendaId, retorno) { return `pc_rascunho_laudo_${agendaId}${retorno ? '_retorno' : ''}`; }

function laudoPadrao(item) {
  return {
    agenda_id: item.id,
    data_fabricacao: item.equipamento_data_fabricacao || '',
    garantia: item.garantia || '', garantia_obs: item.garantia_obs || '',
    acessorios: '', defeito_informado: item.problema || item.servico || '',
    data_entrada: (item.data_hora_inicio || '').slice(0, 16),
    data_conclusao: agoraLocalDatetime(),
    laudo_tecnico: '', servico_realizado: '',
    pecas: [], fotos: [], observacoes: '',
    relevante_biblioteca: false,
    necessidade_retorno: false,
  };
}

function agoraLocalDatetime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// calcula o período de reparo em dias e horas (a maioria dos atendimentos termina no mesmo dia,
// então mostrar só a diferença em dias arredondaria pra "0 dias" e esconderia a duração real)
function periodoReparo(d) {
  if (!d.data_entrada || !d.data_conclusao) return '—';
  const ini = new Date(d.data_entrada);
  const fim = new Date(d.data_conclusao);
  const diffMin = Math.max(0, Math.round((fim - ini) / 60000));
  const dias = Math.floor(diffMin / 1440);
  const horas = Math.floor((diffMin % 1440) / 60);
  const minutos = diffMin % 60;
  const partes = [];
  if (dias > 0) partes.push(`${dias} dia${dias === 1 ? '' : 's'}`);
  if (horas > 0) partes.push(`${horas}h`);
  if (minutos > 0) partes.push(`${minutos}min`);
  return partes.length ? partes.join(' ') : '0min';
}

async function renderLaudoTecnico(item) {
  laudoAgendaAtual = item;
  let salvoEm = null;
  try {
    const bruto = localStorage.getItem(chaveRascunhoLaudo(item.id, item.retorno_pendente_tecnico));
    if (bruto) {
      const salvo = JSON.parse(bruto);
      laudoDraft = salvo.draft;
      salvoEm = salvo.em;
    } else if (item.visita_id && !item.retorno_pendente_tecnico) {
      const { visita } = await api(`/api/visitas/${item.visita_id}`);
      laudoDraft = visita.laudo ? { ...laudoPadrao(item), ...visita.laudo } : laudoPadrao(item);
    } else {
      // relatório de retorno: começa em branco, só com os dados travados da O.S. — não
      // reaproveita o texto do laudo original, que é um atendimento anterior e distinto
      laudoDraft = laudoPadrao(item);
    }
  } catch (e) { laudoDraft = laudoPadrao(item); }
  laudoDraft.agenda_id = item.id;

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${item.retorno_pendente_tecnico ? 'Relatório de retorno' : 'Laudo Técnico'} — ${esc(TIPO_OS_LABEL[item.tipo] || item.tipo)}</h1><p>${item.retorno_pendente_tecnico ? 'Segundo relatório desta O.S., referente ao retorno.' : 'Preenchimento presencial no cliente.'} Campos com * são obrigatórios.</p></div>
    <div class="panel">
      <h2>Dados do atendimento</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Definidos pelo administrador na abertura desta OS — não podem ser alterados aqui.</p>
      <div class="form-grid">
        <div><label>Empresa</label><input value="${esc(item.cliente_nome || '')}" disabled></div>
        <div><label>Contato</label><input value="${esc(item.contato || item.cliente_contato || '')}" disabled></div>
        <div><label>Telefone</label><input value="${esc(item.telefone || item.cliente_telefone || '')}" disabled></div>
        <div class="full"><label>Endereço</label><input value="${esc(`${item.endereco || item.cliente_endereco || ''}, ${item.numero || item.cliente_numero || ''} — ${item.bairro || item.cliente_bairro || ''}, ${item.cidade || item.cliente_cidade || ''}/${item.estado || item.cliente_estado || ''}`)}" disabled></div>
        <div><label>Técnico</label><input value="${esc(USER.nome)}" disabled></div>
        <div><label>Equipamento</label><input value="${esc(`${item.equipamento_tipo || ''} — ${item.equipamento_modelo || ''}`)}" disabled></div>
        <div><label>Nº de série</label><input value="${esc(item.equipamento_serie || '')}" disabled></div>
      </div>
    </div>

    <div class="panel">
      <h2>Dados do equipamento</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Nº de série, data de fabricação, defeito informado e garantia são definidos pelo administrador na abertura da OS — não podem ser alterados aqui.</p>
      <div class="form-grid">
        <div><label>Equipamento</label><input value="${esc(`${item.equipamento_tipo || ''} — ${item.equipamento_modelo || ''}`)}" disabled></div>
        <div><label>Data de fabricação</label><input id="lt-data_fabricacao" disabled></div>
        <div class="full"><label>Acessórios recebidos</label><input id="lt-acessorios" placeholder="ex: cabo de força, fonte, controle..." oninput="atualizarRascunhoLaudo()"></div>
        <div class="full"><label>Defeito informado pelo cliente</label><input id="lt-defeito_informado" disabled></div>
      </div>
      <label>Equipamento está na garantia?</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="lt-garantia" value="sim" disabled style="width:auto;"> Sim</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="lt-garantia" value="nao" disabled style="width:auto;"> Não</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="lt-garantia" value="na" disabled style="width:auto;"> N/A</label>
      </div>
      ${laudoDraft.garantia === 'na' ? `<input id="lt-garantia_obs" disabled>` : ''}
    </div>

    <div class="panel">
      <h2>Técnico responsável</h2>
      <div class="form-grid">
        <div><label>Data de início</label><input id="lt-data_entrada" type="datetime-local" disabled></div>
        <div><label>Data de conclusão*</label><input id="lt-data_conclusao" type="datetime-local" oninput="atualizarRascunhoLaudo()"></div>
        <div><label>Período de reparo</label><input id="lt-periodo" disabled></div>
      </div>
    </div>

    <div class="panel">
      <h2>Laudo técnico*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">O que foi analisado e o que foi encontrado.</p>
      <textarea id="lt-laudo_tecnico" placeholder="Descreva o diagnóstico..." oninput="atualizarRascunhoLaudo()"></textarea>
    </div>

    <div class="panel">
      <h2>Serviço realizado*</h2>
      <textarea id="lt-servico_realizado" placeholder="Descreva o que foi feito para solucionar..." oninput="atualizarRascunhoLaudo()"></textarea>
    </div>

    <div class="panel">
      <h2>Peças fornecidas</h2>
      <div class="steps-list" id="lt-pecas"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarPecaLaudo()">+ Adicionar peça</button>
      <label style="display:flex; align-items:center; gap:10px; font-weight:600; text-transform:none; font-size:13.5px; margin-top:14px;">
        <input type="checkbox" id="lt-necessidade-retorno" onchange="atualizarRascunhoLaudo()" style="width:auto; accent-color:var(--blue);">
        Vai ser necessário um retorno pra concluir o serviço (depois do orçamento das peças aprovado)
      </label>
    </div>

    <div class="panel">
      <h2>Relatório fotográfico*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Anexe ao menos uma foto do equipamento/serviço realizado.</p>
      <div class="step-photos" id="lt-fotos"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">📷</span>Câmera
          <input type="file" accept="image/*" capture="environment" style="display:none" onchange="adicionarFotosLaudo(event)">
        </label>
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">+</span>Galeria
          <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosLaudo(event)">
        </label>
      </div>
    </div>

    <div class="panel">
      <h2>Observações</h2>
      <textarea id="lt-observacoes" placeholder="Observações adicionais (opcional)" oninput="atualizarRascunhoLaudo()"></textarea>
    </div>

    <div class="panel">
      <h2>Sobre o equipamento</h2>
      <p style="font-size:13.5px; line-height:1.6;">
        Para obter assistência durante o período de garantia, entre em contato conosco através dos seguintes meios:<br><br>
        <b>WhatsApp:</b> ${empresaWhatsapp()} &nbsp; <b>Telefone:</b> ${empresaTelefone()}<br>
        <b>E-mail:</b> ${empresaEmails().join(' / ')}
      </p>
    </div>

    <div class="panel">
      <h2>Biblioteca de conhecimento</h2>
      <label style="display:flex; align-items:center; gap:10px; font-weight:600; text-transform:none; font-size:13.5px;">
        <input type="checkbox" id="lt-relevante-biblioteca" onchange="atualizarRascunhoLaudo()" style="width:auto; accent-color:var(--blue);">
        Este atendimento é relevante para a Biblioteca de Defeitos/Falhas — ao ser aprovado pelo administrador, entra na biblioteca com seu nome como autor.
      </label>
    </div>

    <div class="panel">
      <p style="font-size:12.5px; color:var(--ink-soft);">${item.retorno_pendente_tecnico ? 'Ao finalizar, o relatório de retorno é enviado direto — sem passar de novo pela aprovação do gestor.' : 'Ao finalizar, o laudo é enviado para aprovação do administrador. O PDF fica disponível para gerar assim que ele for aprovado.'}</p>
      <p id="lt-rascunho-status" style="font-size:12px; color:var(--green);">${salvoEm ? `Rascunho salvo automaticamente neste dispositivo às ${salvoEm}` : ''}</p>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="limparLaudo(${item.id})">Limpar formulário</button>
        <button class="btn btn-primary btn-sm" onclick="concluirLaudoTecnico()">Finalizar</button>
      </div>
    </div>`;
  preencherCamposLaudo();
  renderPecasLaudo();
  renderFotosLaudo();
}

function preencherCamposLaudo() {
  const d = laudoDraft;
  ['data_fabricacao', 'acessorios', 'defeito_informado', 'garantia_obs', 'data_conclusao', 'laudo_tecnico', 'servico_realizado', 'observacoes'].forEach((campo) => {
    const el = document.getElementById('lt-' + campo);
    if (el) el.value = d[campo] || '';
  });
  document.getElementById('lt-data_entrada').value = d.data_entrada || '';
  document.getElementById('lt-periodo').value = periodoReparo(d);
  if (d.garantia) { const r = document.querySelector(`input[name="lt-garantia"][value="${d.garantia}"]`); if (r) r.checked = true; }
  document.getElementById('lt-relevante-biblioteca').checked = !!d.relevante_biblioteca;
  document.getElementById('lt-necessidade-retorno').checked = !!d.necessidade_retorno;
}

function renderPecasLaudo() {
  document.getElementById('lt-pecas').innerHTML = laudoDraft.pecas.map((p, i) => `
    <div class="step-item">
      <div class="step-main">
        <div class="step-num">${i + 1}</div>
        <input placeholder="Descrição da peça" value="${esc(p.descricao || '')}" style="flex:2;" oninput="laudoDraft.pecas[${i}].descricao=this.value; atualizarRascunhoLaudo(true);">
        <input placeholder="Qtd" value="${esc(p.quantidade || '')}" style="flex:0 0 70px;" oninput="laudoDraft.pecas[${i}].quantidade=this.value; atualizarRascunhoLaudo(true);">
        <button class="step-rm" onclick="removerPecaLaudo(${i})">×</button>
      </div>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhuma peça adicionada.</p>';
}
function adicionarPecaLaudo() { laudoDraft.pecas.push({ descricao: '', quantidade: '' }); renderPecasLaudo(); atualizarRascunhoLaudo(true); }
function removerPecaLaudo(i) { laudoDraft.pecas.splice(i, 1); renderPecasLaudo(); atualizarRascunhoLaudo(true); }

function renderFotosLaudo() {
  document.getElementById('lt-fotos').innerHTML = laudoDraft.fotos.map((f, j) => `
    <div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do laudo">
      <button class="photo-rm" onclick="removerFotoLaudo(${j})">×</button>
    </div>`).join('');
}
// fotos de celular costumam vir com vários MB cada — sem isso, um relatório com só 4-5 fotos
// já manda um POST de dezenas de MB, que trava ou falha em conexão de campo ("Failed to
// fetch"). Redimensiona pro máximo de 1600px no lado maior e recomprime como JPEG, o que reduz
// drasticamente o tamanho sem perda visível no relatório/PDF.
function comprimirImagemDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const escala = MAX / Math.max(width, height);
        width = Math.round(width * escala);
        height = Math.round(height * escala);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      try { resolve(canvas.toDataURL('image/jpeg', 0.75)); } catch (e) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
function lerFotosComoDataUrl(arquivos) {
  return Promise.all(Array.from(arquivos).map((arquivo) => new Promise((resolve) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.readAsDataURL(arquivo);
  }).then(comprimirImagemDataUrl)));
}
function adicionarFotosLaudo(event) {
  lerFotosComoDataUrl(event.target.files || []).then((dataUrls) => {
    laudoDraft.fotos.push(...dataUrls);
    renderFotosLaudo();
    atualizarRascunhoLaudo(true);
  });
}
function removerFotoLaudo(j) { laudoDraft.fotos.splice(j, 1); renderFotosLaudo(); atualizarRascunhoLaudo(true); }

function atualizarRascunhoLaudo(semLerCampos) {
  if (!semLerCampos) {
    const d = laudoDraft;
    ['data_fabricacao', 'acessorios', 'defeito_informado', 'garantia_obs', 'data_conclusao', 'laudo_tecnico', 'servico_realizado', 'observacoes'].forEach((campo) => {
      const el = document.getElementById('lt-' + campo);
      if (el) d[campo] = el.value;
    });
    const garantia = document.querySelector('input[name="lt-garantia"]:checked');
    d.garantia = garantia ? garantia.value : '';
    d.relevante_biblioteca = document.getElementById('lt-relevante-biblioteca').checked;
    d.necessidade_retorno = document.getElementById('lt-necessidade-retorno').checked;
  }
  document.getElementById('lt-periodo').value = periodoReparo(laudoDraft);
  try {
    localStorage.setItem(chaveRascunhoLaudo(laudoDraft.agenda_id, laudoAgendaAtual && laudoAgendaAtual.retorno_pendente_tecnico), JSON.stringify({ draft: laudoDraft, em: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }));
    const status = document.getElementById('lt-rascunho-status');
    if (status) status.textContent = `Rascunho salvo automaticamente neste dispositivo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {}
}

function limparLaudo(agendaId) {
  if (!confirm('Limpar todo o formulário e apagar o rascunho salvo?')) return;
  localStorage.removeItem(chaveRascunhoLaudo(agendaId, laudoAgendaAtual && laudoAgendaAtual.retorno_pendente_tecnico));
  renderLaudoTecnico(laudoAgendaAtual);
}

async function concluirLaudoTecnico() {
  atualizarRascunhoLaudo();
  const d = laudoDraft;
  if (d.garantia === 'na' && !String(d.garantia_obs || '').trim()) return alert('O administrador marcou garantia "N/A" mas não especificou o motivo. Peça para completar antes de enviar o laudo.');
  if (!d.data_conclusao) return alert('Informe a data de conclusão.');
  if (!String(d.laudo_tecnico || '').trim()) return alert('Preencha o laudo técnico.');
  if (!String(d.servico_realizado || '').trim()) return alert('Descreva o serviço realizado.');
  if (!d.fotos.length) return alert('Anexe ao menos uma foto no relatório fotográfico.');

  const chaveRascunho = chaveRascunhoLaudo(d.agenda_id, laudoAgendaAtual && laudoAgendaAtual.retorno_pendente_tecnico);
  const body = { agenda_id: d.agenda_id, laudo: d, relevante_biblioteca: d.relevante_biblioteca };
  let r;
  try {
    r = await enviarVisitaOuEnfileirar(body, { chaveRascunho });
  } catch (e) {
    alert('Erro ao concluir: ' + e.message);
    return;
  }
  if (r.enviado) localStorage.removeItem(chaveRascunho);
  const eraRetorno = laudoAgendaAtual && laudoAgendaAtual.retorno_pendente_tecnico;
  const eraReparo = laudoAgendaAtual && laudoAgendaAtual.tipo === 'atendimento' && ['em_diagnostico_reparo', 'executando_reparo'].includes(laudoAgendaAtual.fase_atendimento);
  mostrarModalSucesso(r.enfileirado ? MSG_ENFILEIRADO : eraReparo ? 'Relatório enviado.' : (eraRetorno ? 'Relatório de retorno enviado — o administrador foi avisado.' : 'Laudo finalizado e enviado para aprovação do administrador. O PDF ficará disponível assim que ele for aprovado.'));
  if (eraReparo) renderFilaReparo();
  else renderAgenda();
}

// PDF do laudo técnico (corretiva/preventiva) — mesmo layout do modelo em papel da PRO Marking
// usado no relatório de manutenção (gerarPdfRelatorioManutencao): capa navy cheia página, depois
// páginas de conteúdo com caixas com borda, checkboxes, tabela de peças e fotos 2 por linha, e
// uma página final de contato. Helpers duplicados de propósito (em vez de compartilhados) pra
// não arriscar mudar o relatório de manutenção, que já está pronto e aprovado.
function gerarPdfLaudo(d, item, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function opcaoCheckbox(x, yy, marcado, label) {
    doc.setDrawColor(...PDF_COR.ink); doc.setLineWidth(0.9);
    doc.rect(x, yy - 7, 7, 7, 'S');
    if (marcado) { doc.setFillColor(...PDF_COR.ink); doc.rect(x + 1.2, yy - 5.8, 4.6, 4.6, 'F'); }
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.ink);
    doc.text(label, x + 11, yy);
    return x + 11 + doc.getTextWidth(label);
  }

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Laudo Técnico', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  // apertado=true mantém o título colado no que vem embaixo (texto de laudo/serviço, fotos) —
  // usado nas seções onde título e conteúdo precisam ficar visualmente juntos. Por padrão (sem
  // subtítulo e sem apertado) o título ganha mais respiro, pra não ficar colado na primeira
  // caixa de dados (Dados do cliente, Tipo de serviço, Dados do equipamento, Técnico responsável).
  function tituloCentro(t, sub, apertado) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13;
    if (sub) {
      doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(sub, pageW / 2, y, { align: 'center' }); y += 13;
      y += 4;
    } else {
      y += apertado ? 4 : 16;
    }
  }

  function tituloEsquerda(t) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(t, margem, y); y += 14;
  }

  // linha de campos "LABEL: valor" dentro de caixas com borda, lado a lado
  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  // ===== capa =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(22); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('LAUDO TÉCNICO', pageW / 2, 420, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(limparPdf(item.cliente_nome).toUpperCase() || '—', pageW / 2, 445, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados do cliente');
  linhaCampos([{ label: 'Empresa', valor: d.empresa || item.cliente_nome, frac: 1 }]);
  linhaCampos([{ label: 'Contato', valor: d.contato || item.contato || item.cliente_contato, frac: 1 }]);
  linhaCampos([{ label: 'Telefone', valor: d.telefone || item.telefone || item.cliente_telefone, frac: 1 }]);
  y += 16;

  tituloCentro('Tipo de serviço');
  {
    const opcoes = [['preventiva', 'PREVENTIVA'], ['corretiva', 'CORRETIVA']];
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5);
    const larguras = opcoes.map(([, l]) => 11 + doc.getTextWidth(l));
    const gap = 16;
    const total = larguras.reduce((a, b) => a + b, 0) + gap * (larguras.length - 1);
    let cx = pageW / 2 - total / 2;
    opcoes.forEach(([v, l], idx) => { opcaoCheckbox(cx, y, item.tipo === v, l); cx += larguras[idx] + gap; });
    y += 26;
  }

  tituloCentro('Dados do equipamento');
  linhaCampos([{ label: 'Equipamento', valor: d.equipamento_tipo || item.equipamento_tipo, frac: 0.34 }, { label: 'Modelo', valor: d.modelo_maquina || item.equipamento_modelo, frac: 0.4 }, { label: 'Nº Série', valor: d.numero_serie || item.equipamento_serie, frac: 0.26 }]);
  {
    const wGarantia = largura * 0.62, wData = largura - wGarantia, altura = 20;
    if (y + altura > pageH - margem) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.rect(margem, y, wGarantia, altura, 'S');
    doc.rect(margem + wGarantia, y, wData, altura, 'S');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
    doc.text('GARANTIA:', margem + 7, y + 13);
    let cx = margem + 7 + doc.getTextWidth('GARANTIA: ') + 4;
    [['sim', 'SIM'], ['nao', 'NÃO'], ['na', 'N/A']].forEach(([v, l]) => { cx = opcaoCheckbox(cx, y + 13, d.garantia === v, l) + 10; });
    doc.setFont(undefined, 'bold'); doc.text('DATA DE FABRICAÇÃO: ', margem + wGarantia + 7, y + 13);
    const wLblFab = doc.getTextWidth('DATA DE FABRICAÇÃO: ');
    doc.setFont(undefined, 'normal'); doc.text(limparPdf(d.data_fabricacao) || '—', margem + wGarantia + 7 + wLblFab, y + 13);
    y += altura;
  }
  linhaCampos([{ label: 'Acessórios', valor: d.acessorios, frac: 1 }]);
  linhaCampos([{ label: 'Defeito informado', valor: d.defeito_informado, frac: 1 }]);
  y += 16;

  tituloCentro('Técnico responsável');
  linhaCampos([{ label: 'Nome', valor: d.tecnico_nome || item.tecnico_nome || USER.nome, frac: 0.5 }, { label: 'E-mail', valor: d.tecnico_email || USER.email, frac: 0.5 }]);
  linhaCampos([{ label: 'Entrada', valor: fmtData(d.data_entrada), frac: 0.33 }, { label: 'Conclusão', valor: fmtData(d.data_conclusao), frac: 0.33 }, { label: 'Período', valor: periodoReparo(d), frac: 0.34 }]);
  y += 16;

  tituloCentro('Laudo técnico', 'Defeito encontrado e análise do estado do equipamento');
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(d.laudo_tecnico) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 16;
  }

  tituloCentro('Serviço realizado', null, true);
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(d.servico_realizado) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 14;
  }

  tituloEsquerda('Peças Fornecidas');
  {
    const cols = [{ t: 'Item', frac: 0.14 }, { t: 'Descrição da peça', frac: 0.66 }, { t: 'Qtd.', frac: 0.2 }];
    const larguras = cols.map((c) => largura * c.frac);
    if (y + 20 > pageH - margem) novaPagina();
    let cx = margem;
    doc.setFillColor(...PDF_COR.navy);
    doc.rect(margem, y, largura, 18, 'F');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
    cols.forEach((c, i) => { doc.text(c.t, cx + 6, y + 12); cx += larguras[i]; });
    y += 18;
    const pecas = d.pecas || [];
    if (!pecas.length) {
      if (y + 18 > pageH - margem) novaPagina();
      doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
      doc.setFont(undefined, 'italic'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text('Nenhuma peça informada', margem + 6, y + 12);
      y += 18;
    } else {
      pecas.forEach((p, i) => {
        if (y + 18 > pageH - margem) novaPagina();
        cx = margem;
        doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
        doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
        const valores = [String(i + 1), limparPdf(p.descricao) || '—', String(p.quantidade || '—')];
        valores.forEach((v, j) => { doc.text(v, cx + 6, y + 12); cx += larguras[j]; });
        y += 18;
      });
    }
    y += 16;
  }

  if (d.observacoes) {
    tituloCentro('Observações');
    if (y > pageH - margem - 40) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(d.observacoes), largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 14;
  }

  // garante que o título "Relatório fotográfico" nunca fique sozinho no fim de uma página
  // com as fotos só aparecendo na página seguinte.
  if (d.fotos && d.fotos.length) {
    const gapCheck = 12, wImgCheck = (largura - gapCheck) / 2, hImgCheck = wImgCheck * 0.68;
    if (y + 34 + hImgCheck > pageH - margem) novaPagina();
  }
  tituloCentro('Relatório fotográfico', null, true);
  if (d.fotos && d.fotos.length) {
    const gap = 12, wImg = (largura - gap) / 2, hImg = wImg * 0.68;
    for (let i = 0; i < d.fotos.length; i += 2) {
      if (y + hImg > pageH - margem) novaPagina();
      [d.fotos[i], d.fotos[i + 1]].forEach((f, j) => {
        if (!f) return;
        const cx = margem + j * (wImg + gap);
        try {
          const m = /^data:image\/(\w+);/.exec(f);
          const formato = m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
          doc.setDrawColor(...PDF_COR.line);
          doc.roundedRect(cx - 1, y - 1, wImg + 2, hImg + 2, 3, 3, 'S');
          doc.addImage(f, formato, cx, y, wImg, hImg);
        } catch (e) {}
      });
      y += hImg + gap;
    }
  } else {
    doc.setFontSize(9); doc.setFont(undefined, 'italic'); doc.setTextColor(...PDF_COR.inkSoft);
    doc.text('Nenhuma foto anexada.', margem, y); y += 16;
  }

  // ===== página de contato =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });

  return doc.output('bloburl');
}

// ---------- APROVAÇÃO DE VISITAS (diário técnico ligado à agenda) ----------
let osAno = new Date().getFullYear();
let osMes = new Date().getMonth();
let osSomenteHoje = false;
let osFiltro = 'ativos';

async function renderAprovacoesVisitas() {
  await carregarAgendaComVisitas();
  desenharOrdemServico();
}

function mudarMesOS(delta) {
  osSomenteHoje = false;
  osMes += delta;
  if (osMes < 0) { osMes = 11; osAno--; }
  if (osMes > 11) { osMes = 0; osAno++; }
  desenharOrdemServico();
}

function irParaHojeOS() {
  const hoje = new Date();
  osAno = hoje.getFullYear();
  osMes = hoje.getMonth();
  osSomenteHoje = !osSomenteHoje;
  desenharOrdemServico();
}

function alternarFiltroOS(valor) {
  osFiltro = valor;
  desenharOrdemServico();
}

function desenharOrdemServico() {
  const agenda = filtrarPorStatusOS(window._agendaCache, osFiltro);
  const visitasPorAgenda = window._visitasPorAgenda || {};
  const hojeISO = dataISOLocal(new Date());
  let doMes = agenda
    .filter((a) => {
      const d = new Date(a.data_hora_inicio);
      return d.getFullYear() === osAno && d.getMonth() === osMes;
    })
    .sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  if (osSomenteHoje) doMes = doMes.filter((a) => (a.data_hora_inicio || '').slice(0, 10) === hojeISO);
  const reaberturas = Object.values(visitasPorAgenda).filter((v) => v.solicitacao_reabertura && v.solicitacao_reabertura.status === 'pendente');

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Ordem de Serviço</h1><p>${osSomenteHoje ? `${doMes.length} O.S. hoje` : `${doMes.length} O.S. em ${MES_LABEL[osMes]} de ${osAno}`}</p></div>
      <button class="btn btn-primary btn-sm" onclick="mostrarFormNovaAtividade()">+ Nova Ordem de Serviço</button>
    </div>
    <div id="form-nova-atividade"></div>
    <div class="panel" style="padding:14px 18px; margin-bottom:22px;">
      <div class="cal-head" style="margin-bottom:0;">
        <div class="cal-nav">
          <button onclick="mudarMesOS(-1)">‹</button>
          <div class="cal-mes-label">${MES_LABEL[osMes]} de ${osAno}</div>
          <button onclick="mudarMesOS(1)">›</button>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          ${botoesFiltroStatusOS(osFiltro, 'alternarFiltroOS')}
          <button class="btn-outline-sm ${osSomenteHoje ? 'active' : ''}" style="${osSomenteHoje ? 'background:var(--blue); color:#fff; border-color:var(--blue);' : ''}" onclick="irParaHojeOS()">${osSomenteHoje ? '✓ Só hoje' : 'Hoje'}</button>
        </div>
      </div>
    </div>

    ${reaberturas.length ? `
    <div class="page-head"><h1 style="font-size:16px;">Solicitações de reabertura</h1></div>
    <div class="panel"><table>
      <tr><th>Equipamento</th><th>Técnico</th><th>Motivo</th><th></th></tr>
      ${reaberturas.map((v) => `
        <tr>
          <td data-label="Equipamento">${v.equipamento_tipo || '—'}</td>
          <td data-label="Técnico">${v.tecnico_nome || '—'}</td>
          <td data-label="Motivo">${esc(v.solicitacao_reabertura.motivo || '—')}</td>
          <td>
            <button class="btn btn-primary btn-sm" onclick="reabrirVisita(${v.id})">Aprovar e reabrir</button>
            <button class="btn btn-ghost btn-sm" onclick="recusarReabertura(${v.id})">Recusar</button>
          </td>
        </tr>`).join('')}
    </table></div>` : ''}

    ${doMes.length ? `<div class="os-grid">${doMes.map((a) => cardOSAdmin(a, visitasPorAgenda[a.id])).join('')}</div>` : `<div class="empty">Nenhuma O.S. neste mês.</div>`}`;
}

// ações disponíveis pra uma O.S. (aprovar/reprovar/reabrir/excluir relatório + editar/excluir a própria O.S.)
// — usadas tanto no card quanto na tela de detalhe.
// ações de uma O.S. de atendimento (fluxo pós-venda/reparo) — o administrador vê e usa os
// mesmos botões das telas dedicadas de pós-venda/reparo, como reforço se ninguém dos setores
// estiver disponível
function acoesOSAtendimento(a) {
  const fase = a.fase_atendimento;
  if (fase === 'em_atendimento') {
    return `
      <button class="btn-outline-sm" onclick="encerrarAtendimento(${a.id})">✓ Encerrar atendimento</button>
      <button class="btn btn-primary btn-sm" onclick="encaminharPosVenda(${a.id})">Encaminhar pro pós-venda</button>`;
  }
  if (fase === 'aguardando_pos_venda') {
    return `
      ${a.motivo_pos_venda === 'cliente_envia_equipamento' && !a.equipamento_recebido_em ? `<button class="btn-outline-sm" onclick="posVendaAguardandoEquipamento(${a.id})">Aguardando equipamento</button>` : ''}
      <button class="btn btn-primary btn-sm" onclick="posVendaOrcamentoEnviado(${a.id})">Orçamento enviado</button>`;
  }
  if (fase === 'aguardando_equipamento') {
    if (!a.estoque_recebido_em) return `<button class="btn btn-primary btn-sm" onclick="estoqueConfirmarChegada(${a.id})">Confirmar chegada (estoque)</button>`;
    return `<button class="btn btn-primary btn-sm" onclick="reparoIniciarAtendimento(${a.id})">Iniciar atendimento (reparo)</button>`;
  }
  if (fase === 'em_diagnostico_reparo') return `<button class="btn btn-primary btn-sm" onclick="abrirDiario(${a.id})">Preencher relatório de diagnóstico</button>`;
  if (fase === 'orcamento_enviado') {
    return `
      <button class="btn btn-primary btn-sm" onclick="posVendaDecisao(${a.id}, true)">Cliente aprovou</button>
      <button class="btn btn-ghost btn-sm" onclick="posVendaDecisao(${a.id}, false)">Cliente não aprovou</button>`;
  }
  if (fase === 'executando_reparo') return `<button class="btn btn-primary btn-sm" onclick="abrirDiario(${a.id})">Preencher relatório de liberação</button>`;
  if (fase === 'aguardando_saida_estoque') {
    const label = a.motivo_pos_venda === 'peca_enviada' ? 'Confirmar envio da peça (estoque)' : 'Confirmar saída do equipamento (estoque)';
    return `<button class="btn btn-primary btn-sm" onclick="estoqueConfirmarSaida(${a.id})">${label}</button>`;
  }
  if (fase === 'aguardando_criacao_os') return `<button class="btn btn-primary btn-sm" onclick="abrirCriarOSDeSolicitacao(${a.id})">Criar O.S. de visita técnica</button>`;
  return '';
}

function acoesOS(a, visita) {
  if (a.finalizada) {
    if (a.orcamento_reprovado_em) {
      return `<span class="tag tag-falha">✗ Finalizada em ${fmtData(a.finalizado_em)} — cliente não aprovou o orçamento das peças. Abra uma nova O.S. se precisar de um novo atendimento.</span>`;
    }
    return `<span class="tag" style="background:var(--blue-pale); color:var(--blue);">✓ Finalizada em ${fmtData(a.finalizado_em)} — cliente já confirmou o serviço. Abra uma nova O.S. se precisar de um novo atendimento.</span>`;
  }
  // O.S. de atendimento (chat): o administrador pode agir como backup do pós-venda/reparo se
  // precisar, além das telas dedicadas de cada setor
  if (a.tipo === 'atendimento' && a.fase_atendimento) return acoesOSAtendimento(a);
  if (!a.confirmado_cliente_em) {
    return `
      <button class="btn btn-primary btn-sm" onclick="confirmarClienteOS(${a.id})">✓ Confirmar cliente</button>
      <button class="btn-outline-sm" onclick="editarOS(${a.id})">Editar</button>
      <button class="btn-outline-sm" onclick="excluirOS(${a.id})" style="color:var(--red); border-color:var(--red);">Excluir O.S.</button>`;
  }
  let acoes;
  if (visita && visita.status_aprovacao === 'pendente') {
    acoes = `
      <button class="btn btn-primary btn-sm" onclick="aprovarVisita(${visita.id})">Aprovar</button>
      ${visita.relevante_biblioteca ? `<button class="btn btn-primary btn-sm" onclick="aprovarVisita(${visita.id}, true)">Aprovar e incluir na biblioteca</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="sugerirEdicaoVisita(${visita.id})">Sugerir edição</button>
      <button class="btn btn-ghost btn-sm" onclick="reprovarVisita(${visita.id})">Reprovar</button>`;
  } else if (visita && visita.status_aprovacao === 'aprovado' && a.visita_tem_pecas && !a.orcamento_aprovado_em) {
    acoes = `
      <button class="btn-outline-sm" onclick="reabrirVisita(${visita.id})">Reabrir</button>
      <button class="btn-outline-sm" onclick="excluirVisita(${visita.id})" style="color:var(--red); border-color:var(--red);">Excluir relatório</button>
      <button class="btn btn-primary btn-sm" onclick="orcamentoAprovadoOS(${a.id})">Orçamento aprovado</button>
      <button class="btn btn-ghost btn-sm" onclick="orcamentoReprovadoOS(${a.id})" style="color:var(--red);">Orçamento reprovado</button>
      <button class="btn-outline-sm" onclick="finalizarForcadoOS(${a.id})" style="color:var(--ink-soft);">⏭ Pular etapas e finalizar</button>`;
  } else if (visita && visita.status_aprovacao === 'aprovado' && a.retorno_pendente_tecnico) {
    let statusRetorno;
    if (!a.retorno_confirmado_cliente_em) {
      statusRetorno = `<button class="btn btn-primary btn-sm" onclick="confirmarClienteRetornoOS(${a.id})">✓ Confirmar cliente (retorno)</button>`;
    } else if (!a.retorno_deslocamento_iniciado_em) {
      statusRetorno = `<span style="font-size:11.5px; color:var(--ink-soft);">Aguardando o técnico iniciar o deslocamento do retorno.</span>`;
    } else if (!a.retorno_chegada_confirmada_em) {
      statusRetorno = `<span style="font-size:11.5px; color:var(--ink-soft);">Técnico a caminho — aguardando registrar a chegada.</span>`;
    } else {
      statusRetorno = `<span style="font-size:11.5px; color:var(--ink-soft);">Aguardando o técnico enviar o relatório de retorno.</span>`;
    }
    acoes = `
      ${statusRetorno}
      <button class="btn-outline-sm" onclick="finalizarForcadoOS(${a.id})" style="color:var(--ink-soft);">⏭ Pular etapas e finalizar</button>`;
  } else if (visita && visita.status_aprovacao === 'aprovado' && !a.feedback_cliente_em) {
    acoes = `
      <button class="btn-outline-sm" onclick="reabrirVisita(${visita.id})">Reabrir</button>
      <button class="btn-outline-sm" onclick="excluirVisita(${visita.id})" style="color:var(--red); border-color:var(--red);">Excluir relatório</button>
      <button class="btn btn-primary btn-sm" onclick="registrarFeedbackOS(${a.id})">✓ Cliente OK</button>
      ${!a.visita_retorno_id ? `<button class="btn btn-ghost btn-sm" onclick="retrabalhoOS(${a.id})" style="color:var(--red);">↺ Retorno / retrabalho</button>` : ''}
      <button class="btn-outline-sm" onclick="finalizarForcadoOS(${a.id})" style="color:var(--ink-soft);">⏭ Pular etapas e finalizar</button>`;
  } else if (visita && visita.status_aprovacao === 'aprovado') {
    const umDiaMs = 24 * 60 * 60 * 1000;
    const podeFinalizar = visita.data_aprovacao && (Date.now() - new Date(visita.data_aprovacao).getTime()) >= umDiaMs;
    acoes = `
      <button class="btn-outline-sm" onclick="reabrirVisita(${visita.id})">Reabrir</button>
      <button class="btn-outline-sm" onclick="excluirVisita(${visita.id})" style="color:var(--red); border-color:var(--red);">Excluir relatório</button>
      ${podeFinalizar ? `<button class="btn btn-primary btn-sm" onclick="finalizarOS(${a.id})">Finalizar O.S.</button>` : `<span class="tag tag-amber">Aguarde 1 dia após a aprovação pra finalizar</span><button class="btn-outline-sm" onclick="finalizarForcadoOS(${a.id})" style="color:var(--ink-soft);">⏭ Pular etapas e finalizar</button>`}`;
  } else if (visita && visita.status_aprovacao === 'reprovado') {
    acoes = `<span class="tag tag-falha">Reprovado${visita.comentario_reprovacao ? ': ' + esc(visita.comentario_reprovacao) : ''}</span>`;
  } else if (visita && visita.status_aprovacao === 'alteracao_sugerida') {
    acoes = `<span class="tag tag-amber">Edição sugerida${visita.comentario_edicao ? ': ' + esc(visita.comentario_edicao) : ''} — aguardando o técnico reenviar</span>`;
  } else {
    let statusExecucao = 'Aguardando execução pelo técnico.';
    if (a.deslocamento_iniciado_em && !a.chegada_confirmada_em) statusExecucao = 'Técnico a caminho — aguardando registrar a chegada.';
    else if (a.chegada_confirmada_em) statusExecucao = 'Técnico chegou — aguardando o relatório.';
    acoes = `<span style="font-size:11.5px; color:var(--ink-soft);">${statusExecucao}</span>`;
  }
  acoes += `
      <button class="btn-outline-sm" onclick="editarOS(${a.id})">Editar</button>
      <button class="btn-outline-sm" onclick="excluirOS(${a.id})" style="color:var(--red); border-color:var(--red);">Excluir O.S.</button>`;
  return acoes;
}

async function finalizarOS(id) {
  if (!confirm('Confirma que a empresa já deu o retorno concordando com o serviço prestado? Depois de finalizada, esta O.S. não pode mais ser alterada — um novo atendimento vai precisar de uma O.S. nova.')) return;
  try { await api(`/api/agenda/${id}/finalizar`, { method: 'POST' }); mostrarToast('O.S. finalizada.'); voltarListaOS(); }
  catch (e) { alert('Erro ao finalizar: ' + e.message); }
}

// escape hatch: o administrador pode finalizar direto quando julgar necessário, pulando
// orçamento/retorno do técnico/feedback do cliente/prazo de 1 dia — usado com moderação
async function finalizarForcadoOS(id) {
  if (!confirm('Isso finaliza a O.S. pulando as etapas pendentes (orçamento, retorno do técnico, feedback do cliente, prazo de 1 dia). Confirma que quer finalizar assim mesmo?')) return;
  try { await api(`/api/agenda/${id}/finalizar`, { method: 'POST', body: { forcar: true } }); mostrarToast('O.S. finalizada — etapas puladas.'); voltarListaOS(); }
  catch (e) { alert('Erro ao finalizar: ' + e.message); }
}

// 2ª etapa da linha do tempo: o admin confirma que o cliente já aceitou o agendamento —
// libera o técnico pra iniciar o deslocamento e executar a O.S. (ficam bloqueados até aqui)
async function confirmarClienteOS(id) {
  if (!confirm('Confirma que o cliente já aceitou este agendamento? Isso libera o técnico para iniciar o deslocamento e executar a O.S.')) return;
  try { await api(`/api/agenda/${id}/confirmar-cliente`, { method: 'POST' }); mostrarToast('Cliente confirmado — o técnico já pode prosseguir.'); voltarListaOS(); }
  catch (e) { alert('Erro ao confirmar: ' + e.message); }
}

// passo entre a aprovação do relatório e a finalização da O.S.: o admin registra que o
// cliente aprovou o serviço ("Cliente OK") — só depois disso o botão Finalizar O.S. libera
async function registrarFeedbackOS(id) {
  if (!confirm('Confirma que o cliente aprovou o serviço prestado?')) return;
  try { await api(`/api/agenda/${id}/registrar-feedback`, { method: 'POST' }); mostrarToast('Feedback do cliente registrado.'); voltarListaOS(); }
  catch (e) { alert('Erro ao registrar feedback: ' + e.message); }
}

// quando o relatório aprovado tem peças fornecidas, o admin aprova o orçamento antes de
// seguir — se o técnico também marcou necessidade de retorno, libera pra ele enviar um
// segundo relatório antes de chegar na etapa de feedback do cliente
async function orcamentoAprovadoOS(id) {
  if (!confirm('Confirma que o orçamento das peças fornecidas foi aprovado?')) return;
  try { await api(`/api/agenda/${id}/orcamento-aprovado`, { method: 'POST' }); mostrarToast('Orçamento aprovado.'); voltarListaOS(); }
  catch (e) { alert('Erro ao aprovar orçamento: ' + e.message); }
}

async function orcamentoReprovadoOS(id) {
  if (!confirm('Confirma que o cliente não aprovou o orçamento? A O.S. será finalizada, sem mais serviço a fazer.')) return;
  try { await api(`/api/agenda/${id}/orcamento-reprovado`, { method: 'POST' }); mostrarToast('Orçamento reprovado — O.S. finalizada.'); voltarListaOS(); }
  catch (e) { alert('Erro ao reprovar orçamento: ' + e.message); }
}

// feedback negativo do cliente: precisa de um retorno do técnico (ex.: novo treinamento) —
// marca a O.S. como retrabalho e libera pro técnico enviar um segundo relatório
async function retrabalhoOS(id) {
  if (!confirm('Confirma que o cliente deu um feedback negativo e precisa de um retorno do técnico? Isso marca a O.S. como retrabalho.')) return;
  try { await api(`/api/agenda/${id}/retrabalho`, { method: 'POST' }); mostrarToast('Retrabalho registrado — o técnico foi avisado.'); voltarListaOS(); }
  catch (e) { alert('Erro ao registrar retrabalho: ' + e.message); }
}

// mesma lógica de confirmarClienteOS, só que pro retorno do técnico (peças que exigiram um
// novo deslocamento, ou retrabalho por feedback negativo) — libera o técnico pra iniciar o
// deslocamento do retorno
async function confirmarClienteRetornoOS(id) {
  if (!confirm('Confirma que o cliente já aceitou o retorno do técnico? Isso libera o técnico para iniciar o deslocamento do retorno.')) return;
  try { await api(`/api/agenda/${id}/retorno/confirmar-cliente`, { method: 'POST' }); mostrarToast('Cliente confirmado — o técnico já pode prosseguir com o retorno.'); voltarListaOS(); }
  catch (e) { alert('Erro ao confirmar: ' + e.message); }
}

function cardOSAdmin(a) {
  return `
    <div class="os-card${a.finalizada ? ' os-card-finalizada' : ''}" onclick="abrirDetalheOS(${a.id})" style="cursor:pointer;">
      ${osCardCorpo(a)}
      <div class="os-card-actions" onclick="event.stopPropagation()">
        <button class="os-card-toggle" onclick="abrirDetalheOS(${a.id})">Abrir</button>
      </div>
    </div>`;
}

// tela separada (substitui a grade de cards do mês) com só os detalhes de uma O.S.
function abrirDetalheOS(id) {
  const a = (window._agendaCache || []).find((x) => x.id === id);
  if (!a) return;
  const visita = (window._visitasPorAgenda || {})[id];
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(numeroOS(a))}</h1><p>${esc(a.cliente_nome || '—')}</p></div>
      <button class="btn-outline-sm" onclick="desenharOrdemServico()">‹ Voltar</button>
    </div>
    <div id="form-nova-atividade"></div>
    <div class="panel">
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">${acoesOS(a, visita)}</div>
      ${detalheCompletoOS(a, visita)}
    </div>`;
}

function editarOS(id) {
  const item = (window._agendaCache || []).find((a) => a.id === id);
  if (!item) return;
  mostrarFormNovaAtividade(item);
  document.getElementById('form-nova-atividade').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function excluirOS(id) {
  if (!confirm('Excluir esta Ordem de Serviço? O relatório e o registro de biblioteca vinculados (se houver) também serão excluídos. Esta ação não pode ser desfeita.')) return;
  try {
    await api(`/api/agenda/${id}`, { method: 'DELETE' });
    mostrarToast('Ordem de serviço excluída.');
    if (paginaAtual === 'aprovacoes-visitas') renderAprovacoesVisitas();
    else renderAgenda();
  } catch (e) { alert('Erro: ' + e.message); }
}

function fmtDataHora(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// linha do tempo completa: abertura -> confirmação do cliente -> deslocamento -> relatório ->
// aprovação do gestor -> feedback do cliente -> finalização da O.S. Cada etapa aparece sempre
// (feita ou em aberto), na ordem — só a reprovação interrompe a sequência normal.
// linha do tempo de uma O.S. de atendimento (nascida do chat) — segue o fluxo de pós-venda/setor
// reparo, bem diferente do fluxo normal (sem confirmação de cliente/deslocamento/feedback)
function timelineOSAtendimento(a) {
  const passos = [
    { label: 'Ordem de serviço aberta', data: a.criado_em, estado: 'feito' },
    { label: 'Em atendimento (chat)', data: a.criado_em, estado: 'feito' },
  ];
  if (!a.encaminhado_pos_venda_em) {
    if (a.finalizada) {
      passos.push({ label: 'Resolvido direto no atendimento (chat) — sem precisar do pós-venda', data: a.finalizado_em, estado: 'feito' });
      passos.push({ label: 'O.S. finalizada', data: a.finalizado_em, estado: 'feito' });
    } else {
      passos.push({ label: 'Em aberto — o técnico encerra direto ou encaminha pro pós-venda', data: null, estado: 'pendente' });
    }
    return renderizarTimelineOS(passos);
  }
  passos.push({ label: `Encaminhado pro pós-venda${a.motivo_pos_venda ? ' — ' + esc(MOTIVO_POS_VENDA_LABEL[a.motivo_pos_venda] || '') : ''}`, data: a.encaminhado_pos_venda_em, estado: 'feito' });

  if (a.motivo_pos_venda === 'cliente_envia_equipamento') {
    passos.push(a.estoque_recebido_em
      ? { label: 'Equipamento chegou e foi conferido pelo estoque', data: a.estoque_recebido_em, estado: 'feito' }
      : { label: 'Aguardando o equipamento chegar no estoque', data: null, estado: 'pendente' });
    if (!a.estoque_recebido_em) return renderizarTimelineOS(passos);

    passos.push(a.equipamento_recebido_em
      ? { label: 'Setor de reparo iniciou o diagnóstico', data: a.equipamento_recebido_em, estado: 'feito' }
      : { label: 'Aguardando o setor de reparo iniciar o diagnóstico', data: null, estado: 'pendente' });
    if (!a.equipamento_recebido_em || a.fase_atendimento === 'em_diagnostico_reparo') return renderizarTimelineOS(passos);
  }

  passos.push(a.pos_venda_orcamento_enviado_em
    ? { label: 'Orçamento enviado ao cliente', data: a.pos_venda_orcamento_enviado_em, estado: 'feito' }
    : { label: 'Aguardando pós-venda enviar o orçamento', data: null, estado: 'pendente' });
  if (!a.pos_venda_orcamento_enviado_em) return renderizarTimelineOS(passos);

  if (a.pos_venda_decisao === 'reprovado') {
    passos.push({ label: 'Cliente não aprovou o orçamento', data: a.pos_venda_decisao_em, estado: 'reprovado' });
    return renderizarTimelineOS(passos);
  }
  passos.push(a.pos_venda_decisao === 'aprovado'
    ? { label: 'Cliente aprovou o orçamento', data: a.pos_venda_decisao_em, estado: 'feito' }
    : { label: 'Aguardando decisão do cliente sobre o orçamento', data: null, estado: 'pendente' });
  if (a.pos_venda_decisao !== 'aprovado') return renderizarTimelineOS(passos);

  if (a.motivo_pos_venda === 'tecnico_visita') {
    passos.push(a.os_criada_id
      ? { label: `Nova O.S. de visita técnica criada — ${esc(a.os_criada_numero || ('#' + a.os_criada_id))}`, data: a.finalizado_em, estado: 'feito' }
      : { label: 'Aguardando o administrador criar a O.S. de visita técnica', data: null, estado: 'pendente' });
    passos.push(a.finalizada
      ? { label: 'Atendimento original encerrado — acompanhamento segue na nova O.S.', data: a.finalizado_em, estado: 'feito' }
      : { label: 'Aguardando finalização deste atendimento', data: null, estado: 'pendente' });
    return renderizarTimelineOS(passos);
  }

  if (a.motivo_pos_venda === 'cliente_envia_equipamento') {
    passos.push(a.equipamento_liberado_reparo_em
      ? { label: 'Equipamento reparado e liberado pelo setor de reparo', data: a.equipamento_liberado_reparo_em, estado: 'feito' }
      : { label: 'Aguardando o setor de reparo executar e liberar o equipamento', data: null, estado: 'pendente' });
    if (!a.equipamento_liberado_reparo_em) return renderizarTimelineOS(passos);
  }

  passos.push(a.estoque_saida_em
    ? { label: a.motivo_pos_venda === 'peca_enviada' ? 'Estoque confirmou o envio da peça' : 'Estoque confirmou a saída do equipamento', data: a.estoque_saida_em, estado: 'feito' }
    : { label: a.motivo_pos_venda === 'peca_enviada' ? 'Aguardando o estoque enviar a peça' : 'Aguardando o estoque confirmar a saída do equipamento', data: null, estado: 'pendente' });
  passos.push(a.finalizada
    ? { label: 'O.S. finalizada', data: a.finalizado_em, estado: 'feito' }
    : { label: 'Aguardando finalização da O.S.', data: null, estado: 'pendente' });
  return renderizarTimelineOS(passos);
}

function timelineOS(a, visita) {
  if (a.tipo === 'atendimento' && a.fase_atendimento) return timelineOSAtendimento(a);
  const passos = [{ label: 'Ordem de serviço aberta', data: a.criado_em, estado: 'feito' }];

  passos.push(a.confirmado_cliente_em
    ? { label: 'Cliente confirmou o agendamento', data: a.confirmado_cliente_em, estado: 'feito' }
    : { label: 'Aguardando confirmação do cliente', data: null, estado: 'pendente' });

  passos.push(a.deslocamento_iniciado_em
    ? { label: 'Técnico iniciou o deslocamento', data: a.deslocamento_iniciado_em, estado: 'feito' }
    : { label: 'Aguardando deslocamento do técnico', data: null, estado: 'pendente' });

  passos.push(a.chegada_confirmada_em
    ? { label: 'Técnico confirmou a chegada', data: a.chegada_confirmada_em, estado: 'feito' }
    : { label: 'Aguardando chegada do técnico', data: null, estado: 'pendente' });

  passos.push(visita
    ? { label: 'Relatório preenchido e enviado para análise', data: visita.criado_em, estado: 'feito' }
    : { label: 'Aguardando o técnico preencher o relatório', data: null, estado: 'pendente' });

  if (visita && visita.status_aprovacao === 'reprovado') {
    passos.push({ label: 'Reprovado pelo gestor' + (visita.comentario_reprovacao ? ': ' + esc(visita.comentario_reprovacao) : ''), data: visita.data_aprovacao, estado: 'reprovado' });
    return renderizarTimelineOS(passos);
  }

  passos.push(visita && visita.status_aprovacao === 'aprovado'
    ? { label: 'Aprovado pelo gestor', data: visita.data_aprovacao, estado: 'feito' }
    : { label: 'Aguardando aprovação do gestor', data: null, estado: 'pendente' });

  // orçamento: só aparece quando o relatório tem peças fornecidas
  if (a.visita_tem_pecas) {
    if (a.orcamento_reprovado_em) {
      passos.push({ label: 'Cliente não aprovou o orçamento', data: a.orcamento_reprovado_em, estado: 'reprovado' });
      return renderizarTimelineOS(passos);
    }
    passos.push(a.orcamento_aprovado_em
      ? { label: 'Orçamento aprovado', data: a.orcamento_aprovado_em, estado: 'feito' }
      : { label: 'Aguardando aprovação do orçamento', data: null, estado: 'pendente' });
  }

  // retorno do técnico: acontece quando o relatório original pediu retorno (depois do
  // orçamento aprovado) OU quando virou retrabalho por feedback negativo do cliente. O
  // deslocamento desse retorno usa o mesmo rótulo do deslocamento original — mesma etapa,
  // só que numa segunda volta.
  if (a.retorno_pendente_tecnico || a.visita_retorno_id) {
    passos.push(a.retorno_confirmado_cliente_em
      ? { label: 'Cliente confirmou o retorno', data: a.retorno_confirmado_cliente_em, estado: 'feito' }
      : { label: 'Aguardando confirmação do cliente (retorno)', data: null, estado: 'pendente' });

    passos.push(a.retorno_deslocamento_iniciado_em
      ? { label: 'Técnico iniciou o deslocamento', data: a.retorno_deslocamento_iniciado_em, estado: 'feito' }
      : { label: 'Aguardando deslocamento do técnico', data: null, estado: 'pendente' });

    passos.push(a.retorno_chegada_confirmada_em
      ? { label: 'Técnico confirmou a chegada', data: a.retorno_chegada_confirmada_em, estado: 'feito' }
      : { label: 'Aguardando chegada do técnico', data: null, estado: 'pendente' });

    const visitaRetorno = (window._visitasRetornoPorAgenda || {})[a.id];
    passos.push(a.visita_retorno_id
      ? { label: 'Técnico enviou o relatório de retorno', data: visitaRetorno ? visitaRetorno.criado_em : null, estado: 'feito' }
      : { label: a.retrabalho ? 'Aguardando relatório retrabalho' : 'Aguardando retorno do técnico', data: null, estado: 'pendente' });
  }

  passos.push(a.feedback_cliente_em
    ? { label: 'Cliente deu o feedback', data: a.feedback_cliente_em, estado: 'feito' }
    : { label: 'Aguardando feedback do cliente', data: null, estado: 'pendente' });

  passos.push(a.finalizada
    ? { label: 'O.S. finalizada', data: a.finalizado_em, estado: 'feito' }
    : { label: 'Aguardando finalização da O.S.', data: null, estado: 'pendente' });

  return renderizarTimelineOS(passos);
}

function renderizarTimelineOS(passos) {
  return `
    <div class="os-card-title" style="margin-top:18px;">Linha do tempo</div>
    <ul class="os-timeline">
      ${passos.map((p) => `<li class="os-timeline-item ${p.estado}">
        <div class="os-timeline-label">${p.label}</div>
        <div class="os-timeline-data">${p.data ? fmtDataHora(p.data) : 'Em aberto'}</div>
      </li>`).join('')}
    </ul>`;
}

// detalhe completo de uma O.S.: dados do atendimento + relatório enviado (se houver) + linha do tempo
function detalheCompletoOS(a, visita) {
  return `
    <div class="kv"><b>Empresa:</b> ${esc(a.cliente_nome || '—')} <span class="sep">·</span> <b>Contato:</b> ${esc(a.contato || a.cliente_contato || '—')} <span class="sep">·</span> <b>Telefone:</b> ${esc(a.telefone || a.cliente_telefone || '—')}</div>
    <div class="kv"><b>E-mail:</b> ${esc(a.email || a.cliente_email || '—')} <span class="sep">·</span> <b>Setor:</b> ${esc(a.setor_cliente || a.cliente_setor || '—')}</div>
    ${a.endereco || a.cliente_endereco ? `<div class="kv"><b>Endereço:</b> ${esc(a.endereco || a.cliente_endereco)}${a.numero || a.cliente_numero ? ', ' + esc(a.numero || a.cliente_numero) : ''} — ${esc(a.bairro || a.cliente_bairro || '—')}, ${esc(a.cidade || a.cliente_cidade || '—')}/${esc(a.estado || a.cliente_estado || '—')}</div>` : ''}
    <div class="kv"><b>Equipamento:</b> ${esc(a.equipamento_tipo || '—')} — ${esc(a.equipamento_modelo || '—')}${a.equipamento_serie ? ' (' + esc(a.equipamento_serie) + ')' : ''}</div>
    <div class="kv"><b>Problema relatado / serviço:</b> ${esc(a.problema || '—')}</div>
    <div class="kv"><b>Técnico designado:</b> ${esc(a.tecnico_nome || '—')} <span class="sep">·</span> <b>Início previsto:</b> ${fmtData(a.data_hora_inicio)} <span class="sep">·</span> <b>Fim previsto:</b> ${fmtData(a.data_hora_fim)}</div>
    ${visita ? `
      <div class="os-relatorio-box">
        <div class="os-relatorio-box-titulo">Relatório enviado pelo técnico</div>
        ${detalheRelatorioVisita(visita)}
        ${visita.laudo && visita.status_aprovacao === 'aprovado' ? `<div style="margin-top:14px;"><button class="btn btn-primary btn-sm" onclick="baixarPdfLaudoAprovado(${a.id})">Gerar relatório (PDF)</button></div>` : ''}
      </div>` : `<div class="admin-note" style="margin-top:14px;">${a.tipo === 'atendimento' ? 'Ainda não há relatório — acompanhe o andamento na linha do tempo abaixo.' : 'O técnico ainda não executou esta O.S. — nenhum relatório enviado até o momento.'}</div>`}
    ${a.visita_retorno_id ? `
      <div class="os-relatorio-box" style="margin-top:14px;">
        <div class="os-relatorio-box-titulo">Relatório de retorno enviado pelo técnico</div>
        ${detalheRelatorioVisita((window._visitasRetornoPorAgenda || {})[a.id] || {})}
      </div>` : ''}
    ${timelineOS(a, visita)}`;
}

async function baixarPdfLaudoAprovado(agendaId) {
  const a = (window._agendaCache || []).find((x) => x.id === agendaId);
  const v = (window._visitasPorAgenda || {})[agendaId];
  if (!a || !v || !v.laudo) return alert('Não foi possível localizar o laudo aprovado desta O.S.');
  try {
    const logo = await carregarLogoDataUri();
    const url = gerarPdfLaudo(v.laudo, a, logo);
    window.open(url, '_blank');
  } catch (e) {
    alert('Erro ao gerar o PDF: ' + e.message);
  }
}

// mostra o relatório enviado pelo técnico organizado exatamente nas mesmas seções (mesmos
// títulos, mesma ordem) do PDF gerado por gerarPdfRelatorio / gerarPdfLaudo — pra não ter
// divergência entre o que aparece na tela e o que sai no documento baixado.
function detalheRelatorioVisita(v) {
  if (v.relatorio) {
    const r = v.relatorio;
    return `
      ${v.relevante_biblioteca ? `<div class="admin-note" style="background:var(--green-bg); color:var(--green);"><b>Marcado como relevante</b>Se aprovado, entra na Biblioteca de Defeitos/Falhas com ${esc(v.tecnico_nome || 'o técnico')} como autor.</div>` : ''}
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Dados do atendimento</div>
        <div class="kv"><b>Empresa:</b> ${esc(r.empresa)} <span class="sep">·</span> <b>Contato:</b> ${esc(r.contato)} <span class="sep">·</span> <b>Telefone:</b> ${esc(r.telefone)}</div>
        <div class="kv"><b>Endereço:</b> ${esc(r.endereco)}, ${esc(r.numero)} — ${esc(r.bairro)}, ${esc(r.cidade)}/${esc(r.estado)} — CEP ${esc(r.cep)}</div>
        <div class="kv"><b>Data inicial:</b> ${esc(r.data_inicial)} <span class="sep">·</span> <b>Data final:</b> ${esc(r.data_final)}</div>
        <div class="kv"><b>Modelo da máquina:</b> ${esc(r.modelo_maquina)} <span class="sep">·</span> <b>Nº de série:</b> ${esc(r.numero_serie)}</div>
        <div class="kv"><b>Serviço:</b> ${esc(r.servico)} <span class="sep">·</span> <b>Técnico:</b> ${esc(r.tecnico_nome)}</div>
      </div>
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Item / entrega / observação</div>
        <ol class="item-steps">
          ${(r.checklist || []).map((c) => `<li>${esc(c.item)} — <b>${c.resposta === 'sim' ? 'Sim' : c.resposta === 'nao' ? 'Não' : 'N/A'}</b>${c.observacao ? ' — ' + esc(c.observacao) : ''}</li>`).join('')}
        </ol>
      </div>
      ${r.observacoes ? `<div class="relatorio-secao"><div class="relatorio-secao-titulo">Observações</div><div class="relatorio-secao-texto">${esc(r.observacoes)}</div></div>` : ''}
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Aceite e avaliação</div>
        <div class="kv"><b>Aceite:</b> ${r.aceite === 'aceito' ? 'Li e aceito os termos' : 'Não aceito'}</div>
        <div class="kv"><b>Avaliação:</b> ${r.avaliacao ? r.avaliacao.estrelas : '—'}/5 estrelas <span class="sep">·</span> Dúvidas sanadas: ${r.avaliacao && r.avaliacao.duvidas_sanadas === 'sim' ? 'Sim' : 'Não'} <span class="sep">·</span> Apto a operar: ${r.avaliacao && r.avaliacao.apto_operar === 'sim' ? 'Sim' : 'Não'}</div>
      </div>
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Assinaturas</div>
        <div style="display:flex; gap:16px; flex-wrap:wrap;">
          <div>${esc(r.assinatura_cliente_nome || '—')} (cliente)${r.assinatura_cliente_img ? `<br><img src="${r.assinatura_cliente_img}" style="max-width:200px; border:1px solid var(--line); border-radius:6px; margin-top:4px;" onclick="abrirLightbox('${r.assinatura_cliente_img}')">` : ''}</div>
          <div>${esc(r.assinatura_tecnico_nome || '—')} (técnico)${r.assinatura_tecnico_img ? `<br><img src="${r.assinatura_tecnico_img}" style="max-width:200px; border:1px solid var(--line); border-radius:6px; margin-top:4px;" onclick="abrirLightbox('${r.assinatura_tecnico_img}')">` : ''}</div>
        </div>
      </div>`;
  }
  if (v.relatorio_simples) {
    const r = v.relatorio_simples;
    return `
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Equipamento</div>
        <div class="kv"><b>Equipamento:</b> ${esc(r.equipamento_tipo)} — ${esc(r.equipamento_modelo)} ${r.numero_serie ? `(${esc(r.numero_serie)})` : ''}</div>
      </div>
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Observações</div>
        <div class="relatorio-secao-texto">${esc(r.observacoes)}</div>
      </div>`;
  }
  if (v.laudo) {
    const l = v.laudo;
    return `
      ${v.relevante_biblioteca ? `<div class="admin-note" style="background:var(--green-bg); color:var(--green);"><b>Marcado como relevante</b>Se aprovado, entra na Biblioteca de Defeitos/Falhas com ${esc(v.tecnico_nome || 'o técnico')} como autor.</div>` : ''}
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Dados do atendimento</div>
        <div class="kv"><b>Empresa:</b> ${esc(l.empresa || '')} <span class="sep">·</span> <b>Contato:</b> ${esc(l.contato || '')} <span class="sep">·</span> <b>Telefone:</b> ${esc(l.telefone || '')}</div>
        <div class="kv"><b>Endereço:</b> ${esc(l.endereco || '')}, ${esc(l.numero || '')} — ${esc(l.bairro || '')}, ${esc(l.cidade || '')}/${esc(l.estado || '')}</div>
        <div class="kv"><b>Técnico:</b> ${esc(l.tecnico_nome || '')} <span class="sep">·</span> <b>Equipamento:</b> ${esc(l.equipamento_tipo || '')} — ${esc(l.modelo_maquina || '')} (${esc(l.numero_serie || '—')})</div>
      </div>
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Dados do equipamento</div>
        <div class="kv"><b>Data de fabricação:</b> ${esc(l.data_fabricacao || '—')} <span class="sep">·</span> <b>Garantia:</b> ${l.garantia === 'sim' ? 'Sim' : l.garantia === 'nao' ? 'Não' : `N/A — ${esc(l.garantia_obs || '')}`}</div>
        <div class="kv"><b>Acessórios recebidos:</b> ${esc(l.acessorios || '—')}</div>
        <div class="kv"><b>Defeito informado:</b> ${esc(l.defeito_informado || '—')}</div>
      </div>
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Técnico responsável</div>
        <div class="kv"><b>Data de início:</b> ${l.data_entrada ? fmtData(l.data_entrada) : '—'} <span class="sep">·</span> <b>Data de conclusão:</b> ${l.data_conclusao ? fmtData(l.data_conclusao) : '—'} <span class="sep">·</span> <b>Período de reparo:</b> ${periodoReparo(l)}</div>
      </div>
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Laudo técnico</div>
        <div class="relatorio-secao-texto">${esc(l.laudo_tecnico || '')}</div>
      </div>
      <div class="relatorio-secao">
        <div class="relatorio-secao-titulo">Serviço realizado</div>
        <div class="relatorio-secao-texto">${esc(l.servico_realizado || '')}</div>
      </div>
      ${(l.pecas || []).length ? `<div class="relatorio-secao"><div class="relatorio-secao-titulo">Peças fornecidas</div><ol class="item-steps">${l.pecas.map((p) => `<li>${esc(p.descricao || '—')}${p.quantidade ? ' (qtd: ' + esc(p.quantidade) + ')' : ''}</li>`).join('')}</ol></div>` : ''}
      ${l.observacoes ? `<div class="relatorio-secao"><div class="relatorio-secao-titulo">Observações</div><div class="relatorio-secao-texto">${esc(l.observacoes)}</div></div>` : ''}
      ${(l.fotos || []).length ? `<div class="relatorio-secao"><div class="relatorio-secao-titulo">Relatório fotográfico</div><div class="step-photos">${l.fotos.map((f) => `<div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do laudo"></div>`).join('')}</div></div>` : ''}`;
  }
  return `<div class="kv"><b>Causa:</b> ${esc(v.causa)}</div><div class="kv"><b>Correção:</b> ${esc(v.correcao)}</div><div class="kv"><b>Resultado:</b> ${esc(v.resultado)}</div>`;
}
async function aprovarVisita(id, incluirBiblioteca) {
  await api(`/api/visitas/${id}/aprovar`, { method: 'POST', body: { incluir_biblioteca: !!incluirBiblioteca } });
  voltarListaOS();
}
// depois de qualquer ação sobre uma visita, volta pra tela de onde ela foi disparada
// (Ordem de Serviço ou o calendário da Agenda geral) em vez de sempre ir pra Ordem de Serviço
function voltarListaOS() {
  if (paginaAtual === 'aprovacoes-visitas') renderAprovacoesVisitas();
  else renderAgenda();
}
async function reprovarVisita(id) {
  const comentario = prompt('Motivo da reprovação (opcional):') || '';
  await api(`/api/visitas/${id}/reprovar`, { method: 'POST', body: { comentario } });
  voltarListaOS();
}
async function sugerirEdicaoVisita(id) {
  const comentario = prompt('O que precisa ser corrigido no relatório? (obrigatório)');
  if (!comentario || !comentario.trim()) return;
  try {
    await api(`/api/visitas/${id}/sugerir-edicao`, { method: 'POST', body: { comentario } });
    mostrarToast('Edição solicitada — o técnico foi notificado.');
    voltarListaOS();
  } catch (e) { alert('Erro: ' + e.message); }
}
async function reabrirVisita(id) {
  if (!confirm('Reabrir este relatório? Ele volta para a fila de aprovação e o técnico pode editá-lo novamente.')) return;
  try { await api(`/api/visitas/${id}/reabrir`, { method: 'POST' }); mostrarToast('Relatório reaberto.'); voltarListaOS(); }
  catch (e) { alert('Erro: ' + e.message); }
}
async function recusarReabertura(id) {
  try { await api(`/api/visitas/${id}/recusar-reabertura`, { method: 'POST' }); mostrarToast('Solicitação de reabertura recusada.'); voltarListaOS(); }
  catch (e) { alert('Erro: ' + e.message); }
}
async function excluirVisita(id) {
  if (!confirm('Excluir este relatório definitivamente? Se ele já tiver entrado na biblioteca, o caso também é removido. Essa ação não pode ser desfeita.')) return;
  try { await api(`/api/visitas/${id}`, { method: 'DELETE' }); mostrarToast('Relatório excluído.'); voltarListaOS(); }
  catch (e) { alert('Erro: ' + e.message); }
}
async function solicitarReaberturaVisita(id) {
  const motivo = prompt('Por que você precisa reabrir este relatório?') || '';
  try { await api(`/api/visitas/${id}/solicitar-reabertura`, { method: 'POST', body: { motivo } }); mostrarToast('Solicitação enviada ao administrador.'); renderAgenda(); }
  catch (e) { alert('Erro: ' + e.message); }
}

// botão "Iniciar deslocamento": só aparece pro técnico designado, numa O.S. ainda em aberto
// (não finalizada). Assim que ele toca no botão, o botão Executar (ou Enviar retorno) já
// aparece no lugar dele — não fica os dois juntos ocupando espaço. O administrador recebe uma
// notificação push quando o técnico toca nele.
function botaoDeslocamento(a) {
  if (a.tecnico_id !== USER.id || a.finalizada) return '';
  // retorno pendente: o técnico precisa se deslocar de novo antes de enviar o relatório de
  // retorno — o mesmo botão/rótulo do deslocamento original, só que num segundo momento
  if (a.retorno_pendente_tecnico) {
    if (a.retorno_deslocamento_iniciado_em) return '';
    if (!a.retorno_confirmado_cliente_em) return `<span class="tag" style="background:var(--line); color:var(--ink-soft); margin-right:6px;">Aguardando confirmação do cliente</span>`;
    return `<button class="btn-outline-sm" onclick="iniciarDeslocamento(${a.id})" style="margin-right:6px;">🚗 Iniciar deslocamento</button>`;
  }
  if (a.status === 'concluida') return '';
  if (!a.confirmado_cliente_em) return `<span class="tag" style="background:var(--line); color:var(--ink-soft); margin-right:6px;">Aguardando confirmação do cliente</span>`;
  if (a.deslocamento_iniciado_em) return '';
  return `<button class="btn-outline-sm" onclick="iniciarDeslocamento(${a.id})" style="margin-right:6px;">🚗 Iniciar deslocamento</button>`;
}

async function iniciarDeslocamento(id) {
  if (!confirm('Confirma que você está saindo agora para este atendimento? O administrador vai ser avisado.')) return;
  try {
    const { agenda } = await api(`/api/agenda/${id}/iniciar-deslocamento`, { method: 'POST' });
    mostrarToast('Deslocamento iniciado — o administrador foi avisado.');
    if (Array.isArray(window._agendaCache)) {
      const idx = window._agendaCache.findIndex((a) => a.id === id);
      if (idx !== -1) window._agendaCache[idx] = agenda;
    }
    if (paginaAtual === 'calendario-tecnico') abrirDetalheOSCalendarioTecnico(id);
    else if (paginaAtual === 'agenda' && minhaAgendaDetalheId === id) abrirDetalheOSMinhaAgenda(id);
    else renderAgenda();
  } catch (e) { alert('Erro: ' + e.message); }
}

// botão "Registrar chegada": só depois de iniciar o deslocamento, e antes de poder executar
// (preencher o relatório) — mesmo padrão do registrarChegadaRetorno, pro primeiro deslocamento
async function confirmarChegada(id) {
  if (!confirm('Confirma que você já chegou no cliente?')) return;
  try {
    const { agenda } = await api(`/api/agenda/${id}/confirmar-chegada`, { method: 'POST' });
    mostrarToast('Chegada registrada — já pode executar o atendimento.');
    if (Array.isArray(window._agendaCache)) {
      const idx = window._agendaCache.findIndex((a) => a.id === id);
      if (idx !== -1) window._agendaCache[idx] = agenda;
    }
    if (paginaAtual === 'calendario-tecnico') abrirDetalheOSCalendarioTecnico(id);
    else if (paginaAtual === 'agenda' && minhaAgendaDetalheId === id) abrirDetalheOSMinhaAgenda(id);
    else renderAgenda();
  } catch (e) { alert('Erro: ' + e.message); }
}

// botão "Registrar chegada" do retorno: só depois de iniciar o deslocamento do retorno, e antes
// de poder enviar o relatório de retorno
async function registrarChegadaRetorno(id) {
  if (!confirm('Confirma que você já chegou no cliente para o retorno?')) return;
  try {
    const { agenda } = await api(`/api/agenda/${id}/retorno/confirmar-chegada`, { method: 'POST' });
    mostrarToast('Chegada registrada — já pode preencher o relatório de retorno.');
    if (Array.isArray(window._agendaCache)) {
      const idx = window._agendaCache.findIndex((a) => a.id === id);
      if (idx !== -1) window._agendaCache[idx] = agenda;
    }
    if (paginaAtual === 'calendario-tecnico') abrirDetalheOSCalendarioTecnico(id);
    else if (paginaAtual === 'agenda' && minhaAgendaDetalheId === id) abrirDetalheOSMinhaAgenda(id);
    else renderAgenda();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- BIBLIOTECA: ACESSAR ----------
async function renderBibliotecaDefeitos(filtros = {}, pesquisou = false) {
  let registros = [];
  if (pesquisou) {
    const params = new URLSearchParams({ tipo: 'defeito', ...filtros });
    ({ registros } = await api('/api/registros?' + params.toString()));
  }
  window._defeitosCache = registros;
  window._defeitosFiltros = filtros;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Biblioteca — Defeitos/Falhas</h1><p>Casos aprovados pela liderança, pesquisáveis por equipamento, palavra-chave ou nº de série</p></div>
    <div class="filtros-row">
      <div class="field"><label>Equipamento</label><input id="f-equip" value="${esc(filtros.equipamento || '')}" placeholder="ex: Máquina de Gelo"></div>
      <div class="field"><label>Nº de série</label><input id="f-serie" value="${esc(filtros.serie || '')}" placeholder="ex: 2301013587"></div>
      <div class="field"><label>Palavra-chave</label><input id="f-q" value="${esc(filtros.q || '')}" placeholder="sintoma, causa ou solução"></div>
      <button class="btn btn-primary btn-sm" onclick="filtrarDefeitos()">Buscar</button>
    </div>
    ${!pesquisou ? `<div class="empty">Preencha um filtro (opcional) e clique em Buscar para ver os casos aprovados.</div>` : registros.length ? `
    <div class="panel"><table>
      <tr><th>Título</th><th>Equipamento</th><th>Nº de série</th><th></th></tr>
      ${registros.map((r, i) => `
        <tr style="cursor:pointer;" onclick="abrirDetalheDefeito(${i})">
          <td data-label="Título">${esc(r.titulo)}</td>
          <td data-label="Equipamento">${esc(r.equipamento_tipo)}${r.equipamento_modelo ? ' — ' + esc(r.equipamento_modelo) : ''}</td>
          <td data-label="Nº de série">${esc(r.numero_serie || '—')}</td>
          <td class="td-acoes">
            <button class="btn-outline-sm" onclick="event.stopPropagation(); abrirDetalheDefeito(${i})">Abrir</button>
            ${USER.papel === 'administrador' ? `<button class="btn-outline-sm" onclick="event.stopPropagation(); excluirRegistroBiblioteca('defeito', ${i})">Excluir</button>` : ''}
          </td>
        </tr>`).join('')}
    </table></div>` : `<div class="empty">Nenhum caso aprovado com esses filtros ainda.</div>`}`;
}
function filtrarDefeitos() {
  const filtros = {
    equipamento: document.getElementById('f-equip').value,
    serie: document.getElementById('f-serie').value,
    q: document.getElementById('f-q').value,
  };
  renderBibliotecaDefeitos(filtros, true);
}
async function abrirDetalheDefeito(i, origem) {
  const r = (window._defeitosCache || [])[i];
  if (!r) return;
  // a lista de busca não traz fotos (economia de banda) — busca o registro completo só agora
  if (!r._completo) { Object.assign(r, (await api(`/api/registros/${r.id}`)).registro); r._completo = true; }
  carregarLogoDataUri();
  const main = document.getElementById('main');
  const voltar = origem === 'solicitacoes' ? 'renderSolicitacoesEdicao()' : 'renderBibliotecaDefeitos(window._defeitosFiltros || {}, true)';
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(r.titulo)}</h1><p>${esc(r.equipamento_tipo)}${r.equipamento_modelo ? ' — ' + esc(r.equipamento_modelo) : ''}${r.numero_serie ? ' · Nº série ' + esc(r.numero_serie) : ''}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="abrirPdfBiblioteca('defeito', ${i})">Abrir PDF</button>
        ${USER.papel === 'administrador' ? `<button class="btn-outline-sm" onclick="abrirEditarDefeito(${i}, '${origem || ''}')">Editar</button>` : ''}
        ${USER.papel === 'suporte' ? `<button class="btn-outline-sm" onclick="solicitarEdicaoBiblioteca('defeito', ${i})">Solicitar edição</button>` : ''}
        <button class="btn-outline-sm" onclick="${voltar}">‹ Voltar</button>
      </div>
    </div>
    ${USER.papel === 'administrador' && r.solicitacao_edicao ? `<div class="admin-note"><b>${esc(r.solicitacao_edicao.solicitante_nome)} pediu uma edição</b>${esc(r.solicitacao_edicao.comentario)}</div>` : ''}
    <div class="panel">
      <span class="tag tag-falha">Defeito</span>
      <div class="kv" style="margin-top:12px;"><b>Sintoma:</b> ${esc(r.sintoma)}</div>
      <div class="kv"><b>Causa:</b> ${esc(r.causa)}</div>
      <div class="kv"><b>Solução:</b> ${esc(r.solucao)}</div>
      ${r.fotos && r.fotos.length ? `<div class="kv"><b>Relatório fotográfico:</b></div><div class="item-step-photos">${r.fotos.map((f) => `<img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do defeito">`).join('')}</div>` : ''}
      <div class="item-autor">Autor: <b>${esc(r.autor_nome || '—')}</b> · ${fmtData(r.criado_em)}</div>
    </div>`;
}

function abrirEditarDefeito(i, origem) {
  const r = (window._defeitosCache || [])[i];
  if (!r) return;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Editar caso — Defeitos/Falhas</h1><p>Alteração direta: o caso continua publicado imediatamente após salvar.</p></div>
    <div class="panel">
      <div class="form-grid">
        <div class="full"><label>Título resumo</label><input id="fd-titulo" value="${esc(r.titulo)}"></div>
        <div><label>Equipamento</label><input id="fd-equip-tipo" value="${esc(r.equipamento_tipo)}"></div>
        <div><label>Modelo</label><input id="fd-equip-modelo" value="${esc(r.equipamento_modelo)}"></div>
        <div><label>Número de série (opcional)</label><input id="fd-serie" value="${esc(r.numero_serie || '')}"></div>
        <div class="full"><label>Defeito/sintoma encontrado</label><textarea id="fd-sintoma">${esc(r.sintoma)}</textarea></div>
        <div class="full"><label>Causa identificada</label><textarea id="fd-causa">${esc(r.causa)}</textarea></div>
        <div class="full"><label>Solução aplicada</label><textarea id="fd-solucao">${esc(r.solucao)}</textarea></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="salvarEdicaoDefeito(${r.id}, ${i}, '${origem || ''}')">Salvar alterações</button>
      <button class="btn-outline-sm" onclick="abrirDetalheDefeito(${i}, '${origem || ''}')">Cancelar</button>
    </div>`;
}
async function salvarEdicaoDefeito(id, i, origem) {
  const body = {
    titulo: document.getElementById('fd-titulo').value,
    equipamento_tipo: document.getElementById('fd-equip-tipo').value,
    equipamento_modelo: document.getElementById('fd-equip-modelo').value,
    numero_serie: document.getElementById('fd-serie').value,
    sintoma: document.getElementById('fd-sintoma').value,
    causa: document.getElementById('fd-causa').value,
    solucao: document.getElementById('fd-solucao').value,
  };
  try {
    const { registro } = await api(`/api/registros/${id}`, { method: 'PUT', body });
    mostrarToast('Alterações salvas.');
    if (origem === 'solicitacoes') { renderSolicitacoesEdicao(); return; }
    registro._completo = true; // já veio com fotos — evita refazer a busca à toa
    window._defeitosCache[i] = registro;
    abrirDetalheDefeito(i, origem);
  } catch (e) { alert('Erro: ' + e.message); }
}
async function solicitarEdicaoBiblioteca(tipo, i) {
  const r = tipo === 'procedimento' ? (window._procedimentosCache || [])[i] : (window._defeitosCache || [])[i];
  if (!r) return;
  const comentario = prompt('O que precisa ser corrigido nesse caso da biblioteca? (obrigatório)');
  if (!comentario || !comentario.trim()) return;
  try {
    await api(`/api/registros/${r.id}/solicitar-edicao`, { method: 'POST', body: { comentario } });
    mostrarToast('Solicitação enviada — o administrador foi notificado.');
  } catch (e) { alert('Erro: ' + e.message); }
}
async function excluirRegistroBiblioteca(tipo, i) {
  const r = tipo === 'procedimento' ? (window._procedimentosCache || [])[i] : (window._defeitosCache || [])[i];
  if (!r) return;
  if (!confirm(`Excluir "${r.titulo}" definitivamente? Essa ação não pode ser desfeita.`)) return;
  try {
    await api(`/api/registros/${r.id}`, { method: 'DELETE' });
    mostrarToast('Registro excluído.');
    if (tipo === 'procedimento') renderBibliotecaProcedimentos(window._procedimentosFiltros || {}, true);
    else renderBibliotecaDefeitos(window._defeitosFiltros || {}, true);
  } catch (e) { alert('Erro: ' + e.message); }
}

async function renderSolicitacoesEdicao() {
  const { registros } = await api('/api/registros/solicitacoes-edicao');
  window._solicitacoesCache = registros;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Solicitações de edição</h1><p>Casos já publicados na biblioteca que um técnico pediu para corrigir</p></div>
    ${registros.length ? registros.map((r, i) => `
      <div class="item-card">
        <span class="tag ${r.tipo === 'defeito' ? 'tag-falha' : 'tag-preventiva'}">${r.tipo === 'defeito' ? 'Defeito' : 'Procedimento'}</span>
        <div class="item-title" style="margin-top:8px;">${esc(r.titulo)}</div>
        <div class="item-meta">Solicitado por <b>${esc(r.solicitacao_edicao.solicitante_nome)}</b> · ${fmtData(r.solicitacao_edicao.criado_em)}</div>
        <div class="kv" style="margin-top:6px;"><b>Comentário:</b> ${esc(r.solicitacao_edicao.comentario)}</div>
        <button class="btn-outline-sm" style="margin-top:10px;" onclick="abrirDeSolicitacao(${i})">Abrir</button>
      </div>`).join('') : `<div class="empty">Nenhuma solicitação de edição pendente.</div>`}`;
}
function abrirDeSolicitacao(i) {
  const r = (window._solicitacoesCache || [])[i];
  if (!r) return;
  r._completo = true; // essa lista já vem com fotos — evita refazer a busca à toa
  if (r.tipo === 'defeito') { window._defeitosCache = [r]; window._defeitosFiltros = {}; abrirDetalheDefeito(0, 'solicitacoes'); }
  else { window._procedimentosCache = [r]; window._procedimentosFiltros = {}; abrirDetalheProcedimento(0, 'solicitacoes'); }
}

async function renderBibliotecaProcedimentos(filtros = {}, pesquisou = false) {
  let registros = [];
  if (pesquisou) {
    const params = new URLSearchParams({ tipo: 'procedimento', ...filtros });
    ({ registros } = await api('/api/registros?' + params.toString()));
  }
  window._procedimentosCache = registros;
  window._procedimentosFiltros = filtros;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Biblioteca — Manual de Procedimentos</h1><p>Procedimentos preventivos aprovados, pesquisáveis por equipamento ou título</p></div>
    <div class="filtros-row">
      <div class="field"><label>Equipamento</label><input id="f-equip" value="${esc(filtros.equipamento || '')}" placeholder="ex: Torre de Bebidas"></div>
      <div class="field"><label>Título</label><input id="f-q" value="${esc(filtros.q || '')}" placeholder="título do procedimento"></div>
      <button class="btn btn-primary btn-sm" onclick="filtrarProcedimentos()">Buscar</button>
    </div>
    ${!pesquisou ? `<div class="empty">Preencha um filtro (opcional) e clique em Buscar para ver os procedimentos aprovados.</div>` : registros.length ? `
    <div class="panel"><table>
      <tr><th>Título</th><th>Equipamento</th><th>Periodicidade</th><th></th></tr>
      ${registros.map((r, i) => `
        <tr style="cursor:pointer;" onclick="abrirDetalheProcedimento(${i})">
          <td data-label="Título">${esc(r.titulo)}</td>
          <td data-label="Equipamento">${esc(r.equipamento_tipo)}${r.equipamento_modelo ? ' — ' + esc(r.equipamento_modelo) : ''}</td>
          <td data-label="Periodicidade">${esc(r.periodicidade || '—')}</td>
          <td class="td-acoes">
            <button class="btn-outline-sm" onclick="event.stopPropagation(); abrirDetalheProcedimento(${i})">Abrir</button>
            ${USER.papel === 'administrador' ? `<button class="btn-outline-sm" onclick="event.stopPropagation(); excluirRegistroBiblioteca('procedimento', ${i})">Excluir</button>` : ''}
          </td>
        </tr>`).join('')}
    </table></div>` : `<div class="empty">Nenhum procedimento aprovado com esses filtros ainda.</div>`}`;
}
function filtrarProcedimentos() {
  const filtros = {
    equipamento: document.getElementById('f-equip').value,
    q: document.getElementById('f-q').value,
  };
  renderBibliotecaProcedimentos(filtros, true);
}
async function abrirDetalheProcedimento(i, origem) {
  const r = (window._procedimentosCache || [])[i];
  if (!r) return;
  // a lista de busca não traz fotos (economia de banda) — busca o registro completo só agora
  if (!r._completo) { Object.assign(r, (await api(`/api/registros/${r.id}`)).registro); r._completo = true; }
  carregarLogoDataUri();
  const main = document.getElementById('main');
  const voltar = origem === 'solicitacoes' ? 'renderSolicitacoesEdicao()' : 'renderBibliotecaProcedimentos(window._procedimentosFiltros || {}, true)';
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(r.titulo)}</h1><p>${esc(r.equipamento_tipo)}${r.equipamento_modelo ? ' — ' + esc(r.equipamento_modelo) : ''}${r.periodicidade ? ' · Periodicidade: ' + esc(r.periodicidade) : ''}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="abrirPdfBiblioteca('procedimento', ${i})">Abrir PDF</button>
        ${USER.papel === 'administrador' ? `<button class="btn-outline-sm" onclick="abrirEditarProcedimento(${i}, '${origem || ''}')">Editar</button>` : ''}
        ${USER.papel === 'suporte' ? `<button class="btn-outline-sm" onclick="solicitarEdicaoBiblioteca('procedimento', ${i})">Solicitar edição</button>` : ''}
        <button class="btn-outline-sm" onclick="${voltar}">‹ Voltar</button>
      </div>
    </div>
    ${USER.papel === 'administrador' && r.solicitacao_edicao ? `<div class="admin-note"><b>${esc(r.solicitacao_edicao.solicitante_nome)} pediu uma edição</b>${esc(r.solicitacao_edicao.comentario)}</div>` : ''}
    <div class="panel">
      <span class="tag tag-preventiva">Procedimento</span>
      <div style="margin-top:12px;">
        ${r.precaucoes ? `<div class="kv"><b>Precauções/EPIs:</b> ${esc(r.precaucoes)}</div>` : ''}
        ${r.ferramentas ? `<div class="kv"><b>Ferramentas:</b> ${esc(r.ferramentas)}</div>` : ''}
        <ol class="item-steps">
          ${(r.passos || []).map((p) => `
            <li>${esc(p.texto)}
              ${p.fotos && p.fotos.length ? `<div class="item-step-photos">${p.fotos.map((f) => `<img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto da etapa">`).join('')}</div>` : ''}
            </li>`).join('')}
        </ol>
        <div class="item-autor">Autor: <b>${esc(r.autor_nome || '—')}</b> · ${fmtData(r.criado_em)}</div>
      </div>
    </div>`;
}

function abrirEditarProcedimento(i, origem) {
  const r = (window._procedimentosCache || [])[i];
  if (!r) return;
  procDraft = r.passos && r.passos.length ? JSON.parse(JSON.stringify(r.passos)) : [{ texto: '', fotos: [] }];
  fotoDestaqueDraft = r.foto_destaque || null;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Editar procedimento</h1><p>Alteração direta: o procedimento continua publicado imediatamente após salvar.</p></div>
    <div class="panel">
      <div class="form-grid">
        <div class="full"><label>Título do procedimento</label><input id="fp-titulo" value="${esc(r.titulo)}"></div>
        <div><label>Equipamento</label><input id="fp-equip-tipo" value="${esc(r.equipamento_tipo)}"></div>
        <div><label>Modelo</label><input id="fp-equip-modelo" value="${esc(r.equipamento_modelo)}"></div>
        <div><label>Periodicidade</label>
          <select id="fp-periodicidade">
            ${['Semanal', 'Mensal', 'Trimestral', 'Semestral', 'Anual', 'N/A'].map((p) => `<option ${r.periodicidade === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div><label>Foto de destaque (equipamento/peça)</label><div id="fp-foto-destaque" style="display:flex;"></div></div>
        <div class="full"><label>Precauções/EPIs</label><textarea id="fp-precaucoes">${esc(r.precaucoes || '')}</textarea></div>
        <div class="full"><label>Ferramentas necessárias</label><textarea id="fp-ferramentas">${esc(r.ferramentas || '')}</textarea></div>
      </div>
      <label>Passo a passo</label>
      <div class="steps-list" id="steps-list"></div>
      <button class="btn btn-ghost btn-sm" style="margin-bottom:18px;" onclick="adicionarPasso()">+ Adicionar passo</button>
      <br>
      <button class="btn btn-primary btn-sm" onclick="salvarEdicaoProcedimento(${r.id}, ${i}, '${origem || ''}')">Salvar alterações</button>
      <button class="btn-outline-sm" onclick="abrirDetalheProcedimento(${i}, '${origem || ''}')">Cancelar</button>
    </div>`;
  renderPassosDraft();
  renderFotoDestaque();
}
async function salvarEdicaoProcedimento(id, i, origem) {
  const body = {
    titulo: document.getElementById('fp-titulo').value,
    equipamento_tipo: document.getElementById('fp-equip-tipo').value,
    equipamento_modelo: document.getElementById('fp-equip-modelo').value,
    periodicidade: document.getElementById('fp-periodicidade').value,
    precaucoes: document.getElementById('fp-precaucoes').value,
    ferramentas: document.getElementById('fp-ferramentas').value,
    foto_destaque: fotoDestaqueDraft,
    passos: procDraft,
  };
  try {
    const { registro } = await api(`/api/registros/${id}`, { method: 'PUT', body });
    mostrarToast('Alterações salvas.');
    if (origem === 'solicitacoes') { renderSolicitacoesEdicao(); return; }
    registro._completo = true; // já veio com fotos — evita refazer a busca à toa
    window._procedimentosCache[i] = registro;
    abrirDetalheProcedimento(i, origem);
  } catch (e) { alert('Erro: ' + e.message); }
}

// paleta da marca Pro Conecta (mesmas cores de style.css), em RGB pra uso no jsPDF
const PDF_COR = {
  navy: [10, 38, 71], navyDeep: [7, 26, 51], blue: [20, 103, 214], blueBright: [46, 134, 255],
  bluePale: [234, 242, 252], ink: [16, 24, 38], inkSoft: [74, 85, 104], line: [220, 228, 239],
  green: [23, 114, 69], greenBg: [225, 243, 233], red: [179, 38, 30], redBg: [250, 227, 225], white: [255, 255, 255],
  bege: [242, 233, 216],
};

let _logoDataUriPromise = null;
function carregarLogoDataUri() {
  if (!_logoDataUriPromise) {
    _logoDataUriPromise = fetch('/logo.png')
      .then((resp) => resp.blob())
      .then((blob) => new Promise((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onload = () => resolve(leitor.result);
        leitor.onerror = reject;
        leitor.readAsDataURL(blob);
      }))
      .catch(() => null);
  }
  return _logoDataUriPromise;
}

async function abrirPdfBiblioteca(tipo, i) {
  const r = tipo === 'procedimento' ? (window._procedimentosCache || [])[i] : (window._defeitosCache || [])[i];
  if (!r) return;
  try {
    const logo = await carregarLogoDataUri();
    const url = gerarPdfBiblioteca(r, tipo, logo);
    window.open(url, '_blank');
  } catch (e) {
    alert('Erro ao gerar o PDF: ' + e.message);
  }
}

// PDF em duas colunas (ficha técnica ilustrada), com a identidade visual do Pro Conecta:
// faixa de cabeçalho com logo + nome, coluna esquerda tintada com foto de destaque/ferramentas/
// periodicidade/última atualização, coluna direita com o conteúdo completo.
function gerarPdfBiblioteca(r, tipo, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 30;
  const colEsqLargura = 150;
  const colDirX = margem + colEsqLargura + 24;
  const colDirLargura = pageW - colDirX - margem;
  const corTipo = tipo === 'procedimento' ? PDF_COR.green : PDF_COR.red;
  const corTipoBg = tipo === 'procedimento' ? PDF_COR.greenBg : PDF_COR.redBg;

  function foto(f) {
    if (!f) return null;
    const m = /^data:image\/(\w+);/.exec(f);
    return m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
  }
  function cor(c) { return c; }

  // ----- moldura + faixa de cabeçalho (navy, com o logo e o nome Pro Conecta) -----
  doc.setFillColor(...PDF_COR.bluePale);
  doc.rect(0, 0, pageW, pageH, 'F');
  const alturaFaixa = 56;
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, alturaFaixa, 'F');
  if (logoDataUri) {
    try { doc.addImage(logoDataUri, 'PNG', margem, 11, 32, 37); } catch (e) {}
  }
  const xNome = logoDataUri ? margem + 42 : margem;
  doc.setFontSize(17); doc.setFont(undefined, 'bold');
  doc.setTextColor(...PDF_COR.blueBright); doc.text('Pro', xNome, 30);
  const wPro = doc.getTextWidth('Pro ');
  doc.setTextColor(...PDF_COR.white); doc.text('Conecta', xNome + wPro, 30);
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text('Biblioteca técnica', xNome, 44);

  const tagTexto = tipo === 'procedimento' ? 'PROCEDIMENTO' : 'DEFEITO/FALHA';
  doc.setFontSize(9); doc.setFont(undefined, 'bold');
  const wTag = doc.getTextWidth(tagTexto) + 18;
  doc.setFillColor(...corTipo);
  doc.roundedRect(pageW - margem - wTag, 18, wTag, 20, 4, 4, 'F');
  doc.setTextColor(...PDF_COR.white);
  doc.text(tagTexto, pageW - margem - wTag / 2, 31, { align: 'center' });

  const topoConteudo = alturaFaixa + 22;

  // ----- coluna esquerda (painel tintado) -----
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(margem, topoConteudo, colEsqLargura, pageH - topoConteudo - margem, 8, 8, 'F');
  doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.8);
  doc.roundedRect(margem, topoConteudo, colEsqLargura, pageH - topoConteudo - margem, 8, 8, 'S');
  doc.setFillColor(...PDF_COR.blue);
  doc.rect(margem, topoConteudo, colEsqLargura, 4, 'F');

  let ye = topoConteudo + 22;
  function rotuloEsq(t) {
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(t, margem + 14, ye); ye += 12;
  }
  function valorEsq(t) {
    doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
    const linhas = doc.splitTextToSize(limparPdf(t) || '—', colEsqLargura - 26);
    doc.text(linhas, margem + 14, ye); ye += linhas.length * 11 + 12;
  }

  rotuloEsq('EQUIPAMENTO');
  valorEsq(`${r.equipamento_tipo || ''}${r.equipamento_modelo ? ' — ' + r.equipamento_modelo : ''}`);

  // procedimentos antigos (criados antes de existir o campo foto_destaque) continuam usando a
  // 1ª foto do passo 1 como reserva, pra não ficar sem imagem nenhuma na coluna esquerda.
  const primeiraFoto = tipo === 'procedimento'
    ? (r.foto_destaque || ((r.passos || []).find((p) => p.fotos && p.fotos.length) || {}).fotos?.[0])
    : (r.fotos || [])[0];
  if (primeiraFoto) {
    try {
      doc.setDrawColor(...PDF_COR.line);
      doc.roundedRect(margem + 14, ye, colEsqLargura - 28, 90, 4, 4, 'S');
      doc.addImage(primeiraFoto, foto(primeiraFoto), margem + 15, ye + 1, colEsqLargura - 30, 88);
      ye += 100;
    } catch (e) {}
  }

  if (tipo === 'procedimento') {
    rotuloEsq('PERIODICIDADE');
    valorEsq(r.periodicidade);
    if (r.ferramentas) {
      rotuloEsq('FERRAMENTAS');
      doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      r.ferramentas.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).forEach((fnome) => {
        const linhas = doc.splitTextToSize(limparPdf('✓ ' + fnome), colEsqLargura - 26);
        doc.text(linhas, margem + 14, ye); ye += linhas.length * 11;
      });
      ye += 10;
    }
  } else {
    rotuloEsq('Nº DE SÉRIE');
    valorEsq(r.numero_serie);
  }

  // ----- rodapé da coluna esquerda: última atualização + marca -----
  const yUpdate = pageH - margem - 58;
  doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.6);
  doc.line(margem + 14, yUpdate - 10, margem + colEsqLargura - 14, yUpdate - 10);
  doc.setFontSize(8); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text('ÚLTIMA ATUALIZAÇÃO', margem + 14, yUpdate);
  doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
  const dataAtt = fmtData(r.atualizado_em || r.criado_em);
  const quemAtt = r.atualizado_por_nome || r.autor_nome || '—';
  const linhasAtt = doc.splitTextToSize(limparPdf(`${dataAtt} · ${quemAtt}`), colEsqLargura - 26);
  doc.text(linhasAtt, margem + 14, yUpdate + 12);

  doc.setFontSize(7); doc.setTextColor(...PDF_COR.inkSoft);
  doc.text(empresaNome(), margem + 14, pageH - margem - 16);
  doc.text(empresaSite(), margem + 14, pageH - margem - 6);

  // ----- coluna direita -----
  let y2 = topoConteudo + 8;
  doc.setFontSize(16); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  const tituloLinhas = doc.splitTextToSize(limparPdf(r.titulo) || '—', colDirLargura);
  doc.text(tituloLinhas, colDirX, y2); y2 += tituloLinhas.length * 19 + 4;

  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
  doc.text(limparPdf(`Equipamento: ${r.equipamento_tipo || ''}${r.equipamento_modelo ? ' — ' + r.equipamento_modelo : ''}`), colDirX, y2); y2 += 14;
  doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.4); doc.line(colDirX, y2, colDirX + colDirLargura, y2); y2 += 18;

  function tituloSecao(t) {
    if (y2 > pageH - margem - 40) { doc.addPage(); pintarFundoPagina(); y2 = margem + 30; }
    doc.setFillColor(...PDF_COR.blue);
    doc.rect(colDirX, y2 - 9, 4, 12, 'F');
    doc.setFontSize(10.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(t, colDirX + 10, y2); y2 += 15;
  }
  function paragrafo(texto) {
    texto = limparPdf(texto);
    if (!texto) return;
    if (y2 > pageH - margem - 40) { doc.addPage(); pintarFundoPagina(); y2 = margem + 30; }
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(texto, colDirLargura);
    doc.text(linhas, colDirX, y2); y2 += linhas.length * 12 + 10;
  }
  function pintarFundoPagina() {
    doc.setFillColor(...PDF_COR.bluePale);
    doc.rect(0, 0, pageW, pageH, 'F');
  }

  if (tipo === 'procedimento') {
    if (r.precaucoes) { tituloSecao('Precaução'); paragrafo(r.precaucoes); }
    tituloSecao('Passo a passo');
    (r.passos || []).forEach((p, i) => {
      if (y2 > pageH - margem - 60) { doc.addPage(); pintarFundoPagina(); y2 = margem + 30; }
      doc.setFillColor(...PDF_COR.blue);
      doc.circle(colDirX + 6, y2 - 3, 7, 'F');
      doc.setFontSize(8); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
      doc.text(String(i + 1), colDirX + 6, y2, { align: 'center' });
      doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
      const linhas = doc.splitTextToSize(limparPdf(p.texto), colDirLargura - 20);
      doc.text(linhas, colDirX + 18, y2); y2 += linhas.length * 12 + 4;
      if (p.fotos && p.fotos.length) {
        const wImg = 90, hImg = 68; let x = colDirX + 18;
        p.fotos.forEach((f) => {
          if (x + wImg > colDirX + colDirLargura) { x = colDirX + 18; y2 += hImg + 8; }
          if (y2 + hImg > pageH - margem - 20) { doc.addPage(); pintarFundoPagina(); y2 = margem + 30; x = colDirX + 18; }
          try {
            doc.setDrawColor(...PDF_COR.line);
            doc.roundedRect(x - 1, y2 - 1, wImg + 2, hImg + 2, 3, 3, 'S');
            doc.addImage(f, foto(f), x, y2, wImg, hImg);
          } catch (e) {}
          x += wImg + 10;
        });
        y2 += hImg + 14;
      } else y2 += 8;
    });
  } else {
    tituloSecao('Sintoma'); paragrafo(r.sintoma);
    tituloSecao('Causa'); paragrafo(r.causa);
    tituloSecao('Solução'); paragrafo(r.solucao);
    if (r.fotos && r.fotos.length) {
      tituloSecao('Relatório fotográfico');
      const wImg = 150, hImg = 110; let x = colDirX;
      r.fotos.forEach((f) => {
        if (x + wImg > colDirX + colDirLargura) { x = colDirX; y2 += hImg + 10; }
        if (y2 + hImg > pageH - margem - 20) { doc.addPage(); pintarFundoPagina(); y2 = margem + 30; x = colDirX; }
        try {
          doc.setDrawColor(...PDF_COR.line);
          doc.roundedRect(x - 1, y2 - 1, wImg + 2, hImg + 2, 3, 3, 'S');
          doc.addImage(f, foto(f), x, y2, wImg, hImg);
        } catch (e) {}
        x += wImg + 12;
      });
      y2 += hImg + 14;
    }
  }

  doc.setFontSize(8); doc.setTextColor(...PDF_COR.inkSoft);
  doc.text(limparPdf(`Autor: ${r.autor_nome || '—'} · ${fmtData(r.criado_em)}`), colDirX, pageH - margem - 10);

  return doc.output('bloburl');
}

// Termo de Manutenção Preventiva — mesma escala de cores (PDF_COR) e mesmo esqueleto
// (capa navy + cabeçalho + títulos + caixas com borda) do relatório de manutenção interna acima,
// com as seções próprias do termo: check-list de 28 itens, peças, fotos por grupo, pesquisa de
// satisfação e assinaturas.
function gerarPdfRelatorioPreventiva(r, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: nomeArquivoRelatorioManutencao(r) });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Termo de Manutenção Preventiva', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  function tituloCentro(t, sub, apertado) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13;
    if (sub) {
      doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(sub, pageW / 2, y, { align: 'center' }); y += 13;
      y += 4;
    } else {
      y += apertado ? 4 : 16;
    }
  }

  function tituloEsquerda(t) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(t, margem, y); y += 14;
  }

  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  // ===== capa =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(20); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('TERMO DE MANUTENÇÃO', pageW / 2, 410, { align: 'center' });
  doc.text('PREVENTIVA', pageW / 2, 438, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(limparPdf(r.empresa).toUpperCase() || '—', pageW / 2, 464, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text(`O.S. ${limparPdf(r.os_uf)}/${limparPdf(r.os_numero)}/${limparPdf(r.os_ano)}`, pageW / 2, 485, { align: 'center' });
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados do atendimento');
  linhaCampos([{ label: 'Data inicial', valor: r.data_inicial, frac: 0.34 }, { label: 'Data final', valor: r.data_final, frac: 0.33 }, { label: 'O.S. Nº', valor: `${r.os_uf}/${r.os_numero}/${r.os_ano}`, frac: 0.33 }]);
  linhaCampos([{ label: 'Modelo da máquina', valor: r.modelo_maquina, frac: 0.5 }, { label: 'Nº de série', valor: r.numero_serie, frac: 0.5 }]);
  linhaCampos([{ label: 'Serviço realizado', valor: r.servico_realizado, frac: 0.5 }, { label: 'Técnico', valor: r.tecnico_nome, frac: 0.5 }]);
  linhaCampos([{ label: 'Empresa (cliente)', valor: r.empresa, frac: 1 }]);
  linhaCampos([{ label: 'Endereço', valor: `${r.endereco}, ${r.numero} — ${r.bairro}, ${r.cidade}/${r.estado} — CEP ${r.cep}`, frac: 1 }]);
  linhaCampos([{ label: 'Setor da máquina', valor: r.setor_maquina, frac: 1 }]);
  y += 16;

  tituloCentro('Check-list de verificação');
  (r.checklist || []).forEach((c, i) => {
    if (y + 16 > pageH - margem) novaPagina();
    const resp = c.resposta === 'sim' ? 'Sim' : c.resposta === 'nao' ? 'Não' : 'N/A';
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
    doc.text(limparPdf(`${String(i + 1).padStart(2, '0')}. ${c.item} — ${resp}`), margem, y); y += 12;
    if (c.observacao) {
      doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      const linhas = doc.splitTextToSize(limparPdf('Obs: ' + c.observacao), largura - 12);
      doc.text(linhas, margem + 12, y); y += linhas.length * 11;
    }
  });
  y += 8;
  { if (y > pageH - margem - 30) novaPagina(); doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy); doc.text('OBSERVAÇÕES DO CHECK-LIST', margem, y); y += 13; doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink); const linhas = doc.splitTextToSize(limparPdf(r.observacoes_checklist) || '—', largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 16; }

  tituloCentro('Serviços realizados', 'O que foi feito na máquina');
  { if (y > pageH - margem - 40) novaPagina(); doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink); const linhas = doc.splitTextToSize(limparPdf(r.servico_feito) || '—', largura - 16); const altura = Math.max(24, linhas.length * 12 + 12); doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S'); doc.text(linhas, margem + 8, y + 14); y += altura + 16; }

  tituloEsquerda('Peças fornecidas');
  {
    const cols = [{ t: 'Item', frac: 0.12 }, { t: 'Descrição da peça', frac: 0.6 }, { t: 'Código PMK', frac: 0.28 }];
    const larguras = cols.map((c) => largura * c.frac);
    if (y + 20 > pageH - margem) novaPagina();
    let cx = margem;
    doc.setFillColor(...PDF_COR.navy);
    doc.rect(margem, y, largura, 18, 'F');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
    cols.forEach((c, i) => { doc.text(c.t, cx + 6, y + 12); cx += larguras[i]; });
    y += 18;
    const pecas = r.pecas || [];
    if (!pecas.length) {
      if (y + 18 > pageH - margem) novaPagina();
      doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
      doc.setFont(undefined, 'italic'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text('Nenhuma peça informada', margem + 6, y + 12);
      y += 18;
    } else {
      pecas.forEach((p, i) => {
        if (y + 18 > pageH - margem) novaPagina();
        cx = margem;
        doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
        doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
        const valores = [String(i + 1), limparPdf(p.descricao) || '—', limparPdf(p.codigo_pmk) || '—'];
        valores.forEach((v, j) => { doc.text(v, cx + 6, y + 12); cx += larguras[j]; });
        y += 18;
      });
    }
    y += 16;
  }

  const temFotos = (r.fotos || []).some((bloco) => bloco && Array.isArray(bloco.fotos) && bloco.fotos.length);
  if (temFotos) {
    const gapFoto = 12, wImgFoto = (largura - gapFoto) / 2, hImgFoto = wImgFoto * 0.68;
    if (y + 34 + hImgFoto > pageH - margem) novaPagina();
  }
  tituloCentro('Fotos', null, true);
  (r.fotos || []).forEach((bloco) => {
    const fotosDoBloco = (bloco && bloco.fotos) || [];
    if (y > pageH - margem - 20) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(limparPdf(bloco && bloco.comentario) || '—', margem, y); y += 12;
    if (fotosDoBloco.length) {
      const gap = 12, wImg = (largura - gap) / 2, hImg = wImg * 0.68;
      for (let i = 0; i < fotosDoBloco.length; i += 2) {
        if (y + hImg > pageH - margem) novaPagina();
        [fotosDoBloco[i], fotosDoBloco[i + 1]].forEach((f, j) => {
          if (!f) return;
          const cx = margem + j * (wImg + gap);
          try {
            const m = /^data:image\/(\w+);/.exec(f);
            const formato = m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
            doc.setDrawColor(...PDF_COR.line);
            doc.roundedRect(cx - 1, y - 1, wImg + 2, hImg + 2, 3, 3, 'S');
            doc.addImage(f, formato, cx, y, wImg, hImg);
          } catch (e) {}
        });
        y += hImg + gap;
      }
    } else {
      doc.setFontSize(8.5); doc.setFont(undefined, 'italic'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text('Nenhuma foto anexada.', margem, y); y += 14;
    }
    y += 6;
  });

  tituloCentro('Pesquisa de satisfação');
  linhaCampos([{ label: 'Avaliação', valor: `${r.satisfacao_estrelas}/5 estrelas`, frac: 0.4 }, { label: 'Autoriza uso do feedback', valor: r.satisfacao_autoriza === 'sim' ? 'Sim' : 'Não', frac: 0.6 }]);
  if (r.satisfacao_comentario) linhaCampos([{ label: 'Comentário', valor: r.satisfacao_comentario, frac: 1 }]);
  y += 8;

  if (y > 560) novaPagina();
  tituloCentro('Assinaturas');
  {
    const wImg = 220, hImg = 90;
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    doc.text(limparPdf(`Cliente: ${r.assinatura_cliente_nome}`), margem, y);
    doc.text(limparPdf(`Técnico: ${r.assinatura_tecnico_nome}`), margem + largura / 2, y);
    y += 8;
    try { doc.addImage(r.assinatura_cliente_img, 'PNG', margem, y, wImg, hImg); } catch (e) {}
    try { doc.addImage(r.assinatura_tecnico_img, 'PNG', margem + largura / 2, y, wImg, hImg); } catch (e) {}
  }

  // ===== página de contato =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });
  doc.setFontSize(8); doc.setTextColor(...PDF_COR.inkSoft);
  doc.text(limparPdf(`Autor: ${r.autor_nome || '—'} · ${fmtData(r.criado_em)}`), pageW / 2, pageH - margem - 10, { align: 'center' });

  return doc.output('bloburl');
}

function gerarPdfRelatorioCorretiva(r, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: nomeArquivoRelatorioManutencao(r) });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Termo de Manutenção Corretiva', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  function tituloCentro(t, sub, apertado) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13;
    if (sub) {
      doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(sub, pageW / 2, y, { align: 'center' }); y += 13;
      y += 4;
    } else {
      y += apertado ? 4 : 16;
    }
  }

  function tituloEsquerda(t) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(t, margem, y); y += 14;
  }

  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  // ===== capa =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(20); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('TERMO DE MANUTENÇÃO', pageW / 2, 410, { align: 'center' });
  doc.text('CORRETIVA', pageW / 2, 438, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(limparPdf(r.empresa).toUpperCase() || '—', pageW / 2, 464, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text(`O.S. ${limparPdf(r.os_uf)}/${limparPdf(r.os_numero)}/${limparPdf(r.os_ano)}`, pageW / 2, 485, { align: 'center' });
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados do atendimento');
  linhaCampos([{ label: 'Data inicial', valor: r.data_inicial, frac: 0.34 }, { label: 'Data final', valor: r.data_final, frac: 0.33 }, { label: 'O.S. Nº', valor: `${r.os_uf}/${r.os_numero}/${r.os_ano}`, frac: 0.33 }]);
  linhaCampos([{ label: 'Modelo da máquina', valor: r.modelo_maquina, frac: 0.5 }, { label: 'Nº de série', valor: r.numero_serie, frac: 0.5 }]);
  linhaCampos([{ label: 'Serviço realizado', valor: r.servico_realizado, frac: 0.5 }, { label: 'Técnico', valor: r.tecnico_nome, frac: 0.5 }]);
  linhaCampos([{ label: 'Empresa (cliente)', valor: r.empresa, frac: 1 }]);
  linhaCampos([{ label: 'Endereço', valor: `${r.endereco}, ${r.numero} — ${r.bairro}, ${r.cidade}/${r.estado} — CEP ${r.cep}`, frac: 1 }]);
  linhaCampos([{ label: 'Setor da máquina', valor: r.setor_maquina, frac: 1 }]);
  y += 16;

  tituloCentro('Defeito informado');
  { if (y > pageH - margem - 40) novaPagina(); doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink); const linhas = doc.splitTextToSize(limparPdf(r.defeito_informado) || '—', largura - 16); const altura = Math.max(24, linhas.length * 12 + 12); doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S'); doc.text(linhas, margem + 8, y + 14); y += altura + 16; }

  tituloCentro('Ações executadas');
  { if (y > pageH - margem - 40) novaPagina(); doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink); const linhas = doc.splitTextToSize(limparPdf(r.acoes_executadas) || '—', largura - 16); const altura = Math.max(24, linhas.length * 12 + 12); doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S'); doc.text(linhas, margem + 8, y + 14); y += altura + 16; }

  tituloCentro('Observações');
  { if (y > pageH - margem - 40) novaPagina(); doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink); const linhas = doc.splitTextToSize(limparPdf(r.observacoes) || '—', largura - 16); const altura = Math.max(24, linhas.length * 12 + 12); doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S'); doc.text(linhas, margem + 8, y + 14); y += altura + 16; }

  tituloEsquerda('Peças fornecidas');
  {
    const cols = [{ t: 'Item', frac: 0.1 }, { t: 'Descrição da peça', frac: 0.52 }, { t: 'Código PMK', frac: 0.24 }, { t: 'Qtd.', frac: 0.14 }];
    const larguras = cols.map((c) => largura * c.frac);
    if (y + 20 > pageH - margem) novaPagina();
    let cx = margem;
    doc.setFillColor(...PDF_COR.navy);
    doc.rect(margem, y, largura, 18, 'F');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
    cols.forEach((c, i) => { doc.text(c.t, cx + 6, y + 12); cx += larguras[i]; });
    y += 18;
    const pecas = r.pecas || [];
    if (!pecas.length) {
      if (y + 18 > pageH - margem) novaPagina();
      doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
      doc.setFont(undefined, 'italic'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text('Nenhuma peça informada', margem + 6, y + 12);
      y += 18;
    } else {
      pecas.forEach((p, i) => {
        if (y + 18 > pageH - margem) novaPagina();
        cx = margem;
        doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
        doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
        const valores = [String(i + 1), limparPdf(p.descricao) || '—', limparPdf(p.codigo_pmk) || '—', limparPdf(p.quantidade) || '—'];
        valores.forEach((v, j) => { doc.text(v, cx + 6, y + 12); cx += larguras[j]; });
        y += 18;
      });
    }
    y += 16;
  }

  const temFotos = (r.fotos || []).some((bloco) => bloco && Array.isArray(bloco.fotos) && bloco.fotos.length);
  if (temFotos) {
    const gapFoto = 12, wImgFoto = (largura - gapFoto) / 2, hImgFoto = wImgFoto * 0.68;
    if (y + 34 + hImgFoto > pageH - margem) novaPagina();
  }
  tituloCentro('Fotos', null, true);
  (r.fotos || []).forEach((bloco) => {
    const fotosDoBloco = (bloco && bloco.fotos) || [];
    if (y > pageH - margem - 20) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(limparPdf(bloco && bloco.comentario) || '—', margem, y); y += 12;
    if (fotosDoBloco.length) {
      const gap = 12, wImg = (largura - gap) / 2, hImg = wImg * 0.68;
      for (let i = 0; i < fotosDoBloco.length; i += 2) {
        if (y + hImg > pageH - margem) novaPagina();
        [fotosDoBloco[i], fotosDoBloco[i + 1]].forEach((f, j) => {
          if (!f) return;
          const cx = margem + j * (wImg + gap);
          try {
            const m = /^data:image\/(\w+);/.exec(f);
            const formato = m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
            doc.setDrawColor(...PDF_COR.line);
            doc.roundedRect(cx - 1, y - 1, wImg + 2, hImg + 2, 3, 3, 'S');
            doc.addImage(f, formato, cx, y, wImg, hImg);
          } catch (e) {}
        });
        y += hImg + gap;
      }
    } else {
      doc.setFontSize(8.5); doc.setFont(undefined, 'italic'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text('Nenhuma foto anexada.', margem, y); y += 14;
    }
    y += 6;
  });

  tituloCentro('Pesquisa de satisfação');
  linhaCampos([{ label: 'Avaliação', valor: `${r.satisfacao_estrelas}/5 estrelas`, frac: 0.4 }, { label: 'Autoriza uso do feedback', valor: r.satisfacao_autoriza === 'sim' ? 'Sim' : 'Não', frac: 0.6 }]);
  if (r.satisfacao_comentario) linhaCampos([{ label: 'Comentário', valor: r.satisfacao_comentario, frac: 1 }]);
  y += 8;

  if (y > 560) novaPagina();
  tituloCentro('Assinaturas');
  {
    const wImg = 220, hImg = 90;
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    doc.text(limparPdf(`Cliente: ${r.assinatura_cliente_nome}`), margem, y);
    doc.text(limparPdf(`Técnico: ${r.assinatura_tecnico_nome}`), margem + largura / 2, y);
    y += 8;
    try { doc.addImage(r.assinatura_cliente_img, 'PNG', margem, y, wImg, hImg); } catch (e) {}
    try { doc.addImage(r.assinatura_tecnico_img, 'PNG', margem + largura / 2, y, wImg, hImg); } catch (e) {}
  }

  // ===== página de contato =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });
  doc.setFontSize(8); doc.setTextColor(...PDF_COR.inkSoft);
  doc.text(limparPdf(`Autor: ${r.autor_nome || '—'} · ${fmtData(r.criado_em)}`), pageW / 2, pageH - margem - 10, { align: 'center' });

  return doc.output('bloburl');
}

// ---------- CRIAR RELATÓRIO (manutenção interna, avulso — sem vínculo com O.S./agenda) ----------

// Relatório > Manual é um único relatório — o "Tipo de formulário" é escolhido dentro do próprio
// preenchimento (não numa tela separada): cada tipo continua com sua própria tela/função/
// validação/PDF já existentes (Completo, Preventiva, Corretiva, Relatório Técnico, Termo de
// Aceite); trocar o seletor só troca qual dessas telas aparece embaixo dele.
const TIPOS_RELATORIO_MANUAL = [
  { tipo: 'completo', label: 'Completo', fn: 'mostrarFormRelatorioManutencao' },
  { tipo: 'preventiva', label: 'Preventiva', fn: 'mostrarFormRelatorioPreventiva' },
  { tipo: 'corretiva', label: 'Corretiva', fn: 'mostrarFormRelatorioCorretiva' },
  { tipo: 'relatorio_tecnico', label: 'Relatório Técnico', fn: 'mostrarFormRelatorioTecnico' },
  { tipo: 'aceite_entrega', label: 'Termo de Aceite', fn: 'mostrarFormRelatorioAceite' },
];

function mostrarFormRelatorioManual(tipo) {
  const def = TIPOS_RELATORIO_MANUAL.find((t) => t.tipo === tipo) || TIPOS_RELATORIO_MANUAL[0];
  window[def.fn]();
  const seletorHtml = `
    <div class="panel">
      <label>Tipo de formulário</label>
      <select onchange="mostrarFormRelatorioManual(this.value)">
        ${TIPOS_RELATORIO_MANUAL.map((t) => `<option value="${t.tipo}" ${t.tipo === def.tipo ? 'selected' : ''}>${t.label}</option>`).join('')}
      </select>
      <p style="color:var(--ink-soft); font-size:12.5px; margin-top:6px;">Ao trocar o tipo, os campos abaixo mudam para os daquele formulário.</p>
    </div>`;
  const main = document.getElementById('main');
  const pageHead = main.querySelector('.page-head');
  if (pageHead) pageHead.insertAdjacentHTML('afterend', seletorHtml);
  else main.insertAdjacentHTML('afterbegin', seletorHtml);
}

async function renderRelatorioManutencao() {
  const { relatorios } = await api('/api/relatorios-manutencao/meus');
  window._relatoriosManutCache = relatorios;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Relatório</h1><p>Relatório de manutenção interna, avulso — sem vínculo com nenhuma O.S., fica salvo só aqui no seu histórico</p></div>
      <button class="btn btn-primary btn-sm" onclick="mostrarFormRelatorioManual()">+ Novo relatório</button>
    </div>
    <div class="panel"><table>
      <tr><th>Data</th><th>Descrição</th><th>Tipo</th><th></th></tr>
      ${relatorios.length ? relatorios.map((r, i) => `
        <tr>
          <td data-label="Data">${fmtData(r.criado_em)}</td>
          <td data-label="Descrição">${descricaoRelatorioManutencao(r)}</td>
          <td data-label="Tipo">${r.tipo === 'ficha' ? tag('Ficha', 'blue') : r.tipo === 'ciclagem' ? tag('Ciclagem', 'purple') : r.tipo === 'preventiva' ? tag('Preventiva', 'amber') : r.tipo === 'corretiva' ? tag('Corretiva', 'orange') : r.tipo === 'relatorio_tecnico' ? tag('Relatório Técnico', 'purple') : r.tipo === 'aceite_entrega' ? tag('Termo de Aceite', 'blue') : tag('Completo', 'green')}</td>
          <td class="td-acoes">
            <button class="btn-outline-sm" onclick="abrirPdfRelatorioManutencao(${i})">PDF</button>
            ${r.tipo !== 'ciclagem' && r.tipo !== 'aceite_entrega' ? `<button class="btn-outline-sm" onclick="abrirFotosRelatorioManutencao(${i})">Fotos</button>` : ''}
            ${r.tipo !== 'preventiva' && r.tipo !== 'corretiva' && r.tipo !== 'relatorio_tecnico' && r.tipo !== 'aceite_entrega' ? `<button class="btn-outline-sm" onclick="baixarWordRelatorioManutencao(${i})">Word</button>` : ''}
            <button class="btn-outline-sm" onclick="editarRelatorioManutencao(${i})">Editar</button>
            <button class="btn-outline-sm" onclick="excluirRelatorioManutencao(${r.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="4" class="empty">Nenhum relatório criado ainda.</td></tr>`}
    </table></div>`;
}

function descricaoRelatorioManutencao(r) {
  if (r.tipo === 'ficha') {
    const partes = (r.campos || []).slice(0, 2).map((c) => `${esc(c.campo)}: ${esc(c.valor)}`);
    return partes.length ? partes.join(' · ') : 'Ficha do equipamento';
  }
  if (r.tipo === 'ciclagem') {
    return `${esc(r.equipamento)} <span style="color:var(--ink-soft); font-size:12.5px;">(${esc(r.empresa)})</span>`;
  }
  if (r.tipo === 'preventiva' || r.tipo === 'corretiva' || r.tipo === 'aceite_entrega') {
    return `${esc(r.modelo_maquina)} <span style="color:var(--ink-soft); font-size:12.5px;">(${esc(r.empresa)})</span>`;
  }
  return `${esc(r.equipamento)}${r.marca ? ' — ' + esc(r.marca) : ''} <span style="color:var(--ink-soft); font-size:12.5px;">(${esc(r.empresa)})</span>`;
}

// tela "Automático" (Relatório > Automático): tira foto da etiqueta/placa do equipamento, manda
// pra IA ler os dados (mesmo se a etiqueta estiver em inglês, vem traduzido) e, com base neles,
// deixa escolher que tipo de relatório gerar: Levantamento de Estoque (Ficha do equipamento, como
// já era) ou Preventiva (Termo de Manutenção Preventiva, tentando já casar o modelo lido com um
// dos equipamentos cadastrados e — se o nº de série já estiver atrelado a um cliente — preenchendo
// os dados do cliente também).
function renderRelatorioAutomatico() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Automático</h1><p>Tire uma foto da etiqueta/placa de identificação do equipamento — a IA lê os dados e você escolhe que tipo de relatório gerar com eles.</p></div>
    <div class="panel" style="text-align:center;">
      <div id="ra-preview" style="margin-bottom:14px;"></div>
      <label class="photo-add" style="display:inline-flex;">
        <span class="plus">📷</span>Tirar foto da etiqueta
        <input type="file" accept="image/*" capture="environment" style="display:none" onchange="processarFotoEtiqueta(event)">
      </label>
      <div id="ra-status" style="margin-top:12px; color:var(--ink-soft); font-size:13px;"></div>
      <div id="ra-escolha" style="margin-top:16px;"></div>
    </div>`;
}

// guarda o resultado da última leitura de etiqueta nesta tela, pra alimentar qualquer um dos
// dois relatórios que o técnico escolher a seguir
let extraidoAutomatico = null;
async function processarFotoEtiqueta(event) {
  const arquivos = event.target.files;
  if (!arquivos || !arquivos.length) return;
  const [dataUrl] = await lerFotosComoDataUrl(arquivos);
  const preview = document.getElementById('ra-preview');
  const status = document.getElementById('ra-status');
  const escolha = document.getElementById('ra-escolha');
  if (preview) preview.innerHTML = `<img src="${dataUrl}" style="max-width:260px; border-radius:10px; border:1px solid var(--line);">`;
  if (status) status.textContent = 'Lendo a etiqueta...';
  if (escolha) escolha.innerHTML = '';
  try {
    const { extraido } = await api('/api/relatorios-manutencao/ler-etiqueta', { method: 'POST', body: { foto: dataUrl } });
    extraidoAutomatico = { campos: Array.isArray(extraido.campos) ? extraido.campos : [], foto: dataUrl };
    if (status) status.textContent = 'Etiqueta lida — escolha que relatório gerar com esses dados.';
    if (escolha) escolha.innerHTML = `
      <p style="font-weight:700; margin-bottom:10px;">Gerar relatório de:</p>
      <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="gerarPreventivaAutomatico()">Preventiva</button>
        <button class="btn-outline-sm" onclick="gerarCorretivaAutomatico()">Corretiva</button>
        <button class="btn-outline-sm" onclick="gerarTecnicoAutomatico()">Relatório Técnico</button>
        <button class="btn-outline-sm" onclick="gerarAceiteAutomatico()">Termo de Aceite</button>
        <button class="btn-outline-sm" onclick="gerarFichaAutomatico()">Levantamento de Estoque</button>
      </div>`;
  } catch (e) {
    if (status) status.textContent = 'Erro: ' + e.message;
  }
}

function gerarFichaAutomatico() {
  if (!extraidoAutomatico) return;
  const draft = fichaEquipamentoPadrao();
  draft.campos = extraidoAutomatico.campos;
  draft.fotos = [extraidoAutomatico.foto];
  mostrarFormFicha(draft);
  mostrarToast('Etiqueta lida — revise os dados antes de salvar.');
}

// tenta casar o campo de nº de série lido na etiqueta com um equipamento já atrelado a um
// cliente — se achar, pré-preenche o modelo (e o check-list/fotos certos, se for um dos modelos
// cadastrados) e os dados do cliente; se não achar, deixa tudo desbloqueado pro técnico preencher.
async function gerarPreventivaAutomatico() {
  if (!extraidoAutomatico) return;
  const campoSerie = extraidoAutomatico.campos.find((c) => /s[ée]rie/i.test(c.campo || ''));
  const numeroSerie = campoSerie ? String(campoSerie.valor || '').trim() : '';
  const draft = relatorioPreventivaPadrao();
  draft.numero_serie = numeroSerie;

  let equipamento = null, cliente = null;
  if (numeroSerie) {
    try {
      const resultado = await api(`/api/equipamentos/buscar-por-serie?numero_serie=${encodeURIComponent(numeroSerie)}`);
      equipamento = resultado.equipamento;
      cliente = resultado.cliente;
    } catch (e) { /* segue sem os dados de cliente/equipamento — técnico preenche na mão */ }
  }

  // identifica o modelo direto pelo que a própria etiqueta já diz (marca/modelo impressos nela,
  // lidos pela IA) — só recorre ao equipamento cadastrado (achado pelo nº de série) se a
  // etiqueta não deixar isso claro. Normaliza tirando espaço/hífen/ponto/underline antes de
  // comparar, pra "MP-5", "MP 5" e "MP5" darem o mesmo resultado.
  const nomesConhecidos = Object.keys(EQUIPAMENTOS_PREVENTIVA);
  function normalizarNomeEquipamento(s) { return String(s || '').toLowerCase().replace(/[\s\-_.]/g, ''); }
  function acharNomeConhecido(texto) {
    const t = normalizarNomeEquipamento(texto);
    if (!t) return null;
    return nomesConhecidos.find((nome) => normalizarNomeEquipamento(nome) === t)
      || nomesConhecidos.find((nome) => t.includes(normalizarNomeEquipamento(nome)));
  }
  let nomePreset = null;
  for (const campo of extraidoAutomatico.campos) {
    nomePreset = acharNomeConhecido(campo.valor);
    if (nomePreset) break;
  }
  const modeloCandidato = nomePreset || (equipamento && (equipamento.modelo || equipamento.tipo)) || '';
  if (!nomePreset && modeloCandidato) nomePreset = acharNomeConhecido(modeloCandidato);
  if (nomePreset) {
    const preset = EQUIPAMENTOS_PREVENTIVA[nomePreset];
    draft.modelo_maquina = nomePreset;
    draft.checklist = preset.checklist.map((item) => ({ item, resposta: '', observacao: '' }));
    draft.fotos = preset.fotos.map((label) => ({ comentario: label, fotos: [] }));
  } else {
    draft.modelo_maquina = modeloCandidato;
    draft.fotos = FOTOS_PREVENTIVA_GENERICO.map((label) => ({ comentario: label, fotos: [] }));
  }
  // a própria foto da etiqueta já cobre o primeiro grupo ("Etiqueta de NS do equipamento")
  if (draft.fotos[0]) draft.fotos[0].fotos.push(extraidoAutomatico.foto);

  if (cliente) {
    draft.empresa = cliente.nome_empresa || '';
    draft.endereco = cliente.endereco || '';
    draft.numero = cliente.numero || '';
    draft.bairro = cliente.bairro || '';
    draft.cidade = cliente.cidade || '';
    draft.estado = cliente.estado || '';
    draft.cep = cliente.cep || '';
    draft.setor_maquina = cliente.setor || '';
  }

  mostrarFormRelatorioPreventiva(draft);
  mostrarToast(cliente ? 'Etiqueta lida — cliente encontrado e dados preenchidos automaticamente.' : 'Etiqueta lida — complete os dados que faltam.');
}

// mesma lógica de casamento de modelo/cliente da Preventiva, só que sem check-list (a Corretiva
// não tem) — o modelo aqui só decide qual conjunto de grupos de fotos usar.
async function gerarCorretivaAutomatico() {
  if (!extraidoAutomatico) return;
  const campoSerie = extraidoAutomatico.campos.find((c) => /s[ée]rie/i.test(c.campo || ''));
  const numeroSerie = campoSerie ? String(campoSerie.valor || '').trim() : '';
  const draft = relatorioCorretivaPadrao();
  draft.numero_serie = numeroSerie;

  let equipamento = null, cliente = null;
  if (numeroSerie) {
    try {
      const resultado = await api(`/api/equipamentos/buscar-por-serie?numero_serie=${encodeURIComponent(numeroSerie)}`);
      equipamento = resultado.equipamento;
      cliente = resultado.cliente;
    } catch (e) { /* segue sem os dados de cliente/equipamento — técnico preenche na mão */ }
  }

  const nomesConhecidos = Object.keys(EQUIPAMENTOS_PREVENTIVA);
  function normalizarNomeEquipamento(s) { return String(s || '').toLowerCase().replace(/[\s\-_.]/g, ''); }
  function acharNomeConhecido(texto) {
    const t = normalizarNomeEquipamento(texto);
    if (!t) return null;
    return nomesConhecidos.find((nome) => normalizarNomeEquipamento(nome) === t)
      || nomesConhecidos.find((nome) => t.includes(normalizarNomeEquipamento(nome)));
  }
  let nomePreset = null;
  for (const campo of extraidoAutomatico.campos) {
    nomePreset = acharNomeConhecido(campo.valor);
    if (nomePreset) break;
  }
  const modeloCandidato = nomePreset || (equipamento && (equipamento.modelo || equipamento.tipo)) || '';
  if (!nomePreset && modeloCandidato) nomePreset = acharNomeConhecido(modeloCandidato);
  if (nomePreset) {
    draft.modelo_maquina = nomePreset;
    draft.fotos = EQUIPAMENTOS_PREVENTIVA[nomePreset].fotos.map((label) => ({ comentario: label, fotos: [] }));
  } else {
    draft.modelo_maquina = modeloCandidato;
    draft.fotos = FOTOS_PREVENTIVA_GENERICO.map((label) => ({ comentario: label, fotos: [] }));
  }
  if (draft.fotos[0]) draft.fotos[0].fotos.push(extraidoAutomatico.foto);

  if (cliente) {
    draft.empresa = cliente.nome_empresa || '';
    draft.endereco = cliente.endereco || '';
    draft.numero = cliente.numero || '';
    draft.bairro = cliente.bairro || '';
    draft.cidade = cliente.cidade || '';
    draft.estado = cliente.estado || '';
    draft.cep = cliente.cep || '';
    draft.setor_maquina = cliente.setor || '';
  }

  mostrarFormRelatorioCorretiva(draft);
  mostrarToast(cliente ? 'Etiqueta lida — cliente encontrado e dados preenchidos automaticamente.' : 'Etiqueta lida — complete os dados que faltam.');
}

// mesma lógica de casamento de modelo/cliente da Preventiva/Corretiva, adaptada pro Relatório
// Técnico: sem checklist e sem grupos de fotos — a foto da etiqueta já entra como a primeira foto
// do relatório fotográfico único, e "Marca" é preenchida se a própria etiqueta tiver esse campo.
async function gerarTecnicoAutomatico() {
  if (!extraidoAutomatico) return;
  const campoSerie = extraidoAutomatico.campos.find((c) => /s[ée]rie/i.test(c.campo || ''));
  const numeroSerie = campoSerie ? String(campoSerie.valor || '').trim() : '';
  const campoMarca = extraidoAutomatico.campos.find((c) => /marca/i.test(c.campo || ''));
  const draft = relatorioTecnicoPadrao();
  draft.numero_serie = numeroSerie;
  if (campoMarca) draft.marca = String(campoMarca.valor || '').trim();

  let equipamento = null, cliente = null;
  if (numeroSerie) {
    try {
      const resultado = await api(`/api/equipamentos/buscar-por-serie?numero_serie=${encodeURIComponent(numeroSerie)}`);
      equipamento = resultado.equipamento;
      cliente = resultado.cliente;
    } catch (e) { /* segue sem os dados de cliente/equipamento — técnico preenche na mão */ }
  }

  const nomesConhecidos = Object.keys(EQUIPAMENTOS_PREVENTIVA);
  function normalizarNomeEquipamento(s) { return String(s || '').toLowerCase().replace(/[\s\-_.]/g, ''); }
  function acharNomeConhecido(texto) {
    const t = normalizarNomeEquipamento(texto);
    if (!t) return null;
    return nomesConhecidos.find((nome) => normalizarNomeEquipamento(nome) === t)
      || nomesConhecidos.find((nome) => t.includes(normalizarNomeEquipamento(nome)));
  }
  let nomePreset = null;
  for (const campo of extraidoAutomatico.campos) {
    nomePreset = acharNomeConhecido(campo.valor);
    if (nomePreset) break;
  }
  const modeloCandidato = nomePreset || (equipamento && (equipamento.modelo || equipamento.tipo)) || '';
  if (!nomePreset && modeloCandidato) nomePreset = acharNomeConhecido(modeloCandidato);
  draft.equipamento = nomePreset || modeloCandidato;
  draft.data_fabricacao = (equipamento && equipamento.data_fabricacao) || '';
  draft.fotos.push(extraidoAutomatico.foto);

  if (cliente) {
    draft.empresa = cliente.nome_empresa || '';
    draft.contato = cliente.contato || '';
    draft.telefone = cliente.telefone || '';
  }

  mostrarFormRelatorioTecnico(draft);
  mostrarToast(cliente ? 'Etiqueta lida — cliente encontrado e dados preenchidos automaticamente.' : 'Etiqueta lida — complete os dados que faltam.');
}

// mesma lógica de casamento de modelo/cliente das demais — adaptada pro Termo de Aceite: sem
// fotos e com os campos próprios do cliente (setor/contato, sem telefone).
async function gerarAceiteAutomatico() {
  if (!extraidoAutomatico) return;
  const campoSerie = extraidoAutomatico.campos.find((c) => /s[ée]rie/i.test(c.campo || ''));
  const numeroSerie = campoSerie ? String(campoSerie.valor || '').trim() : '';
  const draft = relatorioAceitePadrao();
  draft.numero_serie = numeroSerie;

  let equipamento = null, cliente = null;
  if (numeroSerie) {
    try {
      const resultado = await api(`/api/equipamentos/buscar-por-serie?numero_serie=${encodeURIComponent(numeroSerie)}`);
      equipamento = resultado.equipamento;
      cliente = resultado.cliente;
    } catch (e) { /* segue sem os dados de cliente/equipamento — técnico preenche na mão */ }
  }

  const nomesConhecidos = Object.keys(EQUIPAMENTOS_PREVENTIVA);
  function normalizarNomeEquipamento(s) { return String(s || '').toLowerCase().replace(/[\s\-_.]/g, ''); }
  function acharNomeConhecido(texto) {
    const t = normalizarNomeEquipamento(texto);
    if (!t) return null;
    return nomesConhecidos.find((nome) => normalizarNomeEquipamento(nome) === t)
      || nomesConhecidos.find((nome) => t.includes(normalizarNomeEquipamento(nome)));
  }
  let nomePreset = null;
  for (const campo of extraidoAutomatico.campos) {
    nomePreset = acharNomeConhecido(campo.valor);
    if (nomePreset) break;
  }
  const modeloCandidato = nomePreset || (equipamento && (equipamento.modelo || equipamento.tipo)) || '';
  if (!nomePreset && modeloCandidato) nomePreset = acharNomeConhecido(modeloCandidato);
  draft.modelo_maquina = nomePreset || modeloCandidato;

  if (cliente) {
    draft.empresa = cliente.nome_empresa || '';
    draft.setor = cliente.setor || '';
    draft.endereco = cliente.endereco || '';
    draft.numero = cliente.numero || '';
    draft.bairro = cliente.bairro || '';
    draft.estado = cliente.estado || '';
    draft.cidade = cliente.cidade || '';
    draft.cep = cliente.cep || '';
    draft.contato = cliente.contato || '';
  }

  mostrarFormRelatorioAceite(draft);
  mostrarToast(cliente ? 'Etiqueta lida — cliente encontrado e dados preenchidos automaticamente.' : 'Etiqueta lida — complete os dados que faltam.');
}

// ---------- Ficha do equipamento (relatório enxuto: só o que a etiqueta tem + condição + fotos) ----------

let fichaDraft = null;
function fichaEquipamentoPadrao() {
  return { tipo: 'ficha', condicao: '', campos: [], fotos: [] };
}

function mostrarFormFicha(existente) {
  fichaDraft = existente ? JSON.parse(JSON.stringify(existente)) : fichaEquipamentoPadrao();
  const d = fichaDraft;
  const editando = !!d.id;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar ficha do equipamento' : 'Ficha do equipamento'}</h1><p>Dados lidos da etiqueta — revise, ajuste ou adicione campos, e confirme a condição antes de salvar.</p></div>

    <div class="panel">
      <h2>Condição do equipamento*</h2>
      <div style="display:flex; gap:18px; flex-wrap:wrap;">
        ${[['novo', 'Novo'], ['usado', 'Usado']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="fc-condicao" value="${v}" style="width:auto;" ${d.condicao === v ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
    </div>

    <div class="panel">
      <h2>Dados da etiqueta</h2>
      <div class="steps-list" id="fc-campos"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarCampoFicha()">+ Adicionar campo</button>
    </div>

    <div class="panel">
      <h2>Fotos*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Foto da etiqueta e/ou do equipamento.</p>
      <div class="step-photos" id="fc-fotos"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">📷</span>Câmera
          <input type="file" accept="image/*" capture="environment" style="display:none" onchange="adicionarFotosFicha(event)">
        </label>
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">+</span>Galeria
          <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosFicha(event)">
        </label>
      </div>
    </div>

    <div class="panel">
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="renderRelatorioManutencao()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="salvarFicha()">Gerar PDF e salvar</button>
      </div>
    </div>`;
  renderCamposFicha();
  renderFotosFicha();
}

function renderCamposFicha() {
  document.getElementById('fc-campos').innerHTML = fichaDraft.campos.map((c, i) => `
    <div class="step-item">
      <div class="step-main">
        <div class="step-num">${i + 1}</div>
        <input placeholder="Campo (ex: Potência)" value="${esc(c.campo || '')}" style="flex:1;" oninput="fichaDraft.campos[${i}].campo=this.value;">
        <input placeholder="Valor" value="${esc(c.valor || '')}" style="flex:1;" oninput="fichaDraft.campos[${i}].valor=this.value;">
        <button class="step-rm" onclick="removerCampoFicha(${i})">×</button>
      </div>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhum campo lido — adicione manualmente se precisar.</p>';
}
function adicionarCampoFicha() { fichaDraft.campos.push({ campo: '', valor: '' }); renderCamposFicha(); }
function removerCampoFicha(i) { fichaDraft.campos.splice(i, 1); renderCamposFicha(); }

function renderFotosFicha() {
  document.getElementById('fc-fotos').innerHTML = fichaDraft.fotos.map((f, j) => `
    <div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do equipamento">
      <button class="photo-rm" onclick="removerFotoFicha(${j})">×</button>
    </div>`).join('');
}
function removerFotoFicha(j) { fichaDraft.fotos.splice(j, 1); renderFotosFicha(); }
function adicionarFotosFicha(event) {
  lerFotosComoDataUrl(event.target.files || []).then((dataUrls) => {
    fichaDraft.fotos.push(...dataUrls);
    renderFotosFicha();
  });
}

async function salvarFicha() {
  const d = fichaDraft;
  const condicao = document.querySelector('input[name="fc-condicao"]:checked');
  d.condicao = condicao ? condicao.value : '';
  if (!d.condicao) { alert('Marque se o equipamento é Novo ou Usado.'); return; }
  if (!d.fotos.length) { alert('Adicione ao menos uma foto (da etiqueta ou do equipamento).'); return; }
  try {
    const { relatorio } = d.id
      ? await api(`/api/relatorios-manutencao/${d.id}`, { method: 'PUT', body: d })
      : await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfFichaEquipamento(relatorio, logo);
    window.open(url, '_blank');
    mostrarToast(d.id ? 'Ficha atualizada e PDF gerado.' : 'Ficha salva e PDF gerado.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

// ---------- Ensaio de Ciclagem (tryout: ciclos de teste com amostras OK/com desvio) ----------

let ciclagemDraft = null;
function ensaioCiclagemPadrao() {
  return { tipo: 'ciclagem', empresa: '', equipamento: '', data_conclusao: '', mtbf_encontrado: '', resultado_ensaio: '', ciclos: [], conclusao_ensaio: '' };
}

function mostrarFormCiclagem(existente) {
  ciclagemDraft = existente ? JSON.parse(JSON.stringify(existente)) : ensaioCiclagemPadrao();
  const d = ciclagemDraft;
  const editando = !!d.id;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar' : 'Novo'} Ensaio de Ciclagem</h1><p>Ciclos de teste (tryout) — amostras OK e com desvio por ciclo. Campos com * são obrigatórios.</p></div>

    <div class="panel">
      <h2>Dados gerais</h2>
      <div class="form-grid">
        <div><label>Cliente*</label><input id="ec-empresa" value="${esc(d.empresa)}"></div>
        <div><label>Equipamento*</label><input id="ec-equipamento" value="${esc(d.equipamento)}"></div>
        <div><label>Data</label><input id="ec-data" type="date" value="${esc(d.data_conclusao)}"></div>
        <div><label>MTBF encontrado</label><input id="ec-mtbf" placeholder="ex: N/A" value="${esc(d.mtbf_encontrado)}"></div>
      </div>
      <p style="color:var(--ink-soft); font-size:12px; margin-top:-6px;">MTBF = tempo médio entre falhas. Cálculo: (tempo total de funcionamento − tempo perdido) / número total de falhas.</p>
      <label>Resultado do ensaio*</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap;">
        ${[['aprovado', 'Aprovado'], ['reprovado', 'Reprovado']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="ec-resultado" value="${v}" style="width:auto;" ${d.resultado_ensaio === v ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
    </div>

    <div class="panel">
      <h2>Ciclos*</h2>
      <div id="ec-ciclos"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarCicloEnsaio()">+ Adicionar ciclo</button>
    </div>

    <div class="panel">
      <h2>Resumo</h2>
      <div id="ec-resumo"></div>
    </div>

    <div class="panel">
      <h2>Conclusão</h2>
      <input id="ec-conclusao" placeholder="ex: OK" value="${esc(d.conclusao_ensaio)}">
    </div>

    <div class="panel">
      <h2>Responsável</h2>
      <div class="form-grid">
        <div><label>Nome</label><input value="${esc(USER.nome)}" disabled></div>
        <div><label>Cargo</label><input value="${esc(USER.cargo || '')}" disabled></div>
        <div><label>Setor</label><input value="${esc(USER.setor || '')}" disabled></div>
      </div>
    </div>

    <div class="panel">
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="renderRelatorioManutencao()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="salvarCiclagem()">Gerar PDF e salvar</button>
      </div>
    </div>`;
  renderCiclosEnsaio();
}

function renderCiclosEnsaio() {
  const alvo = document.getElementById('ec-ciclos');
  if (!alvo) return;
  alvo.innerHTML = ciclagemDraft.ciclos.map((c, i) => {
    const ok = Number(c.qtd_ok) || 0, desvio = Number(c.qtd_desvio) || 0;
    const avaliadas = ok + desvio;
    const percentual = avaliadas ? ((desvio / avaliadas) * 100).toFixed(2) : '0.00';
    return `
    <div class="panel" style="background:var(--blue-pale-2); margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <b>Ciclo ${i + 1}</b>
        <button class="step-rm" onclick="removerCicloEnsaio(${i})">×</button>
      </div>
      <div class="form-grid">
        <div><label>Tipo de amostra</label><input value="${esc(c.tipo_amostra)}" oninput="ciclagemDraft.ciclos[${i}].tipo_amostra=this.value;"></div>
        <div><label>Quantidade</label><input value="${esc(c.quantidade)}" oninput="ciclagemDraft.ciclos[${i}].quantidade=this.value;"></div>
        <div><label>Hora inicial</label><input type="time" value="${esc(c.hora_inicial)}" oninput="ciclagemDraft.ciclos[${i}].hora_inicial=this.value;"></div>
        <div><label>Hora final</label><input type="time" value="${esc(c.hora_final)}" oninput="ciclagemDraft.ciclos[${i}].hora_final=this.value;"></div>
        <div><label>Amostras OK</label><input type="number" min="0" value="${ok}" onchange="ciclagemDraft.ciclos[${i}].qtd_ok=this.value; renderCiclosEnsaio();"></div>
        <div><label>Amostras com desvio</label><input type="number" min="0" value="${desvio}" onchange="ciclagemDraft.ciclos[${i}].qtd_desvio=this.value; renderCiclosEnsaio();"></div>
      </div>
      <div class="form-grid">
        <div class="full"><label>Descrição do(s) desvio(s)</label><input value="${esc(c.descricao_desvio)}" oninput="ciclagemDraft.ciclos[${i}].descricao_desvio=this.value;"></div>
      </div>
      <p style="font-size:12.5px; color:var(--ink-soft); margin:4px 0 0;">Percentual de desvio: <b>${percentual}%</b></p>
    </div>`;
  }).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhum ciclo adicionado ainda.</p>';
  renderResumoEnsaio();
}
function adicionarCicloEnsaio() {
  ciclagemDraft.ciclos.push({ tipo_amostra: '', quantidade: '', hora_inicial: '', hora_final: '', qtd_ok: 0, qtd_desvio: 0, descricao_desvio: '' });
  renderCiclosEnsaio();
}
function removerCicloEnsaio(i) { ciclagemDraft.ciclos.splice(i, 1); renderCiclosEnsaio(); }

function renderResumoEnsaio() {
  const alvo = document.getElementById('ec-resumo');
  if (!alvo) return;
  const totais = totaisEnsaioCiclagem(ciclagemDraft);
  alvo.innerHTML = `
    <div class="form-grid">
      <div><label>Total de ciclos</label><input value="${totais.totalCiclos}" disabled></div>
      <div><label>Amostras avaliadas</label><input value="${totais.avaliadas}" disabled></div>
      <div><label>Amostras aprovadas (OK)</label><input value="${totais.ok}" disabled></div>
      <div><label>Amostras reprovadas (desvio)</label><input value="${totais.desvio}" disabled></div>
      <div><label>% de reprovação</label><input value="${totais.percentual}%" disabled></div>
    </div>`;
}

// soma os ciclos pra tirar os totais — usado na tela, no PDF e no Word, sempre a partir dos
// ciclos de verdade (nunca fica um total "solto" desatualizado se algum ciclo mudar depois).
function totaisEnsaioCiclagem(r) {
  const ciclos = r.ciclos || [];
  let ok = 0, desvio = 0;
  ciclos.forEach((c) => { ok += Number(c.qtd_ok) || 0; desvio += Number(c.qtd_desvio) || 0; });
  const avaliadas = ok + desvio;
  const percentual = avaliadas ? ((desvio / avaliadas) * 100).toFixed(2) : '0.00';
  return { totalCiclos: ciclos.length, ok, desvio, avaliadas, percentual };
}

async function salvarCiclagem() {
  const d = ciclagemDraft;
  d.empresa = document.getElementById('ec-empresa').value;
  d.equipamento = document.getElementById('ec-equipamento').value;
  d.data_conclusao = document.getElementById('ec-data').value;
  d.mtbf_encontrado = document.getElementById('ec-mtbf').value;
  const resultado = document.querySelector('input[name="ec-resultado"]:checked');
  d.resultado_ensaio = resultado ? resultado.value : '';
  d.conclusao_ensaio = document.getElementById('ec-conclusao').value;

  if (!d.empresa.trim() || !d.equipamento.trim()) { alert('Preencha ao menos Cliente e Equipamento.'); return; }
  if (!d.resultado_ensaio) { alert('Marque o resultado do ensaio (Aprovado ou Reprovado).'); return; }
  if (!d.ciclos.length) { alert('Adicione ao menos um ciclo.'); return; }

  try {
    const { relatorio } = d.id
      ? await api(`/api/relatorios-manutencao/${d.id}`, { method: 'PUT', body: d })
      : await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfEnsaioCiclagem(relatorio, logo);
    window.open(url, '_blank');
    mostrarToast(d.id ? 'Ensaio atualizado e PDF gerado.' : 'Ensaio salvo e PDF gerado.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

let relatorioManutDraft = null;
function relatorioManutPadrao() {
  return {
    empresa: '', contato: '', telefone: '',
    tipo_servico: '', tipo_servico_outros: '',
    marca: '', equipamento: '', numero_serie: '',
    condicao: '',
    garantia: '', garantia_obs: '',
    data_fabricacao: '',
    acessorios: '', defeito_informado: '',
    data_entrada: '', data_conclusao: '',
    laudo_tecnico: '', servico_realizado: '',
    pecas: [],
    // cada bloco é um grupo de fotos + um comentário (com negrito/itálico/cor/fonte) sobre elas
    fotos: [],
  };
}

function mostrarFormRelatorioManutencao(existente) {
  relatorioManutDraft = existente ? JSON.parse(JSON.stringify(existente)) : relatorioManutPadrao();
  const d = relatorioManutDraft;
  const editando = !!d.id;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar relatório' : 'Novo relatório'} — Manutenção interna</h1><p>Preencha os dados abaixo. Ao gerar, o PDF fica disponível e o relatório é salvo no seu histórico. Campos com * são obrigatórios.</p></div>

    <div class="panel">
      <h2>Dados do cliente</h2>
      <div class="form-grid">
        <div class="full"><label>Empresa*</label><input id="rm-empresa" value="${esc(d.empresa)}"></div>
        <div><label>Contato</label><input id="rm-contato" value="${esc(d.contato)}"></div>
        <div><label>Telefone</label><input id="rm-telefone" value="${esc(d.telefone)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Tipo de serviço</h2>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        ${[['amostra', 'Amostra'], ['analise', 'Análise'], ['preventiva', 'Preventiva'], ['corretiva', 'Corretiva'], ['outros', 'Outros']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rm-tipo-servico" value="${v}" style="width:auto;" ${d.tipo_servico === v ? 'checked' : ''} onchange="document.getElementById('rm-tipo-outros-wrap').style.display = this.value === 'outros' ? 'block' : 'none';"> ${l}</label>`).join('')}
      </div>
      <div id="rm-tipo-outros-wrap" style="display:${d.tipo_servico === 'outros' ? 'block' : 'none'};"><label>Especifique</label><input id="rm-tipo-servico-outros" value="${esc(d.tipo_servico_outros)}"></div>
    </div>

    <div class="panel">
      <h2>Dados do equipamento</h2>
      <div class="form-grid">
        <div><label>Marca</label><input id="rm-marca" value="${esc(d.marca)}"></div>
        <div><label>Equipamento*</label><input id="rm-equipamento" value="${esc(d.equipamento)}"></div>
        <div><label>Nº de série</label><input id="rm-numero_serie" value="${esc(d.numero_serie)}"></div>
        <div><label>Data de fabricação (MM/AAAA)</label><input id="rm-data_fabricacao" placeholder="MM/AAAA" maxlength="7" value="${esc(d.data_fabricacao)}"></div>
      </div>
      <label>Condição do equipamento</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        ${[['novo', 'Novo'], ['usado', 'Usado']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rm-condicao" value="${v}" style="width:auto;" ${d.condicao === v ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
      <label>Garantia</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        ${[['sim', 'Sim'], ['nao', 'Não'], ['outros', 'Outros']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rm-garantia" value="${v}" style="width:auto;" ${d.garantia === v ? 'checked' : ''} onchange="document.getElementById('rm-garantia-outros-wrap').style.display = this.value === 'outros' ? 'block' : 'none';"> ${l}</label>`).join('')}
      </div>
      <div id="rm-garantia-outros-wrap" style="display:${d.garantia === 'outros' ? 'block' : 'none'};"><label>Especifique</label><input id="rm-garantia_obs" value="${esc(d.garantia_obs)}"></div>
      <div class="form-grid">
        <div class="full"><label>Acessórios recebidos</label><input id="rm-acessorios" placeholder="ex: cabo de força, fonte..." value="${esc(d.acessorios)}"></div>
        <div class="full"><label>Defeito informado</label><input id="rm-defeito_informado" value="${esc(d.defeito_informado)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Técnico responsável</h2>
      <div class="form-grid">
        <div><label>Nome</label><input value="${esc(USER.nome)}" disabled></div>
        <div><label>E-mail</label><input value="${esc(USER.email || '')}" disabled></div>
        <div><label>Data de entrada</label><input id="rm-data_entrada" type="date" value="${esc(d.data_entrada)}"></div>
        <div><label>Data de conclusão</label><input id="rm-data_conclusao" type="date" value="${esc(d.data_conclusao)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Laudo técnico</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Defeito encontrado e análise do estado do equipamento</p>
      <textarea id="rm-laudo_tecnico" placeholder="Descreva o diagnóstico...">${esc(d.laudo_tecnico)}</textarea>
    </div>

    <div class="panel">
      <h2>Serviços realizados</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Manutenção realizada / resultados de amostra</p>
      <textarea id="rm-servico_realizado" placeholder="Descreva o que foi feito...">${esc(d.servico_realizado)}</textarea>
    </div>

    <div class="panel">
      <h2>Peças fornecidas</h2>
      <div class="steps-list" id="rm-pecas"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarPecaRelatorioManut()">+ Adicionar peça</button>
    </div>

    <div class="panel">
      <h2>Relatório fotográfico</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Anexe uma ou mais fotos e escreva um comentário sobre elas — o comentário aparece embaixo das fotos no PDF. Clique em "+ Adicionar" pra criar outro grupo de fotos com outro comentário.</p>
      <div id="rm-blocos-fotos"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarBlocoFotoRelatorioManut()">+ Adicionar fotos e comentário</button>
    </div>

    <div class="panel">
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="renderRelatorioManutencao()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="salvarRelatorioManutencao()">Gerar PDF e salvar</button>
      </div>
    </div>`;
  renderPecasRelatorioManut();
  renderBlocosFotosRelatorioManut();
}

function renderPecasRelatorioManut() {
  document.getElementById('rm-pecas').innerHTML = relatorioManutDraft.pecas.map((p, i) => `
    <div class="step-item">
      <div class="step-main">
        <div class="step-num">${i + 1}</div>
        <input placeholder="Descrição da peça" value="${esc(p.descricao || '')}" style="flex:2;" oninput="relatorioManutDraft.pecas[${i}].descricao=this.value;">
        <input placeholder="Código PMK" value="${esc(p.codigo_pmk || '')}" style="flex:1;" oninput="relatorioManutDraft.pecas[${i}].codigo_pmk=this.value;">
        <input placeholder="Qtd" value="${esc(p.quantidade || '')}" style="flex:0 0 60px;" oninput="relatorioManutDraft.pecas[${i}].quantidade=this.value;">
        <button class="step-rm" onclick="removerPecaRelatorioManut(${i})">×</button>
      </div>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhuma peça adicionada.</p>';
}
function adicionarPecaRelatorioManut() { relatorioManutDraft.pecas.push({ descricao: '', codigo_pmk: '', quantidade: '' }); renderPecasRelatorioManut(); }
function removerPecaRelatorioManut(i) { relatorioManutDraft.pecas.splice(i, 1); renderPecasRelatorioManut(); }

// "Relatório fotográfico" em blocos: cada bloco tem suas fotos + um comentário de texto rico
// (negrito/itálico/sublinhado/cor/fonte) que aparece embaixo delas no PDF — igual pedido pelo
// usuário, no molde do que já existe nos passos do Manual de Procedimentos da biblioteca.
function renderBlocosFotosRelatorioManut() {
  const alvo = document.getElementById('rm-blocos-fotos');
  if (!alvo) return;
  alvo.innerHTML = relatorioManutDraft.fotos.map((bloco, i) => `
    <div class="rm-bloco-foto">
      <div class="step-photos">
        ${(bloco.fotos || []).map((f, j) => `
          <div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do relatório">
            <button class="photo-rm" onclick="removerFotoDoBlocoRelatorioManut(${i}, ${j})">×</button>
          </div>`).join('')}
      </div>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">📷</span>Câmera
          <input type="file" accept="image/*" capture="environment" style="display:none" onchange="adicionarFotosNoBlocoRelatorioManut(event, ${i})">
        </label>
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">+</span>Galeria
          <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosNoBlocoRelatorioManut(event, ${i})">
        </label>
      </div>
      <div class="rt-toolbar">
        <button type="button" onmousedown="event.preventDefault();" onclick="rtExecRelatorioManut(${i}, 'bold')" title="Negrito"><b>B</b></button>
        <button type="button" onmousedown="event.preventDefault();" onclick="rtExecRelatorioManut(${i}, 'italic')" title="Itálico"><i>I</i></button>
        <button type="button" onmousedown="event.preventDefault();" onclick="rtExecRelatorioManut(${i}, 'underline')" title="Sublinhado"><u>S</u></button>
        <input type="color" title="Cor da fonte" onchange="rtCorRelatorioManut(${i}, this.value)">
        <select title="Fonte" onchange="rtFonteRelatorioManut(${i}, this.value)">
          <option value="helvetica">Fonte padrão</option>
          <option value="times">Fonte serifada</option>
          <option value="courier">Fonte monoespaçada</option>
        </select>
        <button type="button" class="rt-rm" onclick="removerBlocoFotoRelatorioManut(${i})" title="Remover este grupo de fotos">Remover grupo</button>
      </div>
      <div class="rt-editor" id="rm-comentario-${i}" contenteditable="true" data-placeholder="Comente essa(s) foto(s)..." oninput="relatorioManutDraft.fotos[${i}].comentario = this.innerHTML;">${bloco.comentario || ''}</div>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhuma foto adicionada ainda.</p>';
}
function adicionarBlocoFotoRelatorioManut() {
  relatorioManutDraft.fotos.push({ comentario: '', fotos: [] });
  renderBlocosFotosRelatorioManut();
}
function removerBlocoFotoRelatorioManut(i) {
  relatorioManutDraft.fotos.splice(i, 1);
  renderBlocosFotosRelatorioManut();
}
function adicionarFotosNoBlocoRelatorioManut(event, i) {
  lerFotosComoDataUrl(event.target.files || []).then((dataUrls) => {
    relatorioManutDraft.fotos[i].fotos.push(...dataUrls);
    renderBlocosFotosRelatorioManut();
  });
}
function removerFotoDoBlocoRelatorioManut(i, j) {
  relatorioManutDraft.fotos[i].fotos.splice(j, 1);
  renderBlocosFotosRelatorioManut();
}
// comandos de formatação do comentário — usa o próprio editor contenteditable do navegador
// (mesma técnica usada em qualquer editor de texto simples embutido numa página).
// como o seletor de cor nativo (<input type=color>) rouba o foco do editor ao abrir, guarda-se
// continuamente a última seleção de texto feita dentro de cada editor pra poder restaurá-la
// antes de aplicar a cor/fonte — senão o texto selecionado "some" e o comando não pega em nada.
window._rtUltimaSelecao = window._rtUltimaSelecao || {};
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const no = range.commonAncestorContainer;
  const el = no.nodeType === 1 ? no : no.parentElement;
  const editor = el && el.closest && el.closest('.rt-editor');
  if (editor && editor.id.startsWith('rm-comentario-')) {
    window._rtUltimaSelecao[editor.id] = range.cloneRange();
  }
});
function rtRestaurarSelecao(idEditor) {
  const range = window._rtUltimaSelecao[idEditor];
  if (!range) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
function rtExecRelatorioManut(i, comando) {
  document.getElementById(`rm-comentario-${i}`).focus();
  document.execCommand(comando, false, null);
  relatorioManutDraft.fotos[i].comentario = document.getElementById(`rm-comentario-${i}`).innerHTML;
}
function rtCorRelatorioManut(i, cor) {
  const editor = document.getElementById(`rm-comentario-${i}`);
  editor.focus();
  rtRestaurarSelecao(editor.id);
  document.execCommand('foreColor', false, cor);
  relatorioManutDraft.fotos[i].comentario = editor.innerHTML;
}
function rtFonteRelatorioManut(i, fonte) {
  const editor = document.getElementById(`rm-comentario-${i}`);
  editor.focus();
  rtRestaurarSelecao(editor.id);
  document.execCommand('fontName', false, fonte);
  relatorioManutDraft.fotos[i].comentario = editor.innerHTML;
}

// interpreta o HTML simples do comentário (negrito/itálico/sublinhado/cor/fonte) em uma lista de
// palavras com seu estilo — usada tanto pra desenhar no PDF quanto reaproveitável no futuro.
function extrairPalavrasComEstilo(html) {
  const raiz = document.createElement('div');
  raiz.innerHTML = html || '';
  const palavras = [];
  function estiloEfetivo(no, herdado) {
    const estilo = { ...herdado };
    if (no.nodeType !== 1) return estilo;
    const tag = no.tagName.toLowerCase();
    if (tag === 'b' || tag === 'strong') estilo.negrito = true;
    if (tag === 'i' || tag === 'em') estilo.italico = true;
    if (tag === 'u') estilo.sublinhado = true;
    if (tag === 'font') {
      if (no.getAttribute('color')) estilo.cor = no.getAttribute('color');
      if (no.getAttribute('face')) estilo.fonte = no.getAttribute('face');
    }
    if (no.style) {
      if (no.style.color) estilo.cor = no.style.color;
      if (no.style.fontFamily) estilo.fonte = no.style.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const peso = no.style.fontWeight;
      if (peso === 'bold' || (peso && Number(peso) >= 700)) estilo.negrito = true;
      if (no.style.fontStyle === 'italic') estilo.italico = true;
      if (no.style.textDecorationLine === 'underline' || no.style.textDecoration.includes('underline')) estilo.sublinhado = true;
    }
    return estilo;
  }
  function caminhar(no, estilo) {
    if (no.nodeType === 3) {
      no.textContent.split(/(\s+)/).forEach((parte) => { if (parte.trim()) palavras.push({ texto: parte, ...estilo }); });
      return;
    }
    if (no.nodeType !== 1) return;
    if (no.tagName === 'BR') { palavras.push({ quebra: true }); return; }
    const novoEstilo = estiloEfetivo(no, estilo);
    Array.from(no.childNodes).forEach((filho) => caminhar(filho, novoEstilo));
    if (no.tagName === 'DIV' || no.tagName === 'P') palavras.push({ quebra: true });
  }
  Array.from(raiz.childNodes).forEach((no) => caminhar(no, { negrito: false, italico: false, sublinhado: false, cor: null, fonte: null }));
  while (palavras.length && palavras[palavras.length - 1].quebra) palavras.pop();
  return palavras;
}
// normaliza qualquer cor CSS (nome, hex, rgb(...)) pra um trio [r,g,b] usável no jsPDF
function corCssParaRgb(cor) {
  if (!cor) return null;
  const provisorio = document.createElement('div');
  provisorio.style.color = cor;
  document.body.appendChild(provisorio);
  const computada = getComputedStyle(provisorio).color;
  document.body.removeChild(provisorio);
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(computada);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

async function salvarRelatorioManutencao() {
  const d = relatorioManutDraft;
  d.empresa = document.getElementById('rm-empresa').value;
  d.contato = document.getElementById('rm-contato').value;
  d.telefone = document.getElementById('rm-telefone').value;
  const tipoServico = document.querySelector('input[name="rm-tipo-servico"]:checked');
  d.tipo_servico = tipoServico ? tipoServico.value : '';
  d.tipo_servico_outros = document.getElementById('rm-tipo-servico-outros').value;
  d.marca = document.getElementById('rm-marca').value;
  d.equipamento = document.getElementById('rm-equipamento').value;
  d.numero_serie = document.getElementById('rm-numero_serie').value;
  d.data_fabricacao = document.getElementById('rm-data_fabricacao').value;
  const condicao = document.querySelector('input[name="rm-condicao"]:checked');
  d.condicao = condicao ? condicao.value : '';
  const garantia = document.querySelector('input[name="rm-garantia"]:checked');
  d.garantia = garantia ? garantia.value : '';
  d.garantia_obs = document.getElementById('rm-garantia_obs').value;
  d.acessorios = document.getElementById('rm-acessorios').value;
  d.defeito_informado = document.getElementById('rm-defeito_informado').value;
  d.data_entrada = document.getElementById('rm-data_entrada').value;
  d.data_conclusao = document.getElementById('rm-data_conclusao').value;
  d.laudo_tecnico = document.getElementById('rm-laudo_tecnico').value;
  d.servico_realizado = document.getElementById('rm-servico_realizado').value;

  if (!d.empresa.trim() || !d.equipamento.trim()) { alert('Preencha ao menos Empresa e Equipamento.'); return; }

  try {
    const { relatorio } = d.id
      ? await api(`/api/relatorios-manutencao/${d.id}`, { method: 'PUT', body: d })
      : await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfRelatorioManutencao(relatorio, logo);
    window.open(url, '_blank');
    mostrarToast(d.id ? 'Relatório atualizado e PDF gerado.' : 'Relatório salvo e PDF gerado.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

async function editarRelatorioManutencao(i) {
  const r = await relatorioManutCompleto(i);
  if (!r) return;
  if (r.tipo === 'ficha') mostrarFormFicha(r);
  else if (r.tipo === 'ciclagem') mostrarFormCiclagem(r);
  else if (r.tipo === 'preventiva') mostrarFormRelatorioPreventiva(r);
  else if (r.tipo === 'corretiva') mostrarFormRelatorioCorretiva(r);
  else if (r.tipo === 'relatorio_tecnico') mostrarFormRelatorioTecnico(r);
  else if (r.tipo === 'aceite_entrega') mostrarFormRelatorioAceite(r);
  else mostrarFormRelatorioManutencao(r);
}

// ---------- Relatório > Manual > Preventiva (Termo de Manutenção Preventiva) ----------
// relatório avulso de manutenção interna, mesma família do Relatório Manual (relatorios_manutencao,
// tipo "preventiva"), com check-list próprio, pesquisa de satisfação e assinatura — segue o mesmo
// padrão visual (.panel/.form-grid) e a mesma escala de cores de PDF (PDF_COR) do relatório principal.
let relatorioPreventivaDraft = null;
function relatorioPreventivaPadrao() {
  return {
    tipo: 'preventiva',
    os_uf: '', os_numero: '', os_ano: '',
    data_inicial: '', data_final: '',
    modelo_maquina: '', numero_serie: '',
    servico_realizado: 'Preventiva',
    empresa: '', endereco: '', numero: '', bairro: '', estado: '', cidade: '', cep: '',
    setor_maquina: '',
    // vazio até o técnico escolher o modelo da máquina — cada modelo carrega seu próprio
    // check-list e conjunto de fotos (ver EQUIPAMENTOS_PREVENTIVA)
    checklist: [],
    observacoes_checklist: '',
    servico_feito: '',
    pecas: [],
    fotos: [],
    observacoes_servico: '',
    satisfacao_estrelas: 0,
    satisfacao_comentario: '',
    satisfacao_autoriza: '',
    assinatura_cliente_nome: '', assinatura_cliente_img: null,
    assinatura_tecnico_nome: '', assinatura_tecnico_img: null,
    emails_copia: [''],
  };
}

function mostrarFormRelatorioPreventiva(existente) {
  relatorioPreventivaDraft = existente ? JSON.parse(JSON.stringify(existente)) : relatorioPreventivaPadrao();
  const d = relatorioPreventivaDraft;
  const editando = !!d.id;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar' : 'Novo'} Termo de Manutenção Preventiva</h1><p>Relatório de manutenção interna, avulso — sem vínculo com nenhuma O.S. Campos com * são obrigatórios.</p></div>

    <div class="panel">
      <h2>Identificação</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Nº preenchido no ato do atendimento.</p>
      <div class="form-grid">
        <div><label>O.S. Nº — UF*</label><input id="rp-os_uf" maxlength="2" placeholder="UF" value="${esc(d.os_uf)}" style="text-transform:uppercase;"></div>
        <div><label>O.S. Nº — Número*</label><input id="rp-os_numero" placeholder="000" value="${esc(d.os_numero)}"></div>
        <div><label>O.S. Nº — Ano*</label><input id="rp-os_ano" placeholder="0000" value="${esc(d.os_ano)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Dados do atendimento</h2>
      <div class="form-grid">
        <div><label>Data inicial*</label><input id="rp-data_inicial" type="date" value="${esc(d.data_inicial)}"></div>
        <div><label>Data final*</label><input id="rp-data_final" type="date" value="${esc(d.data_final)}"></div>
        <div>
          <label>Modelo da máquina*</label>
          <select id="rp-modelo_maquina" onchange="selecionarModeloPreventiva(this.value)">
            <option value="" ${!d.modelo_maquina || !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'selected' : ''} disabled>Selecione...</option>
            ${Object.keys(EQUIPAMENTOS_PREVENTIVA).map((nome) => `<option value="${esc(nome)}" ${d.modelo_maquina === nome ? 'selected' : ''}>${esc(nome)}</option>`).join('')}
            <option value="Outro" ${d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'selected' : ''}>Outro</option>
          </select>
        </div>
        <div id="rp-modelo_maquina-outro-wrap" style="display:${d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'block' : 'none'};">
          <label>Especifique o modelo*</label>
          <input id="rp-modelo_maquina_outro" value="${esc(d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? d.modelo_maquina : '')}">
        </div>
        <div><label>Número de série*</label><input id="rp-numero_serie" placeholder="Ex.: SN-000000" value="${esc(d.numero_serie)}"></div>
        <div><label>Serviço realizado*</label><input id="rp-servico_realizado" value="${esc(d.servico_realizado)}"></div>
        <div><label>Técnico*</label><input value="${esc(USER.nome)}" disabled></div>
        <div class="full"><label>Empresa (cliente)*</label><input id="rp-empresa" value="${esc(d.empresa)}"></div>
        <div class="full"><label>Endereço*</label><input id="rp-endereco" value="${esc(d.endereco)}"></div>
        <div><label>Número*</label><input id="rp-numero" value="${esc(d.numero)}"></div>
        <div><label>Bairro*</label><input id="rp-bairro" value="${esc(d.bairro)}"></div>
        <div><label>Estado*</label><input id="rp-estado" maxlength="2" placeholder="UF" value="${esc(d.estado)}" style="text-transform:uppercase;"></div>
        <div><label>Cidade*</label><input id="rp-cidade" value="${esc(d.cidade)}"></div>
        <div><label>CEP*</label><input id="rp-cep" placeholder="00000-000" value="${esc(d.cep)}"></div>
        <div class="full"><label>Setor onde a máquina está instalada*</label><input id="rp-setor_maquina" value="${esc(d.setor_maquina)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Check-list de verificação*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Já vem com os itens mais comuns de equipamento a laser — apague, renomeie ou adicione itens pra deixar de acordo com o equipamento atendido. Marque Sim, Não ou N/A para cada item. Use a observação para detalhar qualquer irregularidade.</p>
      <div id="rp-checklist"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarItemChecklistPreventiva()">+ Adicionar item</button>
      <label style="margin-top:10px;">Observações*</label>
      <textarea id="rp-observacoes_checklist" placeholder="Observações gerais sobre o check-list">${esc(d.observacoes_checklist)}</textarea>
    </div>

    <div class="panel">
      <h2>Serviços realizados</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Manutenção realizada / resultados de amostra</p>
      <label>O que foi feito na máquina*</label>
      <textarea id="rp-servico_feito" placeholder="Descreva a manutenção realizada e os resultados obtidos...">${esc(d.servico_feito)}</textarea>
    </div>

    <div class="panel">
      <h2>Peças fornecidas</h2>
      <div class="steps-list" id="rp-pecas"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarPecaPreventiva()">+ Adicionar peça</button>
    </div>

    <div class="panel">
      <h2>Fotos</h2>
      <p id="rp-fotos-vazio" style="color:var(--ink-soft); font-size:13px; ${d.fotos.length ? 'display:none;' : ''}">Selecione o modelo da máquina acima pra liberar os grupos de fotos deste equipamento.</p>
      <div id="rp-fotos-wrap"></div>
    </div>

    <div class="panel">
      <h2>Observações do serviço*</h2>
      <textarea id="rp-observacoes_servico" placeholder="Observações adicionais do técnico...">${esc(d.observacoes_servico)}</textarea>
    </div>

    <div class="panel">
      <h2>Pesquisa de satisfação</h2>
      <label>Qual a sua avaliação sobre o atendimento preventivo realizado?*</label>
      <div id="rp-estrelas" style="margin-bottom:18px;"></div>
      <label>Caso tenha algo para apontar dentro do processo de interação para este atendimento</label>
      <input id="rp-satisfacao_comentario" placeholder="Sua resposta" value="${esc(d.satisfacao_comentario)}">
      <label style="margin-top:10px;">Podemos publicar o seu feedback nos canais de comunicação?*</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rp-autoriza" value="sim" style="width:auto;" ${d.satisfacao_autoriza === 'sim' ? 'checked' : ''}> Sim, autorizo o uso do meu feedback</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rp-autoriza" value="nao" style="width:auto;" ${d.satisfacao_autoriza === 'nao' ? 'checked' : ''}> Não autorizo o uso do meu feedback</label>
      </div>
    </div>

    <div class="panel">
      <h2>Assinatura*</h2>
      <div class="row2">
        ${blocoAssinaturaPreventiva('cliente', 'Cliente')}
        ${blocoAssinaturaPreventiva('tecnico', 'Técnico')}
      </div>
    </div>

    <div class="panel">
      <h2>Envio do termo*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">E-mails que devem receber uma cópia deste termo assim que ele for concluído.</p>
      <div id="rp-emails"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarEmailPreventiva()">+ Adicionar e-mail</button>
    </div>

    <div class="panel">
      <p style="font-size:12.5px; color:var(--ink-soft);">Ao concluir, o PDF do termo é gerado automaticamente e o e-mail para os destinatários é aberto pronto para envio.</p>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="renderRelatorioManutencao()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="concluirRelatorioPreventiva()">Concluir e enviar termo</button>
      </div>
    </div>`;
  renderChecklistPreventiva();
  renderPecasPreventiva();
  renderFotosPreventiva();
  renderEstrelasPreventiva();
  renderEmailsPreventiva();
  montarAssinaturaPreventiva('cliente');
  montarAssinaturaPreventiva('tecnico');
}

function blocoAssinaturaPreventiva(chave, titulo) {
  return `
    <div>
      <label>${titulo}</label>
      <input id="rp-assinatura-${chave}-nome" placeholder="Nome do ${titulo.toLowerCase()}" value="${esc((relatorioPreventivaDraft['assinatura_' + chave + '_nome']) || '')}" oninput="relatorioPreventivaDraft.assinatura_${chave}_nome=this.value;">
      <canvas id="rp-canvas-${chave}" width="360" height="150" style="width:100%; max-width:360px; height:150px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div id="rp-assinatura-${chave}-status" style="font-size:12px; color:var(--ink-soft); margin:6px 0;">Assinatura pendente</div>
      <div style="display:flex; gap:8px;">
        <button class="btn-outline-sm" onclick="ampliarAssinaturaPreventiva('${chave}')">⤢ Ampliar para assinar</button>
        <button class="btn-outline-sm" onclick="limparAssinaturaPreventiva('${chave}')">Limpar</button>
      </div>
    </div>`;
}

function renderChecklistPreventiva() {
  document.getElementById('rp-checklist').innerHTML = relatorioPreventivaDraft.checklist.map((c, i) => `
    <div class="step-item" style="margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; align-items:center; gap:6px; flex:1; min-width:160px;">
          <span style="color:var(--navy); font-size:13.5px; font-weight:700;">${String(i + 1).padStart(2, '0')}</span>
          <input placeholder="Nome do item" value="${esc(c.item)}" style="flex:1;" oninput="relatorioPreventivaDraft.checklist[${i}].item=this.value;">
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          ${['sim', 'nao', 'na'].map((v) => `<button type="button" class="btn-outline-sm" style="${c.resposta === v ? 'background:var(--blue); color:#fff; border-color:var(--blue);' : ''}" onclick="marcarChecklistPreventiva(${i}, '${v}')">${v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : 'N/A'}</button>`).join('')}
          <button class="step-rm" onclick="removerItemChecklistPreventiva(${i})">×</button>
        </div>
      </div>
      <input placeholder="Observação (opcional)" value="${esc(c.observacao)}" oninput="relatorioPreventivaDraft.checklist[${i}].observacao=this.value;">
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhum item no check-list — adicione ao menos um.</p>';
}
function marcarChecklistPreventiva(i, valor) {
  relatorioPreventivaDraft.checklist[i].resposta = valor;
  renderChecklistPreventiva();
}
function adicionarItemChecklistPreventiva() {
  relatorioPreventivaDraft.checklist.push({ item: '', resposta: '', observacao: '' });
  renderChecklistPreventiva();
}
function removerItemChecklistPreventiva(i) {
  relatorioPreventivaDraft.checklist.splice(i, 1);
  renderChecklistPreventiva();
}

function renderPecasPreventiva() {
  document.getElementById('rp-pecas').innerHTML = relatorioPreventivaDraft.pecas.map((p, i) => `
    <div class="step-item">
      <div class="step-main">
        <div class="step-num">${i + 1}</div>
        <input placeholder="Descrição da peça" value="${esc(p.descricao || '')}" style="flex:2;" oninput="relatorioPreventivaDraft.pecas[${i}].descricao=this.value;">
        <input placeholder="Código PMK" value="${esc(p.codigo_pmk || '')}" style="flex:1;" oninput="relatorioPreventivaDraft.pecas[${i}].codigo_pmk=this.value;">
        <button class="step-rm" onclick="removerPecaPreventiva(${i})">×</button>
      </div>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhuma peça adicionada.</p>';
}
function adicionarPecaPreventiva() { relatorioPreventivaDraft.pecas.push({ descricao: '', codigo_pmk: '' }); renderPecasPreventiva(); }
function removerPecaPreventiva(i) { relatorioPreventivaDraft.pecas.splice(i, 1); renderPecasPreventiva(); }

// o modelo da máquina escolhido decide o check-list e o conjunto de fotos deste termo (ver
// EQUIPAMENTOS_PREVENTIVA) — "Outro" libera um campo de texto e começa com o check-list em
// branco e o conjunto de fotos genérico, pra equipamentos fora da lista.
function selecionarModeloPreventiva(nome) {
  const d = relatorioPreventivaDraft;
  const jaTemDados = d.checklist.some((c) => c.item || c.resposta) || d.fotos.some((b) => b.fotos.length);
  if (jaTemDados && !confirm('Trocar o modelo da máquina vai substituir o check-list e as fotos atuais. Continuar?')) {
    document.getElementById('rp-modelo_maquina').value = d.modelo_maquina || '';
    return;
  }
  d.modelo_maquina = nome;
  const outroWrap = document.getElementById('rp-modelo_maquina-outro-wrap');
  const preset = EQUIPAMENTOS_PREVENTIVA[nome];
  if (preset) {
    outroWrap.style.display = 'none';
    d.checklist = preset.checklist.map((item) => ({ item, resposta: '', observacao: '' }));
    d.fotos = preset.fotos.map((label) => ({ comentario: label, fotos: [] }));
  } else {
    outroWrap.style.display = 'block';
    document.getElementById('rp-modelo_maquina_outro').value = '';
    d.checklist = [];
    d.fotos = FOTOS_PREVENTIVA_GENERICO.map((label) => ({ comentario: label, fotos: [] }));
  }
  renderChecklistPreventiva();
  renderFotosPreventiva();
}

function renderFotosPreventiva() {
  const vazio = document.getElementById('rp-fotos-vazio');
  if (vazio) vazio.style.display = relatorioPreventivaDraft.fotos.length ? 'none' : 'block';
  document.getElementById('rp-fotos-wrap').innerHTML = relatorioPreventivaDraft.fotos.map((bloco, idx) => {
    const obrigatorio = idx < relatorioPreventivaDraft.fotos.length - 1;
    return `
    <div style="margin-bottom:18px;">
      <label>${esc(bloco.comentario)}${obrigatorio ? '*' : ''}</label>
      ${!obrigatorio ? `<p style="color:var(--ink-soft); font-size:12.5px; margin-top:-6px;">Caso tenha mais algum registro importante</p>` : ''}
      <div class="step-photos" id="rp-fotos-${idx}"></div>
      <label class="photo-add">
        <span class="plus">+</span>Anexar fotos
        <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosPreventiva(${idx}, event)">
      </label>
    </div>`;
  }).join('');
  relatorioPreventivaDraft.fotos.forEach((bloco, idx) => renderFotosGrupoPreventiva(idx));
}

function renderFotosGrupoPreventiva(idx) {
  const el = document.getElementById('rp-fotos-' + idx);
  if (!el) return;
  const bloco = relatorioPreventivaDraft.fotos[idx];
  el.innerHTML = bloco.fotos.map((f, j) => `
    <div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="${esc(bloco.comentario)}">
      <button class="photo-rm" onclick="removerFotoPreventiva(${idx}, ${j})">×</button>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:12.5px;">Nenhuma foto anexada ainda.</p>';
}
function adicionarFotosPreventiva(idx, event) {
  lerFotosComoDataUrl(event.target.files || []).then((dataUrls) => {
    relatorioPreventivaDraft.fotos[idx].fotos.push(...dataUrls);
    renderFotosGrupoPreventiva(idx);
  });
}
function removerFotoPreventiva(idx, j) { relatorioPreventivaDraft.fotos[idx].fotos.splice(j, 1); renderFotosGrupoPreventiva(idx); }

function renderEstrelasPreventiva() {
  document.getElementById('rp-estrelas').innerHTML = [1, 2, 3, 4, 5].map((n) => `
    <button type="button" onclick="marcarEstrelaPreventiva(${n})" style="background:none; border:none; cursor:pointer; font-size:28px; color:${n <= relatorioPreventivaDraft.satisfacao_estrelas ? 'var(--blue)' : '#D8E2EF'};">★</button>
  `).join('');
}
function marcarEstrelaPreventiva(n) { relatorioPreventivaDraft.satisfacao_estrelas = n; renderEstrelasPreventiva(); }

function renderEmailsPreventiva() {
  document.getElementById('rp-emails').innerHTML = relatorioPreventivaDraft.emails_copia.map((em, i) => `
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <input placeholder="nome@empresa.com" value="${esc(em)}" oninput="relatorioPreventivaDraft.emails_copia[${i}]=this.value;">
      ${relatorioPreventivaDraft.emails_copia.length > 1 ? `<button class="btn-outline-sm" onclick="removerEmailPreventiva(${i})">×</button>` : ''}
    </div>`).join('');
}
function adicionarEmailPreventiva() { relatorioPreventivaDraft.emails_copia.push(''); renderEmailsPreventiva(); }
function removerEmailPreventiva(i) { relatorioPreventivaDraft.emails_copia.splice(i, 1); renderEmailsPreventiva(); }

// ---------- assinatura (canvas) — mesmo mecanismo do relatório corretivo, prefixo "rp-" ----------
const assinaturaEstadoPreventiva = {};
function montarAssinaturaPreventiva(chave) {
  const canvas = document.getElementById('rp-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  assinaturaEstadoPreventiva[chave] = { desenhando: false, temTraco: false };
  if (relatorioPreventivaDraft['assinatura_' + chave + '_img']) {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); assinaturaEstadoPreventiva[chave].temTraco = true; atualizarStatusAssinaturaPreventiva(chave); };
    img.src = relatorioPreventivaDraft['assinatura_' + chave + '_img'];
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); assinaturaEstadoPreventiva[chave].desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!assinaturaEstadoPreventiva[chave].desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); assinaturaEstadoPreventiva[chave].temTraco = true; }
  function parar() {
    if (!assinaturaEstadoPreventiva[chave].desenhando) return;
    assinaturaEstadoPreventiva[chave].desenhando = false;
    if (assinaturaEstadoPreventiva[chave].temTraco) {
      relatorioPreventivaDraft['assinatura_' + chave + '_img'] = canvas.toDataURL('image/png');
      atualizarStatusAssinaturaPreventiva(chave);
    }
  }
  canvas.addEventListener('mousedown', iniciar);
  canvas.addEventListener('mousemove', mover);
  window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false });
  canvas.addEventListener('touchmove', mover, { passive: false });
  canvas.addEventListener('touchend', parar);
}
function atualizarStatusAssinaturaPreventiva(chave) {
  const el = document.getElementById(`rp-assinatura-${chave}-status`);
  if (el) { el.textContent = assinaturaEstadoPreventiva[chave].temTraco ? 'Assinatura registrada' : 'Assinatura pendente'; el.style.color = assinaturaEstadoPreventiva[chave].temTraco ? 'var(--green)' : 'var(--ink-soft)'; }
}
function limparAssinaturaPreventiva(chave) {
  const canvas = document.getElementById('rp-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  assinaturaEstadoPreventiva[chave].temTraco = false;
  relatorioPreventivaDraft['assinatura_' + chave + '_img'] = null;
  atualizarStatusAssinaturaPreventiva(chave);
}
function ampliarAssinaturaPreventiva(chave) {
  let modal = document.getElementById('modal-assinatura');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-assinatura';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;">
      <h3>Assinar</h3>
      <p>Desenhe a assinatura com o dedo ou o mouse.</p>
      <canvas id="modal-canvas" width="900" height="380" style="width:100%; height:260px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-canvas').getContext('2d').clearRect(0,0,900,380)">Limpar</button>
        <button class="btn btn-primary" onclick="confirmarAssinaturaModalPreventiva('${chave}')">Usar esta assinatura</button>
        <button class="btn-outline-sm" onclick="document.getElementById('modal-assinatura').classList.remove('show')">Cancelar</button>
      </div>
    </div>`;
  const canvas = document.getElementById('modal-canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  let desenhando = false;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function parar() { desenhando = false; }
  canvas.addEventListener('mousedown', iniciar); canvas.addEventListener('mousemove', mover); window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false }); canvas.addEventListener('touchmove', mover, { passive: false }); canvas.addEventListener('touchend', parar);
}
function confirmarAssinaturaModalPreventiva(chave) {
  const modalCanvas = document.getElementById('modal-canvas');
  const destino = document.getElementById('rp-canvas-' + chave);
  const ctxDestino = destino.getContext('2d');
  ctxDestino.clearRect(0, 0, destino.width, destino.height);
  ctxDestino.drawImage(modalCanvas, 0, 0, destino.width, destino.height);
  assinaturaEstadoPreventiva[chave].temTraco = true;
  relatorioPreventivaDraft['assinatura_' + chave + '_img'] = destino.toDataURL('image/png');
  atualizarStatusAssinaturaPreventiva(chave);
  document.getElementById('modal-assinatura').classList.remove('show');
}

// ---------- concluir: validar, salvar, gerar PDF, abrir e-mail pra envio ----------
async function concluirRelatorioPreventiva() {
  const d = relatorioPreventivaDraft;
  d.os_uf = document.getElementById('rp-os_uf').value;
  d.os_numero = document.getElementById('rp-os_numero').value;
  d.os_ano = document.getElementById('rp-os_ano').value;
  d.data_inicial = document.getElementById('rp-data_inicial').value;
  d.data_final = document.getElementById('rp-data_final').value;
  const modeloSelecionado = document.getElementById('rp-modelo_maquina').value;
  d.modelo_maquina = modeloSelecionado === 'Outro' ? document.getElementById('rp-modelo_maquina_outro').value : modeloSelecionado;
  d.numero_serie = document.getElementById('rp-numero_serie').value;
  d.servico_realizado = document.getElementById('rp-servico_realizado').value;
  d.empresa = document.getElementById('rp-empresa').value;
  d.endereco = document.getElementById('rp-endereco').value;
  d.numero = document.getElementById('rp-numero').value;
  d.bairro = document.getElementById('rp-bairro').value;
  d.estado = document.getElementById('rp-estado').value;
  d.cidade = document.getElementById('rp-cidade').value;
  d.cep = document.getElementById('rp-cep').value;
  d.setor_maquina = document.getElementById('rp-setor_maquina').value;
  d.observacoes_checklist = document.getElementById('rp-observacoes_checklist').value;
  d.servico_feito = document.getElementById('rp-servico_feito').value;
  d.observacoes_servico = document.getElementById('rp-observacoes_servico').value;
  d.satisfacao_comentario = document.getElementById('rp-satisfacao_comentario').value;
  const autoriza = document.querySelector('input[name="rp-autoriza"]:checked');
  d.satisfacao_autoriza = autoriza ? autoriza.value : '';
  d.assinatura_cliente_nome = document.getElementById('rp-assinatura-cliente-nome').value;
  d.assinatura_tecnico_nome = document.getElementById('rp-assinatura-tecnico-nome').value;

  const obrigatorios = ['os_uf', 'os_numero', 'os_ano', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie',
    'servico_realizado', 'empresa', 'endereco', 'numero', 'bairro', 'estado', 'cidade', 'cep', 'setor_maquina',
    'observacoes_checklist', 'servico_feito', 'observacoes_servico'];
  for (const campo of obrigatorios) {
    if (!String(d[campo] || '').trim()) return alert('Preencha todos os campos obrigatórios de "Identificação" e "Dados do atendimento".');
  }
  if (!d.checklist.length) return alert('Adicione ao menos um item no check-list.');
  if (d.checklist.some((c) => !String(c.item || '').trim())) return alert('Dê um nome a todos os itens do check-list, ou remova os que estiverem em branco.');
  if (d.checklist.some((c) => !c.resposta)) return alert('Responda todos os itens do check-list (Sim/Não/N/A).');
  if (!d.fotos.length) return alert('Selecione o modelo da máquina pra liberar os grupos de fotos.');
  for (let idx = 0; idx < d.fotos.length - 1; idx++) {
    if (!d.fotos[idx].fotos.length) return alert(`Anexe ao menos uma foto em "${d.fotos[idx].comentario}".`);
  }
  if (!d.satisfacao_estrelas) return alert('Selecione a avaliação por estrelas da pesquisa de satisfação.');
  if (!d.satisfacao_autoriza) return alert('Responda se autoriza o uso do feedback.');
  if (!d.assinatura_cliente_nome || !d.assinatura_cliente_img) return alert('Colete o nome e a assinatura do cliente.');
  if (!d.assinatura_tecnico_nome || !d.assinatura_tecnico_img) return alert('Colete o nome e a assinatura do técnico.');
  const emails = d.emails_copia.map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) return alert('Informe ao menos um e-mail para envio do termo.');
  d.emails_copia = emails;

  try {
    const { relatorio } = d.id
      ? await api(`/api/relatorios-manutencao/${d.id}`, { method: 'PUT', body: d })
      : await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfRelatorioPreventiva(relatorio, logo);
    window.open(url, '_blank');
    const assunto = encodeURIComponent(`Termo de Manutenção Preventiva — ${d.empresa}`);
    const corpo = encodeURIComponent(`Olá,\n\nSegue em anexo o Termo de Manutenção Preventiva (OS ${d.os_uf}/${d.os_numero}/${d.os_ano}) referente ao atendimento em ${d.empresa}.\n\nO PDF foi baixado neste dispositivo — anexe-o antes de enviar.\n\nAtenciosamente,\n${USER.nome}`);
    window.open(`mailto:${emails.join(',')}?subject=${assunto}&body=${corpo}`, '_blank');
    mostrarToast(d.id ? 'Termo atualizado e PDF gerado.' : 'Termo salvo e PDF gerado — anexe-o no e-mail que foi aberto.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

// ---------- Relatório > Manual > Corretiva (Termo de Manutenção Corretiva) ----------
// mesmo esqueleto do Preventiva (identificação, modelo da máquina define as fotos, pesquisa de
// satisfação, assinatura, envio por e-mail), mas sem check-list — em vez disso tem defeito
// informado / ações executadas / observações, e a lista de peças fornecidas tem quantidade.
let relatorioCorretivaDraft = null;
function relatorioCorretivaPadrao() {
  return {
    tipo: 'corretiva',
    os_uf: '', os_numero: '', os_ano: '',
    data_inicial: '', data_final: '',
    modelo_maquina: '', numero_serie: '',
    servico_realizado: 'Corretiva',
    empresa: '', endereco: '', numero: '', bairro: '', estado: '', cidade: '', cep: '',
    setor_maquina: '',
    defeito_informado: '',
    acoes_executadas: '',
    observacoes: '',
    pecas: [],
    // vazio até o técnico escolher o modelo da máquina, igual no Preventiva
    fotos: [],
    satisfacao_estrelas: 0,
    satisfacao_comentario: '',
    satisfacao_autoriza: '',
    assinatura_cliente_nome: '', assinatura_cliente_img: null,
    assinatura_tecnico_nome: '', assinatura_tecnico_img: null,
    emails_copia: [''],
  };
}

function mostrarFormRelatorioCorretiva(existente) {
  relatorioCorretivaDraft = existente ? JSON.parse(JSON.stringify(existente)) : relatorioCorretivaPadrao();
  const d = relatorioCorretivaDraft;
  const editando = !!d.id;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar' : 'Novo'} Termo de Manutenção Corretiva</h1><p>Relatório de manutenção interna, avulso — sem vínculo com nenhuma O.S. Campos com * são obrigatórios.</p></div>

    <div class="panel">
      <h2>Identificação</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Nº preenchido no ato do atendimento.</p>
      <div class="form-grid">
        <div><label>O.S. Nº — UF*</label><input id="rcm-os_uf" maxlength="2" placeholder="UF" value="${esc(d.os_uf)}" style="text-transform:uppercase;"></div>
        <div><label>O.S. Nº — Número*</label><input id="rcm-os_numero" placeholder="000" value="${esc(d.os_numero)}"></div>
        <div><label>O.S. Nº — Ano*</label><input id="rcm-os_ano" placeholder="0000" value="${esc(d.os_ano)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Dados do atendimento</h2>
      <div class="form-grid">
        <div><label>Data inicial*</label><input id="rcm-data_inicial" type="date" value="${esc(d.data_inicial)}"></div>
        <div><label>Data final*</label><input id="rcm-data_final" type="date" value="${esc(d.data_final)}"></div>
        <div>
          <label>Modelo da máquina*</label>
          <select id="rcm-modelo_maquina" onchange="selecionarModeloCorretiva(this.value)">
            <option value="" ${!d.modelo_maquina || !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'selected' : ''} disabled>Selecione...</option>
            ${Object.keys(EQUIPAMENTOS_PREVENTIVA).map((nome) => `<option value="${esc(nome)}" ${d.modelo_maquina === nome ? 'selected' : ''}>${esc(nome)}</option>`).join('')}
            <option value="Outro" ${d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'selected' : ''}>Outro</option>
          </select>
        </div>
        <div id="rcm-modelo_maquina-outro-wrap" style="display:${d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'block' : 'none'};">
          <label>Especifique o modelo*</label>
          <input id="rcm-modelo_maquina_outro" value="${esc(d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? d.modelo_maquina : '')}">
        </div>
        <div><label>Número de série*</label><input id="rcm-numero_serie" placeholder="Ex.: SN-000000" value="${esc(d.numero_serie)}"></div>
        <div><label>Serviço realizado*</label><input id="rcm-servico_realizado" value="${esc(d.servico_realizado)}"></div>
        <div><label>Técnico*</label><input value="${esc(USER.nome)}" disabled></div>
        <div class="full"><label>Empresa (cliente)*</label><input id="rcm-empresa" value="${esc(d.empresa)}"></div>
        <div class="full"><label>Endereço*</label><input id="rcm-endereco" value="${esc(d.endereco)}"></div>
        <div><label>Número*</label><input id="rcm-numero" value="${esc(d.numero)}"></div>
        <div><label>Bairro*</label><input id="rcm-bairro" value="${esc(d.bairro)}"></div>
        <div><label>Estado*</label><input id="rcm-estado" maxlength="2" placeholder="UF" value="${esc(d.estado)}" style="text-transform:uppercase;"></div>
        <div><label>Cidade*</label><input id="rcm-cidade" value="${esc(d.cidade)}"></div>
        <div><label>CEP*</label><input id="rcm-cep" placeholder="00000-000" value="${esc(d.cep)}"></div>
        <div class="full"><label>Setor onde a máquina está instalada*</label><input id="rcm-setor_maquina" value="${esc(d.setor_maquina)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Defeito informado*</h2>
      <textarea id="rcm-defeito_informado" placeholder="Descrever de forma breve o problema relatado pelo cliente.">${esc(d.defeito_informado)}</textarea>
    </div>

    <div class="panel">
      <h2>Ações executadas*</h2>
      <textarea id="rcm-acoes_executadas" placeholder="Descrever os serviços e procedimentos realizados no equipamento.">${esc(d.acoes_executadas)}</textarea>
    </div>

    <div class="panel">
      <h2>Observações*</h2>
      <textarea id="rcm-observacoes" placeholder="Informar o problema identificado, diagnóstico realizado, serviço executado e recomendação, quando aplicável.">${esc(d.observacoes)}</textarea>
    </div>

    <div class="panel">
      <h2>Peças fornecidas</h2>
      <div class="steps-list" id="rcm-pecas"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarPecaCorretiva()">+ Adicionar peça</button>
    </div>

    <div class="panel">
      <h2>Fotos</h2>
      <p id="rcm-fotos-vazio" style="color:var(--ink-soft); font-size:13px; ${d.fotos.length ? 'display:none;' : ''}">Selecione o modelo do equipamento em "Dados do Atendimento" para liberar os campos de fotos.</p>
      <div id="rcm-fotos-wrap"></div>
    </div>

    <div class="panel">
      <h2>Pesquisa de satisfação</h2>
      <label>Qual a sua avaliação sobre o atendimento corretivo realizado?*</label>
      <div id="rcm-estrelas" style="margin-bottom:18px;"></div>
      <label>Caso tenha algo para apontar dentro do processo de interação para este atendimento</label>
      <input id="rcm-satisfacao_comentario" placeholder="Sua resposta" value="${esc(d.satisfacao_comentario)}">
      <label style="margin-top:10px;">Podemos publicar o seu feedback nos canais de comunicação?*</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rcm-autoriza" value="sim" style="width:auto;" ${d.satisfacao_autoriza === 'sim' ? 'checked' : ''}> Sim, autorizo o uso do meu feedback</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rcm-autoriza" value="nao" style="width:auto;" ${d.satisfacao_autoriza === 'nao' ? 'checked' : ''}> Não autorizo o uso do meu feedback</label>
      </div>
    </div>

    <div class="panel">
      <h2>Assinatura*</h2>
      <div class="row2">
        ${blocoAssinaturaCorretiva('cliente', 'Cliente')}
        ${blocoAssinaturaCorretiva('tecnico', 'Técnico')}
      </div>
    </div>

    <div class="panel">
      <h2>Envio do termo*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">E-mails que devem receber uma cópia deste termo assim que ele for concluído.</p>
      <div id="rcm-emails"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarEmailCorretiva()">+ Adicionar e-mail</button>
    </div>

    <div class="panel">
      <p style="font-size:12.5px; color:var(--ink-soft);">Ao concluir, o PDF do termo é gerado automaticamente e o e-mail para os destinatários é aberto pronto para envio.</p>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="renderRelatorioManutencao()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="concluirRelatorioCorretiva()">Concluir e enviar termo</button>
      </div>
    </div>`;
  renderPecasCorretiva();
  renderFotosCorretiva();
  renderEstrelasCorretiva();
  renderEmailsCorretiva();
  montarAssinaturaCorretiva('cliente');
  montarAssinaturaCorretiva('tecnico');
}

function blocoAssinaturaCorretiva(chave, titulo) {
  return `
    <div>
      <label>${titulo}</label>
      <input id="rcm-assinatura-${chave}-nome" placeholder="Nome do ${titulo.toLowerCase()}" value="${esc((relatorioCorretivaDraft['assinatura_' + chave + '_nome']) || '')}" oninput="relatorioCorretivaDraft.assinatura_${chave}_nome=this.value;">
      <canvas id="rcm-canvas-${chave}" width="360" height="150" style="width:100%; max-width:360px; height:150px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div id="rcm-assinatura-${chave}-status" style="font-size:12px; color:var(--ink-soft); margin:6px 0;">Assinatura pendente</div>
      <div style="display:flex; gap:8px;">
        <button class="btn-outline-sm" onclick="ampliarAssinaturaCorretiva('${chave}')">⤢ Ampliar para assinar</button>
        <button class="btn-outline-sm" onclick="limparAssinaturaCorretiva('${chave}')">Limpar</button>
      </div>
    </div>`;
}

function renderPecasCorretiva() {
  document.getElementById('rcm-pecas').innerHTML = relatorioCorretivaDraft.pecas.map((p, i) => `
    <div class="step-item">
      <div class="step-main">
        <div class="step-num">${i + 1}</div>
        <input placeholder="Descrição da peça" value="${esc(p.descricao || '')}" style="flex:2;" oninput="relatorioCorretivaDraft.pecas[${i}].descricao=this.value;">
        <input placeholder="Código PMK" value="${esc(p.codigo_pmk || '')}" style="flex:1;" oninput="relatorioCorretivaDraft.pecas[${i}].codigo_pmk=this.value;">
        <input placeholder="Qtd" value="${esc(p.quantidade || '')}" style="flex:0 0 60px;" oninput="relatorioCorretivaDraft.pecas[${i}].quantidade=this.value;">
        <button class="step-rm" onclick="removerPecaCorretiva(${i})">×</button>
      </div>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhuma peça adicionada.</p>';
}
function adicionarPecaCorretiva() { relatorioCorretivaDraft.pecas.push({ descricao: '', codigo_pmk: '', quantidade: '' }); renderPecasCorretiva(); }
function removerPecaCorretiva(i) { relatorioCorretivaDraft.pecas.splice(i, 1); renderPecasCorretiva(); }

// o modelo da máquina escolhido decide o conjunto de fotos deste termo — reaproveita as mesmas
// fotos por equipamento do Preventiva (EQUIPAMENTOS_PREVENTIVA), já que o conjunto de fotos não
// depende do tipo de relatório, só do equipamento atendido. Corretiva não tem check-list.
function selecionarModeloCorretiva(nome) {
  const d = relatorioCorretivaDraft;
  const jaTemFotos = d.fotos.some((b) => b.fotos.length);
  if (jaTemFotos && !confirm('Trocar o modelo da máquina vai substituir as fotos atuais. Continuar?')) {
    document.getElementById('rcm-modelo_maquina').value = d.modelo_maquina || '';
    return;
  }
  d.modelo_maquina = nome;
  const outroWrap = document.getElementById('rcm-modelo_maquina-outro-wrap');
  const preset = EQUIPAMENTOS_PREVENTIVA[nome];
  if (preset) {
    outroWrap.style.display = 'none';
    d.fotos = preset.fotos.map((label) => ({ comentario: label, fotos: [] }));
  } else {
    outroWrap.style.display = 'block';
    document.getElementById('rcm-modelo_maquina_outro').value = '';
    d.fotos = FOTOS_PREVENTIVA_GENERICO.map((label) => ({ comentario: label, fotos: [] }));
  }
  renderFotosCorretiva();
}

function renderFotosCorretiva() {
  const vazio = document.getElementById('rcm-fotos-vazio');
  if (vazio) vazio.style.display = relatorioCorretivaDraft.fotos.length ? 'none' : 'block';
  document.getElementById('rcm-fotos-wrap').innerHTML = relatorioCorretivaDraft.fotos.map((bloco, idx) => {
    const obrigatorio = idx < relatorioCorretivaDraft.fotos.length - 1;
    return `
    <div style="margin-bottom:18px;">
      <label>${esc(bloco.comentario)}${obrigatorio ? '*' : ''}</label>
      ${!obrigatorio ? `<p style="color:var(--ink-soft); font-size:12.5px; margin-top:-6px;">Caso tenha mais algum registro importante</p>` : ''}
      <div class="step-photos" id="rcm-fotos-${idx}"></div>
      <label class="photo-add">
        <span class="plus">+</span>Anexar fotos
        <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosCorretiva(${idx}, event)">
      </label>
    </div>`;
  }).join('');
  relatorioCorretivaDraft.fotos.forEach((bloco, idx) => renderFotosGrupoCorretiva(idx));
}

function renderFotosGrupoCorretiva(idx) {
  const el = document.getElementById('rcm-fotos-' + idx);
  if (!el) return;
  const bloco = relatorioCorretivaDraft.fotos[idx];
  el.innerHTML = bloco.fotos.map((f, j) => `
    <div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="${esc(bloco.comentario)}">
      <button class="photo-rm" onclick="removerFotoCorretiva(${idx}, ${j})">×</button>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:12.5px;">Nenhuma foto anexada ainda.</p>';
}
function adicionarFotosCorretiva(idx, event) {
  lerFotosComoDataUrl(event.target.files || []).then((dataUrls) => {
    relatorioCorretivaDraft.fotos[idx].fotos.push(...dataUrls);
    renderFotosGrupoCorretiva(idx);
  });
}
function removerFotoCorretiva(idx, j) { relatorioCorretivaDraft.fotos[idx].fotos.splice(j, 1); renderFotosGrupoCorretiva(idx); }

function renderEstrelasCorretiva() {
  document.getElementById('rcm-estrelas').innerHTML = [1, 2, 3, 4, 5].map((n) => `
    <button type="button" onclick="marcarEstrelaCorretiva(${n})" style="background:none; border:none; cursor:pointer; font-size:28px; color:${n <= relatorioCorretivaDraft.satisfacao_estrelas ? 'var(--blue)' : '#D8E2EF'};">★</button>
  `).join('');
}
function marcarEstrelaCorretiva(n) { relatorioCorretivaDraft.satisfacao_estrelas = n; renderEstrelasCorretiva(); }

function renderEmailsCorretiva() {
  document.getElementById('rcm-emails').innerHTML = relatorioCorretivaDraft.emails_copia.map((em, i) => `
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <input placeholder="nome@empresa.com" value="${esc(em)}" oninput="relatorioCorretivaDraft.emails_copia[${i}]=this.value;">
      ${relatorioCorretivaDraft.emails_copia.length > 1 ? `<button class="btn-outline-sm" onclick="removerEmailCorretiva(${i})">×</button>` : ''}
    </div>`).join('');
}
function adicionarEmailCorretiva() { relatorioCorretivaDraft.emails_copia.push(''); renderEmailsCorretiva(); }
function removerEmailCorretiva(i) { relatorioCorretivaDraft.emails_copia.splice(i, 1); renderEmailsCorretiva(); }

// ---------- assinatura (canvas) — mesmo mecanismo do relatório preventivo, prefixo "rcm-" ----------
const assinaturaEstadoCorretiva = {};
function montarAssinaturaCorretiva(chave) {
  const canvas = document.getElementById('rcm-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  assinaturaEstadoCorretiva[chave] = { desenhando: false, temTraco: false };
  if (relatorioCorretivaDraft['assinatura_' + chave + '_img']) {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); assinaturaEstadoCorretiva[chave].temTraco = true; atualizarStatusAssinaturaCorretiva(chave); };
    img.src = relatorioCorretivaDraft['assinatura_' + chave + '_img'];
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); assinaturaEstadoCorretiva[chave].desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!assinaturaEstadoCorretiva[chave].desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); assinaturaEstadoCorretiva[chave].temTraco = true; }
  function parar() {
    if (!assinaturaEstadoCorretiva[chave].desenhando) return;
    assinaturaEstadoCorretiva[chave].desenhando = false;
    if (assinaturaEstadoCorretiva[chave].temTraco) {
      relatorioCorretivaDraft['assinatura_' + chave + '_img'] = canvas.toDataURL('image/png');
      atualizarStatusAssinaturaCorretiva(chave);
    }
  }
  canvas.addEventListener('mousedown', iniciar);
  canvas.addEventListener('mousemove', mover);
  window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false });
  canvas.addEventListener('touchmove', mover, { passive: false });
  canvas.addEventListener('touchend', parar);
}
function atualizarStatusAssinaturaCorretiva(chave) {
  const el = document.getElementById(`rcm-assinatura-${chave}-status`);
  if (el) { el.textContent = assinaturaEstadoCorretiva[chave].temTraco ? 'Assinatura registrada' : 'Assinatura pendente'; el.style.color = assinaturaEstadoCorretiva[chave].temTraco ? 'var(--green)' : 'var(--ink-soft)'; }
}
function limparAssinaturaCorretiva(chave) {
  const canvas = document.getElementById('rcm-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  assinaturaEstadoCorretiva[chave].temTraco = false;
  relatorioCorretivaDraft['assinatura_' + chave + '_img'] = null;
  atualizarStatusAssinaturaCorretiva(chave);
}
function ampliarAssinaturaCorretiva(chave) {
  let modal = document.getElementById('modal-assinatura');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-assinatura';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;">
      <h3>Assinar</h3>
      <p>Desenhe a assinatura com o dedo ou o mouse.</p>
      <canvas id="modal-canvas" width="900" height="380" style="width:100%; height:260px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-canvas').getContext('2d').clearRect(0,0,900,380)">Limpar</button>
        <button class="btn btn-primary" onclick="confirmarAssinaturaModalCorretiva('${chave}')">Usar esta assinatura</button>
        <button class="btn-outline-sm" onclick="document.getElementById('modal-assinatura').classList.remove('show')">Cancelar</button>
      </div>
    </div>`;
  const canvas = document.getElementById('modal-canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  let desenhando = false;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function parar() { desenhando = false; }
  canvas.addEventListener('mousedown', iniciar); canvas.addEventListener('mousemove', mover); window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false }); canvas.addEventListener('touchmove', mover, { passive: false }); canvas.addEventListener('touchend', parar);
}
function confirmarAssinaturaModalCorretiva(chave) {
  const modalCanvas = document.getElementById('modal-canvas');
  const destino = document.getElementById('rcm-canvas-' + chave);
  const ctxDestino = destino.getContext('2d');
  ctxDestino.clearRect(0, 0, destino.width, destino.height);
  ctxDestino.drawImage(modalCanvas, 0, 0, destino.width, destino.height);
  assinaturaEstadoCorretiva[chave].temTraco = true;
  relatorioCorretivaDraft['assinatura_' + chave + '_img'] = destino.toDataURL('image/png');
  atualizarStatusAssinaturaCorretiva(chave);
  document.getElementById('modal-assinatura').classList.remove('show');
}

// ---------- concluir: validar, salvar, gerar PDF, abrir e-mail pra envio ----------
async function concluirRelatorioCorretiva() {
  const d = relatorioCorretivaDraft;
  d.os_uf = document.getElementById('rcm-os_uf').value;
  d.os_numero = document.getElementById('rcm-os_numero').value;
  d.os_ano = document.getElementById('rcm-os_ano').value;
  d.data_inicial = document.getElementById('rcm-data_inicial').value;
  d.data_final = document.getElementById('rcm-data_final').value;
  const modeloSelecionado = document.getElementById('rcm-modelo_maquina').value;
  d.modelo_maquina = modeloSelecionado === 'Outro' ? document.getElementById('rcm-modelo_maquina_outro').value : modeloSelecionado;
  d.numero_serie = document.getElementById('rcm-numero_serie').value;
  d.servico_realizado = document.getElementById('rcm-servico_realizado').value;
  d.empresa = document.getElementById('rcm-empresa').value;
  d.endereco = document.getElementById('rcm-endereco').value;
  d.numero = document.getElementById('rcm-numero').value;
  d.bairro = document.getElementById('rcm-bairro').value;
  d.estado = document.getElementById('rcm-estado').value;
  d.cidade = document.getElementById('rcm-cidade').value;
  d.cep = document.getElementById('rcm-cep').value;
  d.setor_maquina = document.getElementById('rcm-setor_maquina').value;
  d.defeito_informado = document.getElementById('rcm-defeito_informado').value;
  d.acoes_executadas = document.getElementById('rcm-acoes_executadas').value;
  d.observacoes = document.getElementById('rcm-observacoes').value;
  d.satisfacao_comentario = document.getElementById('rcm-satisfacao_comentario').value;
  const autoriza = document.querySelector('input[name="rcm-autoriza"]:checked');
  d.satisfacao_autoriza = autoriza ? autoriza.value : '';
  d.assinatura_cliente_nome = document.getElementById('rcm-assinatura-cliente-nome').value;
  d.assinatura_tecnico_nome = document.getElementById('rcm-assinatura-tecnico-nome').value;

  const obrigatorios = ['os_uf', 'os_numero', 'os_ano', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie',
    'servico_realizado', 'empresa', 'endereco', 'numero', 'bairro', 'estado', 'cidade', 'cep', 'setor_maquina',
    'defeito_informado', 'acoes_executadas', 'observacoes'];
  for (const campo of obrigatorios) {
    if (!String(d[campo] || '').trim()) return alert('Preencha todos os campos obrigatórios de "Identificação" e "Dados do atendimento".');
  }
  if (!d.fotos.length) return alert('Selecione o modelo da máquina pra liberar os grupos de fotos.');
  for (let idx = 0; idx < d.fotos.length - 1; idx++) {
    if (!d.fotos[idx].fotos.length) return alert(`Anexe ao menos uma foto em "${d.fotos[idx].comentario}".`);
  }
  if (!d.satisfacao_estrelas) return alert('Selecione a avaliação por estrelas da pesquisa de satisfação.');
  if (!d.satisfacao_autoriza) return alert('Responda se autoriza o uso do feedback.');
  if (!d.assinatura_cliente_nome || !d.assinatura_cliente_img) return alert('Colete o nome e a assinatura do cliente.');
  if (!d.assinatura_tecnico_nome || !d.assinatura_tecnico_img) return alert('Colete o nome e a assinatura do técnico.');
  const emails = d.emails_copia.map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) return alert('Informe ao menos um e-mail para envio do termo.');
  d.emails_copia = emails;

  try {
    const { relatorio } = d.id
      ? await api(`/api/relatorios-manutencao/${d.id}`, { method: 'PUT', body: d })
      : await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfRelatorioCorretiva(relatorio, logo);
    window.open(url, '_blank');
    const assunto = encodeURIComponent(`Termo de Manutenção Corretiva — ${d.empresa}`);
    const corpo = encodeURIComponent(`Olá,\n\nSegue em anexo o Termo de Manutenção Corretiva (OS ${d.os_uf}/${d.os_numero}/${d.os_ano}) referente ao atendimento em ${d.empresa}.\n\nO PDF foi baixado neste dispositivo — anexe-o antes de enviar.\n\nAtenciosamente,\n${USER.nome}`);
    window.open(`mailto:${emails.join(',')}?subject=${assunto}&body=${corpo}`, '_blank');
    mostrarToast(d.id ? 'Termo atualizado e PDF gerado.' : 'Termo salvo e PDF gerado — anexe-o no e-mail que foi aberto.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

// ---------- Relatório > Manual > Relatório Técnico ----------
// mesma família do Relatório Manual, no molde do "Completo" (Dados do cliente, Tipo de serviço,
// Dados do equipamento, Técnico responsável, Laudo técnico, Serviços realizados, Peças, Fotos,
// Observações), mas com o tipo de serviço podendo marcar mais de uma opção, o equipamento
// escolhido de uma lista (mesma EQUIPAMENTOS_PREVENTIVA do front, em vez de texto livre), período
// de reparo calculado automaticamente e um relatório fotográfico único (sem grupos por modelo).
// Sem pesquisa de satisfação, assinatura ou envio por e-mail — só preencher e gerar o PDF.
let relatorioTecnicoDraft = null;
function relatorioTecnicoPadrao() {
  return {
    tipo: 'relatorio_tecnico',
    empresa: '', contato: '', telefone: '',
    tipo_servico: [], tipo_servico_outros: '',
    marca: '', equipamento: '', numero_serie: '', data_fabricacao: '',
    garantia: '', garantia_obs: '',
    acessorios: '', defeito_informado: '',
    data_entrada: '', data_conclusao: '',
    laudo_tecnico: '', servico_realizado: '',
    pecas: [],
    fotos: [],
    observacoes: '',
  };
}

function mostrarFormRelatorioTecnico(existente) {
  relatorioTecnicoDraft = existente ? JSON.parse(JSON.stringify(existente)) : relatorioTecnicoPadrao();
  const d = relatorioTecnicoDraft;
  const editando = !!d.id;
  const tiposServico = [['amostra', 'Amostra'], ['analise', 'Análise'], ['preventiva', 'Preventiva'], ['corretiva', 'Corretiva'], ['outros', 'Outros']];
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar' : 'Novo'} Relatório Técnico</h1><p>Relatório de manutenção interna, avulso — sem vínculo com nenhuma O.S. Campos com * são obrigatórios.</p></div>

    <div class="panel">
      <h2>Dados do cliente</h2>
      <div class="form-grid">
        <div class="full"><label>Empresa*</label><input id="rt-empresa" value="${esc(d.empresa)}"></div>
        <div><label>Contato*</label><input id="rt-contato" value="${esc(d.contato)}"></div>
        <div><label>Telefone*</label><input id="rt-telefone" placeholder="(XX) XXXXX-XXXX" value="${esc(d.telefone)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Tipo de serviço*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Selecione um ou mais tipos aplicáveis a este atendimento.</p>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        ${tiposServico.map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="checkbox" class="rt-tipo-servico" value="${v}" style="width:auto;" ${d.tipo_servico.includes(v) ? 'checked' : ''} onchange="document.getElementById('rt-tipo-outros-wrap').style.display = document.querySelector('.rt-tipo-servico[value=\\'outros\\']').checked ? 'block' : 'none';"> ${l}</label>`).join('')}
      </div>
      <div id="rt-tipo-outros-wrap" style="display:${d.tipo_servico.includes('outros') ? 'block' : 'none'};"><label>Especifique</label><input id="rt-tipo-servico-outros" value="${esc(d.tipo_servico_outros)}"></div>
    </div>

    <div class="panel">
      <h2>Dados do equipamento</h2>
      <div class="form-grid">
        <div><label>Marca*</label><input id="rt-marca" value="${esc(d.marca)}"></div>
        <div>
          <label>Equipamento*</label>
          <select id="rt-equipamento" onchange="document.getElementById('rt-equipamento-outro-wrap').style.display = this.value === 'Outro' ? 'block' : 'none';">
            <option value="" ${!d.equipamento || !EQUIPAMENTOS_PREVENTIVA[d.equipamento] ? 'selected' : ''} disabled>Selecione...</option>
            ${Object.keys(EQUIPAMENTOS_PREVENTIVA).map((nome) => `<option value="${esc(nome)}" ${d.equipamento === nome ? 'selected' : ''}>${esc(nome)}</option>`).join('')}
            <option value="Outro" ${d.equipamento && !EQUIPAMENTOS_PREVENTIVA[d.equipamento] ? 'selected' : ''}>Outro</option>
          </select>
        </div>
        <div id="rt-equipamento-outro-wrap" class="full" style="display:${d.equipamento && !EQUIPAMENTOS_PREVENTIVA[d.equipamento] ? 'block' : 'none'};">
          <label>Especifique o equipamento*</label>
          <input id="rt-equipamento_outro" value="${esc(d.equipamento && !EQUIPAMENTOS_PREVENTIVA[d.equipamento] ? d.equipamento : '')}">
        </div>
        <div><label>Nº de série*</label><input id="rt-numero_serie" placeholder="Ex.: SN-000000" value="${esc(d.numero_serie)}"></div>
        <div><label>Data de fabricação (MM/AAAA)</label><input id="rt-data_fabricacao" placeholder="MM/AAAA" maxlength="7" value="${esc(d.data_fabricacao)}"></div>
      </div>
      <label>Garantia*</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        ${[['sim', 'Sim'], ['nao', 'Não'], ['outros', 'Outros']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rt-garantia" value="${v}" style="width:auto;" ${d.garantia === v ? 'checked' : ''} onchange="document.getElementById('rt-garantia-outros-wrap').style.display = this.value === 'outros' ? 'block' : 'none';"> ${l}</label>`).join('')}
      </div>
      <div id="rt-garantia-outros-wrap" style="display:${d.garantia === 'outros' ? 'block' : 'none'};"><label>Especifique*</label><input id="rt-garantia_obs" value="${esc(d.garantia_obs)}"></div>
      <div class="form-grid">
        <div class="full"><label>Acessórios recebidos</label><input id="rt-acessorios" placeholder="ex: cabo de força, fonte..." value="${esc(d.acessorios)}"></div>
      </div>
      <label>Defeito informado*</label>
      <textarea id="rt-defeito_informado" placeholder="Defeito relatado pelo cliente ao solicitar o serviço...">${esc(d.defeito_informado)}</textarea>
    </div>

    <div class="panel">
      <h2>Técnico responsável</h2>
      <div class="form-grid">
        <div><label>Nome</label><input value="${esc(USER.nome)}" disabled></div>
        <div><label>E-mail</label><input value="${esc(USER.email || '')}" disabled></div>
        <div><label>Data de entrada</label><input id="rt-data_entrada" type="datetime-local" value="${esc(d.data_entrada)}" onchange="atualizarPeriodoTecnico()"></div>
        <div><label>Data de conclusão</label><input id="rt-data_conclusao" type="datetime-local" value="${esc(d.data_conclusao)}" onchange="atualizarPeriodoTecnico()"></div>
        <div><label>Período de reparo</label><input id="rt-periodo" value="${esc(periodoReparo(d))}" disabled></div>
      </div>
    </div>

    <div class="panel">
      <h2>Laudo técnico*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Defeito encontrado e análise do estado do equipamento</p>
      <textarea id="rt-laudo_tecnico" placeholder="Descreva o diagnóstico...">${esc(d.laudo_tecnico)}</textarea>
    </div>

    <div class="panel">
      <h2>Serviços realizados*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Manutenção realizada / resultados de amostra</p>
      <textarea id="rt-servico_realizado" placeholder="Descreva o que foi feito...">${esc(d.servico_realizado)}</textarea>
    </div>

    <div class="panel">
      <h2>Peças fornecidas</h2>
      <div class="steps-list" id="rt-pecas"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarPecaTecnico()">+ Adicionar peça</button>
    </div>

    <div class="panel">
      <h2>Relatório fotográfico*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Anexe ao menos uma foto do equipamento/serviço realizado.</p>
      <div class="step-photos" id="rt-fotos"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">📷</span>Câmera
          <input type="file" accept="image/*" capture="environment" style="display:none" onchange="adicionarFotosTecnico(event)">
        </label>
        <label class="photo-add" style="margin-top:0;">
          <span class="plus">+</span>Galeria
          <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosTecnico(event)">
        </label>
      </div>
    </div>

    <div class="panel">
      <h2>Observações do serviço</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Opcional</p>
      <textarea id="rt-observacoes" placeholder="Observações adicionais do técnico, se houver...">${esc(d.observacoes)}</textarea>
    </div>

    <div class="panel">
      <p style="font-size:12.5px; color:var(--ink-soft);">Ao concluir, o PDF do relatório é gerado automaticamente para download.</p>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="renderRelatorioManutencao()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="concluirRelatorioTecnico()">Concluir e gerar PDF</button>
      </div>
    </div>`;
  renderPecasTecnico();
  renderFotosTecnico();
}

function renderPecasTecnico() {
  document.getElementById('rt-pecas').innerHTML = relatorioTecnicoDraft.pecas.map((p, i) => `
    <div class="step-item">
      <div class="step-main">
        <div class="step-num">${i + 1}</div>
        <input placeholder="Descrição da peça" value="${esc(p.descricao || '')}" style="flex:2;" oninput="relatorioTecnicoDraft.pecas[${i}].descricao=this.value;">
        <input placeholder="Código PMK" value="${esc(p.codigo_pmk || '')}" style="flex:1;" oninput="relatorioTecnicoDraft.pecas[${i}].codigo_pmk=this.value;">
        <input placeholder="Qtd" value="${esc(p.quantidade || '')}" style="flex:0 0 60px;" oninput="relatorioTecnicoDraft.pecas[${i}].quantidade=this.value;">
        <button class="step-rm" onclick="removerPecaTecnico(${i})">×</button>
      </div>
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhuma peça adicionada.</p>';
}
function adicionarPecaTecnico() { relatorioTecnicoDraft.pecas.push({ descricao: '', codigo_pmk: '', quantidade: '' }); renderPecasTecnico(); }
function removerPecaTecnico(i) { relatorioTecnicoDraft.pecas.splice(i, 1); renderPecasTecnico(); }

// relatório fotográfico único (sem grupos por modelo) — mesmo mecanismo do Laudo Técnico da O.S.
function renderFotosTecnico() {
  document.getElementById('rt-fotos').innerHTML = relatorioTecnicoDraft.fotos.map((f, j) => `
    <div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do relatório">
      <button class="photo-rm" onclick="removerFotoTecnico(${j})">×</button>
    </div>`).join('');
}
function adicionarFotosTecnico(event) {
  lerFotosComoDataUrl(event.target.files || []).then((dataUrls) => {
    relatorioTecnicoDraft.fotos.push(...dataUrls);
    renderFotosTecnico();
  });
}
function removerFotoTecnico(j) { relatorioTecnicoDraft.fotos.splice(j, 1); renderFotosTecnico(); }

function atualizarPeriodoTecnico() {
  const data_entrada = document.getElementById('rt-data_entrada').value;
  const data_conclusao = document.getElementById('rt-data_conclusao').value;
  document.getElementById('rt-periodo').value = periodoReparo({ data_entrada, data_conclusao });
}

async function concluirRelatorioTecnico() {
  const d = relatorioTecnicoDraft;
  d.empresa = document.getElementById('rt-empresa').value;
  d.contato = document.getElementById('rt-contato').value;
  d.telefone = document.getElementById('rt-telefone').value;
  d.tipo_servico = Array.from(document.querySelectorAll('.rt-tipo-servico:checked')).map((el) => el.value);
  d.tipo_servico_outros = document.getElementById('rt-tipo-servico-outros').value;
  d.marca = document.getElementById('rt-marca').value;
  const equipamentoSelecionado = document.getElementById('rt-equipamento').value;
  d.equipamento = equipamentoSelecionado === 'Outro' ? document.getElementById('rt-equipamento_outro').value : equipamentoSelecionado;
  d.numero_serie = document.getElementById('rt-numero_serie').value;
  d.data_fabricacao = document.getElementById('rt-data_fabricacao').value;
  const garantia = document.querySelector('input[name="rt-garantia"]:checked');
  d.garantia = garantia ? garantia.value : '';
  d.garantia_obs = document.getElementById('rt-garantia_obs').value;
  d.acessorios = document.getElementById('rt-acessorios').value;
  d.defeito_informado = document.getElementById('rt-defeito_informado').value;
  d.data_entrada = document.getElementById('rt-data_entrada').value;
  d.data_conclusao = document.getElementById('rt-data_conclusao').value;
  d.laudo_tecnico = document.getElementById('rt-laudo_tecnico').value;
  d.servico_realizado = document.getElementById('rt-servico_realizado').value;
  d.observacoes = document.getElementById('rt-observacoes').value;

  if (!d.empresa.trim() || !d.contato.trim() || !d.telefone.trim()) return alert('Preencha os dados do cliente (Empresa, Contato e Telefone).');
  if (!d.tipo_servico.length) return alert('Selecione ao menos um tipo de serviço.');
  if (!d.marca.trim() || !d.equipamento.trim() || !d.numero_serie.trim()) return alert('Preencha os dados do equipamento (Marca, Equipamento e Nº de série).');
  if (!d.garantia) return alert('Responda se o equipamento está na garantia.');
  if (d.garantia === 'outros' && !d.garantia_obs.trim()) return alert('Especifique a garantia.');
  if (!d.defeito_informado.trim()) return alert('Descreva o defeito informado.');
  if (!d.laudo_tecnico.trim()) return alert('Preencha o laudo técnico.');
  if (!d.servico_realizado.trim()) return alert('Descreva o serviço realizado.');
  if (!d.fotos.length) return alert('Anexe ao menos uma foto no relatório fotográfico.');

  try {
    const { relatorio } = d.id
      ? await api(`/api/relatorios-manutencao/${d.id}`, { method: 'PUT', body: d })
      : await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfRelatorioTecnico(relatorio, logo);
    window.open(url, '_blank');
    mostrarToast(d.id ? 'Relatório atualizado e PDF gerado.' : 'Relatório salvo e PDF gerado.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

function gerarPdfRelatorioTecnico(r, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: nomeArquivoRelatorioManutencao(r) });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function opcaoCheckbox(x, yy, marcado, label) {
    doc.setDrawColor(...PDF_COR.ink); doc.setLineWidth(0.9);
    doc.rect(x, yy - 7, 7, 7, 'S');
    if (marcado) { doc.setFillColor(...PDF_COR.ink); doc.rect(x + 1.2, yy - 5.8, 4.6, 4.6, 'F'); }
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.ink);
    doc.text(label, x + 11, yy);
    return x + 11 + doc.getTextWidth(label);
  }

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Relatório Técnico', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  function tituloCentro(t, sub, apertado) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13;
    if (sub) {
      doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(sub, pageW / 2, y, { align: 'center' }); y += 13;
      y += 4;
    } else {
      y += apertado ? 4 : 16;
    }
  }

  function tituloEsquerda(t) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(t, margem, y); y += 14;
  }

  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  // ===== capa =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(22); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('RELATÓRIO TÉCNICO', pageW / 2, 420, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(limparPdf(r.empresa).toUpperCase() || '—', pageW / 2, 445, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados do cliente');
  linhaCampos([{ label: 'Empresa', valor: r.empresa, frac: 1 }]);
  linhaCampos([{ label: 'Contato', valor: r.contato, frac: 1 }]);
  linhaCampos([{ label: 'Telefone', valor: r.telefone, frac: 1 }]);
  y += 16;

  tituloCentro('Tipo de serviço');
  {
    const tipos = Array.isArray(r.tipo_servico) ? r.tipo_servico : [];
    const opcoes = [['amostra', 'AMOSTRA'], ['analise', 'ANÁLISE'], ['preventiva', 'PREVENTIVA'], ['corretiva', 'CORRETIVA'], ['outros', 'OUTROS']];
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5);
    const larguras = opcoes.map(([, l]) => 11 + doc.getTextWidth(l));
    const gap = 14;
    const total = larguras.reduce((a, b) => a + b, 0) + gap * (larguras.length - 1);
    let cx = pageW / 2 - total / 2;
    opcoes.forEach(([v, l], idx) => { opcaoCheckbox(cx, y, tipos.includes(v), l); cx += larguras[idx] + gap; });
    y += 20;
    if (tipos.includes('outros') && r.tipo_servico_outros) {
      doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(limparPdf(`Outros: ${r.tipo_servico_outros}`), pageW / 2, y, { align: 'center' });
      y += 12;
    }
    y += 8;
  }

  tituloCentro('Dados do equipamento');
  linhaCampos([{ label: 'Marca', valor: r.marca, frac: 0.34 }, { label: 'Equipamento', valor: r.equipamento, frac: 0.4 }, { label: 'Nº Série', valor: r.numero_serie, frac: 0.26 }]);
  {
    const wGarantia = largura * 0.62, wData = largura - wGarantia, altura = 20;
    if (y + altura > pageH - margem) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.rect(margem, y, wGarantia, altura, 'S');
    doc.rect(margem + wGarantia, y, wData, altura, 'S');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
    doc.text('GARANTIA:', margem + 7, y + 13);
    let cx = margem + 7 + doc.getTextWidth('GARANTIA: ') + 4;
    [['sim', 'SIM'], ['nao', 'NÃO'], ['outros', 'OUTROS']].forEach(([v, l]) => { cx = opcaoCheckbox(cx, y + 13, r.garantia === v, l) + 10; });
    doc.setFont(undefined, 'bold'); doc.text('DATA DE FABRICAÇÃO: ', margem + wGarantia + 7, y + 13);
    const wLblFab = doc.getTextWidth('DATA DE FABRICAÇÃO: ');
    doc.setFont(undefined, 'normal'); doc.text(limparPdf(r.data_fabricacao) || '—', margem + wGarantia + 7 + wLblFab, y + 13);
    y += altura;
  }
  if (r.garantia === 'outros' && r.garantia_obs) linhaCampos([{ label: 'Especificação da garantia', valor: r.garantia_obs, frac: 1 }]);
  linhaCampos([{ label: 'Acessórios', valor: r.acessorios, frac: 1 }]);
  linhaCampos([{ label: 'Defeito informado', valor: r.defeito_informado, frac: 1 }]);
  y += 16;

  tituloCentro('Técnico responsável');
  linhaCampos([{ label: 'Nome', valor: r.tecnico_nome, frac: 0.5 }, { label: 'E-mail', valor: r.tecnico_email, frac: 0.5 }]);
  linhaCampos([{ label: 'Entrada', valor: fmtData(r.data_entrada), frac: 0.33 }, { label: 'Conclusão', valor: fmtData(r.data_conclusao), frac: 0.33 }, { label: 'Período', valor: periodoReparo(r), frac: 0.34 }]);
  y += 16;

  tituloCentro('Laudo técnico', 'Defeito encontrado e análise do estado do equipamento');
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(r.laudo_tecnico) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 16;
  }

  tituloCentro('Serviços realizados', 'Manutenção realizada / resultados de amostra', true);
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(r.servico_realizado) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 16;
  }

  tituloEsquerda('Peças fornecidas');
  {
    const cols = [{ t: 'Item', frac: 0.1 }, { t: 'Descrição da peça', frac: 0.52 }, { t: 'Código PMK', frac: 0.24 }, { t: 'Qtd.', frac: 0.14 }];
    const larguras = cols.map((c) => largura * c.frac);
    if (y + 20 > pageH - margem) novaPagina();
    let cx = margem;
    doc.setFillColor(...PDF_COR.navy);
    doc.rect(margem, y, largura, 18, 'F');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
    cols.forEach((c, i) => { doc.text(c.t, cx + 6, y + 12); cx += larguras[i]; });
    y += 18;
    const pecas = r.pecas || [];
    if (!pecas.length) {
      if (y + 18 > pageH - margem) novaPagina();
      doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
      doc.setFont(undefined, 'italic'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text('Nenhuma peça informada', margem + 6, y + 12);
      y += 18;
    } else {
      pecas.forEach((p, i) => {
        if (y + 18 > pageH - margem) novaPagina();
        cx = margem;
        doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
        doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
        const valores = [String(i + 1), limparPdf(p.descricao) || '—', limparPdf(p.codigo_pmk) || '—', limparPdf(p.quantidade) || '—'];
        valores.forEach((v, j) => { doc.text(v, cx + 6, y + 12); cx += larguras[j]; });
        y += 18;
      });
    }
    y += 16;
  }

  if (r.observacoes) {
    tituloCentro('Observações do serviço');
    if (y > pageH - margem - 40) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(r.observacoes), largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 14;
  }

  const fotos = r.fotos || [];
  if (fotos.length) {
    const gapCheck = 12, wImgCheck = (largura - gapCheck) / 2, hImgCheck = wImgCheck * 0.68;
    if (y + 34 + hImgCheck > pageH - margem) novaPagina();
  }
  tituloCentro('Relatório fotográfico', null, true);
  if (fotos.length) {
    const gap = 12, wImg = (largura - gap) / 2, hImg = wImg * 0.68;
    for (let i = 0; i < fotos.length; i += 2) {
      if (y + hImg > pageH - margem) novaPagina();
      [fotos[i], fotos[i + 1]].forEach((f, j) => {
        if (!f) return;
        const cx = margem + j * (wImg + gap);
        try {
          const m = /^data:image\/(\w+);/.exec(f);
          const formato = m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
          doc.setDrawColor(...PDF_COR.line);
          doc.roundedRect(cx - 1, y - 1, wImg + 2, hImg + 2, 3, 3, 'S');
          doc.addImage(f, formato, cx, y, wImg, hImg);
        } catch (e) {}
      });
      y += hImg + gap;
    }
  } else {
    doc.setFontSize(9); doc.setFont(undefined, 'italic'); doc.setTextColor(...PDF_COR.inkSoft);
    doc.text('Nenhuma foto anexada.', margem, y); y += 16;
  }

  // ===== página de contato =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });
  doc.setFontSize(8); doc.setTextColor(...PDF_COR.inkSoft);
  doc.text(limparPdf(`Autor: ${r.autor_nome || '—'} · ${fmtData(r.criado_em)}`), pageW / 2, pageH - margem - 10, { align: 'center' });

  return doc.output('bloburl');
}

// ---------- Relatório > Manual > Termo de Aceite ----------
// mesma família do Relatório Manual, avulso — reaproveita o check-list (CHECKLIST_CORRETIVA), o
// aceite, a avaliação de desempenho e a assinatura do "Relatório técnico" ligado à O.S.
// (renderRelatorioCorretiva, prefixo "rc-"), mas como termo independente: identificação com O.S.
// e modelo de máquina escolhido de uma lista (mesma EQUIPAMENTOS_PREVENTIVA da Preventiva), sem
// fotos ou peças.
let relatorioAceiteDraft = null;
function relatorioAceitePadrao() {
  return {
    tipo: 'aceite_entrega',
    os_uf: '', os_numero: '', os_ano: '',
    data_inicial: '', data_final: '',
    modelo_maquina: '', numero_serie: '',
    servico: '',
    empresa: '', setor: '', endereco: '', numero: '', bairro: '', estado: '', cidade: '', cep: '', contato: '',
    checklist: CHECKLIST_CORRETIVA.map((item) => ({ item, resposta: '', observacao: '' })),
    observacoes: '',
    aceite: '',
    satisfacao_estrelas: 0, satisfacao_duvidas: '', satisfacao_apto: '',
    assinatura_cliente_nome: '', assinatura_cliente_img: null,
    assinatura_tecnico_nome: '', assinatura_tecnico_img: null,
    emails_copia: [''],
  };
}

function textoSobreEquipamentoAceite(modelo) {
  return `A máquina está coberta por uma garantia de 1 ano a partir da data de entrega. Esta garantia cobre defeitos de fabricação e mão de obra. Para obter assistência durante o período de garantia, entre em contato conosco através dos seguintes meios de contato.<br><br>
    <b>WhatsApp:</b> ${empresaWhatsapp()} &nbsp; <b>Telefone:</b> ${empresaTelefone()}<br>
    <b>E-mail:</b> ${empresaEmails().slice(0, 2).join(' / ')}<br><br>
    Estamos confiantes de que o equipamento${modelo ? ` modelo <b>${esc(modelo)}</b>` : ''} atenderá às suas expectativas e necessidades de produção. Estamos à disposição para quaisquer perguntas adicionais ou assistência que você possa precisar.`;
}

function mostrarFormRelatorioAceite(existente) {
  relatorioAceiteDraft = existente ? JSON.parse(JSON.stringify(existente)) : relatorioAceitePadrao();
  const d = relatorioAceiteDraft;
  const editando = !!d.id;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar' : 'Novo'} Termo de Aceite da Entrega</h1><p>Relatório de manutenção interna, avulso — sem vínculo com nenhuma O.S. Campos com * são obrigatórios.</p></div>

    <div class="panel">
      <h2>Identificação</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Nº preenchido no ato da entrega.</p>
      <div class="form-grid">
        <div><label>O.S. Nº — UF*</label><input id="rae-os_uf" maxlength="2" placeholder="UF" value="${esc(d.os_uf)}" style="text-transform:uppercase;"></div>
        <div><label>O.S. Nº — Número*</label><input id="rae-os_numero" placeholder="000" value="${esc(d.os_numero)}"></div>
        <div><label>O.S. Nº — Ano*</label><input id="rae-os_ano" placeholder="0000" value="${esc(d.os_ano)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Dados do cliente</h2>
      <div class="form-grid">
        <div><label>Data inicial*</label><input id="rae-data_inicial" type="date" value="${esc(d.data_inicial)}"></div>
        <div><label>Data final*</label><input id="rae-data_final" type="date" value="${esc(d.data_final)}"></div>
        <div>
          <label>Modelo da máquina*</label>
          <select id="rae-modelo_maquina" onchange="selecionarModeloAceite(this.value)">
            <option value="" ${!d.modelo_maquina || !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'selected' : ''} disabled>Selecione...</option>
            ${Object.keys(EQUIPAMENTOS_PREVENTIVA).map((nome) => `<option value="${esc(nome)}" ${d.modelo_maquina === nome ? 'selected' : ''}>${esc(nome)}</option>`).join('')}
            <option value="Outro" ${d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'selected' : ''}>Outro</option>
          </select>
        </div>
        <div id="rae-modelo_maquina-outro-wrap" style="display:${d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? 'block' : 'none'};">
          <label>Especifique o modelo*</label>
          <input id="rae-modelo_maquina_outro" value="${esc(d.modelo_maquina && !EQUIPAMENTOS_PREVENTIVA[d.modelo_maquina] ? d.modelo_maquina : '')}" oninput="atualizarSobreEquipamentoAceite();">
        </div>
        <div><label>Nº de série*</label><input id="rae-numero_serie" placeholder="Ex.: SN-000000" value="${esc(d.numero_serie)}"></div>
        <div><label>Serviço*</label><input id="rae-servico" value="${esc(d.servico)}"></div>
        <div><label>Técnico*</label><input value="${esc(USER.nome)}" disabled></div>
        <div class="full"><label>Empresa*</label><input id="rae-empresa" value="${esc(d.empresa)}"></div>
        <div><label>Setor*</label><input id="rae-setor" value="${esc(d.setor)}"></div>
        <div class="full"><label>Endereço*</label><input id="rae-endereco" value="${esc(d.endereco)}"></div>
        <div><label>Número*</label><input id="rae-numero" placeholder="Ex.: 123" value="${esc(d.numero)}"></div>
        <div><label>Bairro*</label><input id="rae-bairro" placeholder="Ex.: Centro" value="${esc(d.bairro)}"></div>
        <div>
          <label>Estado*</label>
          <select id="rae-estado" onchange="atualizarRegiaoAceite()">
            <option value="">Selecione</option>
            ${Object.keys(UF_REGIAO).map((uf) => `<option value="${uf}" ${d.estado === uf ? 'selected' : ''}>${uf}</option>`).join('')}
          </select>
          <p style="color:var(--ink-soft); font-size:12.5px; margin-top:4px;">Região: <span id="rae-regiao">${esc(UF_REGIAO[d.estado] || '—')}</span></p>
        </div>
        <div><label>Cidade*</label><input id="rae-cidade" placeholder="Ex.: Jundiaí" value="${esc(d.cidade)}"></div>
        <div><label>CEP*</label><input id="rae-cep" placeholder="00000-000" value="${esc(d.cep)}"></div>
        <div><label>Contato*</label><input id="rae-contato" value="${esc(d.contato)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Item / entrega / observação*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Marque Sim, Não ou N/A para cada item. Use a observação para detalhar qualquer pendência.</p>
      <div id="rae-checklist"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarItemChecklistAceite()">+ Adicionar item</button>
    </div>

    <div class="panel">
      <h2>Sobre o equipamento</h2>
      <p id="rae-sobre-equipamento" style="font-size:13.5px; line-height:1.6;">${textoSobreEquipamentoAceite(d.modelo_maquina)}</p>
    </div>

    <div class="panel">
      <h2>Observações*</h2>
      <textarea id="rae-observacoes" placeholder="Observações adicionais sobre a entrega (obrigatório — escreva N/A se não houver)">${esc(d.observacoes)}</textarea>
    </div>

    <div class="panel">
      <h2>Aceite*</h2>
      <p style="font-size:13.5px; color:var(--ink-soft); line-height:1.6;">Por meio da assinatura deste termo, formalizamos o aceite da entrega técnica final deste serviço.</p>
      <label style="display:flex; align-items:center; gap:8px; font-weight:600; text-transform:none; margin-bottom:8px;"><input type="radio" name="rae-aceite" value="aceito" ${d.aceite === 'aceito' ? 'checked' : ''} style="width:auto;"> Li e aceito os termos acima</label>
      <label style="display:flex; align-items:center; gap:8px; font-weight:600; text-transform:none;"><input type="radio" name="rae-aceite" value="nao_aceito" ${d.aceite === 'nao_aceito' ? 'checked' : ''} style="width:auto;"> Não aceito</label>
    </div>

    <div class="panel">
      <h2>Avaliação de desempenho*</h2>
      <label>Em uma escala de 1 a 5, qual a sua satisfação com a entrega técnica?</label>
      <div id="rae-estrelas" style="margin-bottom:18px;"></div>
      <label>O técnico sanou todas as dúvidas na entrega da máquina?</label>
      <div style="display:flex; gap:18px; margin-bottom:18px;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rae-duvidas" value="sim" ${d.satisfacao_duvidas === 'sim' ? 'checked' : ''} style="width:auto;"> Sim</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rae-duvidas" value="nao" ${d.satisfacao_duvidas === 'nao' ? 'checked' : ''} style="width:auto;"> Não</label>
      </div>
      <label>Você se julga apto a operar o equipamento?</label>
      <div style="display:flex; gap:18px;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rae-apto" value="sim" ${d.satisfacao_apto === 'sim' ? 'checked' : ''} style="width:auto;"> Sim</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rae-apto" value="nao" ${d.satisfacao_apto === 'nao' ? 'checked' : ''} style="width:auto;"> Não</label>
      </div>
    </div>

    <div class="panel">
      <h2>Assinatura*</h2>
      <div class="row2">
        ${blocoAssinaturaAceite('cliente', 'Cliente')}
        ${blocoAssinaturaAceite('tecnico', 'Técnico')}
      </div>
    </div>

    <div class="panel">
      <h2>Envio do termo*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">E-mails que devem receber uma cópia deste termo assim que ele for concluído e assinado.</p>
      <div id="rae-emails"></div>
      <button class="btn btn-ghost btn-sm" onclick="adicionarEmailAceite()">+ Adicionar e-mail</button>
    </div>

    <div class="panel">
      <p style="font-size:12.5px; color:var(--ink-soft);">Ao concluir, o PDF do termo é gerado automaticamente e o e-mail para os destinatários é aberto pronto para envio.</p>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="renderRelatorioManutencao()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="concluirRelatorioAceite()">Concluir e enviar termo</button>
      </div>
    </div>`;
  renderChecklistAceite();
  renderEstrelasAceite();
  renderEmailsAceite();
  montarAssinaturaAceite('cliente');
  montarAssinaturaAceite('tecnico');
}

function selecionarModeloAceite(nome) {
  document.getElementById('rae-modelo_maquina-outro-wrap').style.display = nome === 'Outro' ? 'block' : 'none';
  atualizarSobreEquipamentoAceite();
}
function atualizarSobreEquipamentoAceite() {
  const selecionado = document.getElementById('rae-modelo_maquina').value;
  const modelo = selecionado === 'Outro' ? document.getElementById('rae-modelo_maquina_outro').value : selecionado;
  document.getElementById('rae-sobre-equipamento').innerHTML = textoSobreEquipamentoAceite(modelo);
}
function atualizarRegiaoAceite() {
  const uf = document.getElementById('rae-estado').value;
  document.getElementById('rae-regiao').textContent = UF_REGIAO[uf] || '—';
}

function renderChecklistAceite() {
  document.getElementById('rae-checklist').innerHTML = relatorioAceiteDraft.checklist.map((c, i) => `
    <div class="step-item" style="margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; align-items:center; gap:6px; flex:1; min-width:160px;">
          <span style="color:var(--navy); font-size:13.5px; font-weight:700;">${String(i + 1).padStart(2, '0')}</span>
          <input placeholder="Nome do item" value="${esc(c.item)}" style="flex:1;" oninput="relatorioAceiteDraft.checklist[${i}].item=this.value;">
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          ${['sim', 'nao', 'na'].map((v) => `<button type="button" class="btn-outline-sm" style="${c.resposta === v ? 'background:var(--blue); color:#fff; border-color:var(--blue);' : ''}" onclick="marcarChecklistAceite(${i}, '${v}')">${v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : 'N/A'}</button>`).join('')}
          <button class="step-rm" onclick="removerItemChecklistAceite(${i})">×</button>
        </div>
      </div>
      <input placeholder="Observação (opcional)" value="${esc(c.observacao)}" oninput="relatorioAceiteDraft.checklist[${i}].observacao=this.value;">
    </div>`).join('') || '<p style="color:var(--ink-soft); font-size:13px;">Nenhum item no check-list — adicione ao menos um.</p>';
}
function marcarChecklistAceite(i, valor) { relatorioAceiteDraft.checklist[i].resposta = valor; renderChecklistAceite(); }
function adicionarItemChecklistAceite() { relatorioAceiteDraft.checklist.push({ item: '', resposta: '', observacao: '' }); renderChecklistAceite(); }
function removerItemChecklistAceite(i) { relatorioAceiteDraft.checklist.splice(i, 1); renderChecklistAceite(); }

function renderEstrelasAceite() {
  document.getElementById('rae-estrelas').innerHTML = [1, 2, 3, 4, 5].map((n) => `
    <button type="button" onclick="marcarEstrelaAceite(${n})" style="background:none; border:none; cursor:pointer; font-size:28px; color:${n <= relatorioAceiteDraft.satisfacao_estrelas ? 'var(--blue)' : '#D8E2EF'};">★</button>
  `).join('');
}
function marcarEstrelaAceite(n) { relatorioAceiteDraft.satisfacao_estrelas = n; renderEstrelasAceite(); }

function renderEmailsAceite() {
  document.getElementById('rae-emails').innerHTML = relatorioAceiteDraft.emails_copia.map((em, i) => `
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <input placeholder="nome@empresa.com" value="${esc(em)}" oninput="relatorioAceiteDraft.emails_copia[${i}]=this.value;">
      ${relatorioAceiteDraft.emails_copia.length > 1 ? `<button class="btn-outline-sm" onclick="removerEmailAceite(${i})">×</button>` : ''}
    </div>`).join('');
}
function adicionarEmailAceite() { relatorioAceiteDraft.emails_copia.push(''); renderEmailsAceite(); }
function removerEmailAceite(i) { relatorioAceiteDraft.emails_copia.splice(i, 1); renderEmailsAceite(); }

// ---------- assinatura (canvas) — mesmo mecanismo do relatório preventivo, prefixo "rae-" ----------
function blocoAssinaturaAceite(chave, titulo) {
  return `
    <div>
      <label>${titulo}</label>
      <input id="rae-assinatura-${chave}-nome" placeholder="Nome do ${titulo.toLowerCase()}" value="${esc((relatorioAceiteDraft['assinatura_' + chave + '_nome']) || '')}" oninput="relatorioAceiteDraft.assinatura_${chave}_nome=this.value;">
      <canvas id="rae-canvas-${chave}" width="360" height="150" style="width:100%; max-width:360px; height:150px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div id="rae-assinatura-${chave}-status" style="font-size:12px; color:var(--ink-soft); margin:6px 0;">Assinatura pendente</div>
      <div style="display:flex; gap:8px;">
        <button class="btn-outline-sm" onclick="ampliarAssinaturaAceite('${chave}')">⤢ Ampliar para assinar</button>
        <button class="btn-outline-sm" onclick="limparAssinaturaAceite('${chave}')">Limpar</button>
      </div>
    </div>`;
}
const assinaturaEstadoAceite = {};
function montarAssinaturaAceite(chave) {
  const canvas = document.getElementById('rae-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  assinaturaEstadoAceite[chave] = { desenhando: false, temTraco: false };
  if (relatorioAceiteDraft['assinatura_' + chave + '_img']) {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); assinaturaEstadoAceite[chave].temTraco = true; atualizarStatusAssinaturaAceite(chave); };
    img.src = relatorioAceiteDraft['assinatura_' + chave + '_img'];
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); assinaturaEstadoAceite[chave].desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!assinaturaEstadoAceite[chave].desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); assinaturaEstadoAceite[chave].temTraco = true; }
  function parar() {
    if (!assinaturaEstadoAceite[chave].desenhando) return;
    assinaturaEstadoAceite[chave].desenhando = false;
    if (assinaturaEstadoAceite[chave].temTraco) {
      relatorioAceiteDraft['assinatura_' + chave + '_img'] = canvas.toDataURL('image/png');
      atualizarStatusAssinaturaAceite(chave);
    }
  }
  canvas.addEventListener('mousedown', iniciar);
  canvas.addEventListener('mousemove', mover);
  window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false });
  canvas.addEventListener('touchmove', mover, { passive: false });
  canvas.addEventListener('touchend', parar);
}
function atualizarStatusAssinaturaAceite(chave) {
  const el = document.getElementById(`rae-assinatura-${chave}-status`);
  if (el) { el.textContent = assinaturaEstadoAceite[chave].temTraco ? 'Assinatura registrada' : 'Assinatura pendente'; el.style.color = assinaturaEstadoAceite[chave].temTraco ? 'var(--green)' : 'var(--ink-soft)'; }
}
function limparAssinaturaAceite(chave) {
  const canvas = document.getElementById('rae-canvas-' + chave);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  assinaturaEstadoAceite[chave].temTraco = false;
  relatorioAceiteDraft['assinatura_' + chave + '_img'] = null;
  atualizarStatusAssinaturaAceite(chave);
}
function ampliarAssinaturaAceite(chave) {
  let modal = document.getElementById('modal-assinatura');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-assinatura';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;">
      <h3>Assinar</h3>
      <p>Desenhe a assinatura com o dedo ou o mouse.</p>
      <canvas id="modal-canvas" width="900" height="380" style="width:100%; height:260px; border:1.5px dashed var(--line); border-radius:9px; background:#fff; touch-action:none;"></canvas>
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-canvas').getContext('2d').clearRect(0,0,900,380)">Limpar</button>
        <button class="btn btn-primary" onclick="confirmarAssinaturaModalAceite('${chave}')">Usar esta assinatura</button>
        <button class="btn-outline-sm" onclick="document.getElementById('modal-assinatura').classList.remove('show')">Cancelar</button>
      </div>
    </div>`;
  const canvas = document.getElementById('modal-canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#0A2647';
  let desenhando = false;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
  }
  function iniciar(e) { e.preventDefault(); desenhando = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mover(e) { if (!desenhando) return; e.preventDefault(); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function parar() { desenhando = false; }
  canvas.addEventListener('mousedown', iniciar); canvas.addEventListener('mousemove', mover); window.addEventListener('mouseup', parar);
  canvas.addEventListener('touchstart', iniciar, { passive: false }); canvas.addEventListener('touchmove', mover, { passive: false }); canvas.addEventListener('touchend', parar);
}
function confirmarAssinaturaModalAceite(chave) {
  const modalCanvas = document.getElementById('modal-canvas');
  const destino = document.getElementById('rae-canvas-' + chave);
  const ctxDestino = destino.getContext('2d');
  ctxDestino.clearRect(0, 0, destino.width, destino.height);
  ctxDestino.drawImage(modalCanvas, 0, 0, destino.width, destino.height);
  assinaturaEstadoAceite[chave].temTraco = true;
  relatorioAceiteDraft['assinatura_' + chave + '_img'] = destino.toDataURL('image/png');
  atualizarStatusAssinaturaAceite(chave);
  document.getElementById('modal-assinatura').classList.remove('show');
}

// ---------- concluir: validar, salvar, gerar PDF, abrir e-mail pra envio ----------
async function concluirRelatorioAceite() {
  const d = relatorioAceiteDraft;
  d.os_uf = document.getElementById('rae-os_uf').value;
  d.os_numero = document.getElementById('rae-os_numero').value;
  d.os_ano = document.getElementById('rae-os_ano').value;
  d.data_inicial = document.getElementById('rae-data_inicial').value;
  d.data_final = document.getElementById('rae-data_final').value;
  const modeloSelecionado = document.getElementById('rae-modelo_maquina').value;
  d.modelo_maquina = modeloSelecionado === 'Outro' ? document.getElementById('rae-modelo_maquina_outro').value : modeloSelecionado;
  d.numero_serie = document.getElementById('rae-numero_serie').value;
  d.servico = document.getElementById('rae-servico').value;
  d.empresa = document.getElementById('rae-empresa').value;
  d.setor = document.getElementById('rae-setor').value;
  d.endereco = document.getElementById('rae-endereco').value;
  d.numero = document.getElementById('rae-numero').value;
  d.bairro = document.getElementById('rae-bairro').value;
  d.estado = document.getElementById('rae-estado').value;
  d.cidade = document.getElementById('rae-cidade').value;
  d.cep = document.getElementById('rae-cep').value;
  d.contato = document.getElementById('rae-contato').value;
  d.observacoes = document.getElementById('rae-observacoes').value;
  const aceite = document.querySelector('input[name="rae-aceite"]:checked');
  d.aceite = aceite ? aceite.value : '';
  const duvidas = document.querySelector('input[name="rae-duvidas"]:checked');
  d.satisfacao_duvidas = duvidas ? duvidas.value : '';
  const apto = document.querySelector('input[name="rae-apto"]:checked');
  d.satisfacao_apto = apto ? apto.value : '';
  d.assinatura_cliente_nome = document.getElementById('rae-assinatura-cliente-nome').value;
  d.assinatura_tecnico_nome = document.getElementById('rae-assinatura-tecnico-nome').value;

  const obrigatorios = ['os_uf', 'os_numero', 'os_ano', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie',
    'servico', 'empresa', 'setor', 'endereco', 'numero', 'bairro', 'estado', 'cidade', 'cep', 'contato'];
  for (const campo of obrigatorios) {
    if (!String(d[campo] || '').trim()) return alert('Preencha todos os campos obrigatórios de "Identificação" e "Dados do cliente".');
  }
  if (!d.checklist.length) return alert('Adicione ao menos um item no check-list.');
  if (d.checklist.some((c) => !String(c.item || '').trim())) return alert('Dê um nome a todos os itens do check-list, ou remova os que estiverem em branco.');
  if (d.checklist.some((c) => !c.resposta)) return alert('Responda todos os itens do check-list (Sim/Não/N/A).');
  if (!d.observacoes.trim()) return alert('Preencha as observações (escreva N/A se não houver).');
  if (!d.aceite) return alert('Marque se o cliente aceita ou não os termos.');
  if (!d.satisfacao_estrelas) return alert('Selecione a avaliação por estrelas.');
  if (!d.satisfacao_duvidas) return alert('Responda se as dúvidas foram sanadas.');
  if (!d.satisfacao_apto) return alert('Responda se o cliente se julga apto a operar o equipamento.');
  if (!d.assinatura_cliente_nome || !d.assinatura_cliente_img) return alert('Colete o nome e a assinatura do cliente.');
  if (!d.assinatura_tecnico_nome || !d.assinatura_tecnico_img) return alert('Colete o nome e a assinatura do técnico.');
  const emails = d.emails_copia.map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) return alert('Informe ao menos um e-mail para envio do termo.');
  d.emails_copia = emails;

  try {
    const { relatorio } = d.id
      ? await api(`/api/relatorios-manutencao/${d.id}`, { method: 'PUT', body: d })
      : await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfRelatorioAceite(relatorio, logo);
    window.open(url, '_blank');
    const assunto = encodeURIComponent(`Termo de Aceite da Entrega — ${d.empresa}`);
    const corpo = encodeURIComponent(`Olá,\n\nSegue em anexo o Termo de Aceite da Entrega (OS ${d.os_uf}/${d.os_numero}/${d.os_ano}) referente ao atendimento em ${d.empresa}.\n\nO PDF foi baixado neste dispositivo — anexe-o antes de enviar.\n\nAtenciosamente,\n${USER.nome}`);
    window.open(`mailto:${emails.join(',')}?subject=${assunto}&body=${corpo}`, '_blank');
    mostrarToast(d.id ? 'Termo atualizado e PDF gerado.' : 'Termo salvo e PDF gerado — anexe-o no e-mail que foi aberto.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

function gerarPdfRelatorioAceite(r, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: nomeArquivoRelatorioManutencao(r) });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function opcaoCheckbox(x, yy, marcado, label) {
    doc.setDrawColor(...PDF_COR.ink); doc.setLineWidth(0.9);
    doc.rect(x, yy - 7, 7, 7, 'S');
    if (marcado) { doc.setFillColor(...PDF_COR.ink); doc.rect(x + 1.2, yy - 5.8, 4.6, 4.6, 'F'); }
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.ink);
    doc.text(label, x + 11, yy);
    return x + 11 + doc.getTextWidth(label);
  }

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Termo de Aceite da Entrega', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  function tituloCentro(t, sub, apertado) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13;
    if (sub) {
      doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(sub, pageW / 2, y, { align: 'center' }); y += 13;
      y += 4;
    } else {
      y += apertado ? 4 : 16;
    }
  }

  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  // ===== capa =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(20); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('TERMO DE ACEITE', pageW / 2, 410, { align: 'center' });
  doc.text('DA ENTREGA', pageW / 2, 438, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(limparPdf(r.empresa).toUpperCase() || '—', pageW / 2, 464, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text(`O.S. ${limparPdf(r.os_uf)}/${limparPdf(r.os_numero)}/${limparPdf(r.os_ano)}`, pageW / 2, 485, { align: 'center' });
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados do cliente');
  linhaCampos([{ label: 'Data inicial', valor: r.data_inicial, frac: 0.34 }, { label: 'Data final', valor: r.data_final, frac: 0.33 }, { label: 'O.S. Nº', valor: `${r.os_uf}/${r.os_numero}/${r.os_ano}`, frac: 0.33 }]);
  linhaCampos([{ label: 'Modelo da máquina', valor: r.modelo_maquina, frac: 0.5 }, { label: 'Nº de série', valor: r.numero_serie, frac: 0.5 }]);
  linhaCampos([{ label: 'Serviço', valor: r.servico, frac: 0.5 }, { label: 'Técnico', valor: r.tecnico_nome, frac: 0.5 }]);
  linhaCampos([{ label: 'Empresa', valor: r.empresa, frac: 0.7 }, { label: 'Setor', valor: r.setor, frac: 0.3 }]);
  linhaCampos([{ label: 'Endereço', valor: `${r.endereco}, ${r.numero} — ${r.bairro}, ${r.cidade}/${r.estado} — CEP ${r.cep}`, frac: 1 }]);
  linhaCampos([{ label: 'Região', valor: UF_REGIAO[r.estado] || '—', frac: 0.3 }, { label: 'Contato', valor: r.contato, frac: 0.7 }]);
  y += 16;

  tituloCentro('Item / entrega / observação');
  (r.checklist || []).forEach((c, i) => {
    if (y + 16 > pageH - margem) novaPagina();
    const resp = c.resposta === 'sim' ? 'Sim' : c.resposta === 'nao' ? 'Não' : 'N/A';
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
    doc.text(limparPdf(`${String(i + 1).padStart(2, '0')}. ${c.item} — ${resp}`), margem, y); y += 12;
    if (c.observacao) {
      doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      const linhas = doc.splitTextToSize(limparPdf('Obs: ' + c.observacao), largura - 12);
      doc.text(linhas, margem + 12, y); y += linhas.length * 11;
    }
  });
  y += 16;

  tituloCentro('Sobre o equipamento');
  {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const texto = `A máquina está coberta por uma garantia de 1 ano a partir da data de entrega. Esta garantia cobre defeitos de fabricação e mão de obra. WhatsApp: ${empresaWhatsapp()} — Telefone: ${empresaTelefone()} — E-mail: ${empresaEmails().slice(0, 2).join(' / ')}. Estamos confiantes de que o equipamento${r.modelo_maquina ? ` modelo ${r.modelo_maquina}` : ''} atenderá às suas expectativas e necessidades de produção.`;
    const linhas = doc.splitTextToSize(limparPdf(texto), largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.setDrawColor(...PDF_COR.line); doc.setFillColor(...PDF_COR.bege);
    doc.rect(margem, y, largura, altura, 'FD');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 16;
  }

  tituloCentro('Observações');
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(r.observacoes) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 16;
  }

  tituloCentro('Aceite');
  {
    if (y + 20 > pageH - margem) novaPagina();
    opcaoCheckbox(pageW / 2 - 90, y, r.aceite === 'aceito', 'LI E ACEITO OS TERMOS');
    opcaoCheckbox(pageW / 2 + 20, y, r.aceite === 'nao_aceito', 'NÃO ACEITO');
    y += 22;
  }

  tituloCentro('Avaliação de desempenho');
  linhaCampos([{ label: 'Avaliação', valor: `${r.satisfacao_estrelas}/5 estrelas`, frac: 0.34 }, { label: 'Dúvidas sanadas', valor: r.satisfacao_duvidas === 'sim' ? 'Sim' : 'Não', frac: 0.33 }, { label: 'Apto a operar', valor: r.satisfacao_apto === 'sim' ? 'Sim' : 'Não', frac: 0.33 }]);
  y += 8;

  if (y > 560) novaPagina();
  tituloCentro('Assinaturas');
  {
    const wImg = 220, hImg = 90;
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    doc.text(limparPdf(`Cliente: ${r.assinatura_cliente_nome}`), margem, y);
    doc.text(limparPdf(`Técnico: ${r.assinatura_tecnico_nome}`), margem + largura / 2, y);
    y += 8;
    try { doc.addImage(r.assinatura_cliente_img, 'PNG', margem, y, wImg, hImg); } catch (e) {}
    try { doc.addImage(r.assinatura_tecnico_img, 'PNG', margem + largura / 2, y, wImg, hImg); } catch (e) {}
  }

  // ===== página de contato =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });
  doc.setFontSize(8); doc.setTextColor(...PDF_COR.inkSoft);
  doc.text(limparPdf(`Autor: ${r.autor_nome || '—'} · ${fmtData(r.criado_em)}`), pageW / 2, pageH - margem - 10, { align: 'center' });

  return doc.output('bloburl');
}

// a listagem (/meus) não traz as fotos, pra não deixar a tela lenta — busca o relatório
// completo (com fotos) na hora que alguma ação realmente precisa delas, e guarda de volta
// no cache pra não buscar de novo se a pessoa clicar noutra ação do mesmo relatório.
async function relatorioManutCompleto(i) {
  const r = (window._relatoriosManutCache || [])[i];
  if (!r) return null;
  if (r.fotos) return r;
  const { relatorio } = await api(`/api/relatorios-manutencao/${r.id}`);
  window._relatoriosManutCache[i] = relatorio;
  return relatorio;
}

async function abrirPdfRelatorioManutencao(i) {
  const r = await relatorioManutCompleto(i);
  if (!r) return;
  try {
    const logo = await carregarLogoDataUri();
    const url = r.tipo === 'ficha' ? gerarPdfFichaEquipamento(r, logo) : r.tipo === 'ciclagem' ? gerarPdfEnsaioCiclagem(r, logo) : r.tipo === 'preventiva' ? gerarPdfRelatorioPreventiva(r, logo) : r.tipo === 'corretiva' ? gerarPdfRelatorioCorretiva(r, logo) : r.tipo === 'relatorio_tecnico' ? gerarPdfRelatorioTecnico(r, logo) : r.tipo === 'aceite_entrega' ? gerarPdfRelatorioAceite(r, logo) : gerarPdfRelatorioManutencao(r, logo);
    window.open(url, '_blank');
  } catch (e) { alert('Erro ao gerar o PDF: ' + e.message); }
}

async function abrirFotosRelatorioManutencao(i) {
  const r = await relatorioManutCompleto(i);
  if (!r) return;
  const blocos = r.fotos || [];
  const temFotos = blocos.length && blocos.some((b) => (typeof b === 'string' ? true : (b.fotos || []).length));
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Fotos — ${r.tipo === 'ficha' ? 'Ficha do equipamento' : esc(r.empresa)}</h1><p>${r.tipo === 'ficha' ? (r.campos || []).slice(0, 2).map((c) => `${esc(c.campo)}: ${esc(c.valor)}`).join(' · ') : esc(r.equipamento)}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${temFotos ? `<button class="btn btn-primary btn-sm" onclick="baixarTodasFotosRelatorioManutencao(${i})">⬇ Baixar todas as fotos</button>` : ''}
        <button class="btn-outline-sm" onclick="renderRelatorioManutencao()">‹ Voltar</button>
      </div>
    </div>
    <div class="panel">
      ${temFotos ? blocos.map((entrada) => {
        const bloco = typeof entrada === 'string' ? { comentario: '', fotos: [entrada] } : entrada;
        return (bloco.fotos || []).length ? `
          <div style="margin-bottom:18px;">
            <div class="item-step-photos">${bloco.fotos.map((f) => `<img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do relatório">`).join('')}</div>
            ${bloco.comentario ? `<div style="margin-top:8px; font-size:13px; color:var(--ink-soft);">${bloco.comentario}</div>` : ''}
          </div>` : '';
      }).join('') : `<div class="empty">Nenhuma foto anexada neste relatório.</div>`}
    </div>`;
}

async function baixarTodasFotosRelatorioManutencao(i) {
  const r = await relatorioManutCompleto(i);
  if (!r) return;
  const fotos = [];
  (r.fotos || []).forEach((entrada) => {
    const bloco = typeof entrada === 'string' ? { fotos: [entrada] } : entrada;
    (bloco.fotos || []).forEach((f) => fotos.push(f));
  });
  if (!fotos.length) return;
  try {
    const zip = new JSZip();
    fotos.forEach((f, idx) => {
      const m = /^data:image\/(\w+);base64,(.*)$/.exec(f);
      if (!m) return;
      const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
      zip.file(`foto-${String(idx + 1).padStart(2, '0')}.${ext}`, m[2], { base64: true });
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fotos-relatorio-${r.id}.zip`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { alert('Erro ao baixar as fotos: ' + e.message); }
}

const WORD_COR = { navy: '0A2647', blue: '1467D6', ink: '101826', inkSoft: '4A5568', line: 'DCE4EF' };

function corCssParaHexWord(cor) {
  const rgb = corCssParaRgb(cor);
  if (!rgb) return null;
  return rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function dataUriParaUint8Array(dataUri) {
  const base64 = (String(dataUri).split(',')[1] || '').replace(/\s/g, '');
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function wTitulo(texto, opcoes) {
  opcoes = opcoes || {};
  return new docx.Paragraph({
    alignment: opcoes.centralizado ? docx.AlignmentType.CENTER : undefined,
    keepNext: opcoes.manterProximo,
    spacing: { before: 260, after: opcoes.after != null ? opcoes.after : 140 },
    border: { bottom: { color: WORD_COR.blue, space: 4, style: docx.BorderStyle.SINGLE, size: 6 } },
    children: [new docx.TextRun({ text: String(texto).toUpperCase(), bold: true, color: WORD_COR.blue, size: 22 })],
  });
}

function wBordaFinaTabela() {
  const linha = { style: docx.BorderStyle.SINGLE, size: 4, color: WORD_COR.line };
  return { top: linha, bottom: linha, left: linha, right: linha, insideHorizontal: linha, insideVertical: linha };
}

// largura útil da página (A4 menos as margens de 300+300 twips) — usada pra fixar
// a largura das colunas em twips (DXA) em vez de porcentagem, senão o Word recalcula
// a largura de cada coluna pelo tamanho do texto e desproporciona as caixas
function wLarguraConteudo() {
  return docx.convertMillimetersToTwip(210) - 600;
}

// caixas lado a lado dentro de uma linha de tabela, igual ao layout do PDF (linhaCampos)
function wLinhaCampos(campos) {
  const margins = { top: 70, bottom: 70, left: 100, right: 100 };
  const larguraTotal = wLarguraConteudo();
  const larguras = campos.map((c) => Math.round(larguraTotal * c.frac));
  const cells = campos.map((c, i) => new docx.TableCell({
    width: { size: larguras[i], type: docx.WidthType.DXA },
    margins,
    children: [new docx.Paragraph({
      children: [
        new docx.TextRun({ text: c.label.toUpperCase() + ': ', bold: true, color: WORD_COR.ink, size: 18 }),
        new docx.TextRun({ text: c.valor ? String(c.valor) : '—', color: WORD_COR.ink, size: 18 }),
      ],
    })],
  }));
  return new docx.Table({
    width: { size: larguraTotal, type: docx.WidthType.DXA },
    columnWidths: larguras,
    layout: docx.TableLayoutType.FIXED,
    borders: wBordaFinaTabela(),
    rows: [new docx.TableRow({ children: cells })],
  });
}

// caixa "GARANTIA" (com as opções sim/não/outros) ao lado da caixa "DATA DE FABRICAÇÃO", igual ao PDF
// checkbox de verdade (Structured Document Tag do Word), clicável/editável direto no
// Word — em vez de só desenhar ☑/☐ como texto fixo, que ninguém consegue alterar depois
function wCheckboxOpcao(marcado, label, size) {
  return [
    new docx.CheckBox({ checked: !!marcado }),
    new docx.TextRun({ text: ' ' + label, bold: true, color: WORD_COR.ink, size: size || 18 }),
  ];
}

function wLinhaGarantiaData(garantia, dataFabricacao) {
  const margins = { top: 70, bottom: 70, left: 100, right: 100 };
  const larguraTotal = wLarguraConteudo();
  const larguraGarantia = Math.round(larguraTotal * 0.62);
  const larguraData = larguraTotal - larguraGarantia;
  const runsGarantia = [new docx.TextRun({ text: 'GARANTIA: ', bold: true, color: WORD_COR.ink, size: 18 })];
  [['sim', 'SIM'], ['nao', 'NÃO'], ['outros', 'OUTROS']].forEach(([v, l], idx) => {
    if (idx > 0) runsGarantia.push(new docx.TextRun({ text: '   ', size: 18 }));
    runsGarantia.push(...wCheckboxOpcao(v === garantia, l));
  });
  return new docx.Table({
    width: { size: larguraTotal, type: docx.WidthType.DXA },
    columnWidths: [larguraGarantia, larguraData],
    layout: docx.TableLayoutType.FIXED,
    borders: wBordaFinaTabela(),
    rows: [new docx.TableRow({ children: [
      new docx.TableCell({ width: { size: larguraGarantia, type: docx.WidthType.DXA }, margins, children: [new docx.Paragraph({ children: runsGarantia })] }),
      new docx.TableCell({ width: { size: larguraData, type: docx.WidthType.DXA }, margins, children: [new docx.Paragraph({ children: [
        new docx.TextRun({ text: 'DATA DE FABRICAÇÃO: ', bold: true, color: WORD_COR.ink, size: 18 }),
        new docx.TextRun({ text: dataFabricacao ? String(dataFabricacao) : '—', color: WORD_COR.ink, size: 18 }),
      ] })] }),
    ] })],
  });
}

function wLinhaOpcoes(opcoes, selecionado) {
  const runs = [];
  opcoes.forEach(([v, l], idx) => {
    if (idx > 0) runs.push(new docx.TextRun({ text: '     ', size: 20 }));
    runs.push(...wCheckboxOpcao(v === selecionado, l));
  });
  return new docx.Paragraph({ spacing: { after: 100 }, children: runs });
}

function wBlocoTexto(texto) {
  const larguraTotal = wLarguraConteudo();
  return new docx.Table({
    width: { size: larguraTotal, type: docx.WidthType.DXA },
    columnWidths: [larguraTotal],
    layout: docx.TableLayoutType.FIXED,
    borders: wBordaFinaTabela(),
    rows: [new docx.TableRow({ children: [new docx.TableCell({
      margins: { top: 120, bottom: 120, left: 140, right: 140 },
      children: [new docx.Paragraph({ children: [new docx.TextRun({ text: texto ? String(texto) : '—', size: 20, color: WORD_COR.ink })] })],
    })] })],
  });
}

function wTabelaPecas(pecas) {
  const margins = { top: 80, bottom: 80, left: 100, right: 100 };
  const larguraTotal = wLarguraConteudo();
  const fracs = [0.12, 0.48, 0.22, 0.18];
  const larguras = fracs.map((f) => Math.round(larguraTotal * f));
  const headerCell = (t, i) => new docx.TableCell({
    width: { size: larguras[i], type: docx.WidthType.DXA },
    shading: { fill: WORD_COR.navy, type: docx.ShadingType.CLEAR, color: 'auto' },
    margins,
    children: [new docx.Paragraph({ children: [new docx.TextRun({ text: t, bold: true, color: 'FFFFFF', size: 18 })] })],
  });
  const cell = (t, i) => new docx.TableCell({ width: { size: larguras[i], type: docx.WidthType.DXA }, margins, children: [new docx.Paragraph({ children: [new docx.TextRun({ text: t, size: 18, color: WORD_COR.ink })] })] });
  const linhas = [new docx.TableRow({ children: [headerCell('Item', 0), headerCell('Descrição da peça', 1), headerCell('Código PMK', 2), headerCell('Qtd.', 3)] })];
  if (!pecas.length) {
    linhas.push(new docx.TableRow({ children: [new docx.TableCell({ columnSpan: 4, margins, children: [new docx.Paragraph({ children: [new docx.TextRun({ text: 'Nenhuma peça informada', italics: true, color: WORD_COR.inkSoft, size: 18 })] })] })] }));
  } else {
    pecas.forEach((p, i) => {
      linhas.push(new docx.TableRow({ children: [cell(String(i + 1), 0), cell(p.descricao || '—', 1), cell(p.codigo_pmk || '—', 2), cell(String(p.quantidade || '—'), 3)] }));
    });
  }
  return new docx.Table({
    width: { size: larguraTotal, type: docx.WidthType.DXA },
    columnWidths: larguras,
    layout: docx.TableLayoutType.FIXED,
    borders: wBordaFinaTabela(),
    rows: linhas,
  });
}

function wRunsComentario(html) {
  const palavras = extrairPalavrasComEstilo(html);
  const runs = [];
  palavras.forEach((p) => {
    if (p.quebra) { runs.push(new docx.TextRun({ text: '', break: 1 })); return; }
    if (!p.texto) return;
    runs.push(new docx.TextRun({
      text: p.texto + ' ',
      bold: !!p.negrito,
      italics: !!p.italico,
      underline: p.sublinhado ? {} : undefined,
      color: corCssParaHexWord(p.cor) || WORD_COR.ink,
      size: 20,
      font: p.fonte === 'times' ? 'Times New Roman' : p.fonte === 'courier' ? 'Courier New' : 'Calibri',
    }));
  });
  return runs.length ? runs : [new docx.TextRun({ text: '—', size: 20, italics: true, color: WORD_COR.inkSoft })];
}

function wTabelaFotosBloco(fotos) {
  const linhas = [];
  for (let i = 0; i < fotos.length; i += 2) {
    const par = [fotos[i], fotos[i + 1]];
    linhas.push(new docx.TableRow({ children: par.map((f) => {
      if (!f) return new docx.TableCell({ children: [new docx.Paragraph('')] });
      try {
        return new docx.TableCell({
          margins: { top: 60, bottom: 60, left: 60, right: 60 },
          children: [new docx.Paragraph({ children: [new docx.ImageRun({ data: dataUriParaUint8Array(f), transformation: { width: 235, height: 160 } })] })],
        });
      } catch (e) { return new docx.TableCell({ children: [new docx.Paragraph('')] }); }
    }) }));
  }
  return new docx.Table({ width: { size: 100, type: docx.WidthType.PERCENTAGE }, borders: docx.TableBorders.NONE, rows: linhas });
}

// parágrafo praticamente invisível (linha de ~1pt), usado como fechamento explícito
// depois das tabelas de capa/contato pra não depender do parágrafo automático do Word.
// Pinta com a mesma cor de fundo da página, senão sobra uma tira branca descoberta
// entre o fim da tabela colorida e a borda da folha.
function wEspacoInvisivel(fillHex) {
  return new docx.Paragraph({
    shading: { fill: fillHex, type: docx.ShadingType.CLEAR, color: 'auto' },
    spacing: { before: 0, after: 0, line: 20, lineRule: docx.LineRuleType.EXACT },
    // um parágrafo sem nenhum "run" às vezes não pinta o sombreado no Word — um
    // texto vazio garante que a cor realmente seja desenhada
    children: [new docx.TextRun({ text: '' })],
  });
}

// o Word sempre insere um parágrafo "de fechamento" (sem formatação nenhuma) entre a
// primeira seção (capa) e a seção seguinte, pra guardar a quebra de seção — e não tem
// como colorir esse parágrafo específico pela API do docx.js. Depois de gerar o .docx,
// abre o arquivo (é um .zip) e pinta esse parágrafo direto no XML, senão sobra uma tira
// branca entre a capa e a borda da folha.
async function pintarFechoSecaoCapaWord(blob, fillHex) {
  const zip = await JSZip.loadAsync(blob);
  const caminho = 'word/document.xml';
  let xml = await zip.file(caminho).async('string');
  xml = xml.replace('<w:p><w:pPr><w:sectPr', `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="${fillHex}"/><w:sectPr`);
  zip.file(caminho, xml);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}

// uma linha de tabela colorida (usada em várias, formando uma página cheia dividida em
// blocos topo/meio/base) — dividir em blocos pequenos em vez de uma única linha gigante
// evita um bug do Word que às vezes não pinta o sombreamento de uma célula muito alta
function wLinhaBlocoPagina(fillHex, conteudo, altura, alinhamento) {
  return new docx.TableRow({
    height: { value: altura, rule: docx.HeightRule.EXACT },
    children: [new docx.TableCell({
      shading: { fill: fillHex, type: docx.ShadingType.CLEAR, color: 'auto' },
      verticalAlign: alinhamento,
      children: conteudo,
    })],
  });
}

function wCapa(r, logoDataUri, titulo, subtitulo) {
  const DESLOC_TOPO = 3969; // ~7cm — empurra logo/nome da empresa pra baixo, mais perto do centro
  const DESLOC_BASE = 567; // ~1cm — sobe o slogan, tirando ele da borda inferior

  const topo = [];
  if (logoDataUri) {
    try {
      topo.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { before: DESLOC_TOPO, after: 160 },
        children: [new docx.ImageRun({ data: dataUriParaUint8Array(logoDataUri), transformation: { width: 70, height: 81 } })],
      }));
    } catch (e) {}
  }
  topo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: logoDataUri ? undefined : { before: DESLOC_TOPO },
    children: [new docx.TextRun({ text: empresaNome(), bold: true, color: 'FFFFFF', size: 40 })],
  }));

  const meio = [
    new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new docx.TextRun({ text: (titulo || 'RELATÓRIO TÉCNICO').toUpperCase(), bold: true, color: 'FFFFFF', size: 36 })],
    }),
    new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      children: [new docx.TextRun({ text: (subtitulo != null ? subtitulo : (r.empresa ? String(r.empresa) : '—')).toUpperCase(), color: 'C8D8EC', size: 24 })],
    }),
  ];

  const base = [
    new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      spacing: { after: DESLOC_BASE },
      children: [new docx.TextRun({ text: 'SIMPLES, ROBUSTO E ACESSÍVEL', bold: true, color: '96AAC8', size: 18 })],
    }),
  ];

  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: docx.TableBorders.NONE,
    rows: [
      wLinhaBlocoPagina(WORD_COR.navy, topo, 7375, docx.VerticalAlign.TOP),
      wLinhaBlocoPagina(WORD_COR.navy, meio, 6431, docx.VerticalAlign.CENTER),
      wLinhaBlocoPagina(WORD_COR.navy, base, 2731, docx.VerticalAlign.BOTTOM),
    ],
  });
}

function wPaginaContato(logoDataUri) {
  const conteudo = [];
  if (logoDataUri) {
    try {
      conteudo.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 220 },
        children: [new docx.ImageRun({ data: dataUriParaUint8Array(logoDataUri), transformation: { width: 40, height: 46 } })],
      }));
    } catch (e) {}
  }
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 260 },
    children: [new docx.TextRun({ text: empresaNome(), bold: true, color: WORD_COR.navy, size: 26 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [new docx.TextRun({ text: 'Entre em contato conosco através:', bold: true, color: WORD_COR.ink, size: 20 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new docx.TextRun({ text: `WhatsApp: ${empresaWhatsapp()}`, color: WORD_COR.ink, size: 18 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 220 },
    children: [new docx.TextRun({ text: `Telefone: ${empresaTelefone()}`, color: WORD_COR.ink, size: 18 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 100 },
    children: [new docx.TextRun({ text: 'E-mail:', bold: true, color: WORD_COR.ink, size: 18 })],
  }));
  empresaEmails().forEach((email) => {
    conteudo.push(new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new docx.TextRun({ text: email, color: WORD_COR.blue, size: 18 })],
    }));
  });
  // divide em 3 blocos (espaçador vazio / conteúdo / espaçador vazio) em vez de uma
  // única célula gigante — igual a capa, que já comprovadamente pinta certo no Word
  const BEGE = 'F2E9D8';
  const vazio = [new docx.Paragraph({ children: [new docx.TextRun({ text: '' })] })];
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: docx.TableBorders.NONE,
    rows: [
      wLinhaBlocoPagina(BEGE, vazio, 2000, docx.VerticalAlign.CENTER),
      wLinhaBlocoPagina(BEGE, conteudo, 12537, docx.VerticalAlign.CENTER),
      wLinhaBlocoPagina(BEGE, vazio, 2000, docx.VerticalAlign.CENTER),
    ],
  });
}

async function gerarWordRelatorioManutencao(r, logoDataUri) {
  const children = [];

  if (logoDataUri) {
    try {
      children.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new docx.ImageRun({ data: dataUriParaUint8Array(logoDataUri), transformation: { width: 46, height: 53 } })],
      }));
    } catch (e) {}
  }
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 20 },
    children: [new docx.TextRun({ text: empresaNome(), bold: true, color: WORD_COR.navy, size: 24 })],
  }));
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 220 },
    border: { bottom: { color: WORD_COR.blue, space: 6, style: docx.BorderStyle.SINGLE, size: 8 } },
    children: [new docx.TextRun({ text: 'Relatório Técnico', bold: true, color: WORD_COR.ink, size: 30 })],
  }));

  children.push(wTitulo('Dados do cliente'));
  children.push(wLinhaCampos([{ label: 'Empresa', valor: r.empresa, frac: 1 }]));
  children.push(wLinhaCampos([{ label: 'Contato', valor: r.contato, frac: 1 }]));
  children.push(wLinhaCampos([{ label: 'Telefone', valor: r.telefone, frac: 1 }]));
  children.push(new docx.Paragraph({ spacing: { after: 80 } }));

  children.push(wTitulo('Tipo de serviço'));
  children.push(wLinhaOpcoes([
    ['amostra', 'AMOSTRA'], ['analise', 'ANÁLISE'], ['preventiva', 'PREVENTIVA'], ['corretiva', 'CORRETIVA'],
    ['outros', 'OUTROS' + (r.tipo_servico === 'outros' && r.tipo_servico_outros ? ': ' + r.tipo_servico_outros : '')],
  ], r.tipo_servico));

  children.push(wTitulo('Dados do equipamento'));
  children.push(wLinhaCampos([{ label: 'Marca', valor: r.marca, frac: 0.34 }, { label: 'Equipamento', valor: r.equipamento, frac: 0.4 }, { label: 'Nº Série', valor: r.numero_serie, frac: 0.26 }]));
  children.push(wLinhaCampos([{ label: 'Condição', valor: r.condicao === 'novo' ? 'Novo' : r.condicao === 'usado' ? 'Usado' : '—', frac: 1 }]));
  children.push(wLinhaGarantiaData(r.garantia, r.data_fabricacao));
  children.push(wLinhaCampos([{ label: 'Acessórios', valor: r.acessorios, frac: 1 }]));
  children.push(wLinhaCampos([{ label: 'Defeito informado', valor: r.defeito_informado, frac: 1 }]));
  children.push(new docx.Paragraph({ spacing: { after: 80 } }));

  children.push(wTitulo('Técnico responsável'));
  children.push(wLinhaCampos([{ label: 'Nome', valor: r.tecnico_nome, frac: 0.5 }, { label: 'E-mail', valor: r.tecnico_email, frac: 0.5 }]));
  children.push(wLinhaCampos([{ label: 'Entrada', valor: r.data_entrada, frac: 0.26 }, { label: 'Conclusão', valor: r.data_conclusao, frac: 0.26 }, { label: 'Período', valor: periodoManut(r.data_entrada, r.data_conclusao), frac: 0.48 }]));

  children.push(wTitulo('Laudo técnico'));
  children.push(wBlocoTexto(r.laudo_tecnico));
  children.push(new docx.Paragraph({ spacing: { after: 160 } }));

  children.push(wTitulo('Serviços realizados'));
  children.push(wBlocoTexto(r.servico_realizado));
  children.push(new docx.Paragraph({ spacing: { after: 160 } }));

  children.push(wTitulo('Peças fornecidas'));
  children.push(wTabelaPecas(r.pecas || []));
  children.push(new docx.Paragraph({ spacing: { after: 160 } }));

  children.push(wTitulo('Relatório fotográfico', { centralizado: true, manterProximo: true, after: 260 }));
  const blocosFoto = r.fotos || [];
  const temFotos = blocosFoto.length && blocosFoto.some((b) => (typeof b === 'string' ? true : (b.fotos || []).length));
  if (temFotos) {
    blocosFoto.forEach((entrada) => {
      const bloco = typeof entrada === 'string' ? { comentario: '', fotos: [entrada] } : entrada;
      if ((bloco.fotos || []).length) children.push(wTabelaFotosBloco(bloco.fotos));
      children.push(new docx.Paragraph({ spacing: { before: 60, after: 160 }, children: wRunsComentario(bloco.comentario) }));
    });
  } else {
    children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: 'Nenhuma foto anexada.', italics: true, color: WORD_COR.inkSoft, size: 20 })] }));
  }

  const tamanhoPagina = { width: docx.convertMillimetersToTwip(210), height: docx.convertMillimetersToTwip(297) };
  const semMargem = { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 };

  // capa e página de contato ficam em seções próprias, com margem zero, pra cor
  // preencher a folha inteira; o conteúdo fica numa seção separada, com margem normal
  const doc = new docx.Document({
    sections: [
      {
        properties: { page: { size: tamanhoPagina, margin: semMargem } },
        children: [wCapa(r, logoDataUri), wEspacoInvisivel(WORD_COR.navy)],
      },
      {
        properties: { page: { size: tamanhoPagina, margin: { top: 300, bottom: 300, left: 300, right: 300, header: 0, footer: 0 } } },
        children,
      },
      {
        properties: { page: { size: tamanhoPagina, margin: semMargem } },
        children: [wPaginaContato(logoDataUri), wEspacoInvisivel('F2E9D8')],
      },
    ],
  });
  const blob = await docx.Packer.toBlob(doc);
  return pintarFechoSecaoCapaWord(blob, WORD_COR.navy);
}

// PDF enxuto da Ficha do equipamento — só os dados que a etiqueta tiver (lista dinâmica de
// campo/valor), condição (novo/usado) e fotos. Sem capa nem os blocos do relatório completo.
function gerarPdfFichaEquipamento(r, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: nomeArquivoRelatorioManutencao(r) });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Ficha do Equipamento', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  function tituloCentro(t) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13 + 16;
  }

  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  // ===== capa (mesmo estilo navy do relatório completo) =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(22); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('FICHA DO EQUIPAMENTO', pageW / 2, 420, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(r.condicao === 'novo' ? 'EQUIPAMENTO NOVO' : r.condicao === 'usado' ? 'EQUIPAMENTO USADO' : '—', pageW / 2, 445, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados do equipamento');
  if ((r.campos || []).length) {
    r.campos.forEach((c) => linhaCampos([{ label: c.campo, valor: c.valor, frac: 1 }]));
  } else {
    linhaCampos([{ label: 'Dados', valor: 'Nenhum dado lido da etiqueta.', frac: 1 }]);
  }
  linhaCampos([{ label: 'Condição', valor: r.condicao === 'novo' ? 'Novo' : r.condicao === 'usado' ? 'Usado' : '—', frac: 1 }]);
  y += 16;

  linhaCampos([{ label: 'Técnico', valor: r.tecnico_nome, frac: 0.5 }, { label: 'Data', valor: fmtData(r.criado_em), frac: 0.5 }]);
  y += 16;

  if ((r.fotos || []).length) {
    tituloCentro('Fotos');
    const cols = 2, gap = 10;
    const wFoto = (largura - gap * (cols - 1)) / cols;
    const hFoto = wFoto * 0.75;
    let cx = margem, col = 0;
    r.fotos.forEach((f) => {
      if (y + hFoto > pageH - margem) novaPagina();
      const m = /^data:image\/(\w+);/.exec(f);
      const formato = m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
      try { doc.addImage(f, formato, cx, y, wFoto, hFoto); } catch (e) {}
      doc.setDrawColor(...PDF_COR.line); doc.rect(cx, y, wFoto, hFoto, 'S');
      col++;
      if (col >= cols) { col = 0; cx = margem; y += hFoto + gap; } else { cx += wFoto + gap; }
    });
  }

  // ===== página de contato (mesmo padrão dos outros relatórios) =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });

  return doc.output('bloburl');
}

// Word da Ficha do equipamento — mesma estrutura de 3 seções do relatório completo (capa navy,
// conteúdo, página de contato), reaproveitando os mesmos blocos (wCapa/wTitulo/wLinhaCampos/fotos).
async function gerarWordFichaEquipamento(r, logoDataUri) {
  const children = [];
  if (logoDataUri) {
    try {
      children.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new docx.ImageRun({ data: dataUriParaUint8Array(logoDataUri), transformation: { width: 46, height: 53 } })],
      }));
    } catch (e) {}
  }
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 20 },
    children: [new docx.TextRun({ text: empresaNome(), bold: true, color: WORD_COR.navy, size: 24 })],
  }));
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 220 },
    border: { bottom: { color: WORD_COR.blue, space: 6, style: docx.BorderStyle.SINGLE, size: 8 } },
    children: [new docx.TextRun({ text: 'Ficha do Equipamento', bold: true, color: WORD_COR.ink, size: 30 })],
  }));

  children.push(wTitulo('Dados do equipamento'));
  if ((r.campos || []).length) {
    r.campos.forEach((c) => children.push(wLinhaCampos([{ label: c.campo, valor: c.valor, frac: 1 }])));
  } else {
    children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: 'Nenhum dado lido da etiqueta.', italics: true, color: WORD_COR.inkSoft, size: 20 })] }));
  }
  children.push(wLinhaCampos([{ label: 'Condição', valor: r.condicao === 'novo' ? 'Novo' : r.condicao === 'usado' ? 'Usado' : '—', frac: 1 }]));
  children.push(new docx.Paragraph({ spacing: { after: 80 } }));

  children.push(wTitulo('Técnico responsável'));
  children.push(wLinhaCampos([{ label: 'Nome', valor: r.tecnico_nome, frac: 0.5 }, { label: 'Data', valor: fmtData(r.criado_em), frac: 0.5 }]));
  children.push(new docx.Paragraph({ spacing: { after: 160 } }));

  children.push(wTitulo('Fotos', { centralizado: true, manterProximo: true, after: 260 }));
  if ((r.fotos || []).length) {
    children.push(wTabelaFotosBloco(r.fotos));
  } else {
    children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: 'Nenhuma foto anexada.', italics: true, color: WORD_COR.inkSoft, size: 20 })] }));
  }

  const tamanhoPagina = { width: docx.convertMillimetersToTwip(210), height: docx.convertMillimetersToTwip(297) };
  const semMargem = { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 };
  const subtituloCapa = r.condicao === 'novo' ? 'EQUIPAMENTO NOVO' : r.condicao === 'usado' ? 'EQUIPAMENTO USADO' : '—';

  const doc = new docx.Document({
    sections: [
      {
        properties: { page: { size: tamanhoPagina, margin: semMargem } },
        children: [wCapa(r, logoDataUri, 'Ficha do Equipamento', subtituloCapa), wEspacoInvisivel(WORD_COR.navy)],
      },
      {
        properties: { page: { size: tamanhoPagina, margin: { top: 300, bottom: 300, left: 300, right: 300, header: 0, footer: 0 } } },
        children,
      },
      {
        properties: { page: { size: tamanhoPagina, margin: semMargem } },
        children: [wPaginaContato(logoDataUri), wEspacoInvisivel('F2E9D8')],
      },
    ],
  });
  const blob = await docx.Packer.toBlob(doc);
  return pintarFechoSecaoCapaWord(blob, WORD_COR.navy);
}

// PDF do Ensaio de Ciclagem — mesma capa/cores/logo dos outros relatórios; tabela de ciclos
// desenhada linha a linha (sem plugin de tabela), com os totais sempre recalculados dos ciclos.
function gerarPdfEnsaioCiclagem(r, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: nomeArquivoRelatorioManutencao(r) });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Ensaio de Ciclagem', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  function tituloCentro(t) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13 + 16;
  }

  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  const COLS_CICLOS = ['Ciclo', 'Tipo', 'Qtd.', 'Hora ini.', 'Hora fim', 'OK', 'Desvio', '% desv.', 'Descrição do(s) desvio(s)'];
  const FRACS_CICLOS = [0.06, 0.12, 0.07, 0.09, 0.09, 0.07, 0.08, 0.08, 0.34];
  function linhaTabelaCiclos(valores, cabecalhoLinha) {
    const larguras = FRACS_CICLOS.map((f) => largura * f);
    doc.setFontSize(7.5);
    const conteudos = valores.map((v, i) => doc.splitTextToSize(limparPdf(v), larguras[i] - 6));
    let alturaMax = 16;
    conteudos.forEach((linhas) => { const h = Math.max(16, linhas.length * 9 + 6); if (h > alturaMax) alturaMax = h; });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    larguras.forEach((w, i) => {
      if (cabecalhoLinha) { doc.setFillColor(...PDF_COR.blue); doc.rect(cx, y, w, alturaMax, 'F'); }
      else { doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.6); doc.rect(cx, y, w, alturaMax, 'S'); }
      doc.setFont(undefined, cabecalhoLinha ? 'bold' : 'normal');
      doc.setTextColor(...(cabecalhoLinha ? PDF_COR.white : PDF_COR.ink));
      doc.text(conteudos[i], cx + 3, y + 11);
      cx += w;
    });
    y += alturaMax;
  }

  // ===== capa =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(22); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('ENSAIO DE CICLAGEM', pageW / 2, 420, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(limparPdf(r.empresa).toUpperCase() || '—', pageW / 2, 445, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados gerais');
  linhaCampos([{ label: 'Cliente', valor: r.empresa, frac: 0.5 }, { label: 'Equipamento', valor: r.equipamento, frac: 0.5 }]);
  linhaCampos([{ label: 'Data', valor: r.data_conclusao, frac: 0.5 }, { label: 'MTBF encontrado', valor: r.mtbf_encontrado, frac: 0.5 }]);
  {
    const altura = 20;
    if (y + altura > pageH - margem) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.rect(margem, y, largura, altura, 'S');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
    doc.text('RESULTADO:', margem + 7, y + 13);
    let cx = margem + 7 + doc.getTextWidth('RESULTADO: ') + 4;
    [['aprovado', 'APROVADO'], ['reprovado', 'REPROVADO']].forEach(([v, l]) => {
      doc.setDrawColor(...PDF_COR.ink); doc.setLineWidth(0.9);
      doc.rect(cx, y + 13 - 7, 7, 7, 'S');
      if (r.resultado_ensaio === v) { doc.setFillColor(...PDF_COR.ink); doc.rect(cx + 1.2, y + 13 - 5.8, 4.6, 4.6, 'F'); }
      doc.text(l, cx + 11, y + 13);
      cx += 11 + doc.getTextWidth(l) + 14;
    });
    y += altura;
  }
  y += 16;

  tituloCentro('Ciclos');
  linhaTabelaCiclos(COLS_CICLOS, true);
  const ciclos = r.ciclos || [];
  if (ciclos.length) {
    ciclos.forEach((c, i) => {
      const ok = Number(c.qtd_ok) || 0, desvio = Number(c.qtd_desvio) || 0;
      const avaliadas = ok + desvio;
      const percentual = avaliadas ? ((desvio / avaliadas) * 100).toFixed(2) + '%' : '0.00%';
      linhaTabelaCiclos([String(i + 1), c.tipo_amostra, c.quantidade, c.hora_inicial, c.hora_final, String(ok), String(desvio), percentual, c.descricao_desvio], false);
    });
  } else {
    linhaTabelaCiclos(['—', '—', '—', '—', '—', '—', '—', '—', 'Nenhum ciclo registrado'], false);
  }
  y += 16;

  tituloCentro('Resumo');
  {
    const t = totaisEnsaioCiclagem(r);
    linhaCampos([{ label: 'Total de ciclos', valor: String(t.totalCiclos), frac: 0.34 }, { label: 'Amostras avaliadas', valor: String(t.avaliadas), frac: 0.33 }, { label: '% de reprovação', valor: t.percentual + '%', frac: 0.33 }]);
    linhaCampos([{ label: 'Amostras aprovadas (OK)', valor: String(t.ok), frac: 0.5 }, { label: 'Amostras reprovadas (desvio)', valor: String(t.desvio), frac: 0.5 }]);
  }
  linhaCampos([{ label: 'Conclusão', valor: r.conclusao_ensaio, frac: 1 }]);
  y += 16;

  tituloCentro('Responsável');
  linhaCampos([{ label: 'Nome', valor: r.tecnico_nome, frac: 0.4 }, { label: 'Cargo', valor: r.tecnico_cargo, frac: 0.3 }, { label: 'Setor', valor: r.tecnico_setor, frac: 0.3 }]);

  // ===== página de contato =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });

  return doc.output('bloburl');
}

// Word do Ensaio de Ciclagem — mesma estrutura de 3 seções (capa/conteúdo/contato) dos outros.
async function gerarWordEnsaioCiclagem(r, logoDataUri) {
  const children = [];
  if (logoDataUri) {
    try {
      children.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new docx.ImageRun({ data: dataUriParaUint8Array(logoDataUri), transformation: { width: 46, height: 53 } })],
      }));
    } catch (e) {}
  }
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 20 },
    children: [new docx.TextRun({ text: empresaNome(), bold: true, color: WORD_COR.navy, size: 24 })],
  }));
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 220 },
    border: { bottom: { color: WORD_COR.blue, space: 6, style: docx.BorderStyle.SINGLE, size: 8 } },
    children: [new docx.TextRun({ text: 'Ensaio de Ciclagem', bold: true, color: WORD_COR.ink, size: 30 })],
  }));

  children.push(wTitulo('Dados gerais'));
  children.push(wLinhaCampos([{ label: 'Cliente', valor: r.empresa, frac: 0.5 }, { label: 'Equipamento', valor: r.equipamento, frac: 0.5 }]));
  children.push(wLinhaCampos([{ label: 'Data', valor: r.data_conclusao, frac: 0.5 }, { label: 'MTBF encontrado', valor: r.mtbf_encontrado, frac: 0.5 }]));
  children.push(wLinhaOpcoes([['aprovado', 'APROVADO'], ['reprovado', 'REPROVADO']], r.resultado_ensaio));
  children.push(new docx.Paragraph({ spacing: { after: 80 } }));

  children.push(wTitulo('Ciclos'));
  children.push(wTabelaCiclos(r.ciclos || []));
  children.push(new docx.Paragraph({ spacing: { after: 160 } }));

  children.push(wTitulo('Resumo'));
  {
    const t = totaisEnsaioCiclagem(r);
    children.push(wLinhaCampos([{ label: 'Total de ciclos', valor: String(t.totalCiclos), frac: 0.34 }, { label: 'Amostras avaliadas', valor: String(t.avaliadas), frac: 0.33 }, { label: '% de reprovação', valor: t.percentual + '%', frac: 0.33 }]));
    children.push(wLinhaCampos([{ label: 'Amostras aprovadas (OK)', valor: String(t.ok), frac: 0.5 }, { label: 'Amostras reprovadas (desvio)', valor: String(t.desvio), frac: 0.5 }]));
  }
  children.push(wLinhaCampos([{ label: 'Conclusão', valor: r.conclusao_ensaio, frac: 1 }]));
  children.push(new docx.Paragraph({ spacing: { after: 80 } }));

  children.push(wTitulo('Responsável'));
  children.push(wLinhaCampos([{ label: 'Nome', valor: r.tecnico_nome, frac: 0.4 }, { label: 'Cargo', valor: r.tecnico_cargo, frac: 0.3 }, { label: 'Setor', valor: r.tecnico_setor, frac: 0.3 }]));

  const tamanhoPagina = { width: docx.convertMillimetersToTwip(210), height: docx.convertMillimetersToTwip(297) };
  const semMargem = { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 };

  const doc = new docx.Document({
    sections: [
      {
        properties: { page: { size: tamanhoPagina, margin: semMargem } },
        children: [wCapa(r, logoDataUri, 'Ensaio de Ciclagem'), wEspacoInvisivel(WORD_COR.navy)],
      },
      {
        properties: { page: { size: tamanhoPagina, margin: { top: 300, bottom: 300, left: 300, right: 300, header: 0, footer: 0 } } },
        children,
      },
      {
        properties: { page: { size: tamanhoPagina, margin: semMargem } },
        children: [wPaginaContato(logoDataUri), wEspacoInvisivel('F2E9D8')],
      },
    ],
  });
  const blob = await docx.Packer.toBlob(doc);
  return pintarFechoSecaoCapaWord(blob, WORD_COR.navy);
}

// tabela de ciclos pro Word — mesmo padrão visual da wTabelaPecas (cabeçalho navy, bordas finas)
function wTabelaCiclos(ciclos) {
  const margins = { top: 60, bottom: 60, left: 80, right: 80 };
  const larguraTotal = wLarguraConteudo();
  const fracs = [0.06, 0.12, 0.07, 0.09, 0.09, 0.07, 0.08, 0.08, 0.34];
  const larguras = fracs.map((f) => Math.round(larguraTotal * f));
  const rotulos = ['Ciclo', 'Tipo', 'Qtd.', 'Hora ini.', 'Hora fim', 'OK', 'Desvio', '% desv.', 'Descrição do(s) desvio(s)'];
  const headerCell = (t, i) => new docx.TableCell({
    width: { size: larguras[i], type: docx.WidthType.DXA },
    shading: { fill: WORD_COR.navy, type: docx.ShadingType.CLEAR, color: 'auto' },
    margins,
    children: [new docx.Paragraph({ children: [new docx.TextRun({ text: t, bold: true, color: 'FFFFFF', size: 15 })] })],
  });
  const cell = (t, i) => new docx.TableCell({ width: { size: larguras[i], type: docx.WidthType.DXA }, margins, children: [new docx.Paragraph({ children: [new docx.TextRun({ text: t, size: 15, color: WORD_COR.ink })] })] });
  const linhas = [new docx.TableRow({ children: rotulos.map((t, i) => headerCell(t, i)) })];
  if (!ciclos.length) {
    linhas.push(new docx.TableRow({ children: [new docx.TableCell({ columnSpan: rotulos.length, margins, children: [new docx.Paragraph({ children: [new docx.TextRun({ text: 'Nenhum ciclo registrado', italics: true, color: WORD_COR.inkSoft, size: 15 })] })] })] }));
  } else {
    ciclos.forEach((c, i) => {
      const ok = Number(c.qtd_ok) || 0, desvio = Number(c.qtd_desvio) || 0;
      const avaliadas = ok + desvio;
      const percentual = (avaliadas ? ((desvio / avaliadas) * 100).toFixed(2) : '0.00') + '%';
      linhas.push(new docx.TableRow({ children: [
        cell(String(i + 1), 0), cell(c.tipo_amostra || '—', 1), cell(c.quantidade || '—', 2), cell(c.hora_inicial || '—', 3),
        cell(c.hora_final || '—', 4), cell(String(ok), 5), cell(String(desvio), 6), cell(percentual, 7), cell(c.descricao_desvio || '—', 8),
      ] }));
    });
  }
  return new docx.Table({
    width: { size: larguraTotal, type: docx.WidthType.DXA },
    columnWidths: larguras,
    layout: docx.TableLayoutType.FIXED,
    borders: wBordaFinaTabela(),
    rows: linhas,
  });
}

async function baixarWordRelatorioManutencao(i) {
  const r = await relatorioManutCompleto(i);
  if (!r) return;
  try {
    const logo = await carregarLogoDataUri();
    const blob = r.tipo === 'ficha' ? await gerarWordFichaEquipamento(r, logo) : r.tipo === 'ciclagem' ? await gerarWordEnsaioCiclagem(r, logo) : await gerarWordRelatorioManutencao(r, logo);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${nomeArquivoRelatorioManutencao(r)}.docx`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { alert('Erro ao gerar o Word: ' + e.message); }
}

async function excluirRelatorioManutencao(id) {
  if (!confirm('Excluir este relatório do seu histórico? Essa ação não pode ser desfeita.')) return;
  try {
    await api(`/api/relatorios-manutencao/${id}`, { method: 'DELETE' });
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao excluir: ' + e.message); }
}

function periodoManut(dIni, dFim) {
  if (!dIni || !dFim) return '—';
  const d1 = new Date(dIni + 'T00:00:00');
  const d2 = new Date(dFim + 'T00:00:00');
  const dias = Math.max(0, Math.round((d2 - d1) / 86400000));
  return `${dias} DIA${dias === 1 ? '' : 'S'}${dias === 0 ? ' (MESMO DIA)' : ''}`;
}

// nome de arquivo "empresa - número de série" pro PDF/Word do relatório de manutenção,
// ex.: relatório da Montreal com nº série 12345678 vira "Montreal - 12345678"
function nomeArquivoRelatorioManutencao(r) {
  function limpar(v) { return String(v || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim(); }
  if (r.tipo === 'ficha') {
    const serieCampo = (r.campos || []).find((c) => /s[ée]rie/i.test(c.campo || ''));
    const serie = limpar(serieCampo && serieCampo.valor);
    return serie ? `ficha-equipamento - ${serie}` : `ficha-equipamento-${r.id || ''}`;
  }
  if (r.tipo === 'ciclagem') {
    const cliente = limpar(r.empresa) || 'ensaio-ciclagem';
    return `ensaio-ciclagem - ${cliente}`;
  }
  if (r.tipo === 'preventiva') {
    const serie = limpar(r.numero_serie);
    const empresaPrev = limpar(r.empresa) || 'termo-preventiva';
    return serie ? `${empresaPrev} - ${serie}` : empresaPrev;
  }
  if (r.tipo === 'corretiva') {
    const serie = limpar(r.numero_serie);
    const empresaCorr = limpar(r.empresa) || 'termo-corretiva';
    return serie ? `${empresaCorr} - ${serie}` : empresaCorr;
  }
  if (r.tipo === 'aceite_entrega') {
    const serie = limpar(r.numero_serie);
    const empresaAceite = limpar(r.empresa) || 'termo-aceite';
    return serie ? `${empresaAceite} - ${serie}` : empresaAceite;
  }
  const empresa = limpar(r.empresa) || 'relatorio';
  const serie = limpar(r.numero_serie);
  return serie ? `${empresa} - ${serie}` : empresa;
}

// PDF em duas partes: capa (navy, cheia página) + páginas de conteúdo com o mesmo layout do
// modelo em papel da PRO Marking (caixas com borda, checkboxes, tabela de peças, fotos 2 por
// linha) + página final de contato — pro relatório de manutenção interna gerado pelo técnico.
function gerarPdfRelatorioManutencao(r, logoDataUri) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: nomeArquivoRelatorioManutencao(r) });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margem = 40;
  const largura = pageW - margem * 2;
  let y = margem;

  function opcaoCheckbox(x, yy, marcado, label) {
    doc.setDrawColor(...PDF_COR.ink); doc.setLineWidth(0.9);
    doc.rect(x, yy - 7, 7, 7, 'S');
    if (marcado) { doc.setFillColor(...PDF_COR.ink); doc.rect(x + 1.2, yy - 5.8, 4.6, 4.6, 'F'); }
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.ink);
    doc.text(label, x + 11, yy);
    return x + 11 + doc.getTextWidth(label);
  }

  function novaPagina() { doc.addPage(); y = margem; cabecalho(); }

  function cabecalho() {
    if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 9, y - 12, 18, 21); } catch (e) {} }
    y += 20;
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(empresaNome(), pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Relatório Técnico', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  // apertado=true mantém o título colado no que vem embaixo (texto de laudo/serviço, fotos) —
  // usado nas seções onde título e conteúdo precisam ficar visualmente juntos. Por padrão (sem
  // subtítulo e sem apertado) o título ganha mais respiro, pra não ficar colado na primeira
  // caixa de dados (Dados do cliente, Tipo de serviço, Dados do equipamento, Técnico responsável).
  function tituloCentro(t, sub, apertado) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13;
    if (sub) {
      doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(sub, pageW / 2, y, { align: 'center' }); y += 13;
      y += 4;
    } else {
      y += apertado ? 4 : 16;
    }
  }

  function tituloEsquerda(t) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
    doc.text(t, margem, y); y += 14;
  }

  // linha de campos "LABEL: valor" dentro de caixas com borda, lado a lado
  function linhaCampos(campos) {
    const larguras = campos.map((c) => largura * c.frac);
    doc.setFontSize(8.5);
    let alturaMax = 20;
    const conteudos = campos.map((c, i) => {
      const labelTxt = c.label ? c.label.toUpperCase() + ': ' : '';
      doc.setFont(undefined, 'bold');
      const wLabel = doc.getTextWidth(labelTxt);
      doc.setFont(undefined, 'normal');
      const linhas = doc.splitTextToSize(limparPdf(c.valor) || '—', larguras[i] - 14 - wLabel);
      const altura = Math.max(20, linhas.length * 11 + 9);
      if (altura > alturaMax) alturaMax = altura;
      return { labelTxt, wLabel, linhas };
    });
    if (y + alturaMax > pageH - margem) novaPagina();
    let cx = margem;
    campos.forEach((c, i) => {
      doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
      doc.rect(cx, y, larguras[i], alturaMax, 'S');
      doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
      doc.text(conteudos[i].labelTxt, cx + 7, y + 13);
      doc.setFont(undefined, 'normal');
      doc.text(conteudos[i].linhas, cx + 7 + conteudos[i].wLabel, y + 13);
      cx += larguras[i];
    });
    y += alturaMax;
  }

  // ===== capa =====
  doc.setFillColor(...PDF_COR.navy);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 42, 130, 84, 97); } catch (e) {} }
  doc.setFontSize(24); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text(empresaNome(), pageW / 2, 265, { align: 'center' });
  doc.setFontSize(22); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
  doc.text('RELATÓRIO TÉCNICO', pageW / 2, 420, { align: 'center' });
  doc.setFontSize(12); doc.setFont(undefined, 'normal'); doc.setTextColor(200, 216, 236);
  doc.text(limparPdf(r.empresa).toUpperCase() || '—', pageW / 2, 445, { align: 'center' });
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(150, 170, 200);
  doc.text('SIMPLES, ROBUSTO E ACESSÍVEL', pageW / 2, pageH - 60, { align: 'center' });

  // ===== conteúdo =====
  doc.addPage(); y = margem; cabecalho();

  tituloCentro('Dados do cliente');
  linhaCampos([{ label: 'Empresa', valor: r.empresa, frac: 1 }]);
  linhaCampos([{ label: 'Contato', valor: r.contato, frac: 1 }]);
  linhaCampos([{ label: 'Telefone', valor: r.telefone, frac: 1 }]);
  y += 16;

  tituloCentro('Tipo de serviço');
  {
    const opcoes = [['amostra', 'AMOSTRA'], ['analise', 'ANÁLISE'], ['preventiva', 'PREVENTIVA'], ['corretiva', 'CORRETIVA']];
    doc.setFont(undefined, 'bold'); doc.setFontSize(8.5);
    const outrosLabel = 'OUTROS:' + (r.tipo_servico === 'outros' && r.tipo_servico_outros ? ' ' + limparPdf(r.tipo_servico_outros) : ' ____________');
    const larguras = [...opcoes.map(([, l]) => 11 + doc.getTextWidth(l)), 11 + doc.getTextWidth(outrosLabel)];
    const gap = 16;
    const total = larguras.reduce((a, b) => a + b, 0) + gap * (larguras.length - 1);
    let cx = pageW / 2 - total / 2;
    opcoes.forEach(([v, l], idx) => { opcaoCheckbox(cx, y, r.tipo_servico === v, l); cx += larguras[idx] + gap; });
    opcaoCheckbox(cx, y, r.tipo_servico === 'outros', outrosLabel);
    y += 26;
  }

  tituloCentro('Dados do equipamento');
  linhaCampos([{ label: 'Marca', valor: r.marca, frac: 0.34 }, { label: 'Equipamento', valor: r.equipamento, frac: 0.4 }, { label: 'Nº Série', valor: r.numero_serie, frac: 0.26 }]);
  linhaCampos([{ label: 'Condição', valor: r.condicao === 'novo' ? 'Novo' : r.condicao === 'usado' ? 'Usado' : '—', frac: 1 }]);
  {
    const wGarantia = largura * 0.62, wData = largura - wGarantia, altura = 20;
    if (y + altura > pageH - margem) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.rect(margem, y, wGarantia, altura, 'S');
    doc.rect(margem + wGarantia, y, wData, altura, 'S');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.ink);
    doc.text('GARANTIA:', margem + 7, y + 13);
    let cx = margem + 7 + doc.getTextWidth('GARANTIA: ') + 4;
    [['sim', 'SIM'], ['nao', 'NÃO'], ['outros', 'OUTROS']].forEach(([v, l]) => { cx = opcaoCheckbox(cx, y + 13, r.garantia === v, l) + 10; });
    doc.setFont(undefined, 'bold'); doc.text('DATA DE FABRICAÇÃO: ', margem + wGarantia + 7, y + 13);
    const wLblFab = doc.getTextWidth('DATA DE FABRICAÇÃO: ');
    doc.setFont(undefined, 'normal'); doc.text(limparPdf(r.data_fabricacao) || '—', margem + wGarantia + 7 + wLblFab, y + 13);
    y += altura;
  }
  linhaCampos([{ label: 'Acessórios', valor: r.acessorios, frac: 1 }]);
  linhaCampos([{ label: 'Defeito informado', valor: r.defeito_informado, frac: 1 }]);
  y += 16;

  tituloCentro('Técnico responsável');
  linhaCampos([{ label: 'Nome', valor: r.tecnico_nome, frac: 0.5 }, { label: 'E-mail', valor: r.tecnico_email, frac: 0.5 }]);
  linhaCampos([{ label: 'Entrada', valor: r.data_entrada, frac: 0.26 }, { label: 'Conclusão', valor: r.data_conclusao, frac: 0.26 }, { label: 'Período', valor: periodoManut(r.data_entrada, r.data_conclusao), frac: 0.48 }]);
  y += 16;

  tituloCentro('Laudo técnico', 'Defeito encontrado e análise do estado do equipamento');
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(r.laudo_tecnico) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 16;
  }

  tituloCentro('Serviços realizados', 'Manutenção realizada / Resultados de amostra');
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(r.servico_realizado) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 14;
  }

  tituloEsquerda('Peças Fornecidas');
  {
    const cols = [{ t: 'Item', frac: 0.12 }, { t: 'Descrição da peça', frac: 0.48 }, { t: 'Código PMK', frac: 0.22 }, { t: 'Qtd.', frac: 0.18 }];
    const larguras = cols.map((c) => largura * c.frac);
    if (y + 20 > pageH - margem) novaPagina();
    let cx = margem;
    doc.setFillColor(...PDF_COR.navy);
    doc.rect(margem, y, largura, 18, 'F');
    doc.setFontSize(8.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.white);
    cols.forEach((c, i) => { doc.text(c.t, cx + 6, y + 12); cx += larguras[i]; });
    y += 18;
    const pecas = r.pecas || [];
    if (!pecas.length) {
      if (y + 18 > pageH - margem) novaPagina();
      doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
      doc.setFont(undefined, 'italic'); doc.setFontSize(8.5); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text('Nenhuma peça informada', margem + 6, y + 12);
      y += 18;
    } else {
      pecas.forEach((p, i) => {
        if (y + 18 > pageH - margem) novaPagina();
        cx = margem;
        doc.setDrawColor(...PDF_COR.line); doc.rect(margem, y, largura, 18, 'S');
        doc.setFontSize(8.5); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
        const valores = [String(i + 1), limparPdf(p.descricao) || '—', limparPdf(p.codigo_pmk) || '—', String(p.quantidade || '—')];
        valores.forEach((v, j) => { doc.text(v, cx + 6, y + 12); cx += larguras[j]; });
        y += 18;
      });
    }
    y += 16;
  }

  // desenha uma lista de palavras com estilo (do editor de comentário) respeitando a largura
  // da página, com negrito/itálico/sublinhado/cor/fonte por palavra.
  function desenharTextoRico(palavras) {
    const alturaLinha = 12.5;
    let x = margem;
    if (y > pageH - margem - alturaLinha) novaPagina();
    palavras.forEach((p) => {
      if (p.quebra) { x = margem; y += alturaLinha; if (y > pageH - margem - alturaLinha) novaPagina(); return; }
      const fonte = ['helvetica', 'times', 'courier'].includes(p.fonte) ? p.fonte : 'helvetica';
      const estiloFonte = p.negrito && p.italico ? 'bolditalic' : p.negrito ? 'bold' : p.italico ? 'italic' : 'normal';
      doc.setFont(fonte, estiloFonte); doc.setFontSize(9.5);
      const cor = corCssParaRgb(p.cor) || PDF_COR.ink;
      doc.setTextColor(...cor);
      const texto = limparPdf(p.texto);
      if (!texto) return;
      const wPalavra = doc.getTextWidth(texto + ' ');
      if (x + wPalavra > margem + largura) { x = margem; y += alturaLinha; if (y > pageH - margem - alturaLinha) novaPagina(); }
      doc.text(texto, x, y);
      if (p.sublinhado) { doc.setDrawColor(...cor); doc.setLineWidth(0.5); doc.line(x, y + 1.5, x + doc.getTextWidth(texto), y + 1.5); }
      x += wPalavra;
    });
    y += alturaLinha;
  }

  // garante que o título "Relatório fotográfico" nunca fique sozinho no fim de uma página
  // com as fotos só aparecendo na página seguinte — reserva também a altura da primeira
  // linha de fotos antes de decidir se precisa pular de página.
  const temFotos = r.fotos && r.fotos.length && r.fotos.some((entrada) => (typeof entrada === 'string' ? [entrada] : (entrada.fotos || [])).length);
  if (temFotos) {
    const gapFoto = 12, wImgFoto = (largura - gapFoto) / 2, hImgFoto = wImgFoto * 0.68;
    if (y + 34 + hImgFoto > pageH - margem) novaPagina();
  }
  tituloCentro('Relatório fotográfico', null, true);
  if (r.fotos && r.fotos.length) {
    r.fotos.forEach((entrada) => {
      // compatibilidade com relatórios salvos antes de existir o comentário por grupo de fotos
      const bloco = typeof entrada === 'string' ? { comentario: '', fotos: [entrada] } : entrada;
      const fotosDoBloco = bloco.fotos || [];
      if (fotosDoBloco.length) {
        const gap = 12, wImg = (largura - gap) / 2, hImg = wImg * 0.68;
        for (let i = 0; i < fotosDoBloco.length; i += 2) {
          if (y + hImg > pageH - margem) novaPagina();
          [fotosDoBloco[i], fotosDoBloco[i + 1]].forEach((f, j) => {
            if (!f) return;
            const cx = margem + j * (wImg + gap);
            try {
              const m = /^data:image\/(\w+);/.exec(f);
              const formato = m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
              doc.setDrawColor(...PDF_COR.line);
              doc.roundedRect(cx - 1, y - 1, wImg + 2, hImg + 2, 3, 3, 'S');
              doc.addImage(f, formato, cx, y, wImg, hImg);
            } catch (e) {}
          });
          y += hImg + gap;
        }
      }
      const palavras = extrairPalavrasComEstilo(bloco.comentario);
      if (palavras.length) { desenharTextoRico(palavras); y += 10; }
      else y += 4;
    });
  } else {
    doc.setFontSize(9); doc.setFont(undefined, 'italic'); doc.setTextColor(...PDF_COR.inkSoft);
    doc.text('Nenhuma foto anexada.', margem, y); y += 16;
  }

  // ===== página de contato =====
  doc.addPage();
  doc.setFillColor(...PDF_COR.bege);
  doc.rect(0, 0, pageW, pageH, 'F');
  if (logoDataUri) { try { doc.addImage(logoDataUri, 'PNG', pageW / 2 - 20, pageH / 2 - 150, 40, 46); } catch (e) {} }
  doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.navy);
  doc.text(empresaNome(), pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text(`WhatsApp: ${empresaWhatsapp()}`, pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text(`Telefone: ${empresaTelefone()}`, pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  empresaEmails().forEach((email, i) => {
    doc.text(email, pageW / 2, pageH / 2 + 36 + i * 14, { align: 'center' });
  });

  return doc.output('bloburl');
}

// ---------- CALENDÁRIO (técnico): vê todas as O.S. de todos os técnicos, igual o administrador
// vê na Agenda geral — pode abrir e visualizar qualquer uma, mas só consegue executar (preencher
// relatório) as que estiverem designadas a ele mesmo. Reaproveita as funções de visualização já
// existentes (osCardCorpo, detalheCompletoOS, o estado do calendário) sem alterar nada do que já
// existe pro administrador — as ações de administrador (aprovar/reprovar/editar/excluir O.S.)
// não aparecem aqui.

async function renderCalendarioTecnico() {
  const [{ agenda }, { visitas }] = await Promise.all([api('/api/agenda?todas=1'), api('/api/visitas?todas=1')]);
  window._agendaCache = agenda;
  window._visitasPorAgenda = {};
  window._visitasRetornoPorAgenda = {};
  visitas.forEach((v) => {
    if ((v.rodada || 1) === 1) window._visitasPorAgenda[v.agenda_id] = v;
    else window._visitasRetornoPorAgenda[v.agenda_id] = v;
  });
  renderAgendaCalendarioTecnico();
}

let calTecnicoFiltro = 'ativos';

function renderAgendaCalendarioTecnico() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Calendário</h1><p>${(window._agendaCache || []).length} O.S. de todos os técnicos — você pode abrir e visualizar qualquer uma, mas só executa as que estiverem designadas a você</p></div>
    <div class="panel">
      <div class="cal-head">
        <div class="cal-nav">
          <button onclick="mudarMesCalendarioTecnico(-1)">‹</button>
          <div class="cal-mes-label" id="cal-mes-label"></div>
          <button onclick="mudarMesCalendarioTecnico(1)">›</button>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          ${botoesFiltroStatusOS(calTecnicoFiltro, 'alternarFiltroCalendarioTecnico')}
          <button class="btn-outline-sm" onclick="irParaHojeCalendarioTecnico()">Hoje</button>
        </div>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
    </div>
  `;
  desenharGradeCalendarioTecnico();
}

function alternarFiltroCalendarioTecnico(valor) {
  calTecnicoFiltro = valor;
  desenharGradeCalendarioTecnico();
}

function mudarMesCalendarioTecnico(delta) {
  calMes += delta;
  if (calMes < 0) { calMes = 11; calAno--; }
  if (calMes > 11) { calMes = 0; calAno++; }
  desenharGradeCalendarioTecnico();
}

function irParaHojeCalendarioTecnico() {
  const hoje = new Date();
  calAno = hoje.getFullYear();
  calMes = hoje.getMonth();
  calDiaSelecionado = dataISOLocal(hoje);
  desenharGradeCalendarioTecnico();
}

function desenharGradeCalendarioTecnico() {
  const label = document.getElementById('cal-mes-label');
  if (label) label.textContent = `${MES_LABEL[calMes]} de ${calAno}`;
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  const agenda = filtrarPorStatusOS(window._agendaCache, calTecnicoFiltro);
  const contagemPorDia = {};
  agenda.forEach((a) => {
    const dia = (a.data_hora_inicio || '').slice(0, 10);
    if (!dia) return;
    contagemPorDia[dia] = (contagemPorDia[dia] || 0) + 1;
  });

  const inicioSemana = new Date(calAno, calMes, 1).getDay();
  const diasNoMes = new Date(calAno, calMes + 1, 0).getDate();
  const hojeISO = dataISOLocal(new Date());

  const celulas = [];
  for (let i = 0; i < inicioSemana; i++) celulas.push(new Date(calAno, calMes, 1 - (inicioSemana - i)));
  for (let dia = 1; dia <= diasNoMes; dia++) celulas.push(new Date(calAno, calMes, dia));
  while (celulas.length % 7 !== 0) {
    const ultima = celulas[celulas.length - 1];
    celulas.push(new Date(ultima.getFullYear(), ultima.getMonth(), ultima.getDate() + 1));
  }

  grid.innerHTML = DOW_LABEL.map((d) => `<div class="cal-dow">${d}</div>`).join('') +
    celulas.map((data) => {
      const iso = dataISOLocal(data);
      const qtd = contagemPorDia[iso] || 0;
      const classes = ['cal-day'];
      if (data.getMonth() !== calMes) classes.push('fora-mes');
      if (iso === hojeISO) classes.push('hoje');
      if (iso === calDiaSelecionado) classes.push('selecionado');
      return `<div class="${classes.join(' ')}" onclick="selecionarDiaCalendarioTecnico('${iso}')">
        <div class="cal-day-num">${data.getDate()}</div>
        ${qtd ? `<div class="cal-day-badge">${qtd}</div>` : ''}
      </div>`;
    }).join('');
}

function selecionarDiaCalendarioTecnico(iso) {
  calDiaSelecionado = iso;
  renderDiaCalendarioTecnico(iso);
}

function alternarFiltroCalendarioTecnicoDia(valor, iso) {
  calTecnicoFiltro = valor;
  renderDiaCalendarioTecnico(iso);
}

function renderDiaCalendarioTecnico(iso) {
  const agenda = filtrarPorStatusOS(window._agendaCache, calTecnicoFiltro)
    .filter((a) => (a.data_hora_inicio || '').slice(0, 10) === iso)
    .sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  const [y, m, d] = iso.split('-');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Ordens de serviço em ${d}/${m}/${y}</h1><p>${agenda.length} O.S. agendada(s) para este dia</p></div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        ${botoesFiltroStatusOS(calTecnicoFiltro, `((valor) => alternarFiltroCalendarioTecnicoDia(valor, '${iso}'))`)}
        <button class="btn-outline-sm" onclick="renderAgendaCalendarioTecnico()">‹ Voltar ao calendário</button>
      </div>
    </div>
    ${agenda.length ? `<div class="os-grid">${agenda.map((a) => cardOSCalendarioTecnico(a)).join('')}</div>` : `<div class="empty">Nenhuma O.S. agendada para este dia.</div>`}
  `;
}

function cardOSCalendarioTecnico(a) {
  return `
    <div class="os-card${a.finalizada ? ' os-card-finalizada' : ''}" onclick="abrirDetalheOSCalendarioTecnico(${a.id})" style="cursor:pointer;">
      ${osCardCorpo(a)}
      <div class="os-card-actions" onclick="event.stopPropagation()">
        <button class="os-card-toggle" onclick="abrirDetalheOSCalendarioTecnico(${a.id})">Abrir</button>
      </div>
    </div>`;
}

// tela separada com o detalhe completo de uma O.S. — mesma visualização do administrador
// (detalheCompletoOS), mas com as ações limitadas ao que o técnico logado pode de fato fazer.
function abrirDetalheOSCalendarioTecnico(id) {
  const a = (window._agendaCache || []).find((x) => x.id === id);
  if (!a) return;
  const visita = (window._visitasPorAgenda || {})[id];
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(numeroOS(a))}</h1><p>${esc(a.cliente_nome || '—')}</p></div>
      <button class="btn-outline-sm" onclick="renderDiaCalendarioTecnico('${calDiaSelecionado}')">‹ Voltar para o dia</button>
    </div>
    <div class="panel">
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">${acoesOSCalendarioTecnico(a, visita)}</div>
      ${detalheCompletoOS(a, visita)}
    </div>`;
}

// só a O.S. designada ao técnico logado ganha um botão de ação (executar / solicitar
// reabertura) — as demais ficam só pra consulta, sem nenhuma ação de administrador.
function acoesOSCalendarioTecnico(a, visita) {
  if (a.finalizada) {
    return `<span class="tag" style="background:var(--blue-pale); color:var(--blue);">✓ Finalizada em ${fmtData(a.finalizado_em)} — cliente já confirmou o serviço.</span>`;
  }
  // O.S. de atendimento (chat) segue o fluxo de pós-venda/reparo/estoque, sem deslocamento — as
  // ações ficam nas telas dedicadas (Fila de Atendimento, Pós-venda, Setor Reparo, Estoque)
  if (a.tipo === 'atendimento' && a.fase_atendimento) {
    const faseLabel = (FASE_ATENDIMENTO_TARJA[a.fase_atendimento] || {}).label || a.fase_atendimento;
    return `<span style="font-size:11.5px; color:var(--ink-soft);">Fase atual: ${esc(faseLabel)} — acompanhe e aja pela Fila de Atendimento ou pela tela do setor responsável.</span>`;
  }
  if (a.tecnico_id !== USER.id) {
    return `<span style="font-size:11.5px; color:var(--ink-soft);">Designada a ${esc(a.tecnico_nome || 'outro técnico')} — você pode visualizar, mas só quem está designado executa esta O.S.</span>`;
  }
  if (a.retorno_pendente_tecnico) {
    let botaoRetorno = '';
    if (a.retorno_deslocamento_iniciado_em && !a.retorno_chegada_confirmada_em) {
      botaoRetorno = `<button class="btn-outline-sm" onclick="registrarChegadaRetorno(${a.id})" style="margin-right:6px;">📍 Registrar chegada</button>`;
    } else if (a.retorno_chegada_confirmada_em) {
      botaoRetorno = `<button class="btn btn-primary btn-sm" onclick="abrirDiario(${a.id})">Enviar relatório de retorno</button>`;
    }
    return `${botaoDeslocamento(a)}${botaoRetorno}`;
  }
  if (a.status !== 'concluida') {
    let botaoExec = '';
    if (a.deslocamento_iniciado_em && !a.chegada_confirmada_em) {
      botaoExec = `<button class="btn-outline-sm" onclick="confirmarChegada(${a.id})" style="margin-right:6px;">📍 Registrar chegada</button>`;
    } else if (a.chegada_confirmada_em) {
      botaoExec = `<button class="btn btn-primary btn-sm" onclick="abrirDiario(${a.id})">Executar</button>`;
    }
    return `${botaoDeslocamento(a)}${botaoExec}`;
  }
  if (a.visita_id && a.visita_status === 'aprovado') {
    return botaoDeslocamento(a) + (a.visita_solicitacao_reabertura && a.visita_solicitacao_reabertura.status === 'pendente'
      ? `<span class="tag tag-amber">Reabertura solicitada</span>`
      : `<button class="btn-outline-sm" onclick="solicitarReaberturaVisita(${a.visita_id})">Solicitar reabertura</button>`);
  }
  return `<span style="font-size:11.5px; color:var(--ink-soft);">Em análise — aguardando aprovação do administrador.</span>`;
}

// ---------- RANKING DE TÉCNICOS ----------
async function renderRankingTecnicos() {
  const { ranking } = await api('/api/registros/ranking');
  const main = document.getElementById('main');
  const medalhas = ['🥇', '🥈', '🥉'];
  main.innerHTML = `
    <div class="page-head"><h1>Ranking de técnicos</h1><p>Quem mais contribuiu com casos e procedimentos aprovados na biblioteca</p></div>
    ${ranking.length ? ranking.map((r, i) => `
      <div class="item-card" style="display:flex; align-items:center; gap:16px;">
        <div style="font-size:22px; width:34px; text-align:center; flex-shrink:0;">${medalhas[i] || (i + 1) + 'º'}</div>
        <div class="user-avatar" style="width:38px; height:38px; flex-shrink:0;">${initials(r.autor_nome)}</div>
        <div style="flex:1;">
          <div class="item-title" style="margin:0;">${esc(r.autor_nome)}</div>
          <div class="item-meta">${r.defeitos} defeito(s)/falha(s) <span class="sep">·</span> ${r.procedimentos} procedimento(s)</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:22px; font-weight:800; color:var(--navy);">${r.total}</div>
          <div style="font-size:11px; color:var(--ink-soft); text-transform:uppercase; letter-spacing:.4px;">contribuições</div>
        </div>
      </div>`).join('') : `<div class="empty">Ainda não há registros aprovados na biblioteca.</div>`}`;
}

function abrirLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('show');
}
function fecharLightbox() {
  document.getElementById('lightbox').classList.remove('show');
}

// ---------- BIBLIOTECA: ADICIONAR (Defeitos/Falhas) ----------
function renderFormDefeito(main, prefill) {
  const editando = !!prefill;
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar registro' : 'Adicionar Defeito/Falha'}</h1><p>${editando ? 'Corrija conforme o comentário do administrador e reenvie.' : 'Enviado para aprovação do administrador antes de entrar na biblioteca.'}</p></div>
    ${editando && prefill.comentario_admin ? `<div class="admin-note"><b>Comentário do administrador</b>${esc(prefill.comentario_admin)}</div>` : ''}
    <div class="panel">
      <div class="form-grid">
        <div class="full"><label>Título resumo</label><input id="fd-titulo" value="${esc(prefill ? prefill.titulo : '')}" placeholder="ex: Máquina não liga após queda de energia"></div>
        <div><label>Equipamento</label><input id="fd-equip-tipo" value="${esc(prefill ? prefill.equipamento_tipo : '')}" placeholder="ex: Máquina de Gelo"></div>
        <div><label>Modelo</label><input id="fd-equip-modelo" value="${esc(prefill ? prefill.equipamento_modelo : '')}" placeholder="ex: MP5-80P"></div>
        <div><label>Número de série (opcional)</label><input id="fd-serie" value="${esc(prefill ? prefill.numero_serie : '')}"></div>
        <div class="full"><label>Defeito/sintoma encontrado</label><textarea id="fd-sintoma" placeholder="O que foi observado...">${esc(prefill ? prefill.sintoma : '')}</textarea></div>
        <div class="full"><label>Causa identificada</label><textarea id="fd-causa" placeholder="Por que aconteceu...">${esc(prefill ? prefill.causa : '')}</textarea></div>
        <div class="full"><label>Solução aplicada</label><textarea id="fd-solucao" placeholder="O que foi feito para resolver...">${esc(prefill ? prefill.solucao : '')}</textarea></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="salvarDefeito(${editando ? prefill.id : 'null'})">${editando ? 'Reenviar para aprovação' : 'Enviar para aprovação'}</button>
    </div>`;
}
async function salvarDefeito(idParaReenvio) {
  const body = {
    tipo: 'defeito',
    titulo: document.getElementById('fd-titulo').value,
    equipamento_tipo: document.getElementById('fd-equip-tipo').value,
    equipamento_modelo: document.getElementById('fd-equip-modelo').value,
    numero_serie: document.getElementById('fd-serie').value,
    sintoma: document.getElementById('fd-sintoma').value,
    causa: document.getElementById('fd-causa').value,
    solucao: document.getElementById('fd-solucao').value,
  };
  try {
    if (idParaReenvio) await api(`/api/registros/${idParaReenvio}/reenviar`, { method: 'POST', body });
    else await api('/api/registros', { method: 'POST', body });
    mostrarToast('Registro enviado para aprovação.');
    ir('meus-registros');
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- BIBLIOTECA: ADICIONAR (Manual de Procedimentos) ----------
function renderFormProcedimento(main, prefill) {
  const editando = !!prefill;
  procDraft = prefill && prefill.passos && prefill.passos.length ? JSON.parse(JSON.stringify(prefill.passos)) : [{ texto: '', fotos: [] }];
  fotoDestaqueDraft = prefill ? (prefill.foto_destaque || null) : null;
  main.innerHTML = `
    <div class="page-head"><h1>${editando ? 'Editar procedimento' : 'Adicionar Manual de Procedimentos'}</h1><p>${editando ? 'Corrija conforme o comentário do administrador e reenvie.' : 'Cada etapa pode ter uma ou mais fotos anexadas.'}</p></div>
    ${editando && prefill.comentario_admin ? `<div class="admin-note"><b>Comentário do administrador</b>${esc(prefill.comentario_admin)}</div>` : ''}
    <div class="panel">
      <div class="form-grid">
        <div class="full"><label>Título do procedimento</label><input id="fp-titulo" value="${esc(prefill ? prefill.titulo : '')}" placeholder="ex: Limpeza mensal do condensador"></div>
        <div><label>Equipamento</label><input id="fp-equip-tipo" value="${esc(prefill ? prefill.equipamento_tipo : '')}" placeholder="ex: Torre de Bebidas"></div>
        <div><label>Modelo</label><input id="fp-equip-modelo" value="${esc(prefill ? prefill.equipamento_modelo : '')}" placeholder="ex: TB-200"></div>
        <div><label>Periodicidade</label>
          <select id="fp-periodicidade">
            ${['Semanal', 'Mensal', 'Trimestral', 'Semestral', 'Anual', 'N/A'].map((p) => `<option ${prefill && prefill.periodicidade === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div><label>Foto de destaque (equipamento/peça)</label><div id="fp-foto-destaque" style="display:flex;"></div></div>
        <div class="full"><label>Precauções/EPIs</label><textarea id="fp-precaucoes" placeholder="ex: óculos de proteção, desligar da tomada...">${esc(prefill ? prefill.precaucoes : '')}</textarea></div>
        <div class="full"><label>Ferramentas necessárias</label><textarea id="fp-ferramentas" placeholder="ex: chave de fenda, multímetro...">${esc(prefill ? prefill.ferramentas : '')}</textarea></div>
      </div>
      <label>Passo a passo</label>
      <div class="steps-list" id="steps-list"></div>
      <button class="btn btn-ghost btn-sm" style="margin-bottom:18px;" onclick="adicionarPasso()">+ Adicionar passo</button>
      <br>
      <button class="btn btn-primary btn-sm" onclick="salvarProcedimento(${editando ? prefill.id : 'null'})">${editando ? 'Reenviar para aprovação' : 'Enviar para aprovação'}</button>
    </div>`;
  renderPassosDraft();
  renderFotoDestaque();
}

// foto única e independente das fotos dos passos — mostrada em destaque na coluna esquerda do
// PDF do procedimento (antes disso, o PDF usava sempre a 1ª foto do passo 1 como destaque, o
// que ficava estranho quando a etapa 1 não era a que melhor representa o equipamento/peça).
let fotoDestaqueDraft = null;
function renderFotoDestaque() {
  const alvo = document.getElementById('fp-foto-destaque');
  if (!alvo) return;
  alvo.innerHTML = fotoDestaqueDraft
    ? `<div class="photo-thumb"><img src="${fotoDestaqueDraft}" onclick="abrirLightbox('${fotoDestaqueDraft}')" alt="Foto de destaque">
         <button class="photo-rm" onclick="removerFotoDestaque()">×</button></div>`
    : `<div style="display:flex; gap:8px;">
         <label class="photo-add"><span class="plus">📷</span>Câmera<input type="file" accept="image/*" capture="environment" style="display:none" onchange="adicionarFotoDestaque(event)"></label>
         <label class="photo-add"><span class="plus">+</span>Galeria<input type="file" accept="image/*" style="display:none" onchange="adicionarFotoDestaque(event)"></label>
       </div>`;
}
function adicionarFotoDestaque(event) {
  const arquivo = (event.target.files || [])[0];
  if (!arquivo) return;
  lerFotosComoDataUrl([arquivo]).then(([dataUrl]) => { fotoDestaqueDraft = dataUrl; renderFotoDestaque(); });
}
function removerFotoDestaque() { fotoDestaqueDraft = null; renderFotoDestaque(); }

function renderPassosDraft() {
  document.getElementById('steps-list').innerHTML = procDraft.map((p, i) => `
    <div class="step-item">
      <div class="step-main">
        <div class="step-num">${i + 1}</div>
        <textarea placeholder="Descreva esta etapa..." oninput="procDraft[${i}].texto = this.value">${esc(p.texto)}</textarea>
        ${procDraft.length > 1 ? `<button class="step-rm" onclick="removerPasso(${i})">×</button>` : ''}
      </div>
      <div class="step-photos">
        ${p.fotos.map((f, j) => `
          <div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto da etapa">
            <button class="photo-rm" onclick="removerFoto(${i}, ${j})">×</button>
          </div>`).join('')}
        <label class="photo-add">
          <span class="plus">📷</span>Câmera
          <input type="file" accept="image/*" capture="environment" style="display:none" onchange="adicionarFotos(event, ${i})">
        </label>
        <label class="photo-add">
          <span class="plus">+</span>Galeria
          <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotos(event, ${i})">
        </label>
      </div>
    </div>`).join('');
}

function adicionarPasso() { procDraft.push({ texto: '', fotos: [] }); renderPassosDraft(); }
function removerPasso(i) { procDraft.splice(i, 1); renderPassosDraft(); }
function removerFoto(i, j) { procDraft[i].fotos.splice(j, 1); renderPassosDraft(); }
function adicionarFotos(event, i) {
  lerFotosComoDataUrl(event.target.files || []).then((dataUrls) => {
    procDraft[i].fotos.push(...dataUrls);
    renderPassosDraft();
  });
}

async function salvarProcedimento(idParaReenvio) {
  const body = {
    tipo: 'procedimento',
    titulo: document.getElementById('fp-titulo').value,
    equipamento_tipo: document.getElementById('fp-equip-tipo').value,
    equipamento_modelo: document.getElementById('fp-equip-modelo').value,
    periodicidade: document.getElementById('fp-periodicidade').value,
    precaucoes: document.getElementById('fp-precaucoes').value,
    ferramentas: document.getElementById('fp-ferramentas').value,
    passos: procDraft,
    foto_destaque: fotoDestaqueDraft,
  };
  try {
    if (idParaReenvio) await api(`/api/registros/${idParaReenvio}/reenviar`, { method: 'POST', body });
    else await api('/api/registros', { method: 'POST', body });
    mostrarToast('Procedimento enviado para aprovação.');
    ir('meus-registros');
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- MEUS REGISTROS ----------
async function renderMeusRegistros() {
  const { registros } = await api('/api/registros/meus');
  window._meusRegistrosCache = registros;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Meus registros</h1><p>${registros.length} enviado(s) — acompanhe o status de aprovação</p></div>
    ${registros.length ? registros.map((r, i) => `
      <div class="item-card">
        <div class="item-top">
          <div><div class="item-title">${esc(r.titulo)}</div>
            <div class="item-meta">${r.tipo === 'defeito' ? tag('Defeito/Falha', 'falha') : tag('Procedimento', 'preventiva')}<span class="sep">·</span>${fmtData(r.criado_em)}</div>
          </div>
          ${badgeStatus(r.status)}
        </div>
        ${r.status === 'alteracao_sugerida' ? `
          <div class="admin-note"><b>Comentário do administrador</b>${esc(r.comentario_admin)}</div>
          <button class="btn btn-orange btn-outline-sm" style="margin-top:8px;" onclick="editarRegistro(${r.id})">Corrigir e reenviar</button>
        ` : `<button class="btn-outline-sm" style="margin-top:8px;" onclick="abrirDetalheMeuRegistro(${i})">Abrir</button>`}
      </div>`).join('') : `<div class="empty">Você ainda não enviou nenhum registro.</div>`}`;
}

function abrirDetalheMeuRegistro(i) {
  const r = (window._meusRegistrosCache || [])[i];
  if (!r) return;
  carregarLogoDataUri();
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(r.titulo)}</h1><p>${esc(r.equipamento_tipo || '')}${r.equipamento_modelo ? ' — ' + esc(r.equipamento_modelo) : ''}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${r.status === 'aprovado' ? `<button class="btn btn-primary btn-sm" onclick="abrirPdfMeuRegistro(${i})">Abrir PDF</button>` : ''}
        <button class="btn-outline-sm" onclick="renderMeusRegistros()">‹ Voltar</button>
      </div>
    </div>
    ${r.status === 'alteracao_sugerida' ? `<div class="admin-note"><b>Comentário do administrador</b>${esc(r.comentario_admin)}</div>` : ''}
    <div class="panel">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">${r.tipo === 'defeito' ? tag('Defeito/Falha', 'falha') : tag('Procedimento', 'preventiva')}${badgeStatus(r.status)}</div>
      ${r.tipo === 'defeito' ? `
        <div class="kv" style="margin-top:12px;"><b>Sintoma:</b> ${esc(r.sintoma)}</div>
        <div class="kv"><b>Causa:</b> ${esc(r.causa)}</div>
        <div class="kv"><b>Solução:</b> ${esc(r.solucao)}</div>
        ${r.numero_serie ? `<div class="kv"><b>Nº de série:</b> ${esc(r.numero_serie)}</div>` : ''}
        ${r.fotos && r.fotos.length ? `<div class="kv"><b>Relatório fotográfico:</b></div><div class="item-step-photos">${r.fotos.map((f) => `<img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do defeito">`).join('')}</div>` : ''}
      ` : `
        <div style="margin-top:12px;">
          ${r.periodicidade ? `<div class="kv"><b>Periodicidade:</b> ${esc(r.periodicidade)}</div>` : ''}
          ${r.precaucoes ? `<div class="kv"><b>Precauções/EPIs:</b> ${esc(r.precaucoes)}</div>` : ''}
          ${r.ferramentas ? `<div class="kv"><b>Ferramentas:</b> ${esc(r.ferramentas)}</div>` : ''}
          <ol class="item-steps">
            ${(r.passos || []).map((p) => `
              <li>${esc(p.texto)}
                ${p.fotos && p.fotos.length ? `<div class="item-step-photos">${p.fotos.map((f) => `<img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto da etapa">`).join('')}</div>` : ''}
              </li>`).join('')}
          </ol>
        </div>`}
      <div class="item-autor" style="margin-top:14px;">Enviado em ${fmtData(r.criado_em)}</div>
    </div>`;
}

async function abrirPdfMeuRegistro(i) {
  const r = (window._meusRegistrosCache || [])[i];
  if (!r) return;
  try {
    const logo = await carregarLogoDataUri();
    const url = gerarPdfBiblioteca(r, r.tipo, logo);
    window.open(url, '_blank');
  } catch (e) { alert('Erro ao gerar o PDF: ' + e.message); }
}

async function editarRegistro(id) {
  const { registros } = await api('/api/registros/meus');
  const registro = registros.find((r) => r.id === id);
  if (!registro) return;
  const main = document.getElementById('main');
  if (registro.tipo === 'defeito') renderFormDefeito(main, registro);
  else renderFormProcedimento(main, registro);
}

// ---------- APROVAÇÃO DA BIBLIOTECA ----------
let sugerindoId = null;
let filaAberta = new Set(); // ids de registros da fila mostrando o conteúdo completo
async function renderAprovacoesBiblioteca() {
  const { registros } = await api('/api/registros/fila');
  window._filaBiblioteca = registros;
  desenharFilaBiblioteca();
}
function desenharFilaBiblioteca() {
  const registros = window._filaBiblioteca || [];
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Aprovação — Biblioteca</h1><p>${registros.length} pendente(s)</p></div>
    ${registros.length ? registros.map((r) => {
      const aberto = filaAberta.has(r.id);
      return `
      <div class="item-card">
        <div class="item-top">
          <div><div class="item-title">${esc(r.titulo)}</div>
            <div class="item-meta">${r.tipo === 'defeito' ? tag('Defeito/Falha', 'falha') : tag('Procedimento', 'preventiva')}<span class="sep">·</span>${esc(r.equipamento_tipo)}<span class="sep">·</span>por ${esc(r.autor_nome || '—')}</div>
          </div>
        </div>
        ${aberto ? `
        <div class="item-body">
          ${r.tipo === 'defeito' ? `
            <div class="kv"><b>Sintoma:</b> ${esc(r.sintoma)}</div>
            <div class="kv"><b>Causa:</b> ${esc(r.causa)}</div>
            <div class="kv"><b>Solução:</b> ${esc(r.solucao)}</div>
          ` : `
            ${r.precaucoes ? `<div class="kv"><b>Precauções/EPIs:</b> ${esc(r.precaucoes)}</div>` : ''}
            ${r.ferramentas ? `<div class="kv"><b>Ferramentas:</b> ${esc(r.ferramentas)}</div>` : ''}
            <ol class="item-steps">
              ${(r.passos || []).map((p) => `
                <li>${esc(p.texto)}
                  ${p.fotos && p.fotos.length ? `<div class="item-step-photos">${p.fotos.map((f) => `<img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto da etapa">`).join('')}</div>` : ''}
                </li>`).join('')}
            </ol>
          `}
        </div>
        <div class="review-box">
          ${sugerindoId === r.id ? `
            <textarea id="comentario-${r.id}" placeholder="Comentário obrigatório — o que precisa mudar?"></textarea>
            <div class="review-actions">
              <button class="btn btn-orange btn-sm" onclick="confirmarSugestao(${r.id})">Enviar</button>
              <button class="btn btn-ghost btn-sm" onclick="sugerindoId=null; desenharFilaBiblioteca();">Cancelar</button>
            </div>
          ` : `
            <button class="btn btn-primary btn-sm" onclick="aprovarRegistro(${r.id})">Aprovar</button>
            <button class="btn-outline-sm" onclick="excluirRegistroFila(${r.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
            <button class="btn btn-orange btn-sm" onclick="sugerindoId=${r.id}; desenharFilaBiblioteca();">Sugerir edição</button>
            <button class="btn btn-ghost btn-sm" onclick="filaAberta.delete(${r.id}); desenharFilaBiblioteca();">Fechar</button>
          `}
        </div>` : `
        <div class="review-box">
          <button class="btn-outline-sm" onclick="filaAberta.add(${r.id}); desenharFilaBiblioteca();">Abrir</button>
        </div>`}
      </div>`;
    }).join('') : `<div class="empty">Nada pendente no momento.</div>`}`;
}
async function aprovarRegistro(id) {
  await api(`/api/registros/${id}/aprovar`, { method: 'POST' });
  mostrarToast('Registro aprovado e publicado na biblioteca.');
  atualizarSino();
  renderAprovacoesBiblioteca();
}
async function confirmarSugestao(id) {
  const comentario = document.getElementById(`comentario-${id}`).value;
  if (!comentario.trim()) { alert('O comentário é obrigatório.'); return; }
  try {
    await api(`/api/registros/${id}/sugerir-alteracao`, { method: 'POST', body: { comentario } });
    sugerindoId = null;
    mostrarToast('Alteração sugerida — o autor foi notificado.');
    atualizarSino();
    renderAprovacoesBiblioteca();
  } catch (e) { alert('Erro: ' + e.message); }
}
async function excluirRegistroFila(id) {
  if (!confirm('Excluir este registro definitivamente? Essa ação não pode ser desfeita.')) return;
  try {
    await api(`/api/registros/${id}`, { method: 'DELETE' });
    mostrarToast('Registro excluído.');
    renderAprovacoesBiblioteca();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- CLIENTES ----------
async function renderClientes() {
  const { clientes } = await api('/api/clientes');
  window._clientesCache = clientes;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div><h1>Clientes</h1><p>${clientes.length} cadastrado(s)</p></div>
      <button class="btn btn-primary btn-sm" onclick="mostrarFormCliente()">+ Novo cliente</button>
    </div>
    <div id="form-cliente"></div>
    <div class="panel"><table>
      <tr><th>Empresa</th><th>Contato</th><th>Telefone</th><th>E-mail</th><th>Cidade/UF</th><th></th></tr>
      ${clientes.length ? clientes.map((c) => `
        <tr>
          <td data-label="Empresa">${esc(c.nome_empresa)}</td>
          <td data-label="Contato">${esc(c.contato || '—')}</td>
          <td data-label="Telefone">${esc(c.telefone || '—')}</td>
          <td data-label="E-mail">${esc(c.email || '—')}</td>
          <td data-label="Cidade/UF">${c.cidade ? esc(c.cidade) + '/' + esc(c.estado || '') : '—'}</td>
          <td class="td-acoes">
            ${USER.papel === 'administrador' ? `
              <button class="btn-outline-sm" onclick="editarCliente(${c.id})">Editar</button>
              <button class="btn-outline-sm" onclick="excluirCliente(${c.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
            ` : ''}
          </td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">Nenhum cliente cadastrado ainda.</td></tr>`}
    </table></div>`;
}

let clienteEmEdicaoId = null;
function mostrarFormCliente(cliente) {
  clienteEmEdicaoId = cliente ? cliente.id : null;
  document.getElementById('form-cliente').innerHTML = `
    <div class="panel"><div class="panel-head">${cliente ? 'Editar cliente' : 'Novo cliente'}</div>
      <div class="form-grid">
        <div class="full"><label>Nome da empresa*</label><input id="nc-nome" value="${cliente ? esc(cliente.nome_empresa) : ''}"></div>
        <div><label>Contato</label><input id="nc-contato" placeholder="Nome do funcionário responsável" value="${cliente ? esc(cliente.contato || '') : ''}"></div>
        <div><label>Telefone</label><input id="nc-telefone" value="${cliente ? esc(cliente.telefone || '') : ''}"></div>
        <div><label>E-mail</label><input id="nc-email" value="${cliente ? esc(cliente.email || '') : ''}"></div>
        <div><label>Setor</label><input id="nc-setor" value="${cliente ? esc(cliente.setor || '') : ''}"></div>
        <div class="full"><label>Endereço</label><input id="nc-endereco" value="${cliente ? esc(cliente.endereco || '') : ''}"></div>
        <div><label>Número</label><input id="nc-numero" value="${cliente ? esc(cliente.numero || '') : ''}"></div>
        <div><label>Bairro</label><input id="nc-bairro" value="${cliente ? esc(cliente.bairro || '') : ''}"></div>
        <div><label>CEP</label><input id="nc-cep" value="${cliente ? esc(cliente.cep || '') : ''}"></div>
        <div><label>Cidade</label><input id="nc-cidade" value="${cliente ? esc(cliente.cidade || '') : ''}"></div>
        <div><label>Estado</label><select id="nc-estado"><option value="">Selecione</option>${Object.keys(UF_REGIAO).map((uf) => `<option value="${uf}" ${cliente && cliente.estado === uf ? 'selected' : ''}>${uf}</option>`).join('')}</select></div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary btn-sm" onclick="salvarCliente()">${cliente ? 'Salvar alterações' : 'Salvar cliente'}</button>
        ${cliente ? `<button class="btn btn-ghost btn-sm" onclick="cancelarEdicaoCliente()">Cancelar</button>` : ''}
      </div>
    </div>`;
}

function editarCliente(id) {
  const cliente = (window._clientesCache || []).find((c) => c.id === id);
  if (!cliente) return;
  mostrarFormCliente(cliente);
  document.getElementById('form-cliente').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicaoCliente() {
  clienteEmEdicaoId = null;
  document.getElementById('form-cliente').innerHTML = '';
}

async function salvarCliente() {
  const nome = document.getElementById('nc-nome').value.trim();
  if (!nome) return alert('Informe o nome da empresa.');
  const body = {
    nome_empresa: nome,
    contato: document.getElementById('nc-contato').value,
    telefone: document.getElementById('nc-telefone').value,
    email: document.getElementById('nc-email').value,
    setor: document.getElementById('nc-setor').value,
    endereco: document.getElementById('nc-endereco').value,
    numero: document.getElementById('nc-numero').value,
    bairro: document.getElementById('nc-bairro').value,
    cep: document.getElementById('nc-cep').value,
    cidade: document.getElementById('nc-cidade').value,
    estado: document.getElementById('nc-estado').value,
  };
  try {
    if (clienteEmEdicaoId) {
      await api(`/api/clientes/${clienteEmEdicaoId}`, { method: 'PUT', body });
      clienteEmEdicaoId = null;
      mostrarToast('Cliente atualizado.');
    } else {
      await api('/api/clientes', { method: 'POST', body });
      mostrarToast('Cliente cadastrado.');
    }
    renderClientes();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

async function excluirCliente(id) {
  if (!confirm('Excluir este cliente? Esta ação não pode ser desfeita.')) return;
  try {
    await api(`/api/clientes/${id}`, { method: 'DELETE' });
    mostrarToast('Cliente excluído.');
    renderClientes();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- EQUIPAMENTOS ----------
// "cliente_id == null" = catálogo (tipo/modelo genérico, ainda sem unidade física);
// "cliente_id" preenchido = unidade atrelada de fato a um cliente, com nº de série próprio.

async function renderMeusEquipamentos() {
  const { equipamentos } = await api('/api/equipamentos');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Meus equipamentos</h1><p>${equipamentos.length} cadastrado(s)</p></div>
    <div class="panel"><table>
      <tr><th>Tipo</th><th>Modelo</th><th>Nº de série</th><th>Localização</th><th></th></tr>
      ${equipamentos.length ? equipamentos.map((e) => `
        <tr><td data-label="Tipo">${e.tipo}</td><td data-label="Modelo">${e.modelo}</td><td data-label="Nº de série">${e.numero_serie}</td><td data-label="Localização">${e.localizacao || '—'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="verHistorico(${e.id})">Histórico</button></td></tr>`).join('') : `<tr><td colspan="5" class="empty">Nenhum equipamento ainda.</td></tr>`}
    </table></div>
    <div id="historico-eq"></div>`;
}

async function verHistorico(id) {
  const { agenda } = await api(`/api/equipamentos/${id}/historico`);
  document.getElementById('historico-eq').innerHTML = `
    <div class="panel"><div class="panel-head">Histórico do equipamento</div>
    <table>
      <tr><th>Data</th><th>Tipo</th><th>Status</th></tr>
      ${agenda.length ? agenda.map((a) => `<tr><td data-label="Data">${fmtData(a.data_hora_inicio)}</td><td data-label="Tipo">${TIPO_OS_LABEL[a.tipo] || a.tipo}</td><td data-label="Status">${a.status}</td></tr>`).join('') : `<tr><td colspan="3" class="empty">Sem histórico ainda.</td></tr>`}
    </table></div>`;
}

// ---- Cadastrar equipamento (catálogo: tipo/modelo, sem cliente ainda) ----
async function renderEquipamentosCadastrar() {
  const { equipamentos } = await api('/api/equipamentos');
  const catalogo = equipamentos.filter((e) => e.cliente_id === null);
  window._catalogoCache = catalogo;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div><h1>Cadastrar equipamento</h1><p>${catalogo.length} no catálogo</p></div>
      <button class="btn btn-primary btn-sm" onclick="mostrarFormEquipamentoCatalogo()">+ Novo equipamento</button>
    </div>
    <p style="color:var(--ink-soft); font-size:13px; margin-top:-14px;">Cadastre aqui o tipo/modelo do equipamento. Depois, use "Atrelar equipamento" pra vincular uma unidade dessas a um cliente com o número de série dela.</p>
    <div id="form-equipamento-catalogo"></div>
    <div class="panel"><table>
      <tr><th>Tipo</th><th>Modelo</th><th></th></tr>
      ${catalogo.length ? catalogo.map((e) => `<tr><td data-label="Tipo">${esc(e.tipo)}</td><td data-label="Modelo">${esc(e.modelo)}</td>
        <td class="td-acoes">
          ${USER.papel === 'administrador' ? `
            <button class="btn-outline-sm" onclick="editarEquipamentoCatalogo(${e.id})">Editar</button>
            <button class="btn-outline-sm" onclick="excluirEquipamento(${e.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
          ` : ''}
        </td></tr>`).join('') : `<tr><td colspan="3" class="empty">Nenhum equipamento no catálogo ainda.</td></tr>`}
    </table></div>`;
}

let equipamentoCatalogoEmEdicaoId = null;
function mostrarFormEquipamentoCatalogo(equipamento) {
  equipamentoCatalogoEmEdicaoId = equipamento ? equipamento.id : null;
  document.getElementById('form-equipamento-catalogo').innerHTML = `
    <div class="panel"><div class="panel-head">${equipamento ? 'Editar equipamento (catálogo)' : 'Novo equipamento (catálogo)'}</div>
      <div class="form-grid">
        <div><label>Tipo*</label><input id="ec-tipo" placeholder="ex: Máquina de Gelo" value="${equipamento ? esc(equipamento.tipo) : ''}"></div>
        <div><label>Modelo*</label><input id="ec-modelo" value="${equipamento ? esc(equipamento.modelo) : ''}"></div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary btn-sm" onclick="salvarEquipamentoCatalogo()">${equipamento ? 'Salvar alterações' : 'Salvar no catálogo'}</button>
        ${equipamento ? `<button class="btn btn-ghost btn-sm" onclick="cancelarEdicaoEquipamentoCatalogo()">Cancelar</button>` : ''}
      </div>
    </div>`;
}

function editarEquipamentoCatalogo(id) {
  const equipamento = (window._catalogoCache || []).find((e) => e.id === id);
  if (!equipamento) return;
  mostrarFormEquipamentoCatalogo(equipamento);
  document.getElementById('form-equipamento-catalogo').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicaoEquipamentoCatalogo() {
  equipamentoCatalogoEmEdicaoId = null;
  document.getElementById('form-equipamento-catalogo').innerHTML = '';
}

async function salvarEquipamentoCatalogo() {
  const tipo = document.getElementById('ec-tipo').value.trim();
  const modelo = document.getElementById('ec-modelo').value.trim();
  if (!tipo || !modelo) return alert('Preencha tipo e modelo.');
  try {
    if (equipamentoCatalogoEmEdicaoId) {
      await api(`/api/equipamentos/${equipamentoCatalogoEmEdicaoId}`, { method: 'PUT', body: { tipo, modelo } });
      equipamentoCatalogoEmEdicaoId = null;
      mostrarToast('Equipamento atualizado.');
    } else {
      await api('/api/equipamentos', { method: 'POST', body: { tipo, modelo } });
      mostrarToast('Equipamento cadastrado no catálogo.');
    }
    renderEquipamentosCadastrar();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

async function excluirEquipamento(id) {
  if (!confirm('Excluir este equipamento? Esta ação não pode ser desfeita.')) return;
  try {
    await api(`/api/equipamentos/${id}`, { method: 'DELETE' });
    mostrarToast('Equipamento excluído.');
    if (paginaAtual === 'equipamentos-atrelar') renderEquipamentosAtrelar();
    else renderEquipamentosCadastrar();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---- Atrelar equipamento (vincula um item do catálogo a um cliente, com nº de série) ----
async function renderEquipamentosAtrelar() {
  const [{ equipamentos }, { clientes }] = await Promise.all([api('/api/equipamentos'), api('/api/clientes')]);
  window._clientesCache = clientes;
  window._catalogoCache = equipamentos.filter((e) => e.cliente_id === null);
  const atrelados = equipamentos.filter((e) => e.cliente_id !== null);
  window._atreladosCache = atrelados;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Atrelar equipamento</h1><p>${atrelados.length} atrelado(s) a clientes</p></div>
    <div class="panel"><div class="panel-head">Atrelar a um cliente</div>
      <div class="form-grid">
        <div><label>Cliente*</label><select id="ae-cliente">${clientes.length ? clientes.map((c) => `<option value="${c.id}">${esc(c.nome_empresa)}</option>`).join('') : '<option value="">Nenhum cliente cadastrado</option>'}</select></div>
        <div><label>Equipamento (catálogo)*</label><select id="ae-equipamento">${window._catalogoCache.length ? window._catalogoCache.map((e) => `<option value="${e.id}">${esc(e.tipo)} — ${esc(e.modelo)}</option>`).join('') : '<option value="">Nenhum equipamento no catálogo</option>'}</select></div>
        <div><label>Número de série*</label><input id="ae-numero-serie"></div>
        <div><label>Data de fabricação (MM/AAAA)</label><input id="ae-data-fabricacao" placeholder="MM/AAAA" maxlength="7"></div>
        <div><label>Localização</label><input id="ae-localizacao" placeholder="ex: Cozinha"></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="salvarAtrelamento()">Atrelar ao cliente</button>
    </div>
    <div id="form-editar-atrelado"></div>
    <div class="panel"><table>
      <tr><th>Cliente</th><th>Tipo</th><th>Modelo</th><th>Nº de série</th><th>Fabricação</th><th></th></tr>
      ${atrelados.length ? atrelados.map((e) => {
        const cliente = clientes.find((c) => c.id === e.cliente_id);
        return `<tr><td data-label="Cliente">${esc(cliente ? cliente.nome_empresa : '—')}</td><td data-label="Tipo">${esc(e.tipo)}</td><td data-label="Modelo">${esc(e.modelo)}</td><td data-label="Nº de série">${esc(e.numero_serie)}</td><td data-label="Fabricação">${esc(e.data_fabricacao || '—')}</td>
        <td class="td-acoes">
          <button class="btn btn-ghost btn-sm" onclick="verHistorico(${e.id})">Histórico</button>
          ${USER.papel === 'administrador' ? `
            <button class="btn-outline-sm" onclick="editarAtrelado(${e.id})">Editar</button>
            <button class="btn-outline-sm" onclick="excluirEquipamento(${e.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
          ` : ''}
        </td></tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">Nenhum equipamento atrelado a um cliente ainda.</td></tr>`}
    </table></div>
    <div id="historico-eq"></div>`;
}

function editarAtrelado(id) {
  const equipamento = (window._atreladosCache || []).find((e) => e.id === id);
  if (!equipamento) return;
  const cliente = (window._clientesCache || []).find((c) => c.id === equipamento.cliente_id);
  document.getElementById('form-editar-atrelado').innerHTML = `
    <div class="panel"><div class="panel-head">Editar equipamento atrelado — ${esc(cliente ? cliente.nome_empresa : '—')}</div>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Tipo, modelo e cliente não podem ser alterados aqui — exclua e atrele novamente se precisar mudá-los.</p>
      <div class="form-grid">
        <div><label>Tipo</label><input value="${esc(equipamento.tipo)}" disabled></div>
        <div><label>Modelo</label><input value="${esc(equipamento.modelo)}" disabled></div>
        <div><label>Número de série*</label><input id="ea-numero-serie" value="${esc(equipamento.numero_serie)}"></div>
        <div><label>Data de fabricação (MM/AAAA)</label><input id="ea-data-fabricacao" placeholder="MM/AAAA" maxlength="7" value="${esc(equipamento.data_fabricacao || '')}"></div>
        <div><label>Localização</label><input id="ea-localizacao" value="${esc(equipamento.localizacao || '')}"></div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary btn-sm" onclick="salvarEdicaoAtrelado(${equipamento.id})">Salvar alterações</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('form-editar-atrelado').innerHTML=''">Cancelar</button>
      </div>
    </div>`;
  document.getElementById('form-editar-atrelado').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function salvarEdicaoAtrelado(id) {
  const numeroSerie = document.getElementById('ea-numero-serie').value.trim();
  if (!numeroSerie) return alert('Informe o número de série.');
  const body = {
    numero_serie: numeroSerie,
    data_fabricacao: document.getElementById('ea-data-fabricacao').value,
    localizacao: document.getElementById('ea-localizacao').value,
  };
  try {
    await api(`/api/equipamentos/${id}`, { method: 'PUT', body });
    mostrarToast('Equipamento atualizado.');
    renderEquipamentosAtrelar();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

async function salvarAtrelamento() {
  const equipamentoId = document.getElementById('ae-equipamento').value;
  const clienteId = document.getElementById('ae-cliente').value;
  const numeroSerie = document.getElementById('ae-numero-serie').value.trim();
  if (!clienteId) return alert('Cadastre um cliente primeiro em Clientes.');
  if (!equipamentoId) return alert('Cadastre um equipamento no catálogo primeiro em Cadastrar equipamento.');
  if (!numeroSerie) return alert('Informe o número de série.');
  const body = {
    cliente_id: clienteId, numero_serie: numeroSerie,
    data_fabricacao: document.getElementById('ae-data-fabricacao').value,
    localizacao: document.getElementById('ae-localizacao').value,
  };
  try {
    await api(`/api/equipamentos/${equipamentoId}/atrelar`, { method: 'POST', body });
    mostrarToast('Equipamento atrelado ao cliente.');
    renderEquipamentosAtrelar();
  } catch (e) { alert('Erro ao atrelar: ' + e.message); }
}

// ---------- USUÁRIOS (cadastro por convite) ----------
// filtro da lista de usuários por tipo de acesso (fica lembrado enquanto a tela estiver aberta,
// mesmo depois de criar/editar/excluir alguém — só reseta se sair e voltar pra tela).
let usuariosFiltroPapel = 'todos';
function alternarFiltroUsuarios() {
  usuariosFiltroPapel = document.getElementById('filtro-usuarios-papel').value;
  renderUsuarios();
}
async function renderUsuarios() {
  const [{ usuarios }, { clientes }] = await Promise.all([api('/api/usuarios'), api('/api/clientes')]);
  window._clientesCache = clientes;
  window._usuariosCache = usuarios;
  const main = document.getElementById('main');
  const papeisPresentes = [...new Set(usuarios.map((u) => u.papel))];
  if (!papeisPresentes.includes(usuariosFiltroPapel)) usuariosFiltroPapel = 'todos';
  const listaFiltrada = usuariosFiltroPapel === 'todos' ? usuarios : usuarios.filter((u) => u.papel === usuariosFiltroPapel);
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Usuários</h1><p>${listaFiltrada.length}${usuariosFiltroPapel !== 'todos' ? ' de ' + usuarios.length : ''} cadastrado(s)</p></div>
      <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <div><label style="display:block; font-size:12px; color:var(--ink-soft); margin-bottom:4px;">Filtrar por tipo de acesso</label>
          <select id="filtro-usuarios-papel" onchange="alternarFiltroUsuarios()">
            <option value="todos" ${usuariosFiltroPapel === 'todos' ? 'selected' : ''}>Todos</option>
            ${papeisPresentes.map((p) => `<option value="${p}" ${usuariosFiltroPapel === p ? 'selected' : ''}>${esc(PAPEL_LABEL[p] || p)}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="mostrarFormUsuario()">+ Novo usuário</button>
      </div>
    </div>
    <div id="form-usuario"></div>
    <div id="convite-resultado"></div>
    ${listaFiltrada.map((u) => `
      <div class="user-row">
        <div class="u-avatar-lg">${initials(u.nome)}</div>
        <div class="u-info">
          <div class="u-line1">${esc(u.nome)} <span class="tag tag-papel">${esc(PAPEL_LABEL[u.papel] || u.papel)}</span>${u.papel === 'administrador' ? ` <span class="tag tag-papel">${u.departamento ? esc(DEPARTAMENTO_ADMIN_LABEL[u.departamento] || u.departamento) : 'Geral'}</span>` : ''}${u.acesso_total === false ? ' <span class="tag" style="background:var(--blue-pale); color:var(--blue);">Acesso personalizado</span>' : ''}${u.protegido ? ' <span class="tag" style="background:var(--blue-pale); color:var(--blue);">🔒 Protegida</span>' : ''}</div>
          <div class="u-line2">${esc(u.email)} ${u.cargo ? '· ' + esc(u.cargo) : ''} ${u.setor ? '· ' + esc(u.setor) : ''}</div>
        </div>
        <span class="badge ${u.status === 'ativo' ? 'badge-ativo' : 'badge-convite'}">${u.status === 'ativo' ? 'Ativo' : 'Convite enviado'}</span>
        ${u.status !== 'ativo' ? `<button class="btn-outline-sm" onclick="reenviarConvite(${u.id})">Reenviar convite</button>` : ''}
        ${!u.protegido || u.id === USER.id ? `<button class="btn-outline-sm" onclick="editarUsuario(${u.id})">Editar</button>` : ''}
        ${!u.protegido ? `<button class="btn-outline-sm" onclick="excluirUsuario(${u.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>` : ''}
      </div>`).join('')}`;
}
let usuarioEmEdicaoId = null;
// um administrador de departamento (USER.departamento preenchido) só pode cadastrar gente do
// próprio setor e clientes — nem vê a opção "Administrador" (não pode criar outro administrador).
// O administrador geral (USER.departamento vazio) continua vendo todas as opções, como sempre foi.
// Editando o próprio cadastro, sempre mostra (travado) o próprio tipo de acesso, mesmo que não
// esteja entre os que dá pra cadastrar — ninguém pode mudar o próprio tipo de acesso.
function papeisCadastraveis(usuario) {
  if (usuario && usuario.id === USER.id) return [usuario.papel];
  if (USER.papel === 'administrador' && USER.departamento) return [USER.departamento, 'cliente'];
  return ['suporte', 'producao', 'pos_venda', 'estoque', 'administrador', 'cliente'];
}
function mostrarFormUsuario(usuario) {
  usuarioEmEdicaoId = usuario ? usuario.id : null;
  const clientes = window._clientesCache || [];
  const opcoesPapel = {
    suporte: 'Suporte', producao: 'Produção', pos_venda: 'Pós-venda', estoque: 'Estoque',
    administrador: 'Administrador', cliente: 'Cliente',
  };
  const permitidos = papeisCadastraveis(usuario);
  const papelPadrao = usuario ? usuario.papel : permitidos[0];
  document.getElementById('form-usuario').innerHTML = `
    <div class="panel"><div class="panel-head">${usuario ? 'Editar usuário' : 'Novo usuário'}</div>
      <div class="form-grid">
        <div><label>Nome</label><input id="nu-nome" value="${usuario ? esc(usuario.nome) : ''}"></div>
        <div><label>E-mail</label><input id="nu-email" value="${usuario ? esc(usuario.email) : ''}"></div>
        <div><label>Cargo</label><input id="nu-cargo" value="${usuario ? esc(usuario.cargo || '') : ''}"></div>
        <div><label>Setor</label><input id="nu-setor" value="${usuario ? esc(usuario.setor || '') : ''}"></div>
        <div><label>Tipo de acesso</label><select id="nu-papel" onchange="alternarCampoCliente()" ${usuario && usuario.id === USER.id ? 'disabled' : ''}>
          ${permitidos.map((p) => `<option value="${p}" ${papelPadrao === p ? 'selected' : ''}>${opcoesPapel[p]}</option>`).join('')}
        </select></div>
        <div id="campo-cliente"><label>Empresa (cliente)</label>${campoClienteHTML('nu-cliente', clientes)}</div>
      </div>
      <div id="campo-admin-departamento" class="panel" style="background:var(--blue-pale-2); margin:4px 0 14px;">
        <label>Departamento que este administrador vai gerenciar</label>
        <select id="nu-departamento" ${usuario && usuario.id === USER.id ? 'disabled' : ''}>
          <option value="">Administrador geral (todos os setores)</option>
          ${Object.entries(DEPARTAMENTO_ADMIN_LABEL).map(([chave, label]) => `
            <option value="${chave}" ${usuario && usuario.departamento === chave ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <p style="color:var(--ink-soft); font-size:12.5px; margin:6px 0 0;">Esse administrador só vai poder cadastrar usuários do setor escolhido — não vê nem mexe nos outros setores.</p>
      </div>
      <div id="campo-menus-acesso" class="panel" style="background:var(--blue-pale-2); margin:4px 0 14px;">
        <label style="display:flex; align-items:center; gap:8px; font-weight:600; text-transform:none;">
          <input type="checkbox" id="nu-acesso-total" style="width:auto;" onchange="alternarChecklistMenus()" ${!usuario || usuario.acesso_total !== false ? 'checked' : ''}>
          Liberar todos os menus
        </label>
        <p style="color:var(--ink-soft); font-size:12.5px; margin:4px 0 10px;">Desmarque pra escolher só os menus que esse usuário pode acessar.</p>
        <div id="nu-menus-lista" style="display:flex; flex-direction:column; gap:8px;"></div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary btn-sm" onclick="salvarUsuario()">${usuario ? 'Salvar alterações' : 'Salvar e enviar convite'}</button>
        ${usuario ? `<button class="btn btn-ghost btn-sm" onclick="cancelarEdicaoUsuario()">Cancelar</button>` : ''}
      </div>
    </div>`;
  alternarCampoCliente();
  if (usuario && usuario.papel === 'cliente' && usuario.cliente_id) {
    const cliente = clientes.find((c) => c.id === usuario.cliente_id);
    if (cliente) { document.getElementById('nu-cliente-nome').value = cliente.nome_empresa; document.getElementById('nu-cliente').value = cliente.id; }
  }
}
function editarUsuario(id) {
  const usuario = (window._usuariosCache || []).find((u) => u.id === id);
  if (!usuario) return;
  mostrarFormUsuario(usuario);
  document.getElementById('form-usuario').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cancelarEdicaoUsuario() {
  usuarioEmEdicaoId = null;
  document.getElementById('form-usuario').innerHTML = '';
}
// reconstrói a lista de checkboxes conforme o tipo de acesso escolhido no momento — cada papel tem
// seu próprio conjunto de menus (ver MENUS_LABEL_POR_PAPEL). Se o papel escolhido é o mesmo que o
// usuário já tinha, pré-marca o que ele já tinha liberado; se mudou de papel, começa do zero (os
// menus do papel antigo não fazem sentido pro novo).
function atualizarChecklistMenus() {
  const papel = document.getElementById('nu-papel').value;
  const usuario = usuarioEmEdicaoId ? (window._usuariosCache || []).find((u) => u.id === usuarioEmEdicaoId) : null;
  const mapa = MENUS_LABEL_POR_PAPEL[papel] || {};
  const lista = document.getElementById('nu-menus-lista');
  if (!lista) return;
  const veioDoMesmoPapel = usuario && usuario.papel === papel;
  lista.innerHTML = Object.entries(mapa).map(([chave, label]) => `
    <label style="display:flex; align-items:center; gap:8px; font-weight:600; text-transform:none;">
      <input type="checkbox" class="nu-menu-item" value="${chave}" style="width:auto;" ${veioDoMesmoPapel && Array.isArray(usuario.menus) && usuario.menus.includes(chave) ? 'checked' : ''}>
      ${label}
    </label>`).join('');
  const totalEl = document.getElementById('nu-acesso-total');
  if (totalEl) totalEl.checked = veioDoMesmoPapel ? usuario.acesso_total !== false : true;
}
function alternarCampoCliente() {
  const papel = document.getElementById('nu-papel').value;
  document.getElementById('campo-cliente').style.display = papel === 'cliente' ? '' : 'none';
  const campoMenus = document.getElementById('campo-menus-acesso');
  if (campoMenus) campoMenus.style.display = MENUS_LABEL_POR_PAPEL[papel] ? '' : 'none';
  const campoDepartamento = document.getElementById('campo-admin-departamento');
  if (campoDepartamento) campoDepartamento.style.display = papel === 'administrador' && !USER.departamento ? '' : 'none';
  atualizarChecklistMenus();
  alternarChecklistMenus();
}
// desmarcar "Liberar todos os menus" revela os checkboxes de cada menu pra personalizar; marcado,
// os checkboxes ficam desabilitados (o usuário tem tudo, independente do que estava marcado antes)
function alternarChecklistMenus() {
  const totalEl = document.getElementById('nu-acesso-total');
  const lista = document.getElementById('nu-menus-lista');
  if (!totalEl || !lista) return;
  const liberado = totalEl.checked;
  lista.style.opacity = liberado ? '0.5' : '1';
  lista.querySelectorAll('.nu-menu-item').forEach((el) => { el.disabled = liberado; });
}
async function salvarUsuario() {
  const papel = document.getElementById('nu-papel').value;
  if (papel === 'cliente' && !document.getElementById('nu-cliente').value) {
    return alert('Escolha uma empresa cadastrada na lista.');
  }
  const body = {
    nome: document.getElementById('nu-nome').value,
    email: document.getElementById('nu-email').value,
    cargo: document.getElementById('nu-cargo').value,
    setor: document.getElementById('nu-setor').value,
    papel,
    cliente_id: papel === 'cliente' ? Number(document.getElementById('nu-cliente').value) : null,
  };
  const totalEl = document.getElementById('nu-acesso-total');
  if (totalEl) {
    body.acesso_total = totalEl.checked;
    body.menus = body.acesso_total ? [] : Array.from(document.querySelectorAll('.nu-menu-item:checked')).map((el) => el.value);
  }
  if (papel === 'administrador') {
    const campoDepartamento = document.getElementById('nu-departamento');
    body.departamento = campoDepartamento ? (campoDepartamento.value || null) : null;
  }
  try {
    if (usuarioEmEdicaoId) {
      await api(`/api/usuarios/${usuarioEmEdicaoId}`, { method: 'PUT', body });
      usuarioEmEdicaoId = null;
      mostrarToast('Usuário atualizado.');
      await renderUsuarios();
    } else {
      const { convite } = await api('/api/usuarios', { method: 'POST', body });
      await renderUsuarios();
      mostrarLinkConvite(convite);
    }
  } catch (e) { alert('Erro: ' + e.message); }
}
async function excluirUsuario(id) {
  if (!confirm('Excluir este usuário? Esta ação não pode ser desfeita.')) return;
  try {
    await api(`/api/usuarios/${id}`, { method: 'DELETE' });
    mostrarToast('Usuário excluído.');
    renderUsuarios();
  } catch (e) { alert('Erro: ' + e.message); }
}
async function reenviarConvite(id) {
  try {
    const { convite } = await api(`/api/usuarios/${id}/reenviar-convite`, { method: 'POST' });
    mostrarLinkConvite(convite);
  } catch (e) { alert('Erro: ' + e.message); }
}
function mostrarLinkConvite(convite) {
  if (!convite) return;
  const alvo = document.getElementById('convite-resultado');
  if (convite.modo === 'simulado') {
    alvo.innerHTML = `<div class="admin-note"><b>Nenhum provedor de e-mail configurado — copie o link de primeiro acesso abaixo e envie manualmente</b>${esc(convite.link)}</div>`;
  } else if (convite.enviado) {
    alvo.innerHTML = `<div class="admin-note" style="background:var(--green-bg); color:var(--green);"><b>Convite enviado por e-mail</b>Link: ${esc(convite.link)}</div>`;
  } else {
    alvo.innerHTML = `<div class="admin-note"><b>Falha ao enviar o e-mail — copie o link manualmente</b>${esc(convite.link)}</div>`;
  }
}

// ---------- ABERTURA DE CHAMADO (cliente) ----------
// ---------- atendimento por chat: tela do cliente ----------
// o cliente conversa com a IA (se estiver configurada); se ela não resolver, o atendimento cai
// na fila do técnico e a conversa continua no mesmo chat, só que respondida por uma pessoa.

let _atClienteChamado = null;
let _atClientePoll = null;

async function renderChamados() {
  clearInterval(_atClientePoll);
  const { chamado } = await api('/api/chamados/meu-ativo');
  _atClienteChamado = chamado;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Atendimento</h1><p>Converse com o assistente — se não resolver, um técnico assume a conversa.</p></div>
    <div class="panel chat-panel">
      <div class="chat-mensagens" id="at-mensagens"></div>
      ${!chamado || chamado.status !== 'encerrado' ? `
        <div class="chat-compositor">
          <textarea id="at-texto" placeholder="${chamado ? 'Digite sua mensagem...' : 'Descreva o problema pra começar o atendimento...'}" rows="2" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();enviarMensagemAtendimentoCliente();}"></textarea>
          <button class="btn btn-primary btn-sm" onclick="enviarMensagemAtendimentoCliente()">Enviar</button>
        </div>` : '<p class="empty" style="margin-top:10px;">Atendimento encerrado. Mande uma nova mensagem abaixo pra abrir outro.</p>'}
    </div>
    <div id="at-historico"></div>`;
  renderMensagensChat('at-mensagens', chamado ? chamado.mensagens : [], 'cliente');
  mostrarAvisoFilaCliente(chamado);
  if (chamado && chamado.status !== 'encerrado') {
    _atClientePoll = setInterval(atualizarAtendimentoCliente, 4000);
  }
  carregarHistoricoAtendimentoCliente();
}

// quando o atendimento já saiu da IA mas ainda não tem um técnico designado (fila de
// "Aguardando técnico"), não existe nenhuma resposta automática pra cada mensagem nova — sem
// esse aviso, o cliente manda mensagem atrás de mensagem sem nenhuma reação e parece que o
// chat travou. Mostra um aviso fixo explicando que é normal, ainda está na fila.
function mostrarAvisoFilaCliente(chamado) {
  const alvo = document.getElementById('at-mensagens');
  if (!alvo) return;
  if (chamado && chamado.status === 'aguardando_tecnico') {
    alvo.insertAdjacentHTML('beforeend', `<div class="chat-sistema">⏳ Seu atendimento está na fila aguardando um técnico assumir.</div>`);
    alvo.scrollTop = alvo.scrollHeight;
  }
}

async function atualizarAtendimentoCliente() {
  if (!_atClienteChamado) return;
  try {
    const { chamado } = await api(`/api/chamados/${_atClienteChamado.id}`);
    _atClienteChamado = chamado;
    renderMensagensChat('at-mensagens', chamado.mensagens, 'cliente');
    mostrarAvisoFilaCliente(chamado);
    if (chamado.status === 'encerrado') { clearInterval(_atClientePoll); renderChamados(); }
  } catch (e) { /* silencioso — tenta de novo no próximo ciclo */ }
}

async function enviarMensagemAtendimentoCliente() {
  const campo = document.getElementById('at-texto');
  const texto = campo.value.trim();
  if (!texto) return;
  campo.value = ''; campo.disabled = true;
  try {
    if (!_atClienteChamado || _atClienteChamado.status === 'encerrado') {
      const { chamado } = await api('/api/chamados', { method: 'POST', body: { mensagem: texto } });
      _atClienteChamado = chamado;
      renderChamados();
      return;
    }
    const { chamado } = await api(`/api/chamados/${_atClienteChamado.id}/mensagens`, { method: 'POST', body: { texto } });
    _atClienteChamado = chamado;
    renderMensagensChat('at-mensagens', chamado.mensagens, 'cliente');
    mostrarAvisoFilaCliente(chamado);
    if (!_atClientePoll) _atClientePoll = setInterval(atualizarAtendimentoCliente, 4000);
  } catch (e) { alert('Erro: ' + e.message); }
  finally { campo.disabled = false; campo.focus(); }
}

async function carregarHistoricoAtendimentoCliente() {
  const { chamados } = await api('/api/chamados/meus-encerrados');
  const alvo = document.getElementById('at-historico');
  if (!alvo || !chamados.length) return;
  alvo.innerHTML = `
    <div class="page-head"><h1 style="font-size:16px;">Atendimentos anteriores</h1></div>
    <div class="panel"><table>
      <tr><th>Data</th><th>Resolvido por</th></tr>
      ${chamados.map((c) => `<tr><td data-label="Data">${fmtData(c.criado_em)}</td><td data-label="Resolvido por">${c.resolvido_por === 'ia' ? 'Assistente' : c.numero_os ? 'Técnico — ' + esc(c.numero_os) : 'Técnico'}</td></tr>`).join('')}
    </table></div>`;
}

// mensagens do chat — reaproveitado tanto na tela do cliente quanto na do técnico; "visao"
// decide de que lado do chat cada bolha aparece (a mensagem de quem tá olhando vai pra direita)
function renderMensagensChat(containerId, mensagens, visao) {
  const alvo = document.getElementById(containerId);
  if (!alvo) return;
  // visao 'admin' é só leitura (histórico) — não marca nenhuma mensagem como "Você"
  const proprioAutor = visao === 'cliente' ? 'cliente' : visao === 'pos_venda' ? 'pos_venda' : visao === 'admin' ? null : 'tecnico';
  alvo.innerHTML = (mensagens || []).length ? (mensagens || []).map((m) => {
    if (m.autor === 'sistema') return `<div class="chat-sistema">${esc(m.texto)}</div>`;
    const proprio = m.autor === proprioAutor;
    const rotulo = m.autor === 'ia' ? 'Assistente' : proprio ? 'Você' : (m.autor === 'tecnico' ? 'Técnico' : m.autor === 'pos_venda' ? 'Pós-venda' : 'Cliente');
    return `<div class="chat-msg ${proprio ? 'chat-msg-proprio' : 'chat-msg-outro'} chat-msg-${m.autor}">
      <div class="chat-msg-rotulo">${rotulo}</div>
      <div class="chat-msg-texto">${esc(m.texto)}</div>
      <div class="chat-msg-hora">${fmtData(m.criado_em)}</div>
    </div>`;
  }).join('') : '<p class="empty">Nenhuma mensagem ainda.</p>';
  alvo.scrollTop = alvo.scrollHeight;
}

// ---------- atendimento por chat: fila e chat do técnico ----------

async function renderFilaAtendimento() {
  const [{ chamados: fila }, { chamados: meus }] = await Promise.all([
    api('/api/chamados?fila=1'),
    api('/api/chamados'),
  ]);
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Fila de Atendimento</h1><p>Atendimentos que a IA não conseguiu resolver sozinha — qualquer técnico pode assumir.</p></div>
    <div class="panel">
      <h2>Aguardando técnico (${fila.length})</h2>
      <div class="atendimento-grid">
        ${fila.length ? fila.map((c) => cardAtendimentoFila(c)).join('') : '<p class="empty">Nenhum atendimento na fila agora.</p>'}
      </div>
    </div>
    <div class="panel">
      <h2>Meus atendimentos</h2>
      <div class="atendimento-grid">
        ${meus.length ? meus.map((c) => cardAtendimentoFila(c)).join('') : '<p class="empty">Você ainda não assumiu nenhum atendimento.</p>'}
      </div>
    </div>`;
}

function legendaStatusChamado(c) {
  if (c.os_finalizada) return tag('Finalizado', 'green');
  if (c.os_fase_atendimento && c.os_fase_atendimento !== 'em_atendimento') return tag('Pós-venda', 'purple');
  if (c.status === 'aguardando_tecnico') return tag('Aguardando técnico', 'amber');
  if (c.status === 'convertido_os') return tag('Em atendimento', 'green');
  return tag(c.status, 'blue');
}

// nível de SLA definido pela IA (Tabela de Prioridade de Atendimento) — cores seguem a mesma
// escala da planilha da empresa: Baixo=verde, Médio=amarelo, Alto=vermelho, Crítico=roxo
const SLA_TAG_COR = { baixo: 'green', medio: 'amber', alto: 'falha', critico: 'purple' };
const SLA_TAG_LABEL = { baixo: 'Baixo', medio: 'Médio', alto: 'Alto', critico: 'Crítico' };
function tagSla(c) {
  if (!c.sla_nivel) return '';
  return `<span class="tag tag-${SLA_TAG_COR[c.sla_nivel] || 'blue'}" title="Prazo: ${c.sla_horas_atendimento}h atendimento · ${c.sla_dias_manutencao}d manutenção · ${c.sla_dias_visita_tecnica}d visita técnica">SLA ${SLA_TAG_LABEL[c.sla_nivel] || c.sla_nivel}</span>`;
}

// mesmas 11 perguntas da Tabela de Prioridade de Atendimento usadas pela IA (ver ia.js) — sem
// garantia_fabricacao, que o servidor calcula sozinho a partir da data de fabricação do
// equipamento (mesma regra de dentroDaGarantiaDeFabrica), pra o admin não precisar responder.
const PERGUNTAS_SLA = [
  { chave: 'garantia_manutencao', pergunta: 'A máquina está em garantia de manutenção?' },
  { chave: 'linha_parada', pergunta: 'A linha de produção está parada por causa desse problema?' },
  { chave: 'plano_preventiva_ativo', pergunta: 'O cliente tem plano de manutenção preventiva ativo?' },
  { chave: 'possui_maquina_reserva', pergunta: 'O cliente possui mais máquinas para a mesma função (reserva/backup)?' },
  { chave: 'compromete_qualidade', pergunta: 'O problema compromete a qualidade da gravação/marcação?' },
  { chave: 'erro_intermitente', pergunta: 'O erro ocorre de forma intermitente (vai e volta)?' },
  { chave: 'reparo_sem_sucesso', pergunta: 'A máquina já passou por tentativas de reparo sem sucesso?' },
  { chave: 'acesso_remoto', pergunta: 'A máquina permite acesso remoto pra diagnóstico?' },
  { chave: 'duvida_comum_top5', pergunta: 'O erro relatado faz parte das dúvidas mais comuns (Top 5)?' },
  { chave: 'solucao_no_manual', pergunta: 'A informação/solução pra esse problema está no manual do equipamento?' },
];

function cardAtendimentoFila(c) {
  const naoLido = c.tecnico_id && !c.lida_tecnico;
  const resumo = c.resumo_ia || c.primeira_mensagem_cliente || '';
  const encerradoOuEncaminhado = c.os_finalizada || (c.os_fase_atendimento && c.os_fase_atendimento !== 'em_atendimento');
  return `
    <div class="atendimento-card ${c.prioridade === 'alta' ? 'atendimento-urgente' : ''} ${encerradoOuEncaminhado ? 'atendimento-card-finalizado' : ''}" onclick="abrirChatAtendimentoTecnico(${c.id})">
      <div class="atendimento-card-topo">
        <span class="atendimento-numero">ATENDIMENTO #${c.id}</span>
        ${c.prioridade === 'alta' ? '<span class="tag tag-falha">ALTA</span>' : ''}
        ${tagSla(c)}
        ${naoLido ? '<span class="tag tag-blue">Nova mensagem</span>' : ''}
      </div>
      <div class="atendimento-cliente">${esc(c.cliente_nome || 'Cliente não identificado')}</div>
      ${c.equipamento_tipo ? `<div class="atendimento-equip">${esc(c.equipamento_tipo)}${c.equipamento_modelo ? ' — ' + esc(c.equipamento_modelo) : ''}</div>` : ''}
      ${resumo ? `<div class="atendimento-resumo">${esc(resumo.slice(0, 140))}</div>` : ''}
      <div class="atendimento-status">${legendaStatusChamado(c)}</div>
    </div>`;
}

let _atTecChamado = null;
let _atTecPoll = null;

async function abrirChatAtendimentoTecnico(id) {
  clearInterval(_atTecPoll);
  const { chamado } = await api(`/api/chamados/${id}`);
  _atTecChamado = chamado;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Atendimento #${chamado.id} ${tagSla(chamado)}</h1><p>${esc(chamado.cliente_nome || 'Cliente não identificado')}${chamado.equipamento_tipo ? ' — ' + esc(chamado.equipamento_tipo) : ''}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${chamado.status === 'aguardando_tecnico' ? `<button class="btn btn-primary btn-sm" onclick="assumirAtendimento(${chamado.id})">Assumir atendimento</button>` : ''}
        ${chamado.os_id ? `<button class="btn-outline-sm" onclick="ir('agenda')">Ver O.S. ${esc(chamado.numero_os || '')}</button>` : ''}
        ${chamado.os_id && chamado.os_fase_atendimento === 'em_atendimento' ? `<button class="btn-outline-sm" onclick="encerrarAtendimento(${chamado.os_id})">✓ Encerrar atendimento</button>` : ''}
        ${chamado.os_id && chamado.os_fase_atendimento === 'em_atendimento' ? `<button class="btn btn-primary btn-sm" onclick="encaminharPosVenda(${chamado.os_id})">Encaminhar pro pós-venda</button>` : ''}
        <button class="btn-outline-sm" onclick="ir('fila-atendimento')">‹ Voltar</button>
      </div>
    </div>
    <div class="panel chat-panel">
      <div class="chat-mensagens" id="at-mensagens"></div>
      ${chamado.tecnico_id ? `
        <div class="chat-compositor">
          <textarea id="at-texto" placeholder="Digite sua mensagem..." rows="2" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();enviarMensagemAtendimentoTecnico();}"></textarea>
          <button class="btn btn-primary btn-sm" onclick="enviarMensagemAtendimentoTecnico()">Enviar</button>
        </div>` : '<p class="empty" style="margin-top:10px;">Assuma o atendimento pra poder responder ao cliente.</p>'}
    </div>`;
  renderMensagensChat('at-mensagens', chamado.mensagens, 'tecnico');
  if (chamado.status !== 'encerrado') _atTecPoll = setInterval(atualizarAtendimentoTecnico, 4000);
}

async function atualizarAtendimentoTecnico() {
  if (!_atTecChamado) return;
  try {
    const { chamado } = await api(`/api/chamados/${_atTecChamado.id}`);
    _atTecChamado = chamado;
    renderMensagensChat('at-mensagens', chamado.mensagens, 'tecnico');
  } catch (e) { /* silencioso */ }
}

async function enviarMensagemAtendimentoTecnico() {
  const campo = document.getElementById('at-texto');
  const texto = campo.value.trim();
  if (!texto || !_atTecChamado) return;
  campo.value = ''; campo.disabled = true;
  try {
    const { chamado } = await api(`/api/chamados/${_atTecChamado.id}/mensagens`, { method: 'POST', body: { texto } });
    _atTecChamado = chamado;
    renderMensagensChat('at-mensagens', chamado.mensagens, 'tecnico');
  } catch (e) { alert('Erro: ' + e.message); }
  finally { campo.disabled = false; campo.focus(); }
}

async function encerrarAtendimento(agendaId) {
  if (!confirm('Confirma que o problema foi resolvido direto pelo chat? A O.S. será finalizada, sem passar pelo pós-venda.')) return;
  try {
    await api(`/api/agenda/${agendaId}/encerrar-atendimento`, { method: 'POST' });
    mostrarToast('Atendimento encerrado.');
    ir('fila-atendimento');
  } catch (e) { alert('Erro: ' + e.message); }
}

// modal de encaminhamento pro pós-venda: motivo + questionário de SLA opcional (o técnico
// responde aqui antes de encaminhar — a IA do chat não faz mais essas perguntas)
function encaminharPosVenda(agendaId) {
  let modal = document.getElementById('modal-pos-venda');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-pos-venda';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
  modal.innerHTML = `
    <div class="modal-card" style="max-width:640px; max-height:85vh; overflow-y:auto;">
      <h3>Encaminhar pro pós-venda</h3>
      <div class="form-grid">
        <div class="full">
          <label>Motivo*</label>
          <select id="pv-motivo">
            <option value="">Selecione</option>
            <option value="cliente_envia_equipamento">Cliente vai enviar o equipamento</option>
            <option value="tecnico_visita">Técnico vai até o cliente</option>
            <option value="peca_enviada">Vamos enviar uma peça pro cliente</option>
          </select>
        </div>
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-weight:600; text-transform:none; margin:16px 0 10px;">
        <input type="checkbox" id="pv-sla-ativar" onchange="atualizarSlaPosVenda()" style="width:auto;">
        Definir o SLA deste atendimento agora
      </label>
      <div id="pv-sla-perguntas" class="form-grid hidden">
        ${PERGUNTAS_SLA.map((p) => `
          <div class="full">
            <label style="text-transform:none; font-weight:600;">${esc(p.pergunta)}</label>
            <div style="display:flex; gap:18px; margin-top:4px; margin-bottom:6px;">
              <label style="display:flex; align-items:center; gap:6px; font-weight:400; text-transform:none;"><input type="radio" name="pv-sla-${p.chave}" value="sim" style="width:auto;"> Sim</label>
              <label style="display:flex; align-items:center; gap:6px; font-weight:400; text-transform:none;"><input type="radio" name="pv-sla-${p.chave}" value="nao" style="width:auto;"> Não</label>
            </div>
          </div>`).join('')}
      </div>
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-primary" onclick="confirmarEncaminharPosVenda(${agendaId})">Encaminhar</button>
        <button class="btn-outline-sm" onclick="document.getElementById('modal-pos-venda').classList.remove('show')">Cancelar</button>
      </div>
    </div>`;
}

function atualizarSlaPosVenda() {
  const ativo = document.getElementById('pv-sla-ativar').checked;
  document.getElementById('pv-sla-perguntas').classList.toggle('hidden', !ativo);
}

async function confirmarEncaminharPosVenda(agendaId) {
  const motivo = document.getElementById('pv-motivo').value;
  if (!motivo) return alert('Escolha o motivo do encaminhamento.');
  let sla_respostas = null;
  if (document.getElementById('pv-sla-ativar').checked) {
    sla_respostas = {};
    for (const p of PERGUNTAS_SLA) {
      const marcado = document.querySelector(`input[name="pv-sla-${p.chave}"]:checked`);
      if (!marcado) return alert(`Responda a pergunta "${p.pergunta}", ou desmarque "Definir o SLA deste atendimento agora".`);
      sla_respostas[p.chave] = marcado.value === 'sim';
    }
  }
  const body = { motivo };
  if (sla_respostas) body.sla_respostas = sla_respostas;
  try {
    await api(`/api/agenda/${agendaId}/encaminhar-pos-venda`, { method: 'POST', body });
    document.getElementById('modal-pos-venda').classList.remove('show');
    mostrarToast('Encaminhado pro pós-venda.');
    ir('fila-atendimento');
  } catch (e) { alert('Erro: ' + e.message); }
}

async function assumirAtendimento(id) {
  try {
    await api(`/api/chamados/${id}/assumir`, { method: 'POST', body: {} });
    mostrarToast('Atendimento assumido — uma Ordem de Serviço foi aberta.');
    abrirChatAtendimentoTecnico(id);
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- atendimento por chat: painel do administrador ----------

async function renderPainelAtendimentos() {
  const stats = await api('/api/chamados/stats');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Atendimentos</h1><p>Atendimento por chat de hoje — IA de 1º nível e fila de técnicos.</p></div>
    <div class="atendimento-stats-grid">
      <div class="stat-tile"><div class="stat-valor">${stats.total}</div><div class="stat-label">Total hoje</div></div>
      <div class="stat-tile"><div class="stat-valor">${stats.resolvidos_ia}</div><div class="stat-label">Resolvidos pela IA</div></div>
      <div class="stat-tile"><div class="stat-valor">${stats.tecnico}</div><div class="stat-label">Técnico</div></div>
      <div class="stat-tile"><div class="stat-valor">${stats.tempo_medio_ia || '—'}</div><div class="stat-label">Tempo médio IA</div></div>
      <div class="stat-tile"><div class="stat-valor">${stats.tempo_medio_tecnico || '—'}</div><div class="stat-label">Tempo médio técnico</div></div>
      <div class="stat-tile"><div class="stat-valor">${stats.aguardando}</div><div class="stat-label">Aguardando</div></div>
    </div>`;
}

// ---------- pós-venda / setor reparo ----------

const MOTIVO_POS_VENDA_LABEL = {
  cliente_envia_equipamento: 'Cliente vai enviar o equipamento',
  tecnico_visita: 'Técnico vai até o cliente',
  peca_enviada: 'Envio de peça pro cliente',
};

async function renderFilaPosVenda() {
  const { agenda } = await api('/api/agenda/fila-pos-venda');
  window._agendaCache = agenda;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Pós-venda</h1><p>Atendimentos que não resolveram no chat e precisam de orçamento.</p></div>
    <div class="atendimento-grid">
      ${agenda.length ? agenda.map((a) => cardPosVenda(a)).join('') : '<p class="empty">Nenhum atendimento aguardando o pós-venda agora.</p>'}
    </div>`;
}

function cardPosVenda(a) {
  const aguardandoDecisao = a.fase_atendimento === 'orcamento_enviado';
  return `
    <div class="atendimento-card">
      <div class="atendimento-card-topo">
        <span class="atendimento-numero">${esc(numeroOS(a))}</span>
        ${tagSla(a)}
      </div>
      <div class="atendimento-cliente">${esc(a.cliente_nome || 'Cliente não identificado')}</div>
      ${a.equipamento_tipo ? `<div class="atendimento-equip">${esc(a.equipamento_tipo)}${a.equipamento_modelo ? ' — ' + esc(a.equipamento_modelo) : ''}</div>` : ''}
      <div class="atendimento-resumo">${esc(MOTIVO_POS_VENDA_LABEL[a.motivo_pos_venda] || '—')}</div>
      <div class="atendimento-status">${aguardandoDecisao ? tag('Orçamento enviado — aguardando cliente', 'amber') : tag('Aguardando pós-venda', 'blue')}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
        ${a.origem_chamado_id ? `<button class="btn-outline-sm" onclick="abrirChatAtendimentoPosVenda(${a.origem_chamado_id})">💬 Iniciar atendimento</button>` : ''}
        ${aguardandoDecisao ? `
          <button class="btn btn-primary btn-sm" onclick="posVendaDecisao(${a.id}, true)">Cliente aprovou</button>
          <button class="btn-ghost btn-sm" onclick="posVendaDecisao(${a.id}, false)">Cliente não aprovou</button>
        ` : `
          ${a.motivo_pos_venda === 'cliente_envia_equipamento' && !a.equipamento_recebido_em ? `<button class="btn-outline-sm" onclick="posVendaAguardandoEquipamento(${a.id})">Aguardando equipamento</button>` : ''}
          <button class="btn btn-primary btn-sm" onclick="posVendaOrcamentoEnviado(${a.id})">Orçamento enviado</button>
        `}
      </div>
    </div>`;
}

async function posVendaAguardandoEquipamento(id) {
  try { await api(`/api/agenda/${id}/pos-venda/aguardando-equipamento`, { method: 'POST' }); mostrarToast('Encaminhado pro setor de reparo.'); renderFilaPosVenda(); }
  catch (e) { alert('Erro: ' + e.message); }
}

async function posVendaOrcamentoEnviado(id) {
  try { await api(`/api/agenda/${id}/pos-venda/orcamento-enviado`, { method: 'POST' }); mostrarToast('Orçamento marcado como enviado.'); renderFilaPosVenda(); }
  catch (e) { alert('Erro: ' + e.message); }
}

async function posVendaDecisao(id, aprovado) {
  // a mensagem muda conforme o motivo do encaminhamento — só "cliente envia equipamento" vai
  // pro setor de reparo; "peça enviada" vai pro estoque; "técnico visita" avisa o administrador
  // pra criar a O.S. de visita técnica de verdade (ver rota pos-venda/decisao em server.js)
  const item = (window._agendaCache || []).find((a) => a.id === id);
  const motivo = item ? item.motivo_pos_venda : null;
  let msgConfirm, msgToast;
  if (!aprovado) {
    msgConfirm = 'Confirma que o cliente não aprovou o orçamento? A O.S. será finalizada.';
    msgToast = 'O.S. finalizada.';
  } else if (motivo === 'cliente_envia_equipamento') {
    msgConfirm = 'Confirma que o cliente aprovou o orçamento? A O.S. vai pro setor de reparo executar o serviço.';
    msgToast = 'Aprovado — encaminhado pro reparo.';
  } else if (motivo === 'peca_enviada') {
    msgConfirm = 'Confirma que o cliente aprovou o orçamento? A O.S. vai pro estoque enviar a peça.';
    msgToast = 'Aprovado — encaminhado pro estoque.';
  } else {
    msgConfirm = 'Confirma que o cliente aprovou o orçamento? O administrador será avisado pra criar a O.S. de visita técnica.';
    msgToast = 'Aprovado — administrador avisado pra criar a O.S. de visita técnica.';
  }
  if (!confirm(msgConfirm)) return;
  try { await api(`/api/agenda/${id}/pos-venda/decisao`, { method: 'POST', body: { aprovado } }); mostrarToast(msgToast); renderFilaPosVenda(); }
  catch (e) { alert('Erro: ' + e.message); }
}

// ---------- pós-venda: chat com o cliente (mesma conversa iniciada pelo técnico) ----------
// pós-venda usa o chat pra combinar o envio do orçamento por fora do sistema (e-mail, etc.) —
// os botões de aguardando equipamento / orçamento enviado / decisão do cliente ficam disponíveis
// aqui também, além do card na fila.

let _atPvChamado = null;
let _atPvPoll = null;

async function abrirChatAtendimentoPosVenda(chamadoId) {
  clearInterval(_atPvPoll);
  const { chamado } = await api(`/api/chamados/${chamadoId}`);
  _atPvChamado = chamado;
  const a = (window._agendaCache || []).find((x) => x.id === chamado.os_id) || {};
  const aguardandoDecisao = a.fase_atendimento === 'orcamento_enviado';
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Atendimento #${chamado.id}</h1><p>${esc(chamado.cliente_nome || 'Cliente não identificado')}${chamado.equipamento_tipo ? ' — ' + esc(chamado.equipamento_tipo) : ''}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${aguardandoDecisao ? `
          <button class="btn btn-primary btn-sm" onclick="posVendaDecisao(${a.id}, true)">Cliente aprovou</button>
          <button class="btn-ghost btn-sm" onclick="posVendaDecisao(${a.id}, false)">Cliente não aprovou</button>
        ` : a.fase_atendimento === 'aguardando_pos_venda' ? `
          ${a.motivo_pos_venda === 'cliente_envia_equipamento' && !a.equipamento_recebido_em ? `<button class="btn-outline-sm" onclick="posVendaAguardandoEquipamento(${a.id})">Aguardando equipamento</button>` : ''}
          <button class="btn btn-primary btn-sm" onclick="posVendaOrcamentoEnviado(${a.id})">Orçamento enviado</button>
        ` : ''}
        <button class="btn-outline-sm" onclick="ir('fila-pos-venda')">‹ Voltar</button>
      </div>
    </div>
    <div class="panel chat-panel">
      <div class="chat-mensagens" id="at-mensagens"></div>
      ${chamado.status !== 'encerrado' ? `
        <div class="chat-compositor">
          <textarea id="at-texto" placeholder="Digite sua mensagem..." rows="2" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();enviarMensagemAtendimentoPosVenda();}"></textarea>
          <button class="btn btn-primary btn-sm" onclick="enviarMensagemAtendimentoPosVenda()">Enviar</button>
        </div>` : '<p class="empty" style="margin-top:10px;">Atendimento encerrado.</p>'}
    </div>`;
  renderMensagensChat('at-mensagens', chamado.mensagens, 'pos_venda');
  if (chamado.status !== 'encerrado') _atPvPoll = setInterval(atualizarAtendimentoPosVenda, 4000);
}

async function atualizarAtendimentoPosVenda() {
  if (!_atPvChamado) return;
  try {
    const { chamado } = await api(`/api/chamados/${_atPvChamado.id}`);
    _atPvChamado = chamado;
    renderMensagensChat('at-mensagens', chamado.mensagens, 'pos_venda');
  } catch (e) { /* silencioso */ }
}

async function enviarMensagemAtendimentoPosVenda() {
  const campo = document.getElementById('at-texto');
  const texto = campo.value.trim();
  if (!texto || !_atPvChamado) return;
  campo.value = ''; campo.disabled = true;
  try {
    const { chamado } = await api(`/api/chamados/${_atPvChamado.id}/mensagens`, { method: 'POST', body: { texto } });
    _atPvChamado = chamado;
    renderMensagensChat('at-mensagens', chamado.mensagens, 'pos_venda');
  } catch (e) { alert('Erro: ' + e.message); }
  finally { campo.disabled = false; campo.focus(); }
}

async function renderFilaReparo() {
  const { agenda } = await api('/api/agenda/fila-reparo');
  window._agendaCache = agenda;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Setor Reparo</h1><p>Equipamentos aguardando chegada, diagnóstico ou execução do reparo.</p></div>
    <div class="atendimento-grid">
      ${agenda.length ? agenda.map((a) => cardReparo(a)).join('') : '<p class="empty">Nenhum atendimento no setor de reparo agora.</p>'}
    </div>`;
}

function cardReparo(a) {
  let statusTag, acao;
  if (a.fase_atendimento === 'aguardando_equipamento') {
    statusTag = tag('Aguardando equipamento', 'amber');
    acao = `<button class="btn btn-primary btn-sm" onclick="reparoIniciarAtendimento(${a.id})">Iniciar atendimento</button>`;
  } else if (a.fase_atendimento === 'em_diagnostico_reparo') {
    statusTag = tag('Em diagnóstico', 'blue');
    acao = a.tecnico_id === USER.id ? `<button class="btn btn-primary btn-sm" onclick="abrirDiario(${a.id})">Preencher relatório de diagnóstico</button>` : `<span style="font-size:11.5px; color:var(--ink-soft);">Designado a ${esc(a.tecnico_nome || 'outro técnico')}.</span>`;
  } else {
    statusTag = tag('Orçamento aprovado — executar reparo', 'green');
    acao = `<button class="btn btn-primary btn-sm" onclick="abrirDiario(${a.id})">Preencher relatório de liberação</button>`;
  }
  return `
    <div class="atendimento-card">
      <div class="atendimento-card-topo">
        <span class="atendimento-numero">${esc(numeroOS(a))}</span>
      </div>
      <div class="atendimento-cliente">${esc(a.cliente_nome || 'Cliente não identificado')}</div>
      ${a.equipamento_tipo ? `<div class="atendimento-equip">${esc(a.equipamento_tipo)}${a.equipamento_modelo ? ' — ' + esc(a.equipamento_modelo) : ''}</div>` : ''}
      <div class="atendimento-status">${statusTag}</div>
      <div style="margin-top:10px;">${acao}</div>
    </div>`;
}

async function reparoIniciarAtendimento(id) {
  try { await api(`/api/agenda/${id}/reparo/iniciar-atendimento`, { method: 'POST' }); mostrarToast('Atendimento iniciado — preencha o relatório quando concluir o diagnóstico.'); renderFilaReparo(); }
  catch (e) { alert('Erro: ' + e.message); }
}

// ---------- estoque: confirma chegada (equipamento enviado pelo cliente) e saída (equipamento
// reparado ou peça enviada) ----------

async function renderFilaEstoque() {
  const { agenda } = await api('/api/agenda/fila-estoque');
  window._agendaCache = agenda;
  const chegada = agenda.filter((a) => a.fase_atendimento === 'aguardando_equipamento');
  const saida = agenda.filter((a) => a.fase_atendimento === 'aguardando_saida_estoque');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Estoque</h1><p>Confirme a chegada de equipamentos enviados pelo cliente e a saída de equipamentos reparados ou peças.</p></div>
    <div class="panel">
      <h2>Aguardando chegada (${chegada.length})</h2>
      <div class="atendimento-grid">
        ${chegada.length ? chegada.map((a) => cardEstoqueChegada(a)).join('') : '<p class="empty">Nenhum equipamento aguardando chegada agora.</p>'}
      </div>
    </div>
    <div class="panel">
      <h2>Aguardando saída (${saida.length})</h2>
      <div class="atendimento-grid">
        ${saida.length ? saida.map((a) => cardEstoqueSaida(a)).join('') : '<p class="empty">Nenhuma saída pendente agora.</p>'}
      </div>
    </div>`;
}

function cardEstoqueChegada(a) {
  return `
    <div class="atendimento-card" style="cursor:pointer;" onclick="abrirDetalheEstoque(${a.id})">
      <div class="atendimento-card-topo"><span class="atendimento-numero">${esc(numeroOS(a))}</span></div>
      <div class="atendimento-cliente">${esc(a.cliente_nome || 'Cliente não identificado')}</div>
      <div class="atendimento-equip">${a.equipamento_tipo ? esc(a.equipamento_tipo) + (a.equipamento_modelo ? ' — ' + esc(a.equipamento_modelo) : '') : 'Equipamento não vinculado a esta O.S.'}</div>
      <div class="atendimento-status">${tag('Aguardando chegada do cliente', 'amber')}</div>
      <div style="margin-top:10px; display:flex; gap:8px;" onclick="event.stopPropagation()">
        <button class="btn-outline-sm" onclick="abrirDetalheEstoque(${a.id})">Ver detalhes</button>
        <button class="btn btn-primary btn-sm" onclick="estoqueConfirmarChegada(${a.id})">Confirmar chegada</button>
      </div>
    </div>`;
}

function cardEstoqueSaida(a) {
  const label = a.motivo_pos_venda === 'peca_enviada' ? 'Confirmar envio da peça' : 'Confirmar saída do equipamento';
  const resumo = a.motivo_pos_venda === 'peca_enviada' ? 'Orçamento aprovado — peça pronta pra envio' : 'Equipamento reparado pelo setor de reparo';
  return `
    <div class="atendimento-card" style="cursor:pointer;" onclick="abrirDetalheEstoque(${a.id})">
      <div class="atendimento-card-topo"><span class="atendimento-numero">${esc(numeroOS(a))}</span></div>
      <div class="atendimento-cliente">${esc(a.cliente_nome || 'Cliente não identificado')}</div>
      <div class="atendimento-equip">${a.equipamento_tipo ? esc(a.equipamento_tipo) + (a.equipamento_modelo ? ' — ' + esc(a.equipamento_modelo) : '') : 'Equipamento não vinculado a esta O.S.'}</div>
      <div class="atendimento-resumo">${esc(resumo)}</div>
      <div class="atendimento-status">${tag('Pronto pra saída', 'purple')}</div>
      <div style="margin-top:10px; display:flex; gap:8px;" onclick="event.stopPropagation()">
        <button class="btn-outline-sm" onclick="abrirDetalheEstoque(${a.id})">Ver detalhes</button>
        <button class="btn btn-primary btn-sm" onclick="estoqueConfirmarSaida(${a.id})">${label}</button>
      </div>
    </div>`;
}

// tela separada com os dados completos do cliente e do equipamento antes de confirmar chegada ou
// saída — sem isso o estoque só via o resuminho do card (e se o equipamento não estava vinculado
// à O.S., nem isso aparecia).
function abrirDetalheEstoque(id) {
  const a = (window._agendaCache || []).find((x) => x.id === id);
  if (!a) return;
  const aguardandoChegada = a.fase_atendimento === 'aguardando_equipamento';
  const label = a.motivo_pos_venda === 'peca_enviada' ? 'Confirmar envio da peça' : 'Confirmar saída do equipamento';
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(numeroOS(a))}</h1><p>${esc(a.cliente_nome || '—')}</p></div>
      <button class="btn-outline-sm" onclick="renderFilaEstoque()">‹ Voltar</button>
    </div>
    <div class="panel">
      <div class="kv"><b>Empresa:</b> ${esc(a.cliente_nome || '—')} <span class="sep">·</span> <b>Contato:</b> ${esc(a.cliente_contato || '—')} <span class="sep">·</span> <b>Telefone:</b> ${esc(a.cliente_telefone || '—')}</div>
      <div class="kv"><b>E-mail:</b> ${esc(a.cliente_email || '—')}</div>
      ${a.cliente_endereco ? `<div class="kv"><b>Endereço:</b> ${esc(a.cliente_endereco)}${a.cliente_numero ? ', ' + esc(a.cliente_numero) : ''} — ${esc(a.cliente_bairro || '—')}, ${esc(a.cliente_cidade || '—')}/${esc(a.cliente_estado || '—')}</div>` : ''}
      <div class="kv"><b>Equipamento:</b> ${esc(a.equipamento_tipo || '—')} — ${esc(a.equipamento_modelo || '—')}</div>
      <div class="kv"><b>Número de série:</b> ${esc(a.equipamento_serie || '—')} <span class="sep">·</span> <b>Data de fabricação:</b> ${esc(a.equipamento_data_fabricacao || '—')}</div>
      <div class="kv"><b>Técnico do reparo:</b> ${esc(a.tecnico_nome || '—')}</div>
      <div class="admin-note" style="margin-top:14px;">${aguardandoChegada ? 'Aguardando o equipamento chegar (enviado pelo cliente).' : (a.motivo_pos_venda === 'peca_enviada' ? 'Orçamento aprovado — peça pronta pra envio.' : 'Equipamento reparado pelo setor de reparo — pronto pra sair.')}</div>
      <div style="margin-top:16px;">
        ${aguardandoChegada
          ? `<button class="btn btn-primary btn-sm" onclick="estoqueConfirmarChegada(${a.id})">Confirmar chegada</button>`
          : `<button class="btn btn-primary btn-sm" onclick="estoqueConfirmarSaida(${a.id})">${label}</button>`}
      </div>
    </div>`;
}

async function estoqueConfirmarChegada(id) {
  try { await api(`/api/agenda/${id}/estoque/confirmar-chegada`, { method: 'POST' }); mostrarToast('Chegada confirmada — o setor de reparo foi avisado.'); renderFilaEstoque(); }
  catch (e) { alert('Erro: ' + e.message); }
}

async function estoqueConfirmarSaida(id) {
  if (!confirm('Confirma que saiu rumo ao cliente? A O.S. será finalizada.')) return;
  try { await api(`/api/agenda/${id}/estoque/confirmar-saida`, { method: 'POST' }); mostrarToast('Saída confirmada — O.S. finalizada.'); renderFilaEstoque(); }
  catch (e) { alert('Erro: ' + e.message); }
}

// ---------- chat interno (mensagens diretas entre a equipe, sem o cliente) ----------
// widget flutuante tipo Facebook Messenger — fica sobreposto no canto inferior direito em
// qualquer tela do sistema (não é uma página, vive fora do #main, então navegar não fecha ele).

function temAcessoChatInterno() {
  if (!['suporte', 'administrador', 'producao', 'pos_venda', 'estoque'].includes(USER.papel)) return false;
  if (USER.acesso_total !== false) return true;
  return Array.isArray(USER.menus) && USER.menus.includes('chat-interno');
}

let chatWidgetAberto = false;
let chatWidgetTela = 'lista'; // 'lista' | 'conversa'
let _chatInternoAtual = null;
let _chatInternoPoll = null;
let _chatWidgetBadgePoll = null;

function montarWidgetChatInterno() {
  if (!temAcessoChatInterno() || document.getElementById('chat-widget')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="chat-widget" class="chat-widget">
      <div id="chat-widget-painel" class="chat-widget-painel" style="display:none;">
        <div class="chat-widget-topo">
          <button id="chat-widget-voltar" class="chat-widget-voltar" style="display:none;" onclick="chatWidgetMostrarLista()">‹</button>
          <span id="chat-widget-titulo">Mensagens</span>
          <button id="chat-widget-nova" class="chat-widget-nova" onclick="chatWidgetMostrarNovaConversa()" title="Nova conversa">＋</button>
          <button class="chat-widget-fechar" onclick="alternarChatWidget()">✕</button>
        </div>
        <div id="chat-widget-corpo" class="chat-widget-corpo"></div>
      </div>
      <button id="chat-widget-launcher" class="chat-widget-launcher" onclick="alternarChatWidget()" title="Mensagens">
        💬<span id="chat-widget-badge" class="chat-widget-badge" style="display:none;">0</span>
      </button>
    </div>`);
  atualizarBadgeChatWidget();
  _chatWidgetBadgePoll = setInterval(atualizarBadgeChatWidget, 15000);
}

function desmontarWidgetChatInterno() {
  clearInterval(_chatWidgetBadgePoll);
  clearInterval(_chatInternoPoll);
  chatWidgetAberto = false; _chatInternoAtual = null;
  const w = document.getElementById('chat-widget');
  if (w) w.remove();
}

async function atualizarBadgeChatWidget() {
  if (!temAcessoChatInterno()) return;
  try {
    const { contatos } = await api('/api/chat-interno/contatos');
    window._chatInternoContatos = contatos;
    const total = contatos.reduce((soma, c) => soma + (c.nao_lidas || 0), 0);
    const badge = document.getElementById('chat-widget-badge');
    if (badge) { badge.style.display = total ? 'flex' : 'none'; badge.textContent = total > 99 ? '99+' : total; }
    if (chatWidgetAberto && chatWidgetTela === 'lista') renderListaContatosWidget(contatos);
  } catch (e) { /* silencioso */ }
}

function alternarChatWidget() {
  chatWidgetAberto = !chatWidgetAberto;
  const painel = document.getElementById('chat-widget-painel');
  if (!painel) return;
  painel.style.display = chatWidgetAberto ? 'flex' : 'none';
  if (chatWidgetAberto) chatWidgetMostrarLista();
  else { clearInterval(_chatInternoPoll); _chatInternoAtual = null; }
}

async function chatWidgetMostrarLista() {
  chatWidgetTela = 'lista';
  clearInterval(_chatInternoPoll);
  _chatInternoAtual = null;
  document.getElementById('chat-widget-voltar').style.display = 'none';
  document.getElementById('chat-widget-nova').style.display = '';
  document.getElementById('chat-widget-titulo').textContent = 'Mensagens';
  const { contatos } = await api('/api/chat-interno/contatos');
  window._chatInternoContatos = contatos;
  renderListaContatosWidget(contatos);
}

// a lista principal só mostra quem já tem conversa iniciada (igual o WhatsApp) — pra falar com
// alguém novo é o botão "+" (chatWidgetMostrarNovaConversa) que mostra todo mundo pra escolher.
function renderListaContatosWidget(contatos) {
  if (chatWidgetTela !== 'lista') return;
  const corpo = document.getElementById('chat-widget-corpo');
  if (!corpo) return;
  const iniciadas = contatos.filter((c) => c.ultima_mensagem_em);
  corpo.innerHTML = iniciadas.length
    ? `<div class="chat-widget-contatos">${listaContatosInternosHTML(iniciadas)}</div>`
    : `<div class="chat-widget-vazio">
        <p class="empty">Nenhuma conversa ainda.</p>
        <button class="btn btn-primary btn-sm" onclick="chatWidgetMostrarNovaConversa()">+ Nova conversa</button>
      </div>`;
}

async function chatWidgetMostrarNovaConversa() {
  chatWidgetTela = 'nova-conversa';
  clearInterval(_chatInternoPoll);
  _chatInternoAtual = null;
  document.getElementById('chat-widget-voltar').style.display = '';
  document.getElementById('chat-widget-nova').style.display = 'none';
  document.getElementById('chat-widget-titulo').textContent = 'Nova conversa';
  const { contatos } = await api('/api/chat-interno/contatos');
  window._chatInternoContatos = contatos;
  document.getElementById('chat-widget-corpo').innerHTML =
    `<div class="chat-widget-contatos">${listaContatosInternosHTML(contatos, true)}</div>`;
}

// modoPicker esconde a prévia da última mensagem/contador — vira só uma lista de nomes pra
// escolher com quem falar, igual o "Nova conversa" do WhatsApp.
function listaContatosInternosHTML(contatos, modoPicker) {
  if (!contatos.length) return '<p class="empty">Nenhum outro usuário cadastrado ainda.</p>';
  return contatos.map((c) => `
    <div class="user-row" style="cursor:pointer;" onclick="chatWidgetAbrirConversa(${c.id})">
      <div class="u-avatar-lg">${initials(c.nome)}</div>
      <div class="u-info">
        <div class="u-line1">${esc(c.nome)} <span class="tag tag-papel">${esc(PAPEL_LABEL[c.papel] || c.papel)}</span>${c.papel === 'administrador' ? ` <span class="tag tag-papel">${c.departamento ? esc(DEPARTAMENTO_ADMIN_LABEL[c.departamento] || c.departamento) : 'Geral'}</span>` : ''}${!modoPicker && c.nao_lidas ? ` <span class="tag" style="background:var(--blue); color:#fff;">${c.nao_lidas}</span>` : ''}</div>
        ${modoPicker ? '' : `<div class="u-line2">${c.ultima_mensagem_texto ? (c.ultima_mensagem_propria ? 'Você: ' : '') + esc(c.ultima_mensagem_texto) : 'Nenhuma mensagem ainda'}</div>`}
      </div>
      ${!modoPicker && c.ultima_mensagem_em ? `<span class="badge">${fmtData(c.ultima_mensagem_em)}</span>` : ''}
    </div>`).join('');
}

async function chatWidgetAbrirConversa(id) {
  chatWidgetTela = 'conversa';
  clearInterval(_chatInternoPoll);
  const { mensagens, contato } = await api(`/api/chat-interno/${id}/mensagens`);
  _chatInternoAtual = contato;
  document.getElementById('chat-widget-voltar').style.display = '';
  document.getElementById('chat-widget-nova').style.display = 'none';
  document.getElementById('chat-widget-titulo').textContent = contato.nome;
  document.getElementById('chat-widget-corpo').innerHTML = `
    <div class="chat-mensagens" id="ci-mensagens"></div>
    <div class="chat-compositor">
      <textarea id="ci-texto" placeholder="Digite sua mensagem..." rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();enviarMensagemInterna();}"></textarea>
      <button class="btn btn-primary btn-sm" onclick="enviarMensagemInterna()">Enviar</button>
    </div>`;
  renderMensagensInternas(mensagens);
  _chatInternoPoll = setInterval(atualizarConversaInterna, 4000);
  atualizarBadgeChatWidget();
}

async function atualizarConversaInterna() {
  if (!_chatInternoAtual) return;
  try {
    const { mensagens } = await api(`/api/chat-interno/${_chatInternoAtual.id}/mensagens`);
    renderMensagensInternas(mensagens);
  } catch (e) { /* silencioso — tenta de novo no próximo ciclo */ }
}

async function enviarMensagemInterna() {
  if (!_chatInternoAtual) return;
  const campo = document.getElementById('ci-texto');
  const texto = campo.value.trim();
  if (!texto) return;
  campo.value = ''; campo.disabled = true;
  try {
    await api(`/api/chat-interno/${_chatInternoAtual.id}/mensagens`, { method: 'POST', body: { texto } });
    const { mensagens } = await api(`/api/chat-interno/${_chatInternoAtual.id}/mensagens`);
    renderMensagensInternas(mensagens);
  } catch (e) { alert('Erro: ' + e.message); }
  finally { campo.disabled = false; campo.focus(); }
}

function renderMensagensInternas(mensagens) {
  const alvo = document.getElementById('ci-mensagens');
  if (!alvo) return;
  alvo.innerHTML = mensagens.length ? mensagens.map((m) => {
    const proprio = m.remetente_id === USER.id;
    return `<div class="chat-msg ${proprio ? 'chat-msg-proprio' : 'chat-msg-outro'}">
      <div class="chat-msg-texto">${esc(m.texto)}</div>
      <div class="chat-msg-hora">${fmtData(m.criado_em)}</div>
    </div>`;
  }).join('') : '<p class="empty">Nenhuma mensagem ainda — diga oi!</p>';
  alvo.scrollTop = alvo.scrollHeight;
}

// ---------- administrador: Solicitação de Atendimento (motivo "técnico vai até o cliente") ----------
// depois que o pós-venda aprova o orçamento nesse caminho, o admin precisa criar uma O.S. de
// verdade (visita técnica) pra agendar o técnico — essa tela reúne os pedidos e pré-preenche o
// formulário padrão de Nova Ordem de Serviço com os dados do atendimento original.

async function renderFilaSolicitacaoAtendimento() {
  const { agenda } = await api('/api/agenda/fila-solicitacao-atendimento');
  window._agendaCache = agenda;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Solicitação de Atendimento</h1><p>Orçamentos aprovados pra visita técnica — crie a O.S. de verdade pra agendar o técnico.</p></div>
    <div class="atendimento-grid">
      ${agenda.length ? agenda.map((a) => cardSolicitacaoAtendimento(a)).join('') : '<p class="empty">Nenhuma solicitação de atendimento pendente agora.</p>'}
    </div>
    <div id="form-nova-atividade"></div>`;
}

function cardSolicitacaoAtendimento(a) {
  return `
    <div class="atendimento-card">
      <div class="atendimento-card-topo"><span class="atendimento-numero">${esc(numeroOS(a))}</span></div>
      <div class="atendimento-cliente">${esc(a.cliente_nome || 'Cliente não identificado')}</div>
      ${a.equipamento_tipo ? `<div class="atendimento-equip">${esc(a.equipamento_tipo)}${a.equipamento_modelo ? ' — ' + esc(a.equipamento_modelo) : ''}</div>` : ''}
      ${a.problema ? `<div class="atendimento-resumo">${esc(a.problema.slice(0, 140))}</div>` : ''}
      <div class="atendimento-status">${tag('Orçamento aprovado — aguardando O.S.', 'orange')}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
        ${a.origem_chamado_id ? `<button class="btn-outline-sm" onclick="abrirHistoricoAtendimentoAdmin(${a.origem_chamado_id})">💬 Ver atendimento</button>` : ''}
        <button class="btn btn-primary btn-sm" onclick="abrirCriarOSDeSolicitacao(${a.id})">Criar O.S. de visita técnica</button>
      </div>
    </div>`;
}

function abrirCriarOSDeSolicitacao(id) {
  const item = (window._agendaCache || []).find((a) => a.id === id);
  if (!item) return;
  mostrarFormNovaAtividade(null, item);
  document.getElementById('form-nova-atividade').scrollIntoView({ behavior: 'smooth' });
}

// histórico do atendimento por chat, só leitura — o administrador confere a conversa antes de
// criar a O.S. de visita técnica (ver o que já foi discutido com o cliente e o técnico)
async function abrirHistoricoAtendimentoAdmin(chamadoId) {
  const { chamado } = await api(`/api/chamados/${chamadoId}`);
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Atendimento #${chamado.id} ${tagSla(chamado)}</h1><p>${esc(chamado.cliente_nome || 'Cliente não identificado')}${chamado.equipamento_tipo ? ' — ' + esc(chamado.equipamento_tipo) : ''}</p></div>
      <button class="btn-outline-sm" onclick="ir('fila-solicitacao-atendimento')">‹ Voltar</button>
    </div>
    <div class="panel chat-panel">
      <div class="chat-mensagens" id="at-mensagens"></div>
      <p class="empty" style="margin-top:10px;">Histórico da conversa — somente leitura.</p>
    </div>`;
  renderMensagensChat('at-mensagens', chamado.mensagens, 'admin');
}

// ---------- toast ----------
function mostrarModalSucesso(mensagem) {
  let modal = document.getElementById('modal-sucesso');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-sucesso';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
  modal.innerHTML = `
    <div class="modal-card" style="max-width:360px; text-align:center;">
      <div class="modal-sucesso-icone">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <h3 style="margin-top:16px;">${esc(mensagem)}</h3>
      <button class="btn btn-primary" style="width:100%; justify-content:center; margin-top:18px;" onclick="document.getElementById('modal-sucesso').classList.remove('show')">Ok</button>
    </div>`;
}

function mostrarToast(texto) {
  const toast = document.getElementById('toast');
  toast.textContent = texto;
  toast.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

tentarSessaoExistente();
carregarEmpresa();
