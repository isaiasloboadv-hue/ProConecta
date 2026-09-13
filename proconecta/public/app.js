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

const PAPEL_LABEL = { tecnico: 'Técnico', administrador: 'Administrador', cliente: 'Cliente' };
const TIPO_OS_LABEL = {
  corretiva: 'Corretiva', preventiva: 'Preventiva', treinamento_online: 'Treinamento online',
  treinamento_presencial: 'Treinamento presencial', demonstracao_tecnica: 'Demonstração Técnica',
};
// versão curta pro topo do card de O.S. — cabe ao lado da tag do técnico sem quebrar linha
const TIPO_OS_LABEL_CURTO = {
  corretiva: 'Corretiva', preventiva: 'Preventiva', treinamento_online: 'Trein. online',
  treinamento_presencial: 'Trein. presencial', demonstracao_tecnica: 'Demo. técnica',
};
const TIPO_OS_COR = {
  corretiva: 'falha', preventiva: 'green', treinamento_online: 'blue',
  treinamento_presencial: 'amber', demonstracao_tecnica: 'orange',
};
// laudo técnico (diagnóstico + serviço + peças + fotos, sem checklist/assinatura)
const TIPOS_LAUDO_TECNICO = ['corretiva', 'preventiva'];
// termo de aceite com checklist/assinatura — hoje só treinamento presencial, enquanto
// o modelo de referência específico dele não chega
const TIPOS_TERMO_ACEITE = ['treinamento_presencial'];

const CHECKLIST_CORRETIVA = [
  'Instalação mecânica', 'Instalação elétrica', 'Instalação software', 'Sistema de segurança',
  'Tryout', 'Utilização de nobreak', 'Aterramento da máquina', 'Tomada dedicada', 'Lente',
  'I/O da máquina', 'Sistema de refrigeração', 'Acompanhamento da linha',
  'Treinamento operacional', 'Treinamento configuração', 'Treinamento manutenção', 'Entrega de documentação',
];
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
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro || 'Erro na requisição');
  return data;
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
    entrarNoApp();
  } catch (e) {
    erroEl.textContent = e.message;
    erroEl.classList.remove('hidden');
  }
}

function sair() {
  TOKEN = null; USER = null; navAbertos = new Set();
  if (sinoTimer) clearInterval(sinoTimer);
  localStorage.removeItem('pc_token');
  document.getElementById('appView').style.display = 'none';
  document.getElementById('authView').style.display = 'flex';
}

async function tentarSessaoExistente() {
  if (!TOKEN) return;
  try {
    const data = await api('/api/me');
    USER = data.usuario;
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
// termo de aceite quando esse item sincronizar mais tarde.
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
  if (USER.papel === 'tecnico' || USER.papel === 'administrador') ativarNotificacoesPush();
  const paginaInicial = { administrador: 'agenda', tecnico: 'agenda', cliente: 'biblioteca-defeitos' }[USER.papel] || 'agenda';
  ir(paginaInicial);
}

function initials(nome) {
  return (nome || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

function renderHeaderRight() {
  const el = document.getElementById('headerRight');
  el.innerHTML = `
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

// força buscar a versão mais nova do sistema e dos dados — útil no app instalado (PWA),
// que pode ficar aberto em segundo plano por dias sem recarregar sozinho.
function sincronizarApp() {
  const btn = document.getElementById('btn-sync');
  if (btn) btn.classList.add('girando');
  location.reload();
}

// ---------- menu em cascata ----------

const NAV = {
  tecnico: [
    { key: 'agenda', label: 'Minha agenda', page: 'agenda' },
    { key: 'relatorio-manutencao', label: 'Criar Relatório', page: 'relatorio-manutencao' },
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
  ],
  administrador: [
    { key: 'agenda', label: 'Agenda geral', page: 'agenda' },
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
    { key: 'chamados', label: 'Abertura de chamado', page: 'chamados' },
  ],
};

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
  const label = USER.papel === 'tecnico' ? 'Acesso técnico' : USER.papel === 'administrador' ? 'Acesso administrador' : 'Acesso cliente';
  const nav = NAV[USER.papel] || [];
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
  paginaAtual = pagina;
  const caminho = buscarCaminho(NAV[USER.papel] || [], pagina, []);
  if (caminho) caminho.forEach((k) => navAbertos.add(k));
  fecharMenuMobile();
  montarSidebar();
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Carregando...</div>';
  try {
    if (pagina === 'agenda') return renderAgenda();
    if (pagina === 'relatorio-manutencao') return renderRelatorioManutencao();
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
  } catch (e) {
    main.innerHTML = `<div class="empty">Erro: ${e.message}</div>`;
  }
}

function tag(texto, cor) { return `<span class="tag tag-${cor}">${texto}</span>`; }
function fmtData(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
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
async function carregarAgendaComVisitas() {
  const [{ agenda }, { visitas }] = await Promise.all([api('/api/agenda'), api('/api/visitas')]);
  window._agendaCache = agenda;
  window._visitasPorAgenda = {};
  visitas.forEach((v) => { window._visitasPorAgenda[v.agenda_id] = v; });
}

async function renderAgenda() {
  if (USER.papel === 'administrador') {
    await carregarAgendaComVisitas();
    return renderAgendaCalendario();
  }
  const { agenda } = await api('/api/agenda');
  window._agendaCache = agenda;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Minha agenda</h1><p>${agenda.length} atividade(s)</p></div>
    <div class="panel"><table>
      <tr><th>Data</th><th>Cliente</th><th>Equipamento</th><th>Tipo</th><th>Status</th><th></th></tr>
      ${agenda.length ? agenda.map((a) => `
        <tr>
          <td data-label="Data">${fmtData(a.data_hora_inicio)}</td>
          <td data-label="Cliente">${a.cliente_nome || '—'}</td>
          <td data-label="Equipamento">${a.equipamento_tipo || '—'} ${a.equipamento_modelo ? '(' + a.equipamento_modelo + ')' : ''}</td>
          <td data-label="Tipo">${TIPO_OS_LABEL[a.tipo] || a.tipo}</td>
          <td data-label="Status">${a.status === 'concluida'
            ? (a.visita_status === 'aprovado' ? tag('Concluída', 'green') : a.visita_status === 'reprovado' ? tag('Reprovado', 'falha') : tag('Em análise', 'amber'))
            : a.status === 'em_andamento' ? tag('Em andamento', 'blue') : tag('Pendente', 'amber')}</td>
          <td>${botaoDeslocamento(a)}${a.status !== 'concluida' ? `<button class="btn btn-ghost btn-sm" onclick="abrirDiario(${a.id})">Executar</button>` : ''}
            ${a.status === 'concluida' && a.visita_id && a.visita_status === 'aprovado' ? (
              a.visita_solicitacao_reabertura && a.visita_solicitacao_reabertura.status === 'pendente'
                ? `<span class="tag tag-amber">Reabertura solicitada</span>`
                : `<button class="btn-outline-sm" onclick="solicitarReaberturaVisita(${a.visita_id})">Solicitar reabertura</button>`
            ) : ''}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">Nenhuma atividade ainda.</td></tr>`}
    </table></div>
    <div id="diario-form"></div>
  `;
}

// ---------- AGENDA GERAL (admin): calendário mensal ----------
const MES_LABEL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DOW_LABEL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
let calAno = new Date().getFullYear();
let calMes = new Date().getMonth();
let calDiaSelecionado = null;

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
        <button class="btn-outline-sm" onclick="irParaHojeCalendario()">Hoje</button>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
    </div>
  `;
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
  const agenda = window._agendaCache || [];
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
function renderDiaCalendario(iso) {
  const agenda = (window._agendaCache || []).filter((a) => (a.data_hora_inicio || '').slice(0, 10) === iso)
    .sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  const [y, m, d] = iso.split('-');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Ordens de serviço em ${d}/${m}/${y}</h1><p>${agenda.length} O.S. agendada(s) para este dia</p></div>
      <button class="btn-outline-sm" onclick="renderAgendaCalendario()">‹ Voltar ao calendário</button>
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
function faseAtualOS(a) {
  const visita = (window._visitasPorAgenda || {})[a.id];
  if (a.finalizada) return { label: 'Finalizada', cor: 'green' };
  if (visita && visita.status_aprovacao === 'aprovado') return { label: 'Aguardando finalização', cor: 'teal' };
  if (visita && visita.status_aprovacao === 'reprovado') return { label: 'Relatório reprovado', cor: 'red' };
  if (visita) return { label: 'Relatório em análise', cor: 'orange' };
  if (a.deslocamento_iniciado_em) return { label: 'Técnico a caminho', cor: 'blue' };
  const hojeISO = dataISOLocal(new Date());
  const diaAtendimento = (a.data_hora_inicio || '').slice(0, 10);
  if (diaAtendimento > hojeISO) return { label: 'Aguardando serviço', cor: 'navy' };
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
      <div class="os-fase-banner os-fase-${fase.cor}">${esc(fase.label)}</div>
      <div class="os-tarja os-tarja-${status}">${STATUS_OS_LABEL[status]}</div>
      <div class="os-card-top">
        <span class="tag tag-${TIPO_OS_COR[a.tipo] || 'blue'} os-tag-tipo" title="${esc(TIPO_OS_LABEL[a.tipo] || a.tipo)}">${esc(TIPO_OS_LABEL_CURTO[a.tipo] || TIPO_OS_LABEL[a.tipo] || a.tipo)}</span>
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
async function mostrarFormNovaAtividade(agendaItem) {
  agendaEmEdicaoId = agendaItem ? agendaItem.id : null;
  const [{ usuarios }, { equipamentos }, { clientes }, sugestaoNumero] = await Promise.all([
    api('/api/usuarios'), api('/api/equipamentos'), api('/api/clientes'),
    agendaItem ? Promise.resolve(null) : api('/api/agenda/proximo-numero'),
  ]);
  const tecnicos = usuarios.filter((u) => u.papel === 'tecnico');
  window._clientesCache = clientes;
  window._equipamentosCache = equipamentos;
  document.getElementById('form-nova-atividade').innerHTML = `
    <div class="panel"><div class="panel-head">${agendaItem ? 'Editar Ordem de Serviço' : 'Nova Ordem de Serviço'}</div>
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
      await api('/api/agenda', { method: 'POST', body });
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
        <b>WhatsApp:</b> 12 99718-7506 &nbsp; <b>Telefone:</b> 12 3902-3453<br>
        <b>E-mail:</b> suporte@promarking.com.br / tecnico@promarking.com.br
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
function chaveRascunhoLaudo(agendaId) { return `pc_rascunho_laudo_${agendaId}`; }

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
    const bruto = localStorage.getItem(chaveRascunhoLaudo(item.id));
    if (bruto) {
      const salvo = JSON.parse(bruto);
      laudoDraft = salvo.draft;
      salvoEm = salvo.em;
    } else if (item.visita_id) {
      const { visita } = await api(`/api/visitas/${item.visita_id}`);
      laudoDraft = visita.laudo ? { ...laudoPadrao(item), ...visita.laudo } : laudoPadrao(item);
    } else {
      laudoDraft = laudoPadrao(item);
    }
  } catch (e) { laudoDraft = laudoPadrao(item); }
  laudoDraft.agenda_id = item.id;

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Laudo Técnico — ${esc(TIPO_OS_LABEL[item.tipo] || item.tipo)}</h1><p>Preenchimento presencial no cliente. Campos com * são obrigatórios.</p></div>
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
    </div>

    <div class="panel">
      <h2>Relatório fotográfico*</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Anexe ao menos uma foto do equipamento/serviço realizado.</p>
      <div class="step-photos" id="lt-fotos"></div>
      <label class="photo-add" style="margin-top:10px;">
        <span class="plus">+</span>Foto
        <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosLaudo(event)">
      </label>
    </div>

    <div class="panel">
      <h2>Observações</h2>
      <textarea id="lt-observacoes" placeholder="Observações adicionais (opcional)" oninput="atualizarRascunhoLaudo()"></textarea>
    </div>

    <div class="panel">
      <h2>Sobre o equipamento</h2>
      <p style="font-size:13.5px; line-height:1.6;">
        Para obter assistência durante o período de garantia, entre em contato conosco através dos seguintes meios:<br><br>
        <b>WhatsApp:</b> 12 99718-7506 &nbsp; <b>Telefone:</b> 12 3902-3453<br>
        <b>E-mail:</b> suporte@promarking.com.br / atendimento@promarking.com.br / tecnico@promarking.com.br / posvenda@promarking.com.br
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
      <p style="font-size:12.5px; color:var(--ink-soft);">Ao finalizar, o laudo é enviado para aprovação do administrador. O PDF fica disponível para gerar assim que ele for aprovado.</p>
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
function adicionarFotosLaudo(event) {
  const arquivos = Array.from(event.target.files || []);
  Promise.all(arquivos.map((arquivo) => new Promise((resolve) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.readAsDataURL(arquivo);
  }))).then((dataUrls) => {
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
  }
  document.getElementById('lt-periodo').value = periodoReparo(laudoDraft);
  try {
    localStorage.setItem(chaveRascunhoLaudo(laudoDraft.agenda_id), JSON.stringify({ draft: laudoDraft, em: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }));
    const status = document.getElementById('lt-rascunho-status');
    if (status) status.textContent = `Rascunho salvo automaticamente neste dispositivo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {}
}

function limparLaudo(agendaId) {
  if (!confirm('Limpar todo o formulário e apagar o rascunho salvo?')) return;
  localStorage.removeItem(chaveRascunhoLaudo(agendaId));
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

  const body = { agenda_id: d.agenda_id, laudo: d, relevante_biblioteca: d.relevante_biblioteca };
  let r;
  try {
    r = await enviarVisitaOuEnfileirar(body, { chaveRascunho: chaveRascunhoLaudo(d.agenda_id) });
  } catch (e) {
    alert('Erro ao concluir: ' + e.message);
    return;
  }
  if (r.enviado) localStorage.removeItem(chaveRascunhoLaudo(d.agenda_id));
  mostrarModalSucesso(r.enfileirado ? MSG_ENFILEIRADO : 'Laudo finalizado e enviado para aprovação do administrador. O PDF ficará disponível assim que ele for aprovado.');
  renderAgenda();
}

function gerarPdfLaudo(d, item) {
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
  doc.text('Laudo Técnico — Pro Conecta', margem, y); y += 22;
  doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(74, 85, 104);
  doc.text(`Elaborado: ${new Date().toLocaleDateString('pt-BR')} · Setor: ${USER.setor || 'Suporte Técnico'}`, margem, y); y += 24;

  titulo('Dados do atendimento');
  linha('Empresa', item.cliente_nome); linha('Contato', item.contato || item.cliente_contato); linha('Telefone', item.telefone || item.cliente_telefone);
  linha('Endereço', `${item.endereco || item.cliente_endereco || ''}, ${item.numero || item.cliente_numero || ''} — ${item.bairro || item.cliente_bairro || ''}, ${item.cidade || item.cliente_cidade || ''}/${item.estado || item.cliente_estado || ''}`);
  linha('Técnico', item.tecnico_nome || USER.nome);
  linha('Equipamento', `${item.equipamento_tipo || ''} — ${item.equipamento_modelo || ''} (${item.equipamento_serie || '—'})`);
  y += 8;

  titulo('Dados do equipamento');
  linha('Data de fabricação', d.data_fabricacao);
  linha('Garantia', d.garantia === 'sim' ? 'Sim' : d.garantia === 'nao' ? 'Não' : `N/A — ${d.garantia_obs}`);
  linha('Acessórios recebidos', d.acessorios); linha('Defeito informado', d.defeito_informado);
  y += 8;

  titulo('Técnico responsável');
  linha('Data de início', fmtData(d.data_entrada)); linha('Data de conclusão', fmtData(d.data_conclusao)); linha('Período de reparo', periodoReparo(d));
  y += 8;

  titulo('Laudo técnico');
  { if (y > 740) { doc.addPage(); y = 50; } doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38); const linhas = doc.splitTextToSize(limparPdf(d.laudo_tecnico), largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8; }

  titulo('Serviço realizado');
  { if (y > 740) { doc.addPage(); y = 50; } doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38); const linhas = doc.splitTextToSize(limparPdf(d.servico_realizado), largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8; }

  if (d.pecas.length) {
    titulo('Peças fornecidas');
    d.pecas.forEach((p) => {
      if (y > 760) { doc.addPage(); y = 50; }
      doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38);
      doc.text(limparPdf(`- ${p.descricao || '—'}${p.quantidade ? ' (qtd: ' + p.quantidade + ')' : ''}`), margem, y); y += 13;
    });
    y += 8;
  }

  if (d.observacoes) {
    titulo('Observações');
    if (y > 740) { doc.addPage(); y = 50; }
    doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38);
    const linhas = doc.splitTextToSize(limparPdf(d.observacoes), largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8;
  }

  if (d.fotos.length) {
    doc.addPage(); y = 50;
    titulo('Relatório fotográfico');
    const wImg = 240, hImg = 180;
    let x = margem;
    d.fotos.forEach((f, i) => {
      if (x + wImg > margem + largura) { x = margem; y += hImg + 20; }
      if (y + hImg > 780) { doc.addPage(); y = 50; x = margem; }
      const m = /^data:image\/(\w+);/.exec(f);
      const formato = m ? m[1].toUpperCase().replace('JPG', 'JPEG') : 'JPEG';
      try { doc.addImage(f, formato, x, y, wImg, hImg); } catch (e) {}
      x += wImg + 20;
    });
  }

  doc.setFontSize(9); doc.setTextColor(74, 85, 104);
  doc.text('PRO Marking · WhatsApp 12 99718-7506 · Telefone 12 3902-3453 · suporte@promarking.com.br', margem, doc.internal.pageSize.getHeight() - 24);

  return doc.output('datauristring');
}

// ---------- APROVAÇÃO DE VISITAS (diário técnico ligado à agenda) ----------
let osAno = new Date().getFullYear();
let osMes = new Date().getMonth();
let osSomenteHoje = false;

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

function desenharOrdemServico() {
  const agenda = window._agendaCache || [];
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
        <button class="btn-outline-sm ${osSomenteHoje ? 'active' : ''}" style="${osSomenteHoje ? 'background:var(--blue); color:#fff; border-color:var(--blue);' : ''}" onclick="irParaHojeOS()">${osSomenteHoje ? '✓ Só hoje' : 'Hoje'}</button>
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
function acoesOS(a, visita) {
  if (a.finalizada) {
    return `<span class="tag" style="background:var(--blue-pale); color:var(--blue);">✓ Finalizada em ${fmtData(a.finalizado_em)} — cliente já confirmou o serviço. Abra uma nova O.S. se precisar de um novo atendimento.</span>`;
  }
  let acoes;
  if (visita && visita.status_aprovacao === 'pendente') {
    acoes = `
      <button class="btn btn-primary btn-sm" onclick="aprovarVisita(${visita.id})">Aprovar</button>
      ${visita.relevante_biblioteca ? `<button class="btn btn-primary btn-sm" onclick="aprovarVisita(${visita.id}, true)">Aprovar e incluir na biblioteca</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="sugerirEdicaoVisita(${visita.id})">Sugerir edição</button>
      <button class="btn btn-ghost btn-sm" onclick="reprovarVisita(${visita.id})">Reprovar</button>`;
  } else if (visita && visita.status_aprovacao === 'aprovado') {
    const umDiaMs = 24 * 60 * 60 * 1000;
    const podeFinalizar = visita.data_aprovacao && (Date.now() - new Date(visita.data_aprovacao).getTime()) >= umDiaMs;
    acoes = `
      <button class="btn-outline-sm" onclick="reabrirVisita(${visita.id})">Reabrir</button>
      <button class="btn-outline-sm" onclick="excluirVisita(${visita.id})" style="color:var(--red); border-color:var(--red);">Excluir relatório</button>
      ${podeFinalizar ? `<button class="btn btn-primary btn-sm" onclick="finalizarOS(${a.id})">Finalizar O.S.</button>` : ''}`;
  } else if (visita && visita.status_aprovacao === 'reprovado') {
    acoes = `<span class="tag tag-falha">Reprovado${visita.comentario_reprovacao ? ': ' + esc(visita.comentario_reprovacao) : ''}</span>`;
  } else if (visita && visita.status_aprovacao === 'alteracao_sugerida') {
    acoes = `<span class="tag tag-amber">Edição sugerida${visita.comentario_edicao ? ': ' + esc(visita.comentario_edicao) : ''} — aguardando o técnico reenviar</span>`;
  } else {
    acoes = `<span style="font-size:11.5px; color:var(--ink-soft);">Aguardando execução pelo técnico.</span>`;
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

// linha do tempo: abertura da O.S. -> relatório enviado -> aprovação/reprovação
function timelineOS(a, visita) {
  const passos = [{ label: 'Ordem de serviço aberta', data: a.criado_em, estado: 'feito' }];
  if (a.deslocamento_iniciado_em) {
    passos.push({ label: 'Técnico iniciou o deslocamento', data: a.deslocamento_iniciado_em, estado: 'feito' });
  }
  if (visita) {
    passos.push({ label: 'Relatório preenchido e enviado para análise', data: visita.criado_em, estado: 'feito' });
    if (visita.status_aprovacao === 'aprovado') {
      passos.push({ label: 'Aprovado pelo administrador', data: visita.data_aprovacao, estado: 'feito' });
    } else if (visita.status_aprovacao === 'reprovado') {
      passos.push({ label: 'Reprovado pelo administrador' + (visita.comentario_reprovacao ? ': ' + esc(visita.comentario_reprovacao) : ''), data: visita.data_aprovacao, estado: 'reprovado' });
    } else {
      passos.push({ label: 'Aguardando aprovação do administrador', data: null, estado: 'pendente' });
    }
  } else {
    passos.push({ label: 'Aguardando o técnico preencher o relatório', data: null, estado: 'pendente' });
  }
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
      </div>` : `<div class="admin-note" style="margin-top:14px;">O técnico ainda não executou esta O.S. — nenhum relatório enviado até o momento.</div>`}
    ${timelineOS(a, visita)}`;
}

function baixarPdfLaudoAprovado(agendaId) {
  const a = (window._agendaCache || []).find((x) => x.id === agendaId);
  const v = (window._visitasPorAgenda || {})[agendaId];
  if (!a || !v || !v.laudo) return alert('Não foi possível localizar o laudo aprovado desta O.S.');
  try {
    const pdfDataUri = gerarPdfLaudo(v.laudo, a);
    const link = document.createElement('a');
    link.href = pdfDataUri;
    link.download = `laudo-tecnico-${v.id}.pdf`;
    document.body.appendChild(link); link.click(); link.remove();
  } catch (e) {
    alert('Erro ao gerar o PDF: ' + e.message);
  }
}

function detalheRelatorioVisita(v) {
  if (v.relatorio) {
    const r = v.relatorio;
    return `
      ${v.relevante_biblioteca ? `<div class="admin-note" style="background:var(--green-bg); color:var(--green);"><b>Marcado como relevante</b>Se aprovado, entra na Biblioteca de Defeitos/Falhas com ${esc(v.tecnico_nome || 'o técnico')} como autor.</div>` : ''}
      <div class="kv"><b>Empresa:</b> ${esc(r.empresa)} <span class="sep">·</span> <b>Contato:</b> ${esc(r.contato)} <span class="sep">·</span> <b>Telefone:</b> ${esc(r.telefone)}</div>
      <div class="kv"><b>Endereço:</b> ${esc(r.endereco)}, ${esc(r.numero)} — ${esc(r.bairro)}, ${esc(r.cidade)}/${esc(r.estado)} — CEP ${esc(r.cep)}</div>
      <div class="kv"><b>Data:</b> ${esc(r.data_inicial)} a ${esc(r.data_final)} <span class="sep">·</span> <b>Equipamento:</b> ${esc(r.modelo_maquina)} (${esc(r.numero_serie)})</div>
      <div class="kv"><b>Serviço:</b> ${esc(r.servico)}</div>
      <ol class="item-steps">
        ${(r.checklist || []).map((c) => `<li>${esc(c.item)} — <b>${c.resposta === 'sim' ? 'Sim' : c.resposta === 'nao' ? 'Não' : 'N/A'}</b>${c.observacao ? ' — ' + esc(c.observacao) : ''}</li>`).join('')}
      </ol>
      <div class="kv"><b>Observações:</b> ${esc(r.observacoes)}</div>
      <div class="kv"><b>Aceite:</b> ${r.aceite === 'aceito' ? 'Li e aceito os termos' : 'Não aceito'}</div>
      <div class="kv"><b>Avaliação:</b> ${r.avaliacao ? r.avaliacao.estrelas : '—'}/5 estrelas <span class="sep">·</span> Dúvidas sanadas: ${r.avaliacao && r.avaliacao.duvidas_sanadas === 'sim' ? 'Sim' : 'Não'} <span class="sep">·</span> Apto a operar: ${r.avaliacao && r.avaliacao.apto_operar === 'sim' ? 'Sim' : 'Não'}</div>
      <div class="kv"><b>Assinaturas</b></div>
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        <div>${esc(r.assinatura_cliente_nome || '—')} (cliente)${r.assinatura_cliente_img ? `<br><img src="${r.assinatura_cliente_img}" style="max-width:200px; border:1px solid var(--line); border-radius:6px; margin-top:4px;" onclick="abrirLightbox('${r.assinatura_cliente_img}')">` : ''}</div>
        <div>${esc(r.assinatura_tecnico_nome || '—')} (técnico)${r.assinatura_tecnico_img ? `<br><img src="${r.assinatura_tecnico_img}" style="max-width:200px; border:1px solid var(--line); border-radius:6px; margin-top:4px;" onclick="abrirLightbox('${r.assinatura_tecnico_img}')">` : ''}</div>
      </div>`;
  }
  if (v.relatorio_simples) {
    const r = v.relatorio_simples;
    return `
      <div class="kv"><b>Empresa:</b> ${esc(r.empresa)} <span class="sep">·</span> <b>Contato:</b> ${esc(r.contato)} <span class="sep">·</span> <b>Telefone:</b> ${esc(r.telefone)}</div>
      <div class="kv"><b>Equipamento:</b> ${esc(r.equipamento_tipo)} — ${esc(r.equipamento_modelo)} ${r.numero_serie ? `(${esc(r.numero_serie)})` : ''}</div>
      <div class="kv"><b>Observações:</b> ${esc(r.observacoes)}</div>`;
  }
  if (v.laudo) {
    const l = v.laudo;
    return `
      ${v.relevante_biblioteca ? `<div class="admin-note" style="background:var(--green-bg); color:var(--green);"><b>Marcado como relevante</b>Se aprovado, entra na Biblioteca de Defeitos/Falhas com ${esc(v.tecnico_nome || 'o técnico')} como autor.</div>` : ''}
      <div class="kv"><b>Empresa:</b> ${esc(l.empresa || '')} <span class="sep">·</span> <b>Contato:</b> ${esc(l.contato || '')} <span class="sep">·</span> <b>Telefone:</b> ${esc(l.telefone || '')}</div>
      <div class="kv"><b>Equipamento:</b> ${esc(l.equipamento_tipo || '')} — ${esc(l.modelo_maquina || '')} (${esc(l.numero_serie || '—')})</div>
      <div class="kv"><b>Data de fabricação:</b> ${esc(l.data_fabricacao || '—')} <span class="sep">·</span> <b>Garantia:</b> ${l.garantia === 'sim' ? 'Sim' : l.garantia === 'nao' ? 'Não' : `N/A — ${esc(l.garantia_obs || '')}`}</div>
      <div class="kv"><b>Acessórios recebidos:</b> ${esc(l.acessorios || '—')}</div>
      <div class="kv"><b>Defeito informado:</b> ${esc(l.defeito_informado || '—')}</div>
      <div class="kv"><b>Data de início:</b> ${l.data_entrada ? fmtData(l.data_entrada) : '—'} <span class="sep">·</span> <b>Data de conclusão:</b> ${l.data_conclusao ? fmtData(l.data_conclusao) : '—'} <span class="sep">·</span> <b>Período de reparo:</b> ${periodoReparo(l)}</div>
      <div class="kv"><b>Laudo técnico:</b> ${esc(l.laudo_tecnico || '')}</div>
      <div class="kv"><b>Serviço realizado:</b> ${esc(l.servico_realizado || '')}</div>
      ${(l.pecas || []).length ? `<div class="kv"><b>Peças fornecidas:</b></div><ol class="item-steps">${l.pecas.map((p) => `<li>${esc(p.descricao || '—')}${p.quantidade ? ' (qtd: ' + esc(p.quantidade) + ')' : ''}</li>`).join('')}</ol>` : ''}
      ${l.observacoes ? `<div class="kv"><b>Observações:</b> ${esc(l.observacoes)}</div>` : ''}
      ${(l.fotos || []).length ? `<div class="kv"><b>Relatório fotográfico:</b></div><div class="step-photos">${l.fotos.map((f) => `<div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do laudo"></div>`).join('')}</div>` : ''}`;
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
// (não finalizada), e some depois de marcado — vira uma tag mostrando desde quando ele está
// a caminho. O administrador recebe uma notificação push quando o técnico toca nele.
function botaoDeslocamento(a) {
  if (a.tecnico_id !== USER.id || a.finalizada || a.status === 'concluida') return '';
  if (a.deslocamento_iniciado_em) return `<span class="tag" style="background:var(--blue-pale); color:var(--blue); margin-right:6px;">🚗 A caminho desde ${fmtData(a.deslocamento_iniciado_em)}</span>`;
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
          <td style="white-space:nowrap;">
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
function abrirDetalheDefeito(i, origem) {
  const r = (window._defeitosCache || [])[i];
  if (!r) return;
  carregarLogoDataUri();
  const main = document.getElementById('main');
  const voltar = origem === 'solicitacoes' ? 'renderSolicitacoesEdicao()' : 'renderBibliotecaDefeitos(window._defeitosFiltros || {}, true)';
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(r.titulo)}</h1><p>${esc(r.equipamento_tipo)}${r.equipamento_modelo ? ' — ' + esc(r.equipamento_modelo) : ''}${r.numero_serie ? ' · Nº série ' + esc(r.numero_serie) : ''}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="abrirPdfBiblioteca('defeito', ${i})">Abrir PDF</button>
        ${USER.papel === 'administrador' ? `<button class="btn-outline-sm" onclick="abrirEditarDefeito(${i}, '${origem || ''}')">Editar</button>` : ''}
        ${USER.papel === 'tecnico' ? `<button class="btn-outline-sm" onclick="solicitarEdicaoBiblioteca('defeito', ${i})">Solicitar edição</button>` : ''}
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
          <td style="white-space:nowrap;">
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
function abrirDetalheProcedimento(i, origem) {
  const r = (window._procedimentosCache || [])[i];
  if (!r) return;
  carregarLogoDataUri();
  const main = document.getElementById('main');
  const voltar = origem === 'solicitacoes' ? 'renderSolicitacoesEdicao()' : 'renderBibliotecaProcedimentos(window._procedimentosFiltros || {}, true)';
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>${esc(r.titulo)}</h1><p>${esc(r.equipamento_tipo)}${r.equipamento_modelo ? ' — ' + esc(r.equipamento_modelo) : ''}${r.periodicidade ? ' · Periodicidade: ' + esc(r.periodicidade) : ''}</p></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="abrirPdfBiblioteca('procedimento', ${i})">Abrir PDF</button>
        ${USER.papel === 'administrador' ? `<button class="btn-outline-sm" onclick="abrirEditarProcedimento(${i}, '${origem || ''}')">Editar</button>` : ''}
        ${USER.papel === 'tecnico' ? `<button class="btn-outline-sm" onclick="solicitarEdicaoBiblioteca('procedimento', ${i})">Solicitar edição</button>` : ''}
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
            ${['Semanal', 'Mensal', 'Trimestral', 'Semestral', 'Anual'].map((p) => `<option ${r.periodicidade === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
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
}
async function salvarEdicaoProcedimento(id, i, origem) {
  const body = {
    titulo: document.getElementById('fp-titulo').value,
    equipamento_tipo: document.getElementById('fp-equip-tipo').value,
    equipamento_modelo: document.getElementById('fp-equip-modelo').value,
    periodicidade: document.getElementById('fp-periodicidade').value,
    precaucoes: document.getElementById('fp-precaucoes').value,
    ferramentas: document.getElementById('fp-ferramentas').value,
    passos: procDraft,
  };
  try {
    const { registro } = await api(`/api/registros/${id}`, { method: 'PUT', body });
    mostrarToast('Alterações salvas.');
    if (origem === 'solicitacoes') { renderSolicitacoesEdicao(); return; }
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

  const primeiraFoto = tipo === 'procedimento' ? ((r.passos || []).find((p) => p.fotos && p.fotos.length) || {}).fotos?.[0] : (r.fotos || [])[0];
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
  doc.text('PRO Marking', margem + 14, pageH - margem - 16);
  doc.text('promarking.com.br', margem + 14, pageH - margem - 6);

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

// ---------- CRIAR RELATÓRIO (manutenção interna, avulso — sem vínculo com O.S./agenda) ----------

async function renderRelatorioManutencao() {
  const { relatorios } = await api('/api/relatorios-manutencao/meus');
  window._relatoriosManutCache = relatorios;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Criar Relatório</h1><p>Relatório de manutenção interna, avulso — sem vínculo com nenhuma O.S., fica salvo só aqui no seu histórico</p></div>
      <button class="btn btn-primary btn-sm" onclick="mostrarFormRelatorioManutencao()">+ Novo relatório</button>
    </div>
    <div class="panel"><table>
      <tr><th>Data</th><th>Empresa</th><th>Equipamento</th><th></th></tr>
      ${relatorios.length ? relatorios.map((r, i) => `
        <tr>
          <td data-label="Data">${fmtData(r.criado_em)}</td>
          <td data-label="Empresa">${esc(r.empresa)}</td>
          <td data-label="Equipamento">${esc(r.equipamento)}${r.marca ? ' — ' + esc(r.marca) : ''}</td>
          <td style="white-space:nowrap;">
            <button class="btn-outline-sm" onclick="abrirPdfRelatorioManutencao(${i})">PDF</button>
            <button class="btn-outline-sm" onclick="abrirFotosRelatorioManutencao(${i})">Fotos</button>
            <button class="btn-outline-sm" onclick="baixarWordRelatorioManutencao(${i})">Word</button>
            <button class="btn-outline-sm" onclick="excluirRelatorioManutencao(${r.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="4" class="empty">Nenhum relatório criado ainda.</td></tr>`}
    </table></div>`;
}

let relatorioManutDraft = null;
function relatorioManutPadrao() {
  return {
    empresa: '', contato: '', telefone: '',
    tipo_servico: '', tipo_servico_outros: '',
    marca: '', equipamento: '', numero_serie: '',
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

function mostrarFormRelatorioManutencao() {
  relatorioManutDraft = relatorioManutPadrao();
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Novo relatório — Manutenção interna</h1><p>Preencha os dados abaixo. Ao gerar, o PDF fica disponível e o relatório é salvo no seu histórico. Campos com * são obrigatórios.</p></div>

    <div class="panel">
      <h2>Dados do cliente</h2>
      <div class="form-grid">
        <div class="full"><label>Empresa*</label><input id="rm-empresa"></div>
        <div><label>Contato</label><input id="rm-contato"></div>
        <div><label>Telefone</label><input id="rm-telefone"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Tipo de serviço</h2>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        ${[['amostra', 'Amostra'], ['analise', 'Análise'], ['preventiva', 'Preventiva'], ['corretiva', 'Corretiva'], ['outros', 'Outros']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rm-tipo-servico" value="${v}" style="width:auto;" onchange="document.getElementById('rm-tipo-outros-wrap').style.display = this.value === 'outros' ? 'block' : 'none';"> ${l}</label>`).join('')}
      </div>
      <div id="rm-tipo-outros-wrap" style="display:none;"><label>Especifique</label><input id="rm-tipo-servico-outros"></div>
    </div>

    <div class="panel">
      <h2>Dados do equipamento</h2>
      <div class="form-grid">
        <div><label>Marca</label><input id="rm-marca"></div>
        <div><label>Equipamento*</label><input id="rm-equipamento"></div>
        <div><label>Nº de série</label><input id="rm-numero_serie"></div>
        <div><label>Data de fabricação (MM/AAAA)</label><input id="rm-data_fabricacao" placeholder="MM/AAAA" maxlength="7"></div>
      </div>
      <label>Garantia</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        ${[['sim', 'Sim'], ['nao', 'Não'], ['outros', 'Outros']].map(([v, l]) => `
          <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="rm-garantia" value="${v}" style="width:auto;" onchange="document.getElementById('rm-garantia-outros-wrap').style.display = this.value === 'outros' ? 'block' : 'none';"> ${l}</label>`).join('')}
      </div>
      <div id="rm-garantia-outros-wrap" style="display:none;"><label>Especifique</label><input id="rm-garantia_obs"></div>
      <div class="form-grid">
        <div class="full"><label>Acessórios recebidos</label><input id="rm-acessorios" placeholder="ex: cabo de força, fonte..."></div>
        <div class="full"><label>Defeito informado</label><input id="rm-defeito_informado"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Técnico responsável</h2>
      <div class="form-grid">
        <div><label>Nome</label><input value="${esc(USER.nome)}" disabled></div>
        <div><label>E-mail</label><input value="${esc(USER.email || '')}" disabled></div>
        <div><label>Data de entrada</label><input id="rm-data_entrada" type="date"></div>
        <div><label>Data de conclusão</label><input id="rm-data_conclusao" type="date"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Laudo técnico</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Defeito encontrado e análise do estado do equipamento</p>
      <textarea id="rm-laudo_tecnico" placeholder="Descreva o diagnóstico..."></textarea>
    </div>

    <div class="panel">
      <h2>Serviços realizados</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Manutenção realizada / resultados de amostra</p>
      <textarea id="rm-servico_realizado" placeholder="Descreva o que foi feito..."></textarea>
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
      <label class="photo-add" style="margin-top:8px;">
        <span class="plus">+</span>Foto
        <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotosNoBlocoRelatorioManut(event, ${i})">
      </label>
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
  const arquivos = Array.from(event.target.files || []);
  Promise.all(arquivos.map((arquivo) => new Promise((resolve) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.readAsDataURL(arquivo);
  }))).then((dataUrls) => {
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
    const { relatorio } = await api('/api/relatorios-manutencao', { method: 'POST', body: d });
    const logo = await carregarLogoDataUri();
    const url = gerarPdfRelatorioManutencao(relatorio, logo);
    window.open(url, '_blank');
    mostrarToast('Relatório salvo e PDF gerado.');
    renderRelatorioManutencao();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

async function abrirPdfRelatorioManutencao(i) {
  const r = (window._relatoriosManutCache || [])[i];
  if (!r) return;
  try {
    const logo = await carregarLogoDataUri();
    const url = gerarPdfRelatorioManutencao(r, logo);
    window.open(url, '_blank');
  } catch (e) { alert('Erro ao gerar o PDF: ' + e.message); }
}

function abrirFotosRelatorioManutencao(i) {
  const r = (window._relatoriosManutCache || [])[i];
  if (!r) return;
  const blocos = r.fotos || [];
  const temFotos = blocos.length && blocos.some((b) => (typeof b === 'string' ? true : (b.fotos || []).length));
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Fotos — ${esc(r.empresa)}</h1><p>${esc(r.equipamento)}</p></div>
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
  const r = (window._relatoriosManutCache || [])[i];
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

function wCapa(r, logoDataUri) {
  const DESLOC_TOPO = 3969; // ~7cm — empurra logo/"PRO Marking" pra baixo, mais perto do centro
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
    children: [
      new docx.TextRun({ text: 'PRO', bold: true, color: '2E86FF', size: 40 }),
      new docx.TextRun({ text: 'Marking', bold: true, color: 'FFFFFF', size: 40 }),
    ],
  }));

  const meio = [
    new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new docx.TextRun({ text: 'RELATÓRIO TÉCNICO', bold: true, color: 'FFFFFF', size: 36 })],
    }),
    new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      children: [new docx.TextRun({ text: (r.empresa ? String(r.empresa) : '—').toUpperCase(), color: 'C8D8EC', size: 24 })],
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
    children: [new docx.TextRun({ text: 'PRO Marking', bold: true, color: WORD_COR.navy, size: 26 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [new docx.TextRun({ text: 'Entre em contato conosco através:', bold: true, color: WORD_COR.ink, size: 20 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new docx.TextRun({ text: 'WhatsApp: 12 99718-7506', color: WORD_COR.ink, size: 18 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 220 },
    children: [new docx.TextRun({ text: 'Telefone: 12 3902-3453', color: WORD_COR.ink, size: 18 })],
  }));
  conteudo.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 100 },
    children: [new docx.TextRun({ text: 'E-mail:', bold: true, color: WORD_COR.ink, size: 18 })],
  }));
  ['suporte@promarking.com.br', 'atendimento@promarking.com.br', 'tecnico@promarking.com.br', 'posvenda@promarking.com.br'].forEach((email) => {
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
    children: [new docx.TextRun({ text: 'PRO Marking', bold: true, color: WORD_COR.navy, size: 24 })],
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

async function baixarWordRelatorioManutencao(i) {
  const r = (window._relatoriosManutCache || [])[i];
  if (!r) return;
  try {
    const logo = await carregarLogoDataUri();
    const blob = await gerarWordRelatorioManutencao(r, logo);
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
    doc.text('PRO Marking', pageW / 2, y, { align: 'center' });
    y += 15;
    doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Relatório Técnico', pageW / 2, y, { align: 'center' });
    y += 10;
    doc.setDrawColor(...PDF_COR.blue); doc.setLineWidth(1.2);
    doc.line(margem, y, pageW - margem, y);
    y += 24;
  }

  function tituloCentro(t, sub) {
    if (y > pageH - margem - 60) novaPagina();
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_COR.blue);
    doc.text(t.toUpperCase(), pageW / 2, y, { align: 'center' }); y += 13;
    if (sub) {
      doc.setFontSize(8); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.inkSoft);
      doc.text(sub, pageW / 2, y, { align: 'center' }); y += 13;
    }
    y += 4;
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
  doc.setFontSize(26); doc.setFont(undefined, 'bold');
  doc.setTextColor(...PDF_COR.blueBright); doc.text('PRO', pageW / 2 - 4, 265, { align: 'right' });
  doc.setTextColor(...PDF_COR.white); doc.text('Marking', pageW / 2 + 2, 265, { align: 'left' });
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
  y += 12;

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
  y += 12;

  tituloCentro('Técnico responsável');
  linhaCampos([{ label: 'Nome', valor: r.tecnico_nome, frac: 0.5 }, { label: 'E-mail', valor: r.tecnico_email, frac: 0.5 }]);
  linhaCampos([{ label: 'Entrada', valor: r.data_entrada, frac: 0.26 }, { label: 'Conclusão', valor: r.data_conclusao, frac: 0.26 }, { label: 'Período', valor: periodoManut(r.data_entrada, r.data_conclusao), frac: 0.48 }]);
  y += 12;

  tituloCentro('Laudo técnico', 'Defeito encontrado e análise do estado do equipamento');
  {
    if (y > pageH - margem - 40) novaPagina();
    doc.setDrawColor(...PDF_COR.line); doc.setLineWidth(0.7);
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.ink);
    const linhas = doc.splitTextToSize(limparPdf(r.laudo_tecnico) || '—', largura - 16);
    const altura = Math.max(24, linhas.length * 12 + 12);
    doc.rect(margem, y, largura, altura, 'S');
    doc.text(linhas, margem + 8, y + 14);
    y += altura + 12;
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

  tituloCentro('Relatório fotográfico');
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
  doc.text('PRO Marking', pageW / 2, pageH / 2 - 85, { align: 'center' });
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Entre em contato conosco através:', pageW / 2, pageH / 2 - 40, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(...PDF_COR.ink);
  doc.text('WhatsApp: 12 99718-7506', pageW / 2, pageH / 2 - 18, { align: 'center' });
  doc.text('Telefone: 12 3902-3453', pageW / 2, pageH / 2 - 4, { align: 'center' });
  doc.setFont(undefined, 'bold');
  doc.text('E-mail:', pageW / 2, pageH / 2 + 20, { align: 'center' });
  doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_COR.blue);
  ['suporte@promarking.com.br', 'atendimento@promarking.com.br', 'tecnico@promarking.com.br', 'posvenda@promarking.com.br'].forEach((email, i) => {
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
  visitas.forEach((v) => { window._visitasPorAgenda[v.agenda_id] = v; });
  renderAgendaCalendarioTecnico();
}

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
        <button class="btn-outline-sm" onclick="irParaHojeCalendarioTecnico()">Hoje</button>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
    </div>
  `;
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
  const agenda = window._agendaCache || [];
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

function renderDiaCalendarioTecnico(iso) {
  const agenda = (window._agendaCache || []).filter((a) => (a.data_hora_inicio || '').slice(0, 10) === iso)
    .sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  const [y, m, d] = iso.split('-');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
      <div><h1>Ordens de serviço em ${d}/${m}/${y}</h1><p>${agenda.length} O.S. agendada(s) para este dia</p></div>
      <button class="btn-outline-sm" onclick="renderAgendaCalendarioTecnico()">‹ Voltar ao calendário</button>
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
  if (a.tecnico_id !== USER.id) {
    return `<span style="font-size:11.5px; color:var(--ink-soft);">Designada a ${esc(a.tecnico_nome || 'outro técnico')} — você pode visualizar, mas só quem está designado executa esta O.S.</span>`;
  }
  if (a.status !== 'concluida') {
    return `${botaoDeslocamento(a)}<button class="btn btn-primary btn-sm" onclick="abrirDiario(${a.id})">Executar</button>`;
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
            ${['Semanal', 'Mensal', 'Trimestral', 'Semestral', 'Anual'].map((p) => `<option ${prefill && prefill.periodicidade === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
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
}

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
          <span class="plus">+</span>Foto
          <input type="file" accept="image/*" multiple style="display:none" onchange="adicionarFotos(event, ${i})">
        </label>
      </div>
    </div>`).join('');
}

function adicionarPasso() { procDraft.push({ texto: '', fotos: [] }); renderPassosDraft(); }
function removerPasso(i) { procDraft.splice(i, 1); renderPassosDraft(); }
function removerFoto(i, j) { procDraft[i].fotos.splice(j, 1); renderPassosDraft(); }
function adicionarFotos(event, i) {
  const arquivos = Array.from(event.target.files || []);
  Promise.all(arquivos.map((arquivo) => new Promise((resolve) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.readAsDataURL(arquivo);
  }))).then((dataUrls) => {
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
          <td style="white-space:nowrap;">
            <button class="btn-outline-sm" onclick="editarCliente(${c.id})">Editar</button>
            <button class="btn-outline-sm" onclick="excluirCliente(${c.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
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
        <td style="white-space:nowrap;">
          <button class="btn-outline-sm" onclick="editarEquipamentoCatalogo(${e.id})">Editar</button>
          <button class="btn-outline-sm" onclick="excluirEquipamento(${e.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
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
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" onclick="verHistorico(${e.id})">Histórico</button>
          <button class="btn-outline-sm" onclick="editarAtrelado(${e.id})">Editar</button>
          <button class="btn-outline-sm" onclick="excluirEquipamento(${e.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>
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
async function renderUsuarios() {
  const [{ usuarios }, { clientes }] = await Promise.all([api('/api/usuarios'), api('/api/clientes')]);
  window._clientesCache = clientes;
  window._usuariosCache = usuarios;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div><h1>Usuários</h1><p>${usuarios.length} cadastrado(s)</p></div>
      <button class="btn btn-primary btn-sm" onclick="mostrarFormUsuario()">+ Novo usuário</button>
    </div>
    <div id="form-usuario"></div>
    <div id="convite-resultado"></div>
    ${usuarios.map((u) => `
      <div class="user-row">
        <div class="u-avatar-lg">${initials(u.nome)}</div>
        <div class="u-info">
          <div class="u-line1">${esc(u.nome)} <span class="tag tag-papel">${esc(u.papel)}</span>${u.protegido ? ' <span class="tag" style="background:var(--blue-pale); color:var(--blue);">🔒 Protegida</span>' : ''}</div>
          <div class="u-line2">${esc(u.email)} ${u.cargo ? '· ' + esc(u.cargo) : ''} ${u.setor ? '· ' + esc(u.setor) : ''}</div>
        </div>
        <span class="badge ${u.status === 'ativo' ? 'badge-ativo' : 'badge-convite'}">${u.status === 'ativo' ? 'Ativo' : 'Convite enviado'}</span>
        ${u.status !== 'ativo' ? `<button class="btn-outline-sm" onclick="reenviarConvite(${u.id})">Reenviar convite</button>` : ''}
        ${!u.protegido || u.id === USER.id ? `<button class="btn-outline-sm" onclick="editarUsuario(${u.id})">Editar</button>` : ''}
        ${!u.protegido ? `<button class="btn-outline-sm" onclick="excluirUsuario(${u.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>` : ''}
      </div>`).join('')}`;
}
let usuarioEmEdicaoId = null;
function mostrarFormUsuario(usuario) {
  usuarioEmEdicaoId = usuario ? usuario.id : null;
  const clientes = window._clientesCache || [];
  document.getElementById('form-usuario').innerHTML = `
    <div class="panel"><div class="panel-head">${usuario ? 'Editar usuário' : 'Novo usuário'}</div>
      <div class="form-grid">
        <div><label>Nome</label><input id="nu-nome" value="${usuario ? esc(usuario.nome) : ''}"></div>
        <div><label>E-mail</label><input id="nu-email" value="${usuario ? esc(usuario.email) : ''}"></div>
        <div><label>Cargo</label><input id="nu-cargo" value="${usuario ? esc(usuario.cargo || '') : ''}"></div>
        <div><label>Setor</label><input id="nu-setor" value="${usuario ? esc(usuario.setor || '') : ''}"></div>
        <div><label>Tipo de acesso</label><select id="nu-papel" onchange="alternarCampoCliente()">
          <option value="tecnico" ${usuario && usuario.papel === 'tecnico' ? 'selected' : ''}>Técnico</option>
          <option value="administrador" ${usuario && usuario.papel === 'administrador' ? 'selected' : ''}>Administrador</option>
          <option value="cliente" ${usuario && usuario.papel === 'cliente' ? 'selected' : ''}>Cliente</option>
        </select></div>
        <div id="campo-cliente"><label>Empresa (cliente)</label>${campoClienteHTML('nu-cliente', clientes)}</div>
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
function alternarCampoCliente() {
  const papel = document.getElementById('nu-papel').value;
  document.getElementById('campo-cliente').style.display = papel === 'cliente' ? '' : 'none';
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
async function renderChamados() {
  const [{ chamados }, { equipamentos }] = await Promise.all([api('/api/chamados'), api('/api/equipamentos')]);
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Abertura de chamado</h1><p>Solicite manutenção preventiva, corretiva ou treinamento</p></div>
    <div class="panel">
      <div class="form-grid">
        <div><label>Tipo de serviço</label>
          <select id="ch-tipo"><option value="preventiva">Manutenção preventiva</option><option value="corretiva">Manutenção corretiva</option><option value="treinamento">Treinamento</option></select>
        </div>
        <div><label>Equipamento</label>
          <select id="ch-equip">${equipamentos.map((e) => `<option value="${e.id}">${esc(e.tipo)} — ${esc(e.modelo)}</option>`).join('')}</select>
        </div>
        <div class="full"><label>Descreva o problema/necessidade</label><textarea id="ch-descricao"></textarea></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="abrirChamado()">Abrir chamado</button>
    </div>
    <div class="page-head"><h1 style="font-size:16px;">Meus chamados</h1></div>
    <div class="panel"><table>
      <tr><th>Data</th><th>Tipo</th><th>Equipamento</th><th>Status</th></tr>
      ${chamados.length ? chamados.map((c) => `
        <tr><td data-label="Data">${fmtData(c.criado_em)}</td><td data-label="Tipo">${esc(c.tipo_servico)}</td><td data-label="Equipamento">${esc(c.equipamento_tipo || '—')}</td><td data-label="Status">${tag(c.status === 'aberto' ? 'Aberto' : c.status, c.status === 'aberto' ? 'amber' : 'green')}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">Nenhum chamado aberto ainda.</td></tr>`}
    </table></div>`;
}
async function abrirChamado() {
  const body = {
    tipo_servico: document.getElementById('ch-tipo').value,
    equipamento_id: document.getElementById('ch-equip').value,
    descricao: document.getElementById('ch-descricao').value,
  };
  try {
    await api('/api/chamados', { method: 'POST', body });
    mostrarToast('Chamado aberto com sucesso.');
    renderChamados();
  } catch (e) { alert('Erro: ' + e.message); }
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
