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

function preencherDemo(email) {
  document.getElementById('login-email').value = email;
  document.getElementById('login-senha').value = '123456';
  fazerLogin();
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

function entrarNoApp() {
  document.getElementById('authView').style.display = 'none';
  document.getElementById('appView').style.display = 'block';
  montarSidebar();
  atualizarSino();
  sinoTimer = setInterval(atualizarSino, 15000);
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

// ---------- menu em cascata ----------

const NAV = {
  tecnico: [
    { key: 'agenda', label: 'Minha agenda', page: 'agenda' },
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
      { key: 'adicionar', label: 'Adicionar', children: [
        { key: 'adicionar-defeito', label: 'Defeitos/Falhas', page: 'add-defeito' },
        { key: 'adicionar-procedimento', label: 'Manual de Procedimentos', page: 'add-procedimento' },
      ]},
      { key: 'ranking', label: 'Ranking de técnicos', page: 'biblioteca-ranking' },
    ]},
    { key: 'equipamentos', label: 'Equipamentos', page: 'equipamentos' },
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
}

function alternarGrupo(key) {
  if (navAbertos.has(key)) navAbertos.delete(key); else navAbertos.add(key);
  montarSidebar();
}

async function ir(pagina) {
  paginaAtual = pagina;
  const caminho = buscarCaminho(NAV[USER.papel] || [], pagina, []);
  if (caminho) caminho.forEach((k) => navAbertos.add(k));
  montarSidebar();
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Carregando...</div>';
  try {
    if (pagina === 'agenda') return renderAgenda();
    if (pagina === 'aprovacoes-visitas') return renderAprovacoesVisitas();
    if (pagina === 'biblioteca-defeitos') return renderBibliotecaDefeitos();
    if (pagina === 'biblioteca-procedimentos') return renderBibliotecaProcedimentos();
    if (pagina === 'biblioteca-ranking') return renderRankingTecnicos();
    if (pagina === 'add-defeito') return renderFormDefeito(main, null);
    if (pagina === 'add-procedimento') return renderFormProcedimento(main, null);
    if (pagina === 'meus-registros') return renderMeusRegistros();
    if (pagina === 'aprovacoes-biblioteca') return renderAprovacoesBiblioteca();
    if (pagina === 'equipamentos') return renderEquipamentos();
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
async function renderAgenda() {
  const { agenda } = await api('/api/agenda');
  window._agendaCache = agenda;
  if (USER.papel === 'administrador') return renderAgendaCalendario();
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Minha agenda</h1><p>${agenda.length} atividade(s)</p></div>
    <div class="panel"><table>
      <tr><th>Data</th><th>Cliente</th><th>Equipamento</th><th>Tipo</th><th>Status</th><th></th></tr>
      ${agenda.length ? agenda.map((a) => `
        <tr>
          <td>${fmtData(a.data_hora_inicio)}</td>
          <td>${a.cliente_nome || '—'}</td>
          <td>${a.equipamento_tipo || '—'} ${a.equipamento_modelo ? '(' + a.equipamento_modelo + ')' : ''}</td>
          <td>${TIPO_OS_LABEL[a.tipo] || a.tipo}</td>
          <td>${a.status === 'concluida' ? tag('Concluída', 'green') : a.status === 'em_andamento' ? tag('Em andamento', 'blue') : tag('Pendente', 'amber')}</td>
          <td>${a.status !== 'concluida' ? `<button class="btn btn-ghost btn-sm" onclick="abrirDiario(${a.id})">Executar</button>` : ''}
            ${a.status === 'concluida' && a.visita_id ? (
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
      <button class="btn btn-primary btn-sm" onclick="mostrarFormNovaAtividade()">+ Nova atividade</button>
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
    <div id="cal-dia-detalhe"></div>
  `;
  desenharGradeCalendario();
  if (calDiaSelecionado) desenharDetalheDia(calDiaSelecionado);
}

function mudarMesCalendario(delta) {
  calMes += delta;
  if (calMes < 0) { calMes = 11; calAno--; }
  if (calMes > 11) { calMes = 0; calAno++; }
  desenharGradeCalendario();
  const detalhe = document.getElementById('cal-dia-detalhe');
  if (detalhe) detalhe.innerHTML = '';
}

function irParaHojeCalendario() {
  const hoje = new Date();
  calAno = hoje.getFullYear();
  calMes = hoje.getMonth();
  calDiaSelecionado = dataISOLocal(hoje);
  desenharGradeCalendario();
  desenharDetalheDia(calDiaSelecionado);
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
  desenharGradeCalendario();
  desenharDetalheDia(iso);
}

function desenharDetalheDia(iso) {
  const agenda = (window._agendaCache || []).filter((a) => (a.data_hora_inicio || '').slice(0, 10) === iso)
    .sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  const [y, m, d] = iso.split('-');
  const el = document.getElementById('cal-dia-detalhe');
  el.innerHTML = `
    <div class="page-head" style="margin-top:4px;"><h1 style="font-size:16px;">Ordens de serviço em ${d}/${m}/${y}</h1><p>${agenda.length} O.S. agendada(s) para este dia</p></div>
    ${agenda.length ? `<div class="os-grid">${agenda.map((a) => cardOS(a)).join('')}</div>` : `<div class="empty">Nenhuma O.S. agendada para este dia.</div>`}
  `;
}

const STATUS_OS_LABEL = { agendado: 'Agendado', pendente: 'Pendente', concluido: 'Concluído' };

function statusOS(a) {
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

function osCardCorpo(a) {
  const status = statusOS(a);
  const hojeISO = dataISOLocal(new Date());
  const diaAtendimento = (a.data_hora_inicio || '').slice(0, 10);
  const diaAbertura = (a.criado_em || a.data_hora_inicio || '').slice(0, 10);
  const diffVenc = diasEntre(hojeISO, diaAtendimento);
  const vencRelativo = diffVenc === 0 ? 'hoje' : diffVenc > 0 ? `em ${diffVenc} dia${diffVenc === 1 ? '' : 's'}` : `há ${-diffVenc} dia${diffVenc === -1 ? '' : 's'}`;
  const [vy, vm, vd] = diaAtendimento.split('-');
  const diasAbertura = Math.max(0, diasEntre(diaAbertura, hojeISO));
  return `
      <div class="os-tarja os-tarja-${status}">${STATUS_OS_LABEL[status]}</div>
      <div class="os-card-top">
        <span class="tag tag-blue">${esc(TIPO_OS_LABEL[a.tipo] || a.tipo)}</span>
        <span class="tag os-tag-tecnico">${esc(a.tecnico_nome || '—')}</span>
      </div>
      <div class="os-card-title">${esc(a.cliente_nome || '—')}</div>
      <div class="os-card-fields">
        <div class="os-field"><span class="os-field-label"># Nº da O.S.</span><span class="os-field-value">OS-${String(a.id).padStart(6, '0')}</span></div>
        <div class="os-field"><span class="os-field-label">Contato</span><span class="os-field-value">${esc(a.contato || a.cliente_contato || '—')}</span></div>
        <div class="os-field"><span class="os-field-label">E-mail</span><span class="os-field-value">${esc(a.email || a.cliente_email || '—')}</span></div>
        <div class="os-field"><span class="os-field-label">Telefone</span><span class="os-field-value">${esc(a.telefone || a.cliente_telefone || '—')}</span></div>
      </div>
      <div class="os-card-footer">
        <span class="os-venc">Venc ${vd}/${vm} · ${vencRelativo}</span>
        <span class="os-dias-abertura">${diasAbertura} dia${diasAbertura === 1 ? '' : 's'} desde a abertura</span>
      </div>`;
}

function cardOS(a) {
  return `
    <div class="os-card">
      ${osCardCorpo(a)}
      ${a.visita_id ? `<button class="btn-outline-sm" style="margin-top:10px;" onclick="ir('aprovacoes-visitas')">Ver na Ordem de Serviço</button>` : `<span style="display:block; margin-top:8px; font-size:12px; color:var(--ink-soft);">Aguardando execução pelo técnico.</span>`}
    </div>`;
}

async function mostrarFormNovaAtividade() {
  const [{ usuarios }, { equipamentos }, { clientes }] = await Promise.all([api('/api/usuarios'), api('/api/equipamentos'), api('/api/clientes')]);
  const tecnicos = usuarios.filter((u) => u.papel === 'tecnico');
  window._clientesCache = clientes;
  document.getElementById('form-nova-atividade').innerHTML = `
    <div class="panel"><div class="panel-head">Nova atividade</div>
      <div class="form-grid">
        <div class="full"><label>Técnico</label><select id="na-tecnico">${tecnicos.map((t) => `<option value="${t.id}">${t.nome}</option>`).join('')}</select></div>
        <div><label>Equipamento</label><select id="na-equip" onchange="preencherClienteNovaAtividade()">${equipamentos.map((e) => `<option value="${e.id}" data-cliente="${e.cliente_id}">${e.tipo} — ${e.modelo}</option>`).join('')}</select></div>
        <div><label>Tipo</label><select id="na-tipo">
          <option value="corretiva">Corretiva</option>
          <option value="preventiva">Preventiva</option>
          <option value="treinamento_online">Treinamento online</option>
          <option value="treinamento_presencial">Treinamento presencial</option>
          <option value="demonstracao_tecnica">Demonstração Técnica</option>
        </select></div>
        <div><label>Início</label><input type="datetime-local" id="na-inicio"></div>
        <div><label>Fim previsto</label><input type="datetime-local" id="na-fim"></div>
        <div class="full"><label>Problema relatado / serviço</label><textarea id="na-problema" placeholder="Descreva o problema relatado pelo cliente ou o serviço a ser feito..."></textarea></div>
      </div>
      <h2 style="margin-top:4px;">Dados do atendimento</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-10px;">Pré-preenchido a partir do cadastro do cliente — ajuste se for diferente para este atendimento. Fica travado para o técnico.</p>
      <div class="form-grid">
        <div><label>Contato*</label><input id="na-contato"></div>
        <div><label>Telefone*</label><input id="na-telefone"></div>
        <div><label>E-mail*</label><input id="na-email" type="email"></div>
        <div><label>Setor do cliente</label><input id="na-setor-cliente"></div>
        <div class="full"><label>Endereço*</label><input id="na-endereco"></div>
        <div><label>Número*</label><input id="na-numero"></div>
        <div><label>Bairro*</label><input id="na-bairro"></div>
        <div><label>CEP*</label><input id="na-cep"></div>
        <div><label>Cidade*</label><input id="na-cidade"></div>
        <div><label>Estado*</label><select id="na-estado"><option value="">Selecione</option>${Object.keys(UF_REGIAO).map((uf) => `<option value="${uf}">${uf}</option>`).join('')}</select></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="salvarNovaAtividade()">Salvar atividade</button>
    </div>`;
  preencherClienteNovaAtividade();
}

function preencherClienteNovaAtividade() {
  const equipSelect = document.getElementById('na-equip');
  const clienteId = Number(equipSelect.options[equipSelect.selectedIndex].dataset.cliente);
  const cliente = (window._clientesCache || []).find((c) => c.id === clienteId) || {};
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

async function salvarNovaAtividade() {
  const equipSelect = document.getElementById('na-equip');
  const clienteId = equipSelect.options[equipSelect.selectedIndex].dataset.cliente;
  const body = {
    tecnico_id: document.getElementById('na-tecnico').value,
    equipamento_id: equipSelect.value,
    cliente_id: clienteId,
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
  };
  try {
    await api('/api/agenda', { method: 'POST', body });
    renderAgenda();
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
    await api('/api/visitas', { method: 'POST', body });
    mostrarToast('Atividade finalizada e enviada para aprovação do administrador.');
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
  let visita;
  try {
    ({ visita } = await api('/api/visitas', { method: 'POST', body }));
  } catch (e) {
    alert('Erro ao concluir: ' + e.message);
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
  mostrarToast('Relatório concluído e enviado para aprovação do administrador.' + avisoExtra);
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
    const linhas = doc.splitTextToSize(String(valor || '—'), largura - 130);
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
    doc.text(`${String(i + 1).padStart(2, '0')}. ${c.item} — ${r}`, margem, y); y += 13;
    if (c.observacao) { doc.setFont(undefined, 'normal'); doc.setTextColor(74, 85, 104); const linhas = doc.splitTextToSize('Obs: ' + c.observacao, largura - 10); doc.text(linhas, margem + 12, y); y += linhas.length * 12; }
  });
  y += 8;

  titulo('Observações');
  { if (y > 740) { doc.addPage(); y = 50; } doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38); const linhas = doc.splitTextToSize(d.observacoes, largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8; }

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
  doc.text(`Cliente: ${d.assinatura_cliente_nome}`, margem, y);
  doc.text(`Técnico: ${d.assinatura_tecnico_nome}`, margem + largura / 2, y);
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
    await api('/api/visitas', { method: 'POST', body: { agenda_id: relatorioAgendaAtual.id, relatorio_simples } });
    mostrarToast('Atendimento concluído e enviado para aprovação do administrador.');
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
    marca: '', data_fabricacao: '',
    garantia: '', garantia_obs: '',
    acessorios: '', defeito_informado: item.problema || item.servico || '',
    data_entrada: (item.data_hora_inicio || '').slice(0, 10),
    data_conclusao: new Date().toISOString().slice(0, 10),
    laudo_tecnico: '', servico_realizado: '',
    pecas: [], fotos: [], observacoes: '',
    relevante_biblioteca: false,
  };
}

function periodoReparo(d) {
  if (!d.data_entrada || !d.data_conclusao) return '—';
  const ini = new Date(d.data_entrada + 'T00:00:00');
  const fim = new Date(d.data_conclusao + 'T00:00:00');
  const dias = Math.max(0, Math.round((fim - ini) / 86400000));
  return `${dias} dia${dias === 1 ? '' : 's'}`;
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
        <div><label>Equipamento</label><input value="${esc(item.equipamento_tipo || '')}" disabled></div>
        <div><label>Modelo</label><input value="${esc(item.equipamento_modelo || '')}" disabled></div>
        <div><label>Nº de série</label><input value="${esc(item.equipamento_serie || '')}" disabled></div>
      </div>
    </div>

    <div class="panel">
      <h2>Dados do equipamento</h2>
      <div class="form-grid">
        <div><label>Marca</label><input id="lt-marca" placeholder="Marca do equipamento" oninput="atualizarRascunhoLaudo()"></div>
        <div><label>Data de fabricação</label><input id="lt-data_fabricacao" type="date" oninput="atualizarRascunhoLaudo()"></div>
        <div class="full"><label>Acessórios recebidos</label><input id="lt-acessorios" placeholder="ex: cabo de força, fonte, controle..." oninput="atualizarRascunhoLaudo()"></div>
        <div class="full"><label>Defeito informado pelo cliente</label><input id="lt-defeito_informado" oninput="atualizarRascunhoLaudo()"></div>
      </div>
      <label>Equipamento está na garantia?*</label>
      <div style="display:flex; gap:18px; flex-wrap:wrap; margin-bottom:10px;">
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="lt-garantia" value="sim" onchange="atualizarRascunhoLaudo()" style="width:auto;"> Sim</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="lt-garantia" value="nao" onchange="atualizarRascunhoLaudo()" style="width:auto;"> Não</label>
        <label style="display:flex; align-items:center; gap:6px; font-weight:600; text-transform:none;"><input type="radio" name="lt-garantia" value="outros" onchange="atualizarRascunhoLaudo()" style="width:auto;"> Outros</label>
      </div>
      <input id="lt-garantia_obs" placeholder="Especifique (obrigatório se 'Outros')" oninput="atualizarRascunhoLaudo()">
    </div>

    <div class="panel">
      <h2>Técnico responsável</h2>
      <div class="form-grid">
        <div><label>Data de entrada</label><input id="lt-data_entrada" type="date" disabled></div>
        <div><label>Data de conclusão*</label><input id="lt-data_conclusao" type="date" oninput="atualizarRascunhoLaudo()"></div>
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
      <p style="font-size:12.5px; color:var(--ink-soft);">Ao concluir, o PDF do laudo preenchido é gerado e baixado automaticamente.</p>
      <p id="lt-rascunho-status" style="font-size:12px; color:var(--green);">${salvoEm ? `Rascunho salvo automaticamente neste dispositivo às ${salvoEm}` : ''}</p>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm" onclick="limparLaudo(${item.id})">Limpar formulário</button>
        <button class="btn btn-primary btn-sm" onclick="concluirLaudoTecnico()">Concluir e gerar PDF</button>
      </div>
    </div>`;
  preencherCamposLaudo();
  renderPecasLaudo();
  renderFotosLaudo();
}

function preencherCamposLaudo() {
  const d = laudoDraft;
  ['marca', 'data_fabricacao', 'acessorios', 'defeito_informado', 'garantia_obs', 'data_conclusao', 'laudo_tecnico', 'servico_realizado', 'observacoes'].forEach((campo) => {
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
    ['marca', 'data_fabricacao', 'acessorios', 'defeito_informado', 'garantia_obs', 'data_conclusao', 'laudo_tecnico', 'servico_realizado', 'observacoes'].forEach((campo) => {
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
  if (!d.garantia) return alert('Informe se o equipamento está na garantia.');
  if (d.garantia === 'outros' && !String(d.garantia_obs || '').trim()) return alert('Especifique a garantia em "Outros".');
  if (!d.data_conclusao) return alert('Informe a data de conclusão.');
  if (!String(d.laudo_tecnico || '').trim()) return alert('Preencha o laudo técnico.');
  if (!String(d.servico_realizado || '').trim()) return alert('Descreva o serviço realizado.');
  if (!d.fotos.length) return alert('Anexe ao menos uma foto no relatório fotográfico.');

  const body = { agenda_id: d.agenda_id, laudo: d, relevante_biblioteca: d.relevante_biblioteca };
  let visita;
  try {
    ({ visita } = await api('/api/visitas', { method: 'POST', body }));
  } catch (e) {
    alert('Erro ao concluir: ' + e.message);
    return;
  }
  localStorage.removeItem(chaveRascunhoLaudo(d.agenda_id));
  let avisoExtra = '';
  try {
    const pdfDataUri = gerarPdfLaudo(d, laudoAgendaAtual);
    const link = document.createElement('a');
    link.href = pdfDataUri;
    link.download = `laudo-tecnico-${visita.id}.pdf`;
    document.body.appendChild(link); link.click(); link.remove();
  } catch (e) {
    console.error('Falha ao gerar o PDF localmente:', e);
    avisoExtra = ' O laudo foi salvo, mas não foi possível gerar o PDF neste dispositivo.';
  }
  mostrarToast('Laudo concluído e enviado para aprovação do administrador.' + avisoExtra);
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
    const linhas = doc.splitTextToSize(String(valor || '—'), largura - 130);
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
  linha('Técnico', USER.nome);
  linha('Equipamento', `${item.equipamento_tipo || ''} — ${item.equipamento_modelo || ''} (${item.equipamento_serie || '—'})`);
  y += 8;

  titulo('Dados do equipamento');
  linha('Marca', d.marca); linha('Data de fabricação', d.data_fabricacao);
  linha('Garantia', d.garantia === 'sim' ? 'Sim' : d.garantia === 'nao' ? 'Não' : `Outros — ${d.garantia_obs}`);
  linha('Acessórios recebidos', d.acessorios); linha('Defeito informado', d.defeito_informado);
  y += 8;

  titulo('Técnico responsável');
  linha('Data de entrada', d.data_entrada); linha('Data de conclusão', d.data_conclusao); linha('Período de reparo', periodoReparo(d));
  y += 8;

  titulo('Laudo técnico');
  { if (y > 740) { doc.addPage(); y = 50; } doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38); const linhas = doc.splitTextToSize(d.laudo_tecnico, largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8; }

  titulo('Serviço realizado');
  { if (y > 740) { doc.addPage(); y = 50; } doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38); const linhas = doc.splitTextToSize(d.servico_realizado, largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8; }

  if (d.pecas.length) {
    titulo('Peças fornecidas');
    d.pecas.forEach((p) => {
      if (y > 760) { doc.addPage(); y = 50; }
      doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38);
      doc.text(`• ${p.descricao || '—'}${p.quantidade ? ' (qtd: ' + p.quantidade + ')' : ''}`, margem, y); y += 13;
    });
    y += 8;
  }

  if (d.observacoes) {
    titulo('Observações');
    if (y > 740) { doc.addPage(); y = 50; }
    doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(16, 24, 38);
    const linhas = doc.splitTextToSize(d.observacoes, largura); doc.text(linhas, margem, y); y += linhas.length * 12 + 8;
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
let visitasAbertas = new Set();
let osAno = new Date().getFullYear();
let osMes = new Date().getMonth();

async function renderAprovacoesVisitas() {
  const [{ agenda }, { visitas }] = await Promise.all([api('/api/agenda'), api('/api/visitas')]);
  window._osAgendaCache = agenda;
  window._osVisitasPorAgenda = {};
  visitas.forEach((v) => { window._osVisitasPorAgenda[v.agenda_id] = v; });
  desenharOrdemServico();
}

function mudarMesOS(delta) {
  osMes += delta;
  if (osMes < 0) { osMes = 11; osAno--; }
  if (osMes > 11) { osMes = 0; osAno++; }
  desenharOrdemServico();
}

function irParaHojeOS() {
  const hoje = new Date();
  osAno = hoje.getFullYear();
  osMes = hoje.getMonth();
  desenharOrdemServico();
}

function desenharOrdemServico() {
  const agenda = window._osAgendaCache || [];
  const visitasPorAgenda = window._osVisitasPorAgenda || {};
  const doMes = agenda
    .filter((a) => {
      const d = new Date(a.data_hora_inicio);
      return d.getFullYear() === osAno && d.getMonth() === osMes;
    })
    .sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  const reaberturas = Object.values(visitasPorAgenda).filter((v) => v.solicitacao_reabertura && v.solicitacao_reabertura.status === 'pendente');

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Ordem de Serviço</h1><p>${doMes.length} O.S. em ${MES_LABEL[osMes]} de ${osAno}</p></div>
    <div class="panel" style="padding:14px 18px; margin-bottom:22px;">
      <div class="cal-head" style="margin-bottom:0;">
        <div class="cal-nav">
          <button onclick="mudarMesOS(-1)">‹</button>
          <div class="cal-mes-label">${MES_LABEL[osMes]} de ${osAno}</div>
          <button onclick="mudarMesOS(1)">›</button>
        </div>
        <button class="btn-outline-sm" onclick="irParaHojeOS()">Hoje</button>
      </div>
    </div>

    ${reaberturas.length ? `
    <div class="page-head"><h1 style="font-size:16px;">Solicitações de reabertura</h1></div>
    <div class="panel"><table>
      <tr><th>Equipamento</th><th>Técnico</th><th>Motivo</th><th></th></tr>
      ${reaberturas.map((v) => `
        <tr>
          <td>${v.equipamento_tipo || '—'}</td>
          <td>${v.tecnico_nome || '—'}</td>
          <td>${esc(v.solicitacao_reabertura.motivo || '—')}</td>
          <td>
            <button class="btn btn-primary btn-sm" onclick="reabrirVisita(${v.id})">Aprovar e reabrir</button>
            <button class="btn btn-ghost btn-sm" onclick="recusarReabertura(${v.id})">Recusar</button>
          </td>
        </tr>`).join('')}
    </table></div>` : ''}

    ${doMes.length ? `<div class="os-grid">${doMes.map((a) => cardOSAdmin(a, visitasPorAgenda[a.id])).join('')}</div>` : `<div class="empty">Nenhuma O.S. neste mês.</div>`}

    ${doMes.filter((a) => visitasPorAgenda[a.id] && visitasAbertas.has(visitasPorAgenda[a.id].id)).map((a) => {
      const visita = visitasPorAgenda[a.id];
      return `
        <div class="os-detail-panel">
          <div class="panel-head">Relatório — OS-${String(a.id).padStart(6, '0')} · ${esc(a.cliente_nome || '—')}
            <button class="btn-outline-sm" onclick="alternarVisitaAberta(${visita.id})">Fechar</button>
          </div>
          ${detalheRelatorioVisita(visita)}
        </div>`;
    }).join('')}`;
}

function cardOSAdmin(a, visita) {
  const aberto = visita && visitasAbertas.has(visita.id);
  let acoes;
  if (visita && visita.status_aprovacao === 'pendente') {
    acoes = `
      <button class="btn-outline-sm" onclick="alternarVisitaAberta(${visita.id})">${aberto ? 'Fechar relatório' : 'Abrir relatório'}</button>
      <button class="btn btn-primary btn-sm" onclick="aprovarVisita(${visita.id})">Aprovar${visita.relevante_biblioteca ? ' e incluir na biblioteca' : ''}</button>
      <button class="btn btn-ghost btn-sm" onclick="reprovarVisita(${visita.id})">Reprovar</button>`;
  } else if (visita && visita.status_aprovacao === 'aprovado') {
    acoes = `
      <button class="btn-outline-sm" onclick="alternarVisitaAberta(${visita.id})">${aberto ? 'Fechar relatório' : 'Abrir relatório'}</button>
      <button class="btn-outline-sm" onclick="reabrirVisita(${visita.id})">Reabrir</button>
      <button class="btn-outline-sm" onclick="excluirVisita(${visita.id})" style="color:var(--red); border-color:var(--red);">Excluir</button>`;
  } else if (visita && visita.status_aprovacao === 'reprovado') {
    acoes = `
      <button class="btn-outline-sm" onclick="alternarVisitaAberta(${visita.id})">${aberto ? 'Fechar relatório' : 'Abrir relatório'}</button>
      <span class="tag tag-falha">Reprovado${visita.comentario_reprovacao ? ': ' + esc(visita.comentario_reprovacao) : ''}</span>`;
  } else {
    acoes = `<span style="font-size:11.5px; color:var(--ink-soft);">Aguardando execução pelo técnico.</span>`;
  }
  return `
    <div class="os-card">
      ${osCardCorpo(a)}
      <div class="os-card-actions">${acoes}</div>
    </div>`;
}

function alternarVisitaAberta(id) {
  if (visitasAbertas.has(id)) visitasAbertas.delete(id); else visitasAbertas.add(id);
  desenharOrdemServico();
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
      <div class="kv"><b>Equipamento:</b> ${esc(l.equipamento_tipo || '')} — ${esc(l.modelo_maquina || '')} (${esc(l.numero_serie || '—')}) <span class="sep">·</span> <b>Marca:</b> ${esc(l.marca || '—')}</div>
      <div class="kv"><b>Data de fabricação:</b> ${esc(l.data_fabricacao || '—')} <span class="sep">·</span> <b>Garantia:</b> ${l.garantia === 'sim' ? 'Sim' : l.garantia === 'nao' ? 'Não' : `Outros — ${esc(l.garantia_obs || '')}`}</div>
      <div class="kv"><b>Acessórios recebidos:</b> ${esc(l.acessorios || '—')}</div>
      <div class="kv"><b>Defeito informado:</b> ${esc(l.defeito_informado || '—')}</div>
      <div class="kv"><b>Data de entrada:</b> ${esc(l.data_entrada || '—')} <span class="sep">·</span> <b>Data de conclusão:</b> ${esc(l.data_conclusao || '—')} <span class="sep">·</span> <b>Período de reparo:</b> ${periodoReparo(l)}</div>
      <div class="kv"><b>Laudo técnico:</b> ${esc(l.laudo_tecnico || '')}</div>
      <div class="kv"><b>Serviço realizado:</b> ${esc(l.servico_realizado || '')}</div>
      ${(l.pecas || []).length ? `<div class="kv"><b>Peças fornecidas:</b></div><ol class="item-steps">${l.pecas.map((p) => `<li>${esc(p.descricao || '—')}${p.quantidade ? ' (qtd: ' + esc(p.quantidade) + ')' : ''}</li>`).join('')}</ol>` : ''}
      ${l.observacoes ? `<div class="kv"><b>Observações:</b> ${esc(l.observacoes)}</div>` : ''}
      ${(l.fotos || []).length ? `<div class="kv"><b>Relatório fotográfico:</b></div><div class="step-photos">${l.fotos.map((f) => `<div class="photo-thumb"><img src="${f}" onclick="abrirLightbox('${f}')" alt="Foto do laudo"></div>`).join('')}</div>` : ''}`;
  }
  return `<div class="kv"><b>Causa:</b> ${esc(v.causa)}</div><div class="kv"><b>Correção:</b> ${esc(v.correcao)}</div><div class="kv"><b>Resultado:</b> ${esc(v.resultado)}</div>`;
}
async function aprovarVisita(id) { await api(`/api/visitas/${id}/aprovar`, { method: 'POST' }); renderAprovacoesVisitas(); }
async function reprovarVisita(id) {
  const comentario = prompt('Motivo da reprovação (opcional):') || '';
  await api(`/api/visitas/${id}/reprovar`, { method: 'POST', body: { comentario } });
  renderAprovacoesVisitas();
}
async function reabrirVisita(id) {
  if (!confirm('Reabrir este relatório? Ele volta para a fila de aprovação e o técnico pode editá-lo novamente.')) return;
  try { await api(`/api/visitas/${id}/reabrir`, { method: 'POST' }); mostrarToast('Relatório reaberto.'); renderAprovacoesVisitas(); }
  catch (e) { alert('Erro: ' + e.message); }
}
async function recusarReabertura(id) {
  try { await api(`/api/visitas/${id}/recusar-reabertura`, { method: 'POST' }); mostrarToast('Solicitação de reabertura recusada.'); renderAprovacoesVisitas(); }
  catch (e) { alert('Erro: ' + e.message); }
}
async function excluirVisita(id) {
  if (!confirm('Excluir este relatório definitivamente? Se ele já tiver entrado na biblioteca, o caso também é removido. Essa ação não pode ser desfeita.')) return;
  try { await api(`/api/visitas/${id}`, { method: 'DELETE' }); mostrarToast('Relatório excluído.'); renderAprovacoesVisitas(); }
  catch (e) { alert('Erro: ' + e.message); }
}
async function solicitarReaberturaVisita(id) {
  const motivo = prompt('Por que você precisa reabrir este relatório?') || '';
  try { await api(`/api/visitas/${id}/solicitar-reabertura`, { method: 'POST', body: { motivo } }); mostrarToast('Solicitação enviada ao administrador.'); renderAgenda(); }
  catch (e) { alert('Erro: ' + e.message); }
}

// ---------- BIBLIOTECA: ACESSAR ----------
async function renderBibliotecaDefeitos(filtros = {}) {
  const params = new URLSearchParams({ tipo: 'defeito', ...filtros });
  const { registros } = await api('/api/registros?' + params.toString());
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Biblioteca — Defeitos/Falhas</h1><p>Casos aprovados pela liderança, pesquisáveis por equipamento, palavra-chave ou nº de série</p></div>
    <div class="filtros-row">
      <div class="field"><label>Equipamento</label><input id="f-equip" value="${esc(filtros.equipamento || '')}" placeholder="ex: Máquina de Gelo"></div>
      <div class="field"><label>Nº de série</label><input id="f-serie" value="${esc(filtros.serie || '')}" placeholder="ex: 2301013587"></div>
      <div class="field"><label>Palavra-chave</label><input id="f-q" value="${esc(filtros.q || '')}" placeholder="sintoma, causa ou solução"></div>
      <button class="btn btn-primary btn-sm" onclick="filtrarDefeitos()">Buscar</button>
    </div>
    ${registros.length ? registros.map((r) => `
      <div class="item-card">
        <div class="item-top">
          <div><div class="item-title">${esc(r.titulo)}</div>
            <div class="item-meta">${esc(r.equipamento_tipo)} ${r.equipamento_modelo ? '— ' + esc(r.equipamento_modelo) : ''} ${r.numero_serie ? `<span class="sep">·</span> Nº série ${esc(r.numero_serie)}` : ''}</div>
          </div>
          <span class="tag tag-falha">Defeito</span>
        </div>
        <div class="item-body">
          <div class="kv"><b>Sintoma:</b> ${esc(r.sintoma)}</div>
          <div class="kv"><b>Causa:</b> ${esc(r.causa)}</div>
          <div class="kv"><b>Solução:</b> ${esc(r.solucao)}</div>
          <div class="item-autor">Autor: <b>${esc(r.autor_nome || '—')}</b> · ${fmtData(r.criado_em)}</div>
        </div>
      </div>`).join('') : `<div class="empty">Nenhum caso aprovado com esses filtros ainda.</div>`}`;
}
function filtrarDefeitos() {
  renderBibliotecaDefeitos({
    equipamento: document.getElementById('f-equip').value,
    serie: document.getElementById('f-serie').value,
    q: document.getElementById('f-q').value,
  });
}

async function renderBibliotecaProcedimentos(filtros = {}) {
  const params = new URLSearchParams({ tipo: 'procedimento', ...filtros });
  const { registros } = await api('/api/registros?' + params.toString());
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Biblioteca — Manual de Procedimentos</h1><p>Procedimentos preventivos aprovados, pesquisáveis por equipamento ou título</p></div>
    <div class="filtros-row">
      <div class="field"><label>Equipamento</label><input id="f-equip" value="${esc(filtros.equipamento || '')}" placeholder="ex: Torre de Bebidas"></div>
      <div class="field"><label>Título</label><input id="f-q" value="${esc(filtros.q || '')}" placeholder="título do procedimento"></div>
      <button class="btn btn-primary btn-sm" onclick="filtrarProcedimentos()">Buscar</button>
    </div>
    ${registros.length ? registros.map((r) => `
      <div class="item-card">
        <div class="item-top">
          <div><div class="item-title">${esc(r.titulo)}</div>
            <div class="item-meta">${esc(r.equipamento_tipo)} ${r.equipamento_modelo ? '— ' + esc(r.equipamento_modelo) : ''} ${r.periodicidade ? `<span class="sep">·</span> Periodicidade: ${esc(r.periodicidade)}` : ''}</div>
          </div>
          <span class="tag tag-preventiva">Procedimento</span>
        </div>
        <div class="item-body">
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
      </div>`).join('') : `<div class="empty">Nenhum procedimento aprovado com esses filtros ainda.</div>`}`;
}
function filtrarProcedimentos() {
  renderBibliotecaProcedimentos({
    equipamento: document.getElementById('f-equip').value,
    q: document.getElementById('f-q').value,
  });
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
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Meus registros</h1><p>${registros.length} enviado(s) — acompanhe o status de aprovação</p></div>
    ${registros.length ? registros.map((r) => `
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
        ` : ''}
      </div>`).join('') : `<div class="empty">Você ainda não enviou nenhum registro.</div>`}`;
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
    ${registros.length ? registros.map((r) => `
      <div class="item-card">
        <div class="item-top">
          <div><div class="item-title">${esc(r.titulo)}</div>
            <div class="item-meta">${r.tipo === 'defeito' ? tag('Defeito/Falha', 'falha') : tag('Procedimento', 'preventiva')}<span class="sep">·</span>${esc(r.equipamento_tipo)}<span class="sep">·</span>por ${esc(r.autor_nome || '—')}</div>
          </div>
        </div>
        <div class="item-body">
          ${r.tipo === 'defeito' ? `
            <div class="kv"><b>Sintoma:</b> ${esc(r.sintoma)}</div>
            <div class="kv"><b>Causa:</b> ${esc(r.causa)}</div>
            <div class="kv"><b>Solução:</b> ${esc(r.solucao)}</div>
          ` : `
            <ol class="item-steps">${(r.passos || []).map((p) => `<li>${esc(p.texto)} ${p.fotos && p.fotos.length ? `(${p.fotos.length} foto(s))` : ''}</li>`).join('')}</ol>
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
            <button class="btn btn-orange btn-sm" onclick="sugerindoId=${r.id}; desenharFilaBiblioteca();">Sugerir alteração</button>
          `}
        </div>
      </div>`).join('') : `<div class="empty">Nada pendente no momento.</div>`}`;
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

// ---------- EQUIPAMENTOS ----------
async function renderEquipamentos() {
  const { equipamentos } = await api('/api/equipamentos');
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head"><h1>Equipamentos</h1><p>${equipamentos.length} cadastrado(s)</p></div>
    <div class="panel"><table>
      <tr><th>Tipo</th><th>Modelo</th><th>Nº de série</th><th>Localização</th><th></th></tr>
      ${equipamentos.map((e) => `
        <tr><td>${e.tipo}</td><td>${e.modelo}</td><td>${e.numero_serie}</td><td>${e.localizacao || '—'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="verHistorico(${e.id})">Histórico</button></td></tr>`).join('')}
    </table></div>
    <div id="historico-eq"></div>`;
}
async function verHistorico(id) {
  const { agenda } = await api(`/api/equipamentos/${id}/historico`);
  document.getElementById('historico-eq').innerHTML = `
    <div class="panel"><div class="panel-head">Histórico do equipamento</div>
    <table>
      <tr><th>Data</th><th>Tipo</th><th>Status</th></tr>
      ${agenda.length ? agenda.map((a) => `<tr><td>${fmtData(a.data_hora_inicio)}</td><td>${TIPO_OS_LABEL[a.tipo] || a.tipo}</td><td>${a.status}</td></tr>`).join('') : `<tr><td colspan="3" class="empty">Sem histórico ainda.</td></tr>`}
    </table></div>`;
}

// ---------- USUÁRIOS (cadastro por convite) ----------
async function renderUsuarios() {
  const [{ usuarios }, { clientes }] = await Promise.all([api('/api/usuarios'), api('/api/clientes')]);
  window._clientesCache = clientes;
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
          <div class="u-line1">${esc(u.nome)} <span class="tag tag-papel">${esc(u.papel)}</span></div>
          <div class="u-line2">${esc(u.email)} ${u.cargo ? '· ' + esc(u.cargo) : ''} ${u.setor ? '· ' + esc(u.setor) : ''}</div>
        </div>
        <span class="badge ${u.status === 'ativo' ? 'badge-ativo' : 'badge-convite'}">${u.status === 'ativo' ? 'Ativo' : 'Convite enviado'}</span>
        ${u.status !== 'ativo' ? `<button class="btn-outline-sm" onclick="reenviarConvite(${u.id})">Reenviar convite</button>` : ''}
      </div>`).join('')}`;
}
function mostrarFormUsuario() {
  const clientes = window._clientesCache || [];
  document.getElementById('form-usuario').innerHTML = `
    <div class="panel"><div class="panel-head">Novo usuário</div>
      <div class="form-grid">
        <div><label>Nome</label><input id="nu-nome"></div>
        <div><label>E-mail</label><input id="nu-email"></div>
        <div><label>Cargo</label><input id="nu-cargo"></div>
        <div><label>Setor</label><input id="nu-setor"></div>
        <div><label>Tipo de acesso</label><select id="nu-papel" onchange="alternarCampoCliente()"><option value="tecnico">Técnico</option><option value="administrador">Administrador</option><option value="cliente">Cliente</option></select></div>
        <div id="campo-cliente"><label>Empresa (cliente)</label><select id="nu-cliente">${clientes.map((c) => `<option value="${c.id}">${esc(c.nome_empresa)}</option>`).join('')}</select></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="salvarUsuario()">Salvar e enviar convite</button>
    </div>`;
  alternarCampoCliente();
}
function alternarCampoCliente() {
  const papel = document.getElementById('nu-papel').value;
  document.getElementById('campo-cliente').style.display = papel === 'cliente' ? '' : 'none';
}
async function salvarUsuario() {
  const papel = document.getElementById('nu-papel').value;
  const body = {
    nome: document.getElementById('nu-nome').value,
    email: document.getElementById('nu-email').value,
    cargo: document.getElementById('nu-cargo').value,
    setor: document.getElementById('nu-setor').value,
    papel,
    cliente_id: papel === 'cliente' ? Number(document.getElementById('nu-cliente').value) : null,
  };
  try {
    const { convite } = await api('/api/usuarios', { method: 'POST', body });
    await renderUsuarios();
    mostrarLinkConvite(convite);
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
        <tr><td>${fmtData(c.criado_em)}</td><td>${esc(c.tipo_servico)}</td><td>${esc(c.equipamento_tipo || '—')}</td><td>${tag(c.status === 'aberto' ? 'Aberto' : c.status, c.status === 'aberto' ? 'amber' : 'green')}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">Nenhum chamado aberto ainda.</td></tr>`}
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
function mostrarToast(texto) {
  const toast = document.getElementById('toast');
  toast.textContent = texto;
  toast.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

tentarSessaoExistente();
