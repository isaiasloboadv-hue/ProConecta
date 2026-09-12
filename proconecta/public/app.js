// app.js — frontend real do Pro Conecta. Tudo aqui chama a API de verdade (fetch),
// sem dados inventados: o que aparece na tela veio do servidor.

let TOKEN = localStorage.getItem('pc_token') || null;
let USER = null;
let paginaAtual = null;
let navAbertos = new Set();
let sinoTimer = null;
let procDraft = [{ texto: '', fotos: [] }];

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
  erroEl.textContent = '';
  try {
    const data = await api('/api/login', { method: 'POST', body: { email, senha } });
    TOKEN = data.token;
    USER = data.usuario;
    localStorage.setItem('pc_token', TOKEN);
    entrarNoApp();
  } catch (e) {
    erroEl.textContent = e.message;
  }
}

function sair() {
  TOKEN = null; USER = null; navAbertos = new Set();
  if (sinoTimer) clearInterval(sinoTimer);
  localStorage.removeItem('pc_token');
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
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
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');
  montarSidebar();
  atualizarSino();
  sinoTimer = setInterval(atualizarSino, 15000);
  const paginaInicial = { administrador: 'agenda', tecnico: 'agenda', cliente: 'biblioteca-defeitos' }[USER.papel] || 'agenda';
  ir(paginaInicial);
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
    ]},
  ],
  administrador: [
    { key: 'agenda', label: 'Agenda geral', page: 'agenda' },
    { key: 'aprovacoes-visitas', label: 'Aprovação de visitas', page: 'aprovacoes-visitas' },
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
    return `<button class="nav-leaf ${ativo ? 'active' : ''}" style="padding-left:${indent}px" onclick="ir('${node.page}')">${node.label}</button>`;
  }).join('');
}

function montarSidebar() {
  document.getElementById('sb-nome').textContent = USER.nome;
  document.getElementById('sb-papel').textContent = USER.papel;
  const nav = NAV[USER.papel] || [];
  document.getElementById('sb-nav').innerHTML = renderNavNodes(nav, 0);
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
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="empty">Carregando...</div>';
  try {
    if (pagina === 'agenda') return renderAgenda();
    if (pagina === 'aprovacoes-visitas') return renderAprovacoesVisitas();
    if (pagina === 'biblioteca-defeitos') return renderBibliotecaDefeitos();
    if (pagina === 'biblioteca-procedimentos') return renderBibliotecaProcedimentos();
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
  if (status === 'aprovado') return tag('Aprovado', 'green');
  if (status === 'alteracao_sugerida') return tag('Alteração sugerida', 'orange');
  return tag('Em análise', 'amber');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- sino de notificações ----------

async function atualizarSino() {
  try {
    const { notificacoes, contador } = await api('/api/notificacoes');
    const badge = document.getElementById('bell-badge');
    badge.textContent = contador;
    badge.classList.toggle('hidden', contador === 0);
    document.getElementById('bell-panel').innerHTML = `
      <div class="bell-title">Notificações</div>
      ${notificacoes.length ? notificacoes.map((n) => `<button class="bell-item" onclick="clicarNotificacao(${n.registro_id}, '${n.tipo}')">${esc(n.texto)}</button>`).join('') : '<div class="bell-empty">Nada por aqui no momento.</div>'}
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
  const isAdmin = USER.papel === 'administrador';
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div><h1>${isAdmin ? 'Agenda geral' : 'Minha agenda'}</h1><p>${agenda.length} atividade(s)</p></div>
      ${isAdmin ? `<button class="btn btn-primary btn-sm" style="width:auto;" onclick="mostrarFormNovaAtividade()">+ Nova atividade</button>` : ''}
    </div>
    <div id="form-nova-atividade"></div>
    <div class="panel"><table>
      <tr><th>Data</th>${isAdmin ? '<th>Técnico</th>' : ''}<th>Cliente</th><th>Equipamento</th><th>Tipo</th><th>Status</th><th></th></tr>
      ${agenda.length ? agenda.map((a) => `
        <tr>
          <td>${fmtData(a.data_hora_inicio)}</td>
          ${isAdmin ? `<td>${a.tecnico_nome || '—'}</td>` : ''}
          <td>${a.cliente_nome || '—'}</td>
          <td>${a.equipamento_tipo || '—'} ${a.equipamento_modelo ? '(' + a.equipamento_modelo + ')' : ''}</td>
          <td>${a.tipo}</td>
          <td>${a.status === 'concluida' ? tag('Concluída', 'green') : a.status === 'em_andamento' ? tag('Em andamento', 'blue') : tag('Pendente', 'amber')}</td>
          <td>${!isAdmin && a.status !== 'concluida' ? `<button class="btn btn-ghost btn-sm" onclick="abrirDiario(${a.id})">Executar</button>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">Nenhuma atividade ainda.</td></tr>`}
    </table></div>
    <div id="diario-form"></div>
  `;
}

async function mostrarFormNovaAtividade() {
  const [{ usuarios }, { equipamentos }] = await Promise.all([api('/api/usuarios'), api('/api/equipamentos')]);
  const tecnicos = usuarios.filter((u) => u.papel === 'tecnico');
  document.getElementById('form-nova-atividade').innerHTML = `
    <div class="panel"><div class="panel-head">Nova atividade</div>
      <div class="form-grid">
        <div class="full"><label>Técnico</label><select id="na-tecnico">${tecnicos.map((t) => `<option value="${t.id}">${t.nome}</option>`).join('')}</select></div>
        <div><label>Equipamento</label><select id="na-equip">${equipamentos.map((e) => `<option value="${e.id}" data-cliente="${e.cliente_id}">${e.tipo} — ${e.modelo}</option>`).join('')}</select></div>
        <div><label>Tipo</label><select id="na-tipo"><option value="corretiva">Corretiva</option><option value="preventiva">Preventiva</option><option value="treinamento">Treinamento</option></select></div>
        <div><label>Início</label><input type="datetime-local" id="na-inicio"></div>
        <div><label>Fim previsto</label><input type="datetime-local" id="na-fim"></div>
        <div class="full"><label>Problema relatado</label><textarea id="na-problema" placeholder="Descreva o problema relatado pelo cliente..."></textarea></div>
      </div>
      <div class="panel-body" style="padding-top:0;">
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="salvarNovaAtividade()">Salvar atividade</button>
      </div>
    </div>`;
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
  };
  try {
    await api('/api/agenda', { method: 'POST', body });
    renderAgenda();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

async function abrirDiario(agendaId) {
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
      <div class="panel-body" style="padding-top:0;">
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="finalizarDiario(${agendaId})">Finalizar atividade</button>
      </div>
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
    alert('Atividade finalizada e enviada para aprovação do administrador.');
    renderAgenda();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- APROVAÇÃO DE VISITAS (diário técnico ligado à agenda) ----------
async function renderAprovacoesVisitas() {
  const { visitas } = await api('/api/visitas?status=pendente');
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head"><h1>Aprovação de visitas</h1><p>${visitas.length} pendente(s)</p></div>
    <div class="panel"><table>
      <tr><th>Equipamento</th><th>Técnico</th><th>Causa</th><th>Correção</th><th>Resultado</th><th></th></tr>
      ${visitas.length ? visitas.map((v) => `
        <tr>
          <td>${v.equipamento_tipo || '—'}</td>
          <td>${v.tecnico_nome || '—'}</td>
          <td>${v.causa || '—'}</td>
          <td>${v.correcao || '—'}</td>
          <td>${v.resultado}</td>
          <td>
            <button class="btn btn-primary btn-sm" onclick="aprovarVisita(${v.id})">Aprovar</button>
            <button class="btn btn-ghost btn-sm" onclick="reprovarVisita(${v.id})">Reprovar</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">Nada pendente no momento.</td></tr>`}
    </table></div>`;
}
async function aprovarVisita(id) { await api(`/api/visitas/${id}/aprovar`, { method: 'POST' }); renderAprovacoesVisitas(); }
async function reprovarVisita(id) {
  const comentario = prompt('Motivo da reprovação (opcional):') || '';
  await api(`/api/visitas/${id}/reprovar`, { method: 'POST', body: { comentario } });
  renderAprovacoesVisitas();
}

// ---------- BIBLIOTECA: ACESSAR ----------
async function renderBibliotecaDefeitos(filtros = {}) {
  const params = new URLSearchParams({ tipo: 'defeito', ...filtros });
  const { registros } = await api('/api/registros?' + params.toString());
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head"><h1>Biblioteca — Defeitos/Falhas</h1><p>Casos aprovados pela liderança, pesquisáveis por equipamento, palavra-chave ou nº de série</p></div>
    <div class="panel filtros-row">
      <div class="field"><label>Equipamento</label><input id="f-equip" value="${esc(filtros.equipamento || '')}" placeholder="ex: Máquina de Gelo"></div>
      <div class="field"><label>Nº de série</label><input id="f-serie" value="${esc(filtros.serie || '')}" placeholder="ex: 2301013587"></div>
      <div class="field"><label>Palavra-chave</label><input id="f-q" value="${esc(filtros.q || '')}" placeholder="sintoma, causa ou solução"></div>
      <button class="btn btn-primary btn-sm" style="width:auto; align-self:flex-end;" onclick="filtrarDefeitos()">Buscar</button>
    </div>
    <div class="lista-registros">
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
            <div class="item-meta">Registrado por ${esc(r.autor_nome || '—')} em ${fmtData(r.criado_em)}</div>
          </div>
        </div>`).join('') : `<div class="empty">Nenhum caso aprovado com esses filtros ainda.</div>`}
    </div>`;
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
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head"><h1>Biblioteca — Manual de Procedimentos</h1><p>Procedimentos preventivos aprovados, pesquisáveis por equipamento ou título</p></div>
    <div class="panel filtros-row">
      <div class="field"><label>Equipamento</label><input id="f-equip" value="${esc(filtros.equipamento || '')}" placeholder="ex: Torre de Bebidas"></div>
      <div class="field"><label>Título</label><input id="f-q" value="${esc(filtros.q || '')}" placeholder="título do procedimento"></div>
      <button class="btn btn-primary btn-sm" style="width:auto; align-self:flex-end;" onclick="filtrarProcedimentos()">Buscar</button>
    </div>
    <div class="lista-registros">
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
            <div class="item-meta">Registrado por ${esc(r.autor_nome || '—')} em ${fmtData(r.criado_em)}</div>
          </div>
        </div>`).join('') : `<div class="empty">Nenhum procedimento aprovado com esses filtros ainda.</div>`}
    </div>`;
}
function filtrarProcedimentos() {
  renderBibliotecaProcedimentos({
    equipamento: document.getElementById('f-equip').value,
    q: document.getElementById('f-q').value,
  });
}

function abrirLightbox(src) {
  let lb = document.getElementById('lightbox-dinamico');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox-dinamico';
    lb.className = 'lightbox';
    lb.innerHTML = `<button class="lightbox-close" onclick="document.getElementById('lightbox-dinamico').classList.remove('show')">×</button><img id="lightbox-img" src="" alt="Foto ampliada">`;
    lb.onclick = (e) => { if (e.target === lb) lb.classList.remove('show'); };
    document.body.appendChild(lb);
  }
  document.getElementById('lightbox-img').src = src;
  lb.classList.add('show');
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
      <div class="panel-body" style="padding-top:0;">
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="salvarDefeito(${editando ? prefill.id : 'null'})">${editando ? 'Reenviar para aprovação' : 'Enviar para aprovação'}</button>
      </div>
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
      <div class="panel-body" style="padding-top:0;">
        <label>Passo a passo</label>
        <div class="steps-list" id="steps-list"></div>
        <button class="btn btn-ghost btn-sm" style="width:auto;" onclick="adicionarPasso()">+ Adicionar passo</button>
      </div>
      <div class="panel-body" style="padding-top:0;">
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="salvarProcedimento(${editando ? prefill.id : 'null'})">${editando ? 'Reenviar para aprovação' : 'Enviar para aprovação'}</button>
      </div>
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
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head"><h1>Meus registros</h1><p>${registros.length} enviado(s) — acompanhe o status de aprovação</p></div>
    <div class="lista-registros">
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
        </div>`).join('') : `<div class="empty">Você ainda não enviou nenhum registro.</div>`}
    </div>`;
}

async function editarRegistro(id) {
  const { registros } = await api('/api/registros/meus');
  const registro = registros.find((r) => r.id === id);
  if (!registro) return;
  const main = document.getElementById('main-content');
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
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head"><h1>Aprovação — Biblioteca</h1><p>${registros.length} pendente(s)</p></div>
    <div class="lista-registros">
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
        </div>`).join('') : `<div class="empty">Nada pendente no momento.</div>`}
    </div>`;
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
  const main = document.getElementById('main-content');
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
  const { agenda, visitas } = await api(`/api/equipamentos/${id}/historico`);
  document.getElementById('historico-eq').innerHTML = `
    <div class="panel"><div class="panel-head">Histórico do equipamento</div>
    <table>
      <tr><th>Data</th><th>Tipo</th><th>Status</th></tr>
      ${agenda.length ? agenda.map((a) => `<tr><td>${fmtData(a.data_hora_inicio)}</td><td>${a.tipo}</td><td>${a.status}</td></tr>`).join('') : `<tr><td colspan="3" class="empty">Sem histórico ainda.</td></tr>`}
    </table></div>`;
}

// ---------- USUÁRIOS (cadastro por convite) ----------
async function renderUsuarios() {
  const [{ usuarios }, { clientes }] = await Promise.all([api('/api/usuarios'), api('/api/clientes')]);
  window._clientesCache = clientes;
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div><h1>Usuários</h1><p>${usuarios.length} cadastrado(s)</p></div>
      <button class="btn btn-primary btn-sm" style="width:auto;" onclick="mostrarFormUsuario()">+ Novo usuário</button>
    </div>
    <div id="form-usuario"></div>
    <div id="convite-resultado"></div>
    <div class="panel"><table>
      <tr><th>Nome</th><th>Papel</th><th>Cargo/Setor</th><th>E-mail</th><th>Status</th><th></th></tr>
      ${usuarios.map((u) => `
        <tr>
          <td>${esc(u.nome)}</td>
          <td>${tag(u.papel, 'blue')}</td>
          <td>${esc(u.cargo || '—')} ${u.setor ? '/ ' + esc(u.setor) : ''}</td>
          <td>${esc(u.email)}</td>
          <td>${u.status === 'ativo' ? tag('Ativo', 'green') : tag('Convite enviado', 'amber')}</td>
          <td>${u.status !== 'ativo' ? `<button class="btn btn-outline-sm" onclick="reenviarConvite(${u.id})">Reenviar convite</button>` : ''}</td>
        </tr>`).join('')}
    </table></div>`;
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
      <div class="panel-body" style="padding-top:0;">
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="salvarUsuario()">Salvar e enviar convite</button>
      </div>
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
    alvo.innerHTML = `<div class="admin-note" style="background:var(--green-dim, #E1F5EA); color:var(--green,#1E8E5A);"><b>Convite enviado por e-mail</b>Link: ${esc(convite.link)}</div>`;
  } else {
    alvo.innerHTML = `<div class="admin-note"><b>Falha ao enviar o e-mail — copie o link manualmente</b>${esc(convite.link)}</div>`;
  }
}

// ---------- ABERTURA DE CHAMADO (cliente) ----------
async function renderChamados() {
  const [{ chamados }, { equipamentos }] = await Promise.all([api('/api/chamados'), api('/api/equipamentos')]);
  const main = document.getElementById('main-content');
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
      <div class="panel-body" style="padding-top:0;">
        <button class="btn btn-primary btn-sm" style="width:auto;" onclick="abrirChamado()">Abrir chamado</button>
      </div>
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
  let toast = document.getElementById('toast-dinamico');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-dinamico';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = texto;
  toast.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

tentarSessaoExistente();
