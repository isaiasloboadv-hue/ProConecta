// RCM/SAP PM Fase 1, passo 11: o contrato de manutenção preventiva do equipamento
// (tem_contrato_manutencao) agora pode ser definido em 3 lugares — Atrelar/Editar equipamento
// (admin, sempre sobrescreve), abertura da O.S. (campo dedicado) e a pergunta
// "plano_preventiva_ativo" do questionário de SLA — e quem preenche primeiro trava os outros 2
// (tri-estado null/true/false). Pedido do usuário: "qualquer uma das três preenchido primeiro as
// outras duas se preenche automático e deixa bloqueado". Este arquivo prova:
// 1) a migração do passo 10 (que gravava `false` por padrão) volta pra "não informado" (null)
//    só uma vez, sem desfazer uma escolha real feita depois (mesmo no modo arquivo, que roda a
//    migração de novo em todo load());
// 2) o campo dedicado na abertura da O.S. trava o equipamento quando ainda não informado;
// 3) a pergunta de SLA trava do mesmo jeito;
// 4) depois de travado, só o Atrelar/Editar equipamento (admin) consegue mudar — inclusive voltar
//    pra null de propósito;
// 5) o mesmo lock vale no encaminhamento pro pós-venda (reaproveita slaDoBody);
// 6) o filtro com/sem contrato do dashboard de KPIs ignora equipamento "não informado".
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function iso(diasAtras, horasAtras = 0) {
  return new Date(Date.now() - diasAtras * 864e5 - horasAtras * 36e5).toISOString();
}

function dados(equipamentosExtra, agendaExtra) {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Técnico', email: 'tecnico@x.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [{ id: 1, empresa_id: 1, nome_empresa: 'Cliente Y', contato: '', telefone: '', email: '' }],
    equipamentos: equipamentosExtra,
    agenda: agendaExtra || [],
    visitas: [], chamados: [], registros: [],
    fmea_componentes: [], fmea_modos_falha: [], fmea_causas: [], fmea_efeitos: [],
    _seq: { usuarios: 3, clientes: 2, equipamentos: 100, agenda: 200, visitas: 1 },
    empresas: [{ id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} }],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
    // marca a migração "false não confirmado → null" como já feita, pra um `false` escrito
    // direto no seed (simulando uma escolha JÁ confirmada) não ser confundido com o default não
    // confirmado do passo 10 — o teste de migração em si remove essa flag de propósito.
    _migracaoContratoNaoInformadoV1: true,
  };
}

function equip(id, temContrato, numeroSerie) {
  return { id, empresa_id: 1, cliente_id: 1, catalogo_id: null, tipo: 'Gravadora', modelo: 'X200', numero_serie: numeroSerie || `SN-${id}`, data_fabricacao: '', tem_contrato_manutencao: temContrato };
}

async function aguardarServidorSubir(porta) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${porta}/api/empresa`);
      if (r.ok) return;
    } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('servidor não subiu a tempo');
}

async function subirServidorComLogin(seed) {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-contrato-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(seed));
  const porta = 44900 + Math.floor(Math.random() * 600);
  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });
  await aguardarServidorSubir(porta);
  const base = `http://localhost:${porta}`;
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@x.com', senha: 'senha1234' }),
  });
  const token = (await r.json()).token;
  return { base, auth: { Authorization: `Bearer ${token}` }, servidor, dbTemp };
}

async function equipamentoPorId(base, auth, id) {
  const { equipamentos } = await (await fetch(`${base}/api/equipamentos`, { headers: auth })).json();
  return equipamentos.find((e) => e.id === id);
}

const CAMPOS_BASE_OS = {
  tecnico_id: 2, cliente_id: 1, tipo: 'corretiva',
  data_hora_inicio: new Date(Date.now() + 36e5).toISOString().slice(0, 16),
  data_hora_fim: new Date(Date.now() + 2 * 36e5).toISOString().slice(0, 16),
  contato: 'Fulano', telefone: '11999999999', email: 'fulano@cliente.com',
  endereco: 'Rua X', numero: '10', bairro: 'Centro', cep: '00000-000', cidade: 'São Paulo', estado: 'SP',
  garantia: 'nao',
};

test('migração do passo 10 → passo 11: false não confirmado vira null, true confirmado permanece, e a conversão não desfaz uma escolha real feita depois (mesmo relendo o arquivo de novo)', async () => {
  const seed = dados([
    equip(32, false), // simula o default do passo 10, nunca confirmado por ninguém
    equip(33, true), // simula uma escolha explícita já feita antes do passo 11
  ]);
  delete seed._migracaoContratoNaoInformadoV1; // simula um data.json de verdade, de antes do passo 11
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(seed);
  try {
    const antes32 = await equipamentoPorId(base, auth, 32);
    const antes33 = await equipamentoPorId(base, auth, 33);
    assert.equal(antes32.tem_contrato_manutencao, null);
    assert.equal(antes33.tem_contrato_manutencao, true);

    // agora o admin confirma de verdade: equipamento 32 não tem contrato
    const resPut = await fetch(`${base}/api/equipamentos/32`, {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero_serie: 'SN-32', tem_contrato_manutencao: false }),
    });
    assert.equal(resPut.status, 200);

    // uma SEGUNDA leitura (o modo arquivo roda a migração de novo em todo load()) não pode
    // desfazer essa escolha real voltando pra null
    const depois32 = await equipamentoPorId(base, auth, 32);
    assert.equal(depois32.tem_contrato_manutencao, false);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('abertura da O.S.: campo dedicado trava o equipamento "não informado", e uma segunda O.S. não consegue mudar depois', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados([equip(30, null)]));
  try {
    const authJson = { ...auth, 'Content-Type': 'application/json' };
    const r1 = await fetch(`${base}/api/agenda`, {
      method: 'POST', headers: authJson,
      body: JSON.stringify({ ...CAMPOS_BASE_OS, equipamento_id: 30, tem_contrato_manutencao: true }),
    });
    assert.equal(r1.status, 201);
    const { agenda: os1 } = await r1.json();
    assert.equal(os1.equipamento_tem_contrato_manutencao, true);
    assert.equal((await equipamentoPorId(base, auth, 30)).tem_contrato_manutencao, true);

    // segunda O.S. tenta mudar pra "sem contrato" no mesmo equipamento — já travado, não pode
    const r2 = await fetch(`${base}/api/agenda`, {
      method: 'POST', headers: authJson,
      body: JSON.stringify({ ...CAMPOS_BASE_OS, equipamento_id: 30, tem_contrato_manutencao: false }),
    });
    assert.equal(r2.status, 201);
    assert.equal((await equipamentoPorId(base, auth, 30)).tem_contrato_manutencao, true);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('questionário de SLA: a pergunta "plano_preventiva_ativo" trava o equipamento "não informado", e uma segunda resposta não consegue mudar depois', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados([equip(31, null)]));
  try {
    const authJson = { ...auth, 'Content-Type': 'application/json' };
    const r1 = await fetch(`${base}/api/agenda`, {
      method: 'POST', headers: authJson,
      body: JSON.stringify({ ...CAMPOS_BASE_OS, equipamento_id: 31, sla_respostas: { plano_preventiva_ativo: true } }),
    });
    assert.equal(r1.status, 201);
    assert.equal((await equipamentoPorId(base, auth, 31)).tem_contrato_manutencao, true);

    const r2 = await fetch(`${base}/api/agenda`, {
      method: 'POST', headers: authJson,
      body: JSON.stringify({ ...CAMPOS_BASE_OS, equipamento_id: 31, sla_respostas: { plano_preventiva_ativo: false } }),
    });
    assert.equal(r2.status, 201);
    assert.equal((await equipamentoPorId(base, auth, 31)).tem_contrato_manutencao, true);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('depois de travado por qualquer um dos 3 lugares, só Atrelar/Editar equipamento (admin) consegue mudar — inclusive voltar pra "não informado" de propósito', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados([equip(34, true)]));
  try {
    const authJson = { ...auth, 'Content-Type': 'application/json' };
    const r1 = await fetch(`${base}/api/equipamentos/34`, {
      method: 'PUT', headers: authJson,
      body: JSON.stringify({ numero_serie: 'SN-34', tem_contrato_manutencao: false }),
    });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).equipamento.tem_contrato_manutencao, false);

    const r2 = await fetch(`${base}/api/equipamentos/34`, {
      method: 'PUT', headers: authJson,
      body: JSON.stringify({ numero_serie: 'SN-34', tem_contrato_manutencao: null }),
    });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).equipamento.tem_contrato_manutencao, null);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('encaminhar pro pós-venda: a mesma pergunta de SLA trava o equipamento "não informado" (reaproveita slaDoBody)', async () => {
  const osAtendimento = {
    id: 100, empresa_id: 1, numero_os: 'OS-000100', tipo: 'atendimento',
    tecnico_id: 2, cliente_id: 1, equipamento_id: 35,
    data_hora_inicio: new Date().toISOString(), data_hora_fim: new Date().toISOString(),
    contato: 'Fulano', telefone: '11999999999', email: 'fulano@cliente.com',
    fase_atendimento: 'em_atendimento', finalizada: false, criado_em: new Date().toISOString(),
    sla_nivel: null, sla_pontuacao: null, sla_horas_atendimento: null, sla_dias_manutencao: null, sla_dias_visita_tecnica: null,
  };
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados([equip(35, null)], [osAtendimento]));
  try {
    const authJson = { ...auth, 'Content-Type': 'application/json' };
    const r1 = await fetch(`${base}/api/agenda/100/encaminhar-pos-venda`, {
      method: 'POST', headers: authJson,
      body: JSON.stringify({ motivo: 'tecnico_visita', sla_respostas: { plano_preventiva_ativo: true } }),
    });
    assert.equal(r1.status, 200);
    assert.equal((await equipamentoPorId(base, auth, 35)).tem_contrato_manutencao, true);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('dashboard de KPIs: equipamento "não informado" não entra nem no filtro "com" nem no "sem" contrato', async () => {
  const agendaExtra = [
    { id: 201, empresa_id: 1, numero_os: 'OS-000201', tipo: 'corretiva', equipamento_id: 40, cliente_id: 1, tecnico_id: 2, criado_em: iso(5), finalizada: true, finalizado_em: iso(4) },
    { id: 202, empresa_id: 1, numero_os: 'OS-000202', tipo: 'corretiva', equipamento_id: 41, cliente_id: 1, tecnico_id: 2, criado_em: iso(5), finalizada: true, finalizado_em: iso(4) },
    { id: 203, empresa_id: 1, numero_os: 'OS-000203', tipo: 'corretiva', equipamento_id: 42, cliente_id: 1, tecnico_id: 2, criado_em: iso(5), finalizada: true, finalizado_em: iso(4) },
  ];
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados([equip(40, true), equip(41, false), equip(42, null)], agendaExtra));
  try {
    const semFiltro = await (await fetch(`${base}/api/kpis/detalhe?indicador=preventiva_corretiva`, { headers: auth })).json();
    const comFiltro = await (await fetch(`${base}/api/kpis/detalhe?indicador=preventiva_corretiva&contrato=com`, { headers: auth })).json();
    const semContrato = await (await fetch(`${base}/api/kpis/detalhe?indicador=preventiva_corretiva&contrato=sem`, { headers: auth })).json();
    assert.equal(semFiltro.linhas.length, 3); // todos, inclusive o "não informado"
    assert.equal(comFiltro.linhas.length, 1); // só o equipamento 40 (true)
    assert.equal(semContrato.linhas.length, 1); // só o equipamento 41 (false) — 42 (null) não entra aqui
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
