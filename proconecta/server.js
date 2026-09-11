// server.js — Pro Conecta, backend real (Fase 1), com Postgres (Neon).
// Rode com: node server.js  (precisa da variável de ambiente DATABASE_URL)
// Abra: http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

carregarEnvLocal(); // lê o arquivo .env se existir, antes de usar process.env

const db = require('./db');
const { gerarToken, verificarToken } = require('./auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- .env local (sem depender do pacote "dotenv") ----------

function carregarEnvLocal() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const linhas = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const linha of linhas) {
    const l = linha.trim();
    if (!l || l.startsWith('#')) continue;
    const igual = l.indexOf('=');
    if (igual === -1) continue;
    const chave = l.slice(0, igual).trim();
    let valor = l.slice(igual + 1).trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    if (!(chave in process.env)) process.env[chave] = valor;
  }
}

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
    req.on('data', (c) => chunks.push(c));
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

function exigirPapel(user, papeis) {
  return user && papeis.includes(user.papel);
}

function usuarioPublico(u) {
  const { salt, hash, ...resto } = u;
  return resto;
}

// ---------- rotas da API ----------

const rotas = [];
function rota(metodo, regex, handler) {
  rotas.push({ metodo, regex, handler });
}

// POST /api/login
rota('POST', /^\/api\/login$/, async (req, res) => {
  const { email, senha } = await lerCorpo(req);
  const u = await db.buscarUsuarioPorEmail(email || '');
  if (!u || !db.conferirSenha(senha || '', u.salt, u.hash)) {
    return enviarJSON(res, 401, { erro: 'E-mail ou senha inválidos.' });
  }
  const token = gerarToken({ id: u.id, papel: u.papel, nome: u.nome, cliente_id: u.cliente_id });
  enviarJSON(res, 200, { token, usuario: usuarioPublico(u) });
});

// GET /api/me
rota('GET', /^\/api\/me$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  enviarJSON(res, 200, { usuario: user });
});

// GET /api/agenda
rota('GET', /^\/api\/agenda$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const agenda = await db.listarAgenda({ papel: user.papel, userId: user.id, clienteId: user.cliente_id });
  enviarJSON(res, 200, { agenda });
});

// POST /api/agenda  (administrador cria atividade)
rota('POST', /^\/api\/agenda$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador pode criar atividades.' });
  const body = await lerCorpo(req);
  const obrig = ['tecnico_id', 'cliente_id', 'equipamento_id', 'data_hora_inicio', 'data_hora_fim', 'tipo'];
  for (const campo of obrig) {
    if (!body[campo]) return enviarJSON(res, 400, { erro: `Campo obrigatório faltando: ${campo}` });
  }
  const item = await db.criarAgenda({
    tecnico_id: Number(body.tecnico_id),
    cliente_id: Number(body.cliente_id),
    equipamento_id: Number(body.equipamento_id),
    data_hora_inicio: body.data_hora_inicio,
    data_hora_fim: body.data_hora_fim,
    tipo: body.tipo,
    categoria: body.categoria || 'inloco',
    problema: body.problema || '',
  });
  enviarJSON(res, 201, { agenda: item });
});

// POST /api/visitas  (técnico registra o diário técnico de uma atividade)
rota('POST', /^\/api\/visitas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico pode registrar uma visita.' });
  const body = await lerCorpo(req);
  const agendaItem = await db.buscarAgendaPorId(Number(body.agenda_id));
  if (!agendaItem) return enviarJSON(res, 404, { erro: 'Atividade de agenda não encontrada.' });
  if (agendaItem.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta atividade não é sua.' });

  const visita = await db.criarVisita({
    agenda_id: agendaItem.id,
    tecnico_id: user.id,
    equipamento_id: agendaItem.equipamento_id,
    analise: body.analise,
    causa: body.causa,
    correcao: body.correcao,
    resultado: body.resultado,
    relevante_biblioteca: body.relevante_biblioteca,
  });
  await db.marcarAgendaConcluida(agendaItem.id);
  enviarJSON(res, 201, { visita });
});

// GET /api/visitas?status=pendente
rota('GET', /^\/api\/visitas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const visitas = await db.listarVisitas({ papel: user.papel, userId: user.id, status: query.status });
  enviarJSON(res, 200, { visitas });
});

// POST /api/visitas/:id/aprovar
rota('POST', /^\/api\/visitas\/(\d+)\/aprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador aprova.' });
  const visitaAntes = await db.buscarVisitaPorId(Number(m[1]));
  if (!visitaAntes) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });

  const visita = await db.aprovarVisita(visitaAntes.id, user.id);
  const agendaDetalhada = await db.buscarAgendaComDetalhes(visita.agenda_id);
  await db.criarBiblioteca({
    visita_id: visita.id,
    equipamento_tipo: agendaDetalhada ? agendaDetalhada.equipamento_tipo : null,
    sintoma: agendaDetalhada ? agendaDetalhada.problema : '',
    causa: visita.causa,
    solucao: visita.correcao,
    resultado: visita.resultado,
  });
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/reprovar
rota('POST', /^\/api\/visitas\/(\d+)\/reprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador reprova.' });
  const body = await lerCorpo(req);
  const visitaAntes = await db.buscarVisitaPorId(Number(m[1]));
  if (!visitaAntes) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  const visita = await db.reprovarVisita(visitaAntes.id, body.comentario);
  enviarJSON(res, 200, { visita });
});

// GET /api/biblioteca?q=...
rota('GET', /^\/api\/biblioteca$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const biblioteca = await db.listarBiblioteca(query.q);
  enviarJSON(res, 200, { biblioteca });
});

// GET /api/equipamentos
rota('GET', /^\/api\/equipamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const equipamentos = await db.listarEquipamentos(user.papel === 'cliente' ? user.cliente_id : null);
  enviarJSON(res, 200, { equipamentos });
});

// POST /api/equipamentos
rota('POST', /^\/api\/equipamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra equipamentos.' });
  const body = await lerCorpo(req);
  const equipamento = await db.criarEquipamento({
    cliente_id: Number(body.cliente_id),
    tipo: body.tipo, modelo: body.modelo, numero_serie: body.numero_serie, localizacao: body.localizacao,
  });
  enviarJSON(res, 201, { equipamento });
});

// GET /api/equipamentos/:id/historico
rota('GET', /^\/api\/equipamentos\/(\d+)\/historico$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const historico = await db.historicoEquipamento(Number(m[1]));
  enviarJSON(res, 200, historico);
});

// GET /api/usuarios
rota('GET', /^\/api\/usuarios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê usuários.' });
  const usuarios = await db.listarUsuarios();
  enviarJSON(res, 200, { usuarios });
});

// POST /api/usuarios  (administrador cadastra técnico/etc)
rota('POST', /^\/api\/usuarios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra usuários.' });
  const body = await lerCorpo(req);
  if (!body.nome || !body.email || !body.papel || !body.senha) {
    return enviarJSON(res, 400, { erro: 'nome, email, papel e senha são obrigatórios.' });
  }
  const existente = await db.buscarUsuarioPorEmail(body.email);
  if (existente) return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });

  const { salt, hash } = db.hashSenha(body.senha);
  const novo = await db.criarUsuario({
    nome: body.nome, email: body.email, papel: body.papel,
    celular: body.celular, cliente_id: body.cliente_id, salt, hash,
  });
  enviarJSON(res, 201, { usuario: novo });
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

async function iniciar() {
  await db.initSchema();
  await db.seedIfEmpty();
  server.listen(PORT, () => {
    console.log(`Pro Conecta rodando em http://localhost:${PORT}`);
    console.log('Login de teste: admin@proconecta.com.br / isaias@proconecta.com.br / cliente@abc.com.br — senha: 123456');
  });
}

iniciar().catch((e) => {
  console.error('Falha ao iniciar o servidor:', e);
  process.exit(1);
});
