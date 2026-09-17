// app.js — lógica de tela do FamilyChat, chamando a API real via fetch + polling.

let TOKEN = localStorage.getItem('familychat_token') || null;
let EU = null;
let CONVERSAS = [];
let CONVERSA_ATIVA = null;
let ULTIMO_TS_MENSAGEM = 0;
let USUARIOS_FAMILIA = [];
let MODO_MODAL = 'conversa'; // 'conversa' | 'grupo'
let SELECIONADOS_MODAL = new Set();

let timerConversas = null;
let timerMensagens = null;

async function api(caminho, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const res = await fetch(caminho, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.erro || 'Erro inesperado.');
  return json;
}

function $(id) { return document.getElementById(id); }

function corIniciais(nome) {
  return (nome || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function formatarHora(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ---------- autenticação ----------

$('aba-login').onclick = () => trocarAba('login');
$('aba-registrar').onclick = () => trocarAba('registrar');

function trocarAba(qual) {
  $('aba-login').classList.toggle('ativa', qual === 'login');
  $('aba-registrar').classList.toggle('ativa', qual === 'registrar');
  $('form-login').classList.toggle('escondido', qual !== 'login');
  $('form-registrar').classList.toggle('escondido', qual !== 'registrar');
}

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-erro').textContent = '';
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: { telefone: $('login-telefone').value, senha: $('login-senha').value },
    });
    logar(r.token, r.usuario);
  } catch (err) {
    $('login-erro').textContent = err.message;
  }
});

$('form-registrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('reg-erro').textContent = '';
  try {
    const r = await api('/api/registrar', {
      method: 'POST',
      body: { nome: $('reg-nome').value, telefone: $('reg-telefone').value, senha: $('reg-senha').value },
    });
    logar(r.token, r.usuario);
  } catch (err) {
    $('reg-erro').textContent = err.message;
  }
});

function logar(token, usuario) {
  TOKEN = token;
  EU = usuario;
  localStorage.setItem('familychat_token', token);
  entrarNoApp();
}

$('btn-sair').onclick = () => {
  localStorage.removeItem('familychat_token');
  clearInterval(timerConversas);
  clearInterval(timerMensagens);
  location.reload();
};

async function entrarNoApp() {
  $('tela-auth').classList.add('escondido');
  $('tela-app').classList.remove('escondido');
  $('meu-nome').textContent = EU.nome;
  const av = $('meu-avatar');
  av.textContent = corIniciais(EU.nome);
  av.style.background = EU.cor;

  await carregarConversas();
  timerConversas = setInterval(carregarConversas, 4000);
}

// ---------- conversas ----------

async function carregarConversas() {
  try {
    const r = await api('/api/conversas');
    CONVERSAS = r.conversas;
    renderizarListaConversas();
  } catch (err) {
    if (String(err.message).includes('autenticado')) {
      localStorage.removeItem('familychat_token');
      location.reload();
    }
  }
}

function renderizarListaConversas() {
  const box = $('lista-conversas');
  box.innerHTML = '';
  if (CONVERSAS.length === 0) {
    box.innerHTML = '<p style="padding:16px;color:#667781;font-size:14px;">Nenhuma conversa ainda. Clique em "＋ Conversa" para começar.</p>';
    return;
  }
  CONVERSAS.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'item-conversa' + (CONVERSA_ATIVA && CONVERSA_ATIVA.id === c.id ? ' ativo' : '');
    const previa = c.ultima_mensagem
      ? (c.tipo === 'grupo' ? (c.membros.find((m) => m.id === c.ultima_mensagem.autor_id)?.nome.split(' ')[0] + ': ') : '') + c.ultima_mensagem.texto
      : 'Nenhuma mensagem ainda';
    item.innerHTML = `
      <span class="avatar" style="background:${c.cor}">${c.tipo === 'grupo' ? '👪' : corIniciais(c.nome)}</span>
      <div class="info">
        <div class="linha-topo">
          <span class="nome">${escaparHtml(c.nome)}</span>
          <span class="hora">${c.ultima_mensagem ? formatarHora(c.ultima_mensagem.criado_em) : ''}</span>
        </div>
        <div class="previa">${escaparHtml(previa)}</div>
      </div>
      ${c.nao_lidas > 0 ? `<span class="badge-nao-lida">${c.nao_lidas}</span>` : ''}
    `;
    item.onclick = () => abrirConversa(c);
    box.appendChild(item);
  });
}

function escaparHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

async function abrirConversa(conversa) {
  CONVERSA_ATIVA = conversa;
  ULTIMO_TS_MENSAGEM = 0;
  clearInterval(timerMensagens);

  $('chat-vazio').classList.add('escondido');
  $('chat-ativo').classList.remove('escondido');
  const av = $('chat-avatar');
  av.textContent = conversa.tipo === 'grupo' ? '👪' : corIniciais(conversa.nome);
  av.style.background = conversa.cor;
  $('chat-nome').textContent = conversa.nome;
  $('chat-membros').textContent = conversa.tipo === 'grupo' ? conversa.membros.map((m) => m.nome.split(' ')[0]).join(', ') : '';
  $('mensagens').innerHTML = '';

  renderizarListaConversas();
  await carregarMensagens();
  await marcarComoLida();
  timerMensagens = setInterval(async () => { await carregarMensagens(); await marcarComoLida(); }, 2000);
}

async function carregarMensagens() {
  if (!CONVERSA_ATIVA) return;
  const r = await api(`/api/conversas/${CONVERSA_ATIVA.id}/mensagens?desde=${ULTIMO_TS_MENSAGEM}`);
  if (r.mensagens.length === 0) return;
  const box = $('mensagens');
  const estavaNoFim = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  r.mensagens.forEach((msg) => {
    ULTIMO_TS_MENSAGEM = Math.max(ULTIMO_TS_MENSAGEM, msg.criado_em);
    const meu = msg.autor_id === EU.id;
    const bolha = document.createElement('div');
    bolha.className = 'balao ' + (meu ? 'enviado' : 'recebido');
    bolha.innerHTML = `
      ${!meu && CONVERSA_ATIVA.tipo === 'grupo' ? `<div class="autor">${escaparHtml(msg.autor_nome)}</div>` : ''}
      <div class="texto">${escaparHtml(msg.texto)}</div>
      <div class="hora">${formatarHora(msg.criado_em)}</div>
    `;
    box.appendChild(bolha);
  });
  if (estavaNoFim) box.scrollTop = box.scrollHeight;
}

async function marcarComoLida() {
  if (!CONVERSA_ATIVA) return;
  await api(`/api/conversas/${CONVERSA_ATIVA.id}/lida`, { method: 'POST' });
  await carregarConversas();
}

$('form-mensagem').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('input-mensagem');
  const texto = input.value.trim();
  if (!texto || !CONVERSA_ATIVA) return;
  input.value = '';
  try {
    await api(`/api/conversas/${CONVERSA_ATIVA.id}/mensagens`, { method: 'POST', body: { texto } });
    await carregarMensagens();
    const box = $('mensagens');
    box.scrollTop = box.scrollHeight;
    await carregarConversas();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- modal (nova conversa / novo grupo) ----------

$('btn-nova-conversa').onclick = () => abrirModal('conversa');
$('btn-novo-grupo').onclick = () => abrirModal('grupo');
$('modal-fechar').onclick = fecharModal;
$('modal-fundo').onclick = (e) => { if (e.target.id === 'modal-fundo') fecharModal(); };

async function abrirModal(modo) {
  MODO_MODAL = modo;
  SELECIONADOS_MODAL = new Set();
  $('modal-erro').textContent = '';
  $('modal-titulo').textContent = modo === 'grupo' ? 'Novo grupo' : 'Nova conversa';
  $('modal-nome-grupo-wrap').classList.toggle('escondido', modo !== 'grupo');
  $('modal-nome-grupo').value = '';
  $('modal-confirmar').classList.toggle('escondido', modo !== 'grupo');

  const r = await api('/api/usuarios');
  USUARIOS_FAMILIA = r.usuarios;
  renderizarListaModal();
  $('modal-fundo').classList.remove('escondido');
}

function fecharModal() {
  $('modal-fundo').classList.add('escondido');
}

function renderizarListaModal() {
  const box = $('modal-lista-usuarios');
  box.innerHTML = '';
  if (USUARIOS_FAMILIA.length === 0) {
    box.innerHTML = '<p style="color:#667781;font-size:14px;">Ninguém mais da família se cadastrou ainda. Peça pra alguém criar uma conta!</p>';
    return;
  }
  USUARIOS_FAMILIA.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'item-usuario-modal';
    const marcado = SELECIONADOS_MODAL.has(u.id);
    item.innerHTML = `
      ${MODO_MODAL === 'grupo' ? `<input type="checkbox" ${marcado ? 'checked' : ''}>` : ''}
      <span class="avatar" style="background:${u.cor};width:34px;height:34px;font-size:13px;">${corIniciais(u.nome)}</span>
      <span>${escaparHtml(u.nome)}</span>
    `;
    item.classList.toggle('selecionado', marcado);
    item.onclick = () => selecionarUsuarioModal(u);
    box.appendChild(item);
  });
}

async function selecionarUsuarioModal(usuario) {
  if (MODO_MODAL === 'conversa') {
    try {
      const r = await api('/api/conversas', { method: 'POST', body: { tipo: 'individual', membro_id: usuario.id } });
      fecharModal();
      await carregarConversas();
      const conversa = CONVERSAS.find((c) => c.id === r.conversa.id) || r.conversa;
      abrirConversa(conversa);
    } catch (err) {
      $('modal-erro').textContent = err.message;
    }
    return;
  }
  if (SELECIONADOS_MODAL.has(usuario.id)) SELECIONADOS_MODAL.delete(usuario.id);
  else SELECIONADOS_MODAL.add(usuario.id);
  renderizarListaModal();
}

$('modal-confirmar').onclick = async () => {
  const nome = $('modal-nome-grupo').value.trim();
  try {
    const r = await api('/api/conversas', {
      method: 'POST',
      body: { tipo: 'grupo', nome, membros: Array.from(SELECIONADOS_MODAL) },
    });
    fecharModal();
    await carregarConversas();
    const conversa = CONVERSAS.find((c) => c.id === r.conversa.id) || r.conversa;
    abrirConversa(conversa);
  } catch (err) {
    $('modal-erro').textContent = err.message;
  }
};

// ---------- inicialização ----------

(async function init() {
  if (!TOKEN) return;
  try {
    const r = await api('/api/eu');
    EU = r.usuario;
    entrarNoApp();
  } catch {
    localStorage.removeItem('familychat_token');
  }
})();
