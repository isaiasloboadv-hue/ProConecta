// db.js — "banco de dados" simples em arquivo JSON.
// Sem dependências externas: usa só o módulo nativo "fs" do Node.
// Troque por SQLite/Postgres depois sem mudar a API (routes/*.js só chamam as funções daqui).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data.json');

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
    _seq: { usuarios: 5, clientes: 2, equipamentos: 4, agenda: 2, visitas: 1, registros: 1, chamados: 1 },
  };
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const data = seed();
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return data;
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // migração leve: bancos criados antes destes campos existirem ganham valores padrão
  if (!data.registros) data.registros = [];
  if (!data.chamados) data.chamados = [];
  if (!data._seq.registros) data._seq.registros = 1;
  if (!data._seq.chamados) data._seq.chamados = 1;
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

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function nextId(data, tabela) {
  const id = data._seq[tabela]++;
  return id;
}

module.exports = { load, save, nextId, hashSenha, conferirSenha, gerarTokenConvite, DB_PATH };
