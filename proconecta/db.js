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
    chamados_rr_index: 0,
    relatorios_manutencao: [],
    push_subscriptions: [],
    vapid: null,
    empresas: [],
    _seq: { usuarios: 1, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, registros: 1, chamados: 1, relatorios_manutencao: 1 },
  };
}

// dados da empresa "dona" da instalação — hoje só existe a de id 1, mas já mora numa lista própria
// (com empresa_id nos demais registros) pra um dia dar pra ter mais de uma empresa usando o mesmo
// sistema sem redesenhar o banco. Configurável por variável de ambiente: uma instalação nova (outra
// empresa comprando o sistema) só precisa trocar as variáveis no hospedeiro, sem mexer em código.
// Roda a cada carregamento, então mudar a variável de ambiente reflete sem precisar apagar o banco.
function sincronizarEmpresaPadrao(data) {
  if (!data.empresas) data.empresas = [];
  let empresa = data.empresas.find((e) => e.id === 1);
  if (!empresa) {
    empresa = {
      id: 1,
      nome: 'PRO Marking',
      site: 'promarking.com.br',
      whatsapp: '12 99718-7506',
      telefone: '12 3902-3453',
      emails: ['suporte@promarking.com.br', 'atendimento@promarking.com.br', 'tecnico@promarking.com.br', 'posvenda@promarking.com.br'],
      cor_primaria: '#0A2647',
      cor_secundaria: '#0E7C86',
    };
    data.empresas.push(empresa);
  }
  if (process.env.EMPRESA_NOME) empresa.nome = process.env.EMPRESA_NOME;
  if (process.env.EMPRESA_SITE) empresa.site = process.env.EMPRESA_SITE;
  if (process.env.EMPRESA_WHATSAPP) empresa.whatsapp = process.env.EMPRESA_WHATSAPP;
  if (process.env.EMPRESA_TELEFONE) empresa.telefone = process.env.EMPRESA_TELEFONE;
  if (process.env.EMPRESA_EMAILS) empresa.emails = process.env.EMPRESA_EMAILS.split(',').map((e) => e.trim()).filter(Boolean);
  if (process.env.EMPRESA_COR_PRIMARIA) empresa.cor_primaria = process.env.EMPRESA_COR_PRIMARIA;
  if (process.env.EMPRESA_COR_SECUNDARIA) empresa.cor_secundaria = process.env.EMPRESA_COR_SECUNDARIA;
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
  if (data.chamados_rr_index === undefined) data.chamados_rr_index = 0;
  if (!data.relatorios_manutencao) data.relatorios_manutencao = [];
  sincronizarEmpresaPadrao(data);
  // bancos anteriores ao empresa_id (preparação pra multi-tenant) ganham empresa_id 1 — hoje só
  // existe essa empresa mesmo, então todo registro já criado pertence a ela.
  for (const lista of [data.usuarios, data.clientes, data.equipamentos, data.agenda, data.visitas, data.registros, data.chamados, data.relatorios_manutencao]) {
    for (const item of lista) {
      if (item.empresa_id === undefined) item.empresa_id = 1;
    }
  }
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
    // presença do técnico pra fila de atendimento (round-robin) — online_desde marca quando
    // ele ficou online pela última vez, e decide a ordem da fila entre quem está online agora
    if (u.online === undefined) u.online = false;
    if (u.online_desde === undefined) u.online_desde = null;
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
    // fluxo de pós-venda/reparo (só usado em O.S. tipo "atendimento", nascidas de um chamado do
    // chat) — ver server.js, seção "pós-venda / setor reparo"
    if (a.fase_atendimento === undefined) a.fase_atendimento = null;
    if (a.motivo_pos_venda === undefined) a.motivo_pos_venda = null;
    if (a.encaminhado_pos_venda_em === undefined) a.encaminhado_pos_venda_em = null;
    if (a.equipamento_recebido_em === undefined) a.equipamento_recebido_em = null;
    if (a.pos_venda_orcamento_enviado_em === undefined) a.pos_venda_orcamento_enviado_em = null;
    if (a.pos_venda_decisao === undefined) a.pos_venda_decisao = null;
    if (a.pos_venda_decisao_em === undefined) a.pos_venda_decisao_em = null;
    if (a.tecnico_chat_id === undefined) a.tecnico_chat_id = null;
    // estoque (chegada/saída) e handoff pra O.S. de visita técnica — ver server.js
    if (a.estoque_recebido_em === undefined) a.estoque_recebido_em = null;
    if (a.equipamento_liberado_reparo_em === undefined) a.equipamento_liberado_reparo_em = null;
    if (a.estoque_saida_em === undefined) a.estoque_saida_em = null;
    if (a.os_criada_id === undefined) a.os_criada_id = null;
    // O.S. de atendimento criadas antes desse fluxo existir (fase_atendimento nunca foi
    // preenchida) entram agora em "em_atendimento" — do jeito que já estavam, só passam a
    // seguir a linha do tempo nova a partir daqui em vez da antiga (deslocamento/orçamento)
    if (a.tipo === 'atendimento' && !a.finalizada && !a.fase_atendimento) {
      a.fase_atendimento = 'em_atendimento';
      if (!a.tecnico_chat_id) a.tecnico_chat_id = a.tecnico_id;
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
    sincronizarEmpresaPadrao(data);
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
  await p.query('CREATE TABLE IF NOT EXISTS fotos (id TEXT PRIMARY KEY, dados TEXT NOT NULL, criado_em TIMESTAMPTZ DEFAULT now())');
  const r = await p.query('SELECT data FROM app_state WHERE id = 1');
  if (r.rows.length === 0) {
    const data = seed();
    bootstrapAdminMaster(data);
    sincronizarEmpresaPadrao(data);
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

// ---------- fotos (guardadas à parte do bloco principal — antes ficavam dentro do mesmo JSON
// que fica sempre carregado na memória, e isso foi o que estourou o limite de RAM do plano
// gratuito do Render conforme foram se acumulando; agora só uma referência pequena fica no bloco
// principal, e a foto de verdade só é buscada quando alguém realmente precisa dela) ----------

const FOTOS_DIR = path.join(__dirname, 'fotos');

async function salvarFoto(dadosBase64) {
  const id = crypto.randomBytes(12).toString('hex');
  if (estaUsandoPostgres()) {
    await obterPool().query('INSERT INTO fotos (id, dados) VALUES ($1, $2)', [id, dadosBase64]);
  } else {
    if (!fs.existsSync(FOTOS_DIR)) fs.mkdirSync(FOTOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(FOTOS_DIR, id), dadosBase64);
  }
  return id;
}

async function carregarFoto(id) {
  if (!id) return null;
  if (estaUsandoPostgres()) {
    const r = await obterPool().query('SELECT dados FROM fotos WHERE id = $1', [id]);
    return r.rows.length ? r.rows[0].dados : null;
  }
  const caminho = path.join(FOTOS_DIR, String(id));
  return fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf8') : null;
}

module.exports = { load, save, nextId, hashSenha, conferirSenha, gerarTokenConvite, DB_PATH, pronto, estaUsandoPostgres, salvarFoto, carregarFoto };
