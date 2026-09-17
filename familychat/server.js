// server.js — FamilyChat, um mini WhatsApp caseiro pra família conversar. Sem dependências externas.
// Rode com: node server.js
// Abra: http://localhost:3001

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');
const { gerarToken, verificarToken, hashSenha, conferirSenha } = require('./auth');
const { nextId, corParaId } = db;

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- utilidades ----------

function enviarJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    const LIMITE = 2 * 1024 * 1024; // 2MB é de sobra pra texto
    req.on('data', (c) => {
      total += c.length;
      if (total > LIMITE) { reject(new Error('Mensagem excede o limite permitido.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function usuarioAutenticado(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verificarToken(token);
}

function usuarioPublico(u) {
  return { id: u.id, nome: u.nome, telefone: u.telefone, cor: u.cor };
}

function normalizarTelefone(t) {
  return String(t || '').replace(/\D/g, '');
}

// nome exibido de uma conversa do ponto de vista de quem está olhando
function conversaComDetalhes(data, conversa, meuId) {
  const membros = conversa.membros.map((id) => data.usuarios.find((u) => u.id === id)).filter(Boolean);
  let nome = conversa.nome;
  let cor = '#25D366';
  if (conversa.tipo === 'individual') {
    const outro = membros.find((m) => m.id !== meuId);
    nome = outro ? outro.nome : '(usuário removido)';
    cor = outro ? outro.cor : cor;
  }
  const mensagensDaConversa = data.mensagens.filter((m) => m.conversa_id === conversa.id);
  const ultima = mensagensDaConversa[mensagensDaConversa.length - 1] || null;
  const lidoAte = (conversa.lido_ate && conversa.lido_ate[meuId]) || 0;
  const naoLidas = mensagensDaConversa.filter((m) => m.autor_id !== meuId && m.criado_em > lidoAte).length;
  return {
    id: conversa.id,
    tipo: conversa.tipo,
    nome,
    cor,
    membros: membros.map(usuarioPublico),
    ultima_mensagem: ultima ? { texto: ultima.texto, autor_id: ultima.autor_id, criado_em: ultima.criado_em } : null,
    nao_lidas: naoLidas,
  };
}

// ---------- rotas da API ----------

const rotas = [];
function rota(metodo, regex, handler) {
  rotas.push({ metodo, regex, handler });
}

// POST /api/registrar { nome, telefone, senha }
rota('POST', /^\/api\/registrar$/, async (req, res) => {
  const body = await lerCorpo(req);
  const nome = (body.nome || '').trim();
  const telefone = normalizarTelefone(body.telefone);
  const senha = body.senha || '';
  if (!nome || nome.length < 2) return enviarJSON(res, 400, { erro: 'Digite seu nome.' });
  if (!telefone || telefone.length < 8) return enviarJSON(res, 400, { erro: 'Digite um telefone válido (com DDD).' });
  if (!senha || senha.length < 4) return enviarJSON(res, 400, { erro: 'A senha precisa ter pelo menos 4 caracteres.' });

  const data = db.load();
  if (data.usuarios.some((u) => u.telefone === telefone)) {
    return enviarJSON(res, 409, { erro: 'Já existe alguém da família cadastrado com esse telefone.' });
  }
  const id = nextId(data, 'usuarios');
  const { salt, hash } = hashSenha(senha);
  const usuario = { id, nome, telefone, salt, hash, cor: corParaId(id), criado_em: Date.now() };
  data.usuarios.push(usuario);
  db.save(data);

  const token = gerarToken({ id: usuario.id, nome: usuario.nome, telefone: usuario.telefone });
  enviarJSON(res, 200, { token, usuario: usuarioPublico(usuario) });
});

// POST /api/login { telefone, senha }
rota('POST', /^\/api\/login$/, async (req, res) => {
  const body = await lerCorpo(req);
  const telefone = normalizarTelefone(body.telefone);
  const senha = body.senha || '';
  const data = db.load();
  const u = data.usuarios.find((x) => x.telefone === telefone);
  if (!u || !conferirSenha(senha, u.salt, u.hash)) {
    return enviarJSON(res, 401, { erro: 'Telefone ou senha inválidos.' });
  }
  const token = gerarToken({ id: u.id, nome: u.nome, telefone: u.telefone });
  enviarJSON(res, 200, { token, usuario: usuarioPublico(u) });
});

// GET /api/eu
rota('GET', /^\/api\/eu$/, async (req, res) => {
  const sessao = usuarioAutenticado(req);
  if (!sessao) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === sessao.id);
  if (!u) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  enviarJSON(res, 200, { usuario: usuarioPublico(u) });
});

// GET /api/usuarios — lista da família toda, pra começar conversas novas
rota('GET', /^\/api\/usuarios$/, async (req, res) => {
  const sessao = usuarioAutenticado(req);
  if (!sessao) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  enviarJSON(res, 200, { usuarios: data.usuarios.filter((u) => u.id !== sessao.id).map(usuarioPublico) });
});

// GET /api/conversas
rota('GET', /^\/api\/conversas$/, async (req, res) => {
  const sessao = usuarioAutenticado(req);
  if (!sessao) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const minhas = data.conversas
    .filter((c) => c.membros.includes(sessao.id))
    .map((c) => conversaComDetalhes(data, c, sessao.id))
    .sort((a, b) => (b.ultima_mensagem ? b.ultima_mensagem.criado_em : 0) - (a.ultima_mensagem ? a.ultima_mensagem.criado_em : 0));
  enviarJSON(res, 200, { conversas: minhas });
});

// POST /api/conversas { tipo: 'individual'|'grupo', membro_id, membros: [], nome }
rota('POST', /^\/api\/conversas$/, async (req, res) => {
  const sessao = usuarioAutenticado(req);
  if (!sessao) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await lerCorpo(req);
  const data = db.load();

  if (body.tipo === 'grupo') {
    const nome = (body.nome || '').trim();
    const membrosSelecionados = Array.isArray(body.membros) ? body.membros.filter((id) => data.usuarios.some((u) => u.id === id)) : [];
    if (!nome) return enviarJSON(res, 400, { erro: 'Dê um nome para o grupo.' });
    if (membrosSelecionados.length < 2) return enviarJSON(res, 400, { erro: 'Escolha pelo menos 2 outras pessoas para o grupo.' });
    const membros = Array.from(new Set([sessao.id, ...membrosSelecionados]));
    const id = nextId(data, 'conversas');
    const conversa = { id, tipo: 'grupo', nome, membros, lido_ate: {}, criado_por: sessao.id, criado_em: Date.now() };
    data.conversas.push(conversa);
    db.save(data);
    return enviarJSON(res, 200, { conversa: conversaComDetalhes(data, conversa, sessao.id) });
  }

  // individual
  const outroId = Number(body.membro_id);
  const outro = data.usuarios.find((u) => u.id === outroId);
  if (!outro) return enviarJSON(res, 404, { erro: 'Pessoa não encontrada.' });
  if (outroId === sessao.id) return enviarJSON(res, 400, { erro: 'Escolha outra pessoa para conversar.' });

  let conversa = data.conversas.find(
    (c) => c.tipo === 'individual' && c.membros.includes(sessao.id) && c.membros.includes(outroId)
  );
  if (!conversa) {
    const id = nextId(data, 'conversas');
    conversa = { id, tipo: 'individual', nome: null, membros: [sessao.id, outroId], lido_ate: {}, criado_por: sessao.id, criado_em: Date.now() };
    data.conversas.push(conversa);
    db.save(data);
  }
  enviarJSON(res, 200, { conversa: conversaComDetalhes(data, conversa, sessao.id) });
});

// GET /api/conversas/:id/mensagens?desde=timestamp
rota('GET', /^\/api\/conversas\/(\d+)\/mensagens$/, async (req, res, m) => {
  const sessao = usuarioAutenticado(req);
  if (!sessao) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const conversaId = Number(m[1]);
  const data = db.load();
  const conversa = data.conversas.find((c) => c.id === conversaId);
  if (!conversa || !conversa.membros.includes(sessao.id)) return enviarJSON(res, 404, { erro: 'Conversa não encontrada.' });

  const { query } = url.parse(req.url, true);
  const desde = Number(query.desde) || 0;
  const mensagens = data.mensagens
    .filter((msg) => msg.conversa_id === conversaId && msg.criado_em > desde)
    .map((msg) => {
      const autor = data.usuarios.find((u) => u.id === msg.autor_id);
      return { ...msg, autor_nome: autor ? autor.nome : '?' };
    });
  enviarJSON(res, 200, { mensagens });
});

// POST /api/conversas/:id/mensagens { texto }
rota('POST', /^\/api\/conversas\/(\d+)\/mensagens$/, async (req, res, m) => {
  const sessao = usuarioAutenticado(req);
  if (!sessao) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const conversaId = Number(m[1]);
  const body = await lerCorpo(req);
  const texto = (body.texto || '').trim();
  if (!texto) return enviarJSON(res, 400, { erro: 'A mensagem não pode ser vazia.' });
  if (texto.length > 4000) return enviarJSON(res, 400, { erro: 'Mensagem muito longa.' });

  const data = db.load();
  const conversa = data.conversas.find((c) => c.id === conversaId);
  if (!conversa || !conversa.membros.includes(sessao.id)) return enviarJSON(res, 404, { erro: 'Conversa não encontrada.' });

  const id = nextId(data, 'mensagens');
  const mensagem = { id, conversa_id: conversaId, autor_id: sessao.id, texto, criado_em: Date.now() };
  data.mensagens.push(mensagem);
  conversa.lido_ate = conversa.lido_ate || {};
  conversa.lido_ate[sessao.id] = mensagem.criado_em;
  db.save(data);

  const autor = data.usuarios.find((u) => u.id === sessao.id);
  enviarJSON(res, 200, { mensagem: { ...mensagem, autor_nome: autor.nome } });
});

// POST /api/conversas/:id/lida — marca tudo como lido até agora
rota('POST', /^\/api\/conversas\/(\d+)\/lida$/, async (req, res, m) => {
  const sessao = usuarioAutenticado(req);
  if (!sessao) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const conversaId = Number(m[1]);
  const data = db.load();
  const conversa = data.conversas.find((c) => c.id === conversaId);
  if (!conversa || !conversa.membros.includes(sessao.id)) return enviarJSON(res, 404, { erro: 'Conversa não encontrada.' });
  conversa.lido_ate = conversa.lido_ate || {};
  conversa.lido_ate[sessao.id] = Date.now();
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- arquivos estáticos (frontend) ----------

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

function servirEstatico(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Proibido'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- servidor ----------

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);
  const rotaEncontrada = rotas.find((r) => r.metodo === req.method && r.regex.test(pathname));
  if (rotaEncontrada) {
    try {
      const m = pathname.match(rotaEncontrada.regex);
      await rotaEncontrada.handler(req, res, m);
    } catch (e) {
      console.error(e);
      enviarJSON(res, 500, { erro: 'Erro interno.', detalhe: String(e.message || e) });
    }
    return;
  }
  if (pathname.startsWith('/api/')) {
    return enviarJSON(res, 404, { erro: 'Rota não encontrada.' });
  }
  servirEstatico(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`FamilyChat rodando em http://localhost:${PORT}`);
  console.log(`Banco de dados: ${db.DB_PATH}`);
});
