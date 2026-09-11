// app.js — frontend real do Pro Conecta. Tudo aqui chama a API de verdade (fetch),
// sem dados inventados: o que aparece na tela veio do servidor.

let TOKEN = localStorage.getItem('pc_token') || null;
let USER = null;

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
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    montarSidebar();
    ir('agenda');
  } catch (e) {
    erroEl.textContent = e.message;
  }
}

function sair() {
  TOKEN = null; USER = null;
  localStorage.removeItem('pc_token');
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

async function tentarSessaoExistente() {
  if (!TOKEN) return;
  try {
    const data = await api('/api/me');
    USER = data.usuario;
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    montarSidebar();
    ir('agenda');
  } catch (e) {
    TOKEN = null; localStorage.removeItem('pc_token');
  }
}

const NAV = {
  administrador: [['agenda', 'Agenda geral'], ['aprovacoes', 'Aprovações'], ['biblioteca', 'Biblioteca'], ['equipamentos', 'Equipamentos'], ['usuarios', 'Usuários']],
  tecnico: [['agenda', 'Minha agenda'], ['biblioteca', 'Biblioteca']],
  cliente: [['equipamentos', 'Meus equipamentos']],
};

function montarSidebar() {
  document.getElementById('sb-nome').textContent = USER.nome;
  document.getElementById('sb-papel').textContent = USER.papel;
  const nav = NAV[USER.papel] || [];
  document.getElementById('sb-nav').innerHTML = nav.map(([key, label]) =>
    `<div class="sb-item" data-key="${key}" onclick="ir('${key}')">${label}</div>`
  ).join('');
}

async function ir(pagina) {
  document.querySelectorAll('.sb-item').forEach((el) => el.classList.toggle('active', el.dataset.key === pagina));
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="empty">Carregando...</div>';
  try {
    if (pagina === 'agenda') return renderAgenda();
    if (pagina === 'aprovacoes') return renderAprovacoes();
    if (pagina === 'biblioteca') return renderBiblioteca();
    if (pagina === 'equipamentos') return renderEquipamentos();
    if (pagina === 'usuarios') return renderUsuarios();
  } catch (e) {
    main.innerHTML = `<div class="empty">Erro: ${e.message}</div>`;
  }
}

function tag(texto, cor) { return `<span class="tag tag-${cor}">${texto}</span>`; }
function fmtData(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

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

// ---------- APROVAÇÕES ----------
async function renderAprovacoes() {
  const { visitas } = await api('/api/visitas?status=pendente');
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head"><h1>Aprovações</h1><p>${visitas.length} pendente(s)</p></div>
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
async function aprovarVisita(id) { await api(`/api/visitas/${id}/aprovar`, { method: 'POST' }); renderAprovacoes(); }
async function reprovarVisita(id) {
  const comentario = prompt('Motivo da reprovação (opcional):') || '';
  await api(`/api/visitas/${id}/reprovar`, { method: 'POST', body: { comentario } });
  renderAprovacoes();
}

// ---------- BIBLIOTECA ----------
async function renderBiblioteca(q) {
  const { biblioteca } = await api('/api/biblioteca' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head"><h1>Biblioteca de defeitos e soluções</h1><p>Casos aprovados pela liderança</p></div>
    <div class="panel-body" style="padding-left:0; padding-right:0;">
      <input placeholder="Buscar por equipamento, sintoma ou solução..." id="bib-busca"
        style="width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:6px; margin-bottom:16px;"
        oninput="renderBiblioteca(this.value)" value="${q || ''}">
    </div>
    <div class="card-grid">
      ${biblioteca.length ? biblioteca.map((b) => `
        <div class="lib-card">
          <div class="eq">${b.equipamento_tipo}</div>
          <h3>${b.sintoma || 'Caso técnico'}</h3>
          <div class="row"><b>Causa:</b> ${b.causa || '—'}</div>
          <div class="row"><b>Solução:</b> ${b.solucao || '—'}</div>
        </div>`).join('') : `<div class="empty">Nenhum caso aprovado ainda — aparece aqui assim que o administrador aprovar uma visita.</div>`}
    </div>`;
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

// ---------- USUÁRIOS ----------
async function renderUsuarios() {
  const { usuarios } = await api('/api/usuarios');
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div><h1>Usuários</h1><p>${usuarios.length} cadastrado(s)</p></div>
      <button class="btn btn-primary btn-sm" style="width:auto;" onclick="mostrarFormUsuario()">+ Novo usuário</button>
    </div>
    <div id="form-usuario"></div>
    <div class="panel"><table>
      <tr><th>Nome</th><th>Papel</th><th>E-mail</th></tr>
      ${usuarios.map((u) => `<tr><td>${u.nome}</td><td>${tag(u.papel, 'blue')}</td><td>${u.email}</td></tr>`).join('')}
    </table></div>`;
}
function mostrarFormUsuario() {
  document.getElementById('form-usuario').innerHTML = `
    <div class="panel"><div class="panel-head">Novo usuário</div>
      <div class="form-grid">
        <div><label>Nome</label><input id="nu-nome"></div>
        <div><label>E-mail</label><input id="nu-email"></div>
        <div><label>Papel</label><select id="nu-papel"><option value="tecnico">Técnico</option><option value="supervisor">Supervisor</option><option value="financeiro">Financeiro</option><option value="administrador">Administrador</option></select></div>
        <div><label>Senha inicial</label><input id="nu-senha" value="123456"></div>
      </div>
      <div class="panel-body" style="padding-top:0;"><button class="btn btn-primary btn-sm" style="width:auto;" onclick="salvarUsuario()">Salvar</button></div>
    </div>`;
}
async function salvarUsuario() {
  const body = {
    nome: document.getElementById('nu-nome').value,
    email: document.getElementById('nu-email').value,
    papel: document.getElementById('nu-papel').value,
    senha: document.getElementById('nu-senha').value,
  };
  try { await api('/api/usuarios', { method: 'POST', body }); renderUsuarios(); }
  catch (e) { alert('Erro: ' + e.message); }
}

tentarSessaoExistente();
