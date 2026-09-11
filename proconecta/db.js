// db.js — acesso ao banco de dados Postgres (Neon).
// Único pacote externo do projeto: "pg". O Render/seu computador precisa
// rodar "npm install" uma vez para baixá-lo (precisa de internet nessa hora).

const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('ERRO: variável de ambiente DATABASE_URL não definida.');
  console.error('Veja o README.md — seção "Banco de dados (Neon)" para como configurar.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon exige conexão SSL
});

// ---------- senha ----------

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

// ---------- schema + seed (roda sozinho ao iniciar o servidor) ----------

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      papel TEXT NOT NULL,
      celular TEXT,
      cliente_id INTEGER,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome_empresa TEXT NOT NULL,
      contato TEXT,
      telefone TEXT,
      nivel_acesso TEXT DEFAULT 'basico'
    );
    CREATE TABLE IF NOT EXISTS equipamentos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id),
      tipo TEXT NOT NULL,
      modelo TEXT,
      numero_serie TEXT,
      localizacao TEXT
    );
    CREATE TABLE IF NOT EXISTS agenda (
      id SERIAL PRIMARY KEY,
      tecnico_id INTEGER REFERENCES usuarios(id),
      cliente_id INTEGER REFERENCES clientes(id),
      equipamento_id INTEGER REFERENCES equipamentos(id),
      data_hora_inicio TIMESTAMP NOT NULL,
      data_hora_fim TIMESTAMP,
      tipo TEXT NOT NULL,
      categoria TEXT DEFAULT 'inloco',
      problema TEXT,
      status TEXT DEFAULT 'pendente',
      valor_servico NUMERIC,
      retrabalho BOOLEAN DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS visitas (
      id SERIAL PRIMARY KEY,
      agenda_id INTEGER REFERENCES agenda(id),
      tecnico_id INTEGER REFERENCES usuarios(id),
      equipamento_id INTEGER REFERENCES equipamentos(id),
      analise TEXT,
      causa TEXT,
      correcao TEXT,
      resultado TEXT,
      relevante_biblioteca BOOLEAN DEFAULT false,
      status_aprovacao TEXT DEFAULT 'pendente',
      aprovado_por INTEGER REFERENCES usuarios(id),
      data_aprovacao TIMESTAMP,
      comentario_reprovacao TEXT,
      criado_em TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS biblioteca (
      id SERIAL PRIMARY KEY,
      visita_id INTEGER REFERENCES visitas(id),
      equipamento_tipo TEXT,
      sintoma TEXT,
      causa TEXT,
      solucao TEXT,
      resultado TEXT
    );
  `);
}

async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) return; // já tem dados, não mexe

  console.log('Banco vazio — inserindo dados de teste...');
  const senha = hashSenha('123456');

  const cliente = (await pool.query(
    `INSERT INTO clientes (nome_empresa, contato, telefone, nivel_acesso) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['Cliente ABC Ltda', 'Marcos (manutenção)', '(12) 3921-0000', 'completo']
  )).rows[0];

  const admin = (await pool.query(
    `INSERT INTO usuarios (nome, email, papel, celular, cliente_id, salt, hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    ['Marcos Andrade', 'admin@proconecta.com.br', 'administrador', '(12) 99999-0001', null, senha.salt, senha.hash]
  )).rows[0];
  const tecnico = (await pool.query(
    `INSERT INTO usuarios (nome, email, papel, celular, cliente_id, salt, hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    ['Isaías Lobo', 'isaias@proconecta.com.br', 'tecnico', '(12) 99999-0002', null, senha.salt, senha.hash]
  )).rows[0];
  await pool.query(
    `INSERT INTO usuarios (nome, email, papel, celular, cliente_id, salt, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['Cliente ABC', 'cliente@abc.com.br', 'cliente', '(12) 99999-0004', cliente.id, senha.salt, senha.hash]
  );

  const eq1 = (await pool.query(
    `INSERT INTO equipamentos (cliente_id, tipo, modelo, numero_serie, localizacao) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [cliente.id, 'Máquina de Gelo', 'Promarking MP5-80P', '2301013587', 'Cozinha']
  )).rows[0];
  await pool.query(
    `INSERT INTO equipamentos (cliente_id, tipo, modelo, numero_serie, localizacao) VALUES ($1,$2,$3,$4,$5)`,
    [cliente.id, 'Torre de Bebidas', 'TB-200', 'TB200-887', 'Salão']
  );

  await pool.query(
    `INSERT INTO agenda (tecnico_id, cliente_id, equipamento_id, data_hora_inicio, data_hora_fim, tipo, categoria, problema, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendente')`,
    [tecnico.id, cliente.id, eq1.id, '2026-09-12T08:00:00', '2026-09-12T11:00:00', 'corretiva', 'inloco', 'Perda de referência do eixo Y']
  );

  console.log('Pronto: admin@proconecta.com.br / isaias@proconecta.com.br / cliente@abc.com.br — senha 123456');
}

// ---------- usuários ----------

async function buscarUsuarioPorEmail(email) {
  const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  return rows[0];
}

async function listarUsuarios() {
  const { rows } = await pool.query('SELECT id, nome, email, papel, celular, cliente_id FROM usuarios ORDER BY id');
  return rows;
}

async function criarUsuario(u) {
  const { rows } = await pool.query(
    `INSERT INTO usuarios (nome, email, papel, celular, cliente_id, salt, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, nome, email, papel, celular, cliente_id`,
    [u.nome, u.email, u.papel, u.celular || '', u.cliente_id || null, u.salt, u.hash]
  );
  return rows[0];
}

// ---------- agenda ----------

async function listarAgenda({ papel, userId, clienteId }) {
  let sql = `
    SELECT a.*, u.nome AS tecnico_nome, c.nome_empresa AS cliente_nome,
           e.tipo AS equipamento_tipo, e.modelo AS equipamento_modelo, e.numero_serie AS equipamento_serie
    FROM agenda a
    LEFT JOIN usuarios u ON u.id = a.tecnico_id
    LEFT JOIN clientes c ON c.id = a.cliente_id
    LEFT JOIN equipamentos e ON e.id = a.equipamento_id`;
  const params = [];
  if (papel === 'tecnico') { params.push(userId); sql += ` WHERE a.tecnico_id = $${params.length}`; }
  else if (papel === 'cliente') { params.push(clienteId); sql += ` WHERE a.cliente_id = $${params.length}`; }
  sql += ' ORDER BY a.data_hora_inicio';
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function buscarAgendaPorId(id) {
  const { rows } = await pool.query('SELECT * FROM agenda WHERE id = $1', [id]);
  return rows[0];
}

async function criarAgenda(item) {
  const { rows } = await pool.query(
    `INSERT INTO agenda (tecnico_id, cliente_id, equipamento_id, data_hora_inicio, data_hora_fim, tipo, categoria, problema, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendente') RETURNING id`,
    [item.tecnico_id, item.cliente_id, item.equipamento_id, item.data_hora_inicio, item.data_hora_fim, item.tipo, item.categoria || 'inloco', item.problema || '']
  );
  return buscarAgendaComDetalhes(rows[0].id);
}

async function buscarAgendaComDetalhes(id) {
  const { rows } = await pool.query(`
    SELECT a.*, u.nome AS tecnico_nome, c.nome_empresa AS cliente_nome,
           e.tipo AS equipamento_tipo, e.modelo AS equipamento_modelo, e.numero_serie AS equipamento_serie
    FROM agenda a
    LEFT JOIN usuarios u ON u.id = a.tecnico_id
    LEFT JOIN clientes c ON c.id = a.cliente_id
    LEFT JOIN equipamentos e ON e.id = a.equipamento_id
    WHERE a.id = $1`, [id]);
  return rows[0];
}

async function marcarAgendaConcluida(id) {
  await pool.query(`UPDATE agenda SET status = 'concluida' WHERE id = $1`, [id]);
}

// ---------- visitas (diário técnico) ----------

async function criarVisita(v) {
  const { rows } = await pool.query(
    `INSERT INTO visitas (agenda_id, tecnico_id, equipamento_id, analise, causa, correcao, resultado, relevante_biblioteca, status_aprovacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendente') RETURNING *`,
    [v.agenda_id, v.tecnico_id, v.equipamento_id, v.analise || '', v.causa || '', v.correcao || '', v.resultado || 'solucionado', !!v.relevante_biblioteca]
  );
  return rows[0];
}

async function listarVisitas({ papel, userId, status }) {
  let sql = `
    SELECT v.*, e.tipo AS equipamento_tipo, u.nome AS tecnico_nome
    FROM visitas v
    LEFT JOIN equipamentos e ON e.id = v.equipamento_id
    LEFT JOIN usuarios u ON u.id = v.tecnico_id`;
  const clauses = [];
  const params = [];
  if (papel === 'tecnico') { params.push(userId); clauses.push(`v.tecnico_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`v.status_aprovacao = $${params.length}`); }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY v.criado_em DESC';
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function buscarVisitaPorId(id) {
  const { rows } = await pool.query('SELECT * FROM visitas WHERE id = $1', [id]);
  return rows[0];
}

async function aprovarVisita(id, aprovadoPor) {
  const { rows } = await pool.query(
    `UPDATE visitas SET status_aprovacao = 'aprovado', aprovado_por = $2, data_aprovacao = now() WHERE id = $1 RETURNING *`,
    [id, aprovadoPor]
  );
  return rows[0];
}

async function reprovarVisita(id, comentario) {
  const { rows } = await pool.query(
    `UPDATE visitas SET status_aprovacao = 'reprovado', comentario_reprovacao = $2 WHERE id = $1 RETURNING *`,
    [id, comentario || '']
  );
  return rows[0];
}

// ---------- biblioteca ----------

async function criarBiblioteca(item) {
  const { rows } = await pool.query(
    `INSERT INTO biblioteca (visita_id, equipamento_tipo, sintoma, causa, solucao, resultado)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [item.visita_id, item.equipamento_tipo, item.sintoma, item.causa, item.solucao, item.resultado]
  );
  return rows[0];
}

async function listarBiblioteca(q) {
  if (q) {
    const { rows } = await pool.query(
      `SELECT * FROM biblioteca
       WHERE lower(coalesce(equipamento_tipo,'') || ' ' || coalesce(sintoma,'') || ' ' || coalesce(causa,'') || ' ' || coalesce(solucao,'')) LIKE $1
       ORDER BY id DESC`,
      [`%${q.toLowerCase()}%`]
    );
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM biblioteca ORDER BY id DESC');
  return rows;
}

// ---------- equipamentos ----------

async function listarEquipamentos(clienteId) {
  if (clienteId) {
    const { rows } = await pool.query('SELECT * FROM equipamentos WHERE cliente_id = $1 ORDER BY id', [clienteId]);
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM equipamentos ORDER BY id');
  return rows;
}

async function criarEquipamento(e) {
  const { rows } = await pool.query(
    `INSERT INTO equipamentos (cliente_id, tipo, modelo, numero_serie, localizacao) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [e.cliente_id, e.tipo, e.modelo, e.numero_serie, e.localizacao || '']
  );
  return rows[0];
}

async function historicoEquipamento(id) {
  const agenda = await pool.query(`
    SELECT a.*, u.nome AS tecnico_nome, c.nome_empresa AS cliente_nome
    FROM agenda a
    LEFT JOIN usuarios u ON u.id = a.tecnico_id
    LEFT JOIN clientes c ON c.id = a.cliente_id
    WHERE a.equipamento_id = $1
    ORDER BY a.data_hora_inicio DESC`, [id]);
  const visitas = await pool.query('SELECT * FROM visitas WHERE equipamento_id = $1 ORDER BY criado_em DESC', [id]);
  return { agenda: agenda.rows, visitas: visitas.rows };
}

module.exports = {
  pool, initSchema, seedIfEmpty, hashSenha, conferirSenha,
  buscarUsuarioPorEmail, listarUsuarios, criarUsuario,
  listarAgenda, buscarAgendaPorId, buscarAgendaComDetalhes, criarAgenda, marcarAgendaConcluida,
  criarVisita, listarVisitas, buscarVisitaPorId, aprovarVisita, reprovarVisita,
  criarBiblioteca, listarBiblioteca,
  listarEquipamentos, criarEquipamento, historicoEquipamento,
};
