// db.js — "banco de dados". Por padrão, um arquivo JSON local (sem dependências externas).
// Se a variável de ambiente DATABASE_URL estiver definida, usa Postgres (ex.: Supabase) —
// guarda o mesmo objeto inteiro como um único registro JSONB, então nenhuma outra parte do
// sistema precisa mudar (load()/save() continuam funcionando exatamente igual).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data.json');
const usaPostgres = !!process.env.DATABASE_URL;

function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { salt, hash };
}

function conferirSenha(senha, salt, hash) {
  const tentativa = crypto.scryptSync(senha, salt, 64);
  const alvo = Buffer.from(hash, 'hex');
  return tentativa.length === alvo.length && crypto.timingSafeEqual(tentativa, alvo);
}

function gerarTokenConvite() {
  return crypto.randomBytes(24).toString('hex');
}

// banco novo começa vazio — o primeiro acesso vem do bootstrap de admin master
// (ADMIN_EMAIL/ADMIN_SENHA) ou de um convite criado manualmente por quem tiver acesso ao banco.
function seed() {
  return {
    usuarios: [],
    clientes: [],
    equipamentos: [],
    agenda: [],
    visitas: [],
    registros: [],
    chamados: [],
    relatorios_manutencao: [],
    push_subscriptions: [],
    vapid: null,
    _seq: { usuarios: 1, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, registros: 1, chamados: 1, relatorios_manutencao: 1 },
  };
}

// se as variáveis de ambiente ADMIN_EMAIL/ADMIN_SENHA estiverem definidas e ainda não existir
// usuário com esse e-mail, cria um administrador ativo — assim a senha nunca precisa ficar
// escrita em código/commit, só no painel de variáveis de ambiente do hospedeiro (Render etc.).
// Roda a cada carregamento (idempotente: só cria uma vez). Devolve true se criou alguém.
function bootstrapAdminMaster(data) {
  const email = process.env.ADMIN_EMAIL;
  const senha = process.env.ADMIN_SENHA;
  if (!email || !senha) return false;
  if (data.usuarios.some((u) => u.email === email)) return false;
  const { salt, hash } = hashSenha(senha);
  data.usuarios.push({
    id: nextId(data, 'usuarios'),
    nome: 'Desenvolvedor', email, papel: 'administrador',
    cargo: '', setor: '', celular: '', cliente_id: null,
    status: 'ativo', convite_token: null, salt, hash,
    protegido: true,
  });
  console.log(`[db] Conta master criada automaticamente: ${email}`);
  return true;
}

// garante que a conta master (e-mail em ADMIN_EMAIL) fique sempre marcada como protegida —
// cobre também quem já existia antes dessa flag existir, ou foi criado numa corrida em que
// bootstrapAdminMaster ainda não tinha essa marca. Roda a cada carregamento (idempotente).
function protegerAdminMaster(data) {
  const email = process.env.ADMIN_EMAIL;
  if (!email) return;
  const master = data.usuarios.find((u) => u.email === email);
  if (!master) return;
  if (master.nome === 'Administrador') master.nome = 'Desenvolvedor';
  master.protegido = true;
}

// migração leve: bancos criados antes destes campos existirem ganham valores padrão.
// Roda uma vez ao carregar (seja do arquivo ou do Postgres) — mutila e devolve o mesmo objeto.
function migrar(data) {
  if (!data.registros) data.registros = [];
  if (!data.push_subscriptions) data.push_subscriptions = [];
  // gera o par de chaves VAPID (push notification) uma única vez e guarda no próprio banco,
  // assim não depende de configurar variável de ambiente manualmente no hospedeiro
  if (!data.vapid) {
    const { publicKey, privateKey } = require('web-push').generateVAPIDKeys();
    data.vapid = { publicKey, privateKey };
  }
  if (!data.chamados) data.chamados = [];
  if (!data.relatorios_manutencao) data.relatorios_manutencao = [];
  // "chamados" virou o atendimento por chat (IA -> técnico), unificando o que antes era
  // conversas_whatsapp (histórico solto por telefone) com o antigo chamado (só criado quando a
  // IA escalava). Bancos antigos que ainda tenham chamados no formato de antes do chat ganham os
  // campos novos com valor neutro, pra não quebrar a leitura.
  for (const c of data.chamados) {
    if (!Array.isArray(c.mensagens)) c.mensagens = [];
    if (c.status === undefined) c.status = 'aguardando_tecnico';
    if (c.telefone_whatsapp === undefined) c.telefone_whatsapp = null;
    if (c.origem === undefined) c.origem = 'app';
    if (c.tecnico_id === undefined) c.tecnico_id = null;
    if (c.os_id === undefined) c.os_id = null;
    if (c.prioridade === undefined) c.prioridade = 'normal';
    if (c.resolvido_por === undefined) c.resolvido_por = null;
    if (c.resolvido_em === undefined) c.resolvido_em = null;
    if (c.assumido_em === undefined) c.assumido_em = null;
    if (c.lida_tecnico === undefined) c.lida_tecnico = true;
    if (c.lida_cliente === undefined) c.lida_cliente = true;
  }
  if (!data._seq.registros) data._seq.registros = 1;
  if (!data._seq.chamados) data._seq.chamados = 1;
  if (!data._seq.relatorios_manutencao) data._seq.relatorios_manutencao = 1;
  for (const u of data.usuarios) {
    if (!u.status) u.status = 'ativo';
    if (u.convite_token === undefined) u.convite_token = null;
    if (u.cargo === undefined) u.cargo = '';
    if (u.setor === undefined) u.setor = '';
  }
  for (const c of data.clientes) {
    for (const campo of ['setor', 'endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado', 'email']) {
      if (c[campo] === undefined) c[campo] = '';
    }
  }
  for (const a of data.agenda) {
    if (a.email === undefined) a.email = '';
    if (a.criado_em === undefined) a.criado_em = a.data_hora_inicio || new Date().toISOString();
    for (const campo of ['garantia', 'garantia_obs']) {
      if (a[campo] === undefined) a[campo] = '';
    }
    if (a.lida_tecnico === undefined) a.lida_tecnico = false;
    if (a.deslocamento_iniciado_em === undefined) a.deslocamento_iniciado_em = null;
    if (a.lembrete_deslocamento_enviado === undefined) a.lembrete_deslocamento_enviado = false;
    if (a.confirmado_cliente_em === undefined) {
      // O.S. que já tinham avançado (deslocamento, relatório ou já finalizadas) antes desse
      // controle existir claramente já passaram do aceite do cliente na prática — não faz
      // sentido bloquear elas retroativamente; só as que ainda nem começaram esperam a
      // confirmação a partir de agora.
      const jaAvancou = a.finalizada || a.deslocamento_iniciado_em || data.visitas.some((v) => v.agenda_id === a.id);
      a.confirmado_cliente_em = jaAvancou ? (a.criado_em || new Date().toISOString()) : null;
    }
    if (a.feedback_cliente_em === undefined) {
      // mesma lógica: O.S. que já estavam aprovadas (ou finalizadas) antes desse controle
      // existir já passaram desse ponto na prática — só as aprovações novas, a partir de
      // agora, exigem o registro explícito do feedback antes de finalizar.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const jaAprovado = a.finalizada || (visitaDoItem && visitaDoItem.status_aprovacao === 'aprovado');
      a.feedback_cliente_em = jaAprovado ? (a.finalizado_em || (visitaDoItem && visitaDoItem.data_aprovacao) || new Date().toISOString()) : null;
    }
    if (a.retrabalho === undefined) a.retrabalho = false;
    if (a.retorno_pendente_tecnico === undefined) a.retorno_pendente_tecnico = false;
    if (a.retorno_deslocamento_iniciado_em === undefined) a.retorno_deslocamento_iniciado_em = null;
    if (a.orcamento_aprovado_em === undefined) {
      // se o relatório já aprovado tinha peças fornecidas, mas esse controle de orçamento
      // ainda não existia, considera que o orçamento já foi tratado por fora do sistema —
      // não bloqueia O.S. antigas que já passaram desse ponto na prática.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const temPecas = visitaDoItem && visitaDoItem.laudo && Array.isArray(visitaDoItem.laudo.pecas) && visitaDoItem.laudo.pecas.length > 0;
      const jaAprovado = a.finalizada || (visitaDoItem && visitaDoItem.status_aprovacao === 'aprovado');
      a.orcamento_aprovado_em = (temPecas && jaAprovado) ? (a.feedback_cliente_em || a.criado_em || new Date().toISOString()) : null;
    }
  }
  for (const e of data.equipamentos) {
    if (e.cliente_id === undefined) e.cliente_id = null;
    if (e.data_fabricacao === undefined) e.data_fabricacao = '';
  }
  for (const v of data.visitas) {
    if (v.lida_tecnico === undefined) v.lida_tecnico = false;
    if (v.rodada === undefined) v.rodada = 1;
  }
  // relatórios de manutenção criados antes do e-mail do técnico ser buscado corretamente
  // ficaram com esse campo em branco — preenche retroativamente a partir do cadastro atual
  for (const r of data.relatorios_manutencao) {
    if (!r.tecnico_email) {
      const autor = data.usuarios.find((u) => u.id === r.autor_id);
      if (autor && autor.email) r.tecnico_email = autor.email;
    }
  }
  protegerAdminMaster(data);
  return data;
}

// ---------- modo arquivo (padrão, sem DATABASE_URL) ----------

function carregarDoArquivo() {
  if (!fs.existsSync(DB_PATH)) {
    const data = seed();
    bootstrapAdminMaster(data);
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return data;
  }
  const data = migrar(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  if (bootstrapAdminMaster(data)) salvarNoArquivo(data);
  return data;
}

function salvarNoArquivo(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------- modo Postgres (opcional, via DATABASE_URL) ----------
// Guarda tudo como um único registro JSONB — mantém load()/save() síncronos com um cache em
// memória (populado uma vez no boot), pra não precisar tornar todo o server.js assíncrono.

let pool = null;
function obterPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  }
  return pool;
}

let cache = null;

async function inicializarPostgres() {
  const p = obterPool();
  await p.query('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL)');
  const r = await p.query('SELECT data FROM app_state WHERE id = 1');
  if (r.rows.length === 0) {
    const data = seed();
    bootstrapAdminMaster(data);
    await p.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [JSON.stringify(data)]);
    cache = data;
  } else {
    const data = migrar(r.rows[0].data);
    if (bootstrapAdminMaster(data)) {
      await p.query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(data)]);
    }
    cache = data;
  }
  console.log('Conectado ao Postgres — os dados persistem entre reinícios.');
}

// server.js aguarda essa promise antes de abrir a porta. No modo arquivo, resolve na hora.
// Se a conexão com o Postgres falhar, cai pro arquivo local em vez de derrubar o servidor.
const pronto = usaPostgres
  ? inicializarPostgres().catch((e) => {
      console.error('Falha ao conectar no Postgres — usando o arquivo local como reserva:', e.message);
      cache = null;
    })
  : Promise.resolve();

function load() {
  if (usaPostgres && cache) return cache;
  return carregarDoArquivo();
}

function save(data) {
  if (usaPostgres && cache) {
    cache = data;
    obterPool()
      .query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(data)])
      .catch((e) => console.error('Erro ao salvar no Postgres:', e.message));
    return;
  }
  salvarNoArquivo(data);
}

function nextId(data, tabela) {
  const id = data._seq[tabela]++;
  return id;
}

function estaUsandoPostgres() {
  return usaPostgres && !!cache;
}

module.exports = { load, save, nextId, hashSenha, conferirSenha, gerarTokenConvite, DB_PATH, pronto, estaUsandoPostgres };
