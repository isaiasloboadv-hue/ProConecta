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

function seed() {
  const senhaPadrao = hashSenha('123456');
  return {
    usuarios: [
      { id: 1, nome: 'Marcos Andrade', email: 'admin@proconecta.com.br', papel: 'administrador', cargo: 'Gerente de Operações', setor: 'Administração', celular: '(12) 99999-0001', cliente_id: null, status: 'ativo', convite_token: null, ...senhaPadrao },
      { id: 2, nome: 'Isaías Lobo', email: 'isaias@proconecta.com.br', papel: 'tecnico', cargo: 'Técnico de Campo', setor: 'Manutenção', celular: '(12) 99999-0002', cliente_id: null, status: 'ativo', convite_token: null, ...senhaPadrao },
      { id: 3, nome: 'Renata Alves', email: 'renata@proconecta.com.br', papel: 'tecnico', cargo: 'Técnica de Campo', setor: 'Manutenção', celular: '(12) 99999-0003', cliente_id: null, status: 'ativo', convite_token: null, ...senhaPadrao },
      { id: 4, nome: 'Cliente ABC', email: 'cliente@abc.com.br', papel: 'cliente', cargo: 'Responsável pela manutenção', setor: 'Facilities', celular: '(12) 99999-0004', cliente_id: 1, status: 'ativo', convite_token: null, ...senhaPadrao },
    ],
    clientes: [
      {
        id: 1, nome_empresa: 'Cliente ABC Ltda', contato: 'Marcos (manutenção)', telefone: '(12) 3921-0000', email: 'marcos@clienteabc.com.br', nivel_acesso: 'completo',
        setor: 'Produção', endereco: 'Av. das Indústrias', numero: '850', bairro: 'Distrito Industrial',
        cep: '12345-000', cidade: 'Jacareí', estado: 'SP',
      },
    ],
    // equipamentos com cliente_id null são o "catálogo" (tipo/modelo genérico, sem cliente ainda);
    // com cliente_id preenchido são a unidade física de fato instalada num cliente (nº de série próprio)
    equipamentos: [
      { id: 1, cliente_id: 1, tipo: 'Máquina de Gelo', modelo: 'Promarking MP5-80P', numero_serie: '2301013587', data_fabricacao: '11/2022', localizacao: 'Cozinha' },
      { id: 2, cliente_id: 1, tipo: 'Torre de Bebidas', modelo: 'TB-200', numero_serie: 'TB200-887', data_fabricacao: '02/2023', localizacao: 'Salão' },
      { id: 3, cliente_id: null, tipo: 'Máquina de Marcação a Laser', modelo: 'PM-Laser 3000', numero_serie: '', data_fabricacao: '', localizacao: '' },
    ],
    agenda: [
      {
        id: 1, tecnico_id: 2, cliente_id: 1, equipamento_id: 1,
        data_hora_inicio: '2026-09-12T08:00:00', data_hora_fim: '2026-09-12T11:00:00',
        tipo: 'corretiva', categoria: 'inloco', problema: 'Perda de referência do eixo Y',
        contato: 'Marcos (manutenção)', telefone: '(12) 3921-0000', email: 'marcos@clienteabc.com.br', setor_cliente: 'Produção',
        endereco: 'Av. das Indústrias', numero: '850', bairro: 'Distrito Industrial', cep: '12345-000', cidade: 'Jacareí', estado: 'SP',
        garantia: 'nao', garantia_obs: '',
        status: 'pendente', valor_servico: null, retrabalho: false, criado_em: '2026-09-05T09:00:00.000Z',
        lida_tecnico: false,
      },
    ],
    visitas: [],
    // biblioteca técnica: registros de Defeitos/Falhas e Manual de Procedimentos,
    // com fluxo de aprovação (em_analise -> aprovado | alteracao_sugerida -> em_analise ...)
    registros: [],
    chamados: [],
    // mensagens internas (equipe: administrador/técnico — cliente não participa)
    conversas: [],
    mensagens: [],
    _seq: { usuarios: 5, clientes: 2, equipamentos: 4, agenda: 2, visitas: 1, registros: 1, chamados: 1, conversas: 1, mensagens: 1 },
  };
}

// migração leve: bancos criados antes destes campos existirem ganham valores padrão.
// Roda uma vez ao carregar (seja do arquivo ou do Postgres) — mutila e devolve o mesmo objeto.
function migrar(data) {
  if (!data.registros) data.registros = [];
  if (!data.chamados) data.chamados = [];
  if (!data.conversas) data.conversas = [];
  if (!data.mensagens) data.mensagens = [];
  if (!data._seq.registros) data._seq.registros = 1;
  if (!data._seq.chamados) data._seq.chamados = 1;
  if (!data._seq.conversas) data._seq.conversas = 1;
  if (!data._seq.mensagens) data._seq.mensagens = 1;
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
  }
  for (const e of data.equipamentos) {
    if (e.cliente_id === undefined) e.cliente_id = null;
    if (e.data_fabricacao === undefined) e.data_fabricacao = '';
  }
  for (const v of data.visitas) {
    if (v.lida_tecnico === undefined) v.lida_tecnico = false;
  }
  return data;
}

// ---------- modo arquivo (padrão, sem DATABASE_URL) ----------

function carregarDoArquivo() {
  if (!fs.existsSync(DB_PATH)) {
    const data = seed();
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return data;
  }
  return migrar(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
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
    await p.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [JSON.stringify(data)]);
    cache = data;
  } else {
    cache = migrar(r.rows[0].data);
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
