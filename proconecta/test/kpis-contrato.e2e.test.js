// RCM/SAP PM Fase 1, passo 10: filtro "com contrato de manutenção preventiva" × "sem contrato" no
// dashboard de KPIs — pedido explícito do usuário ("equipamentos com contrato pode impactar
// nossos indicadores... retrabalhos, demoras, equipamentos quebrando sempre"). Prova que o filtro
// (GET /api/kpis, /api/kpis/mensal e /api/kpis/detalhe, todos via filtrarAgendaKpis) restringe
// certo o recorte a partir do campo tem_contrato_manutencao do equipamento.
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

function dados() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [{ id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha }],
    clientes: [{ id: 1, empresa_id: 1, nome_empresa: 'Cliente X', contato: '', telefone: '', email: '' }],
    equipamentos: [
      { id: 1, empresa_id: 1, cliente_id: null, catalogo_id: null, tipo: 'Gravadora', modelo: 'X200', numero_serie: '', data_fabricacao: '' },
      // equipamento 10: COM contrato — 2 corretivas (mais retrabalho esperado)
      { id: 10, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-COM', data_fabricacao: '', tem_contrato_manutencao: true },
      // equipamento 11: SEM contrato — 1 corretiva
      { id: 11, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-SEM', data_fabricacao: '', tem_contrato_manutencao: false },
    ],
    agenda: [
      { id: 1, empresa_id: 1, numero_os: 'OS-000001', tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(40), finalizada: true, finalizado_em: iso(39) },
      { id: 2, empresa_id: 1, numero_os: 'OS-000002', tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(30), finalizada: true, finalizado_em: iso(29) },
      { id: 3, empresa_id: 1, numero_os: 'OS-000003', tipo: 'corretiva', equipamento_id: 11, cliente_id: 1, tecnico_id: 1, criado_em: iso(10), finalizada: true, finalizado_em: iso(9) },
      { id: 4, empresa_id: 1, numero_os: 'OS-000004', tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(20), finalizada: true, finalizado_em: iso(19) },
    ],
    visitas: [
      { id: 1, empresa_id: 1, agenda_id: 1, rodada: 1, laudo: { data_entrada: iso(40), data_conclusao: iso(40, -2) } },
      { id: 2, empresa_id: 1, agenda_id: 2, rodada: 1, laudo: { data_entrada: iso(30), data_conclusao: iso(30, -4) } },
      { id: 3, empresa_id: 1, agenda_id: 3, rodada: 1, laudo: { data_entrada: iso(10), data_conclusao: iso(10, -1) } },
    ],
    fmea_componentes: [], fmea_modos_falha: [], fmea_causas: [], fmea_efeitos: [],
    _seq: { usuarios: 2, clientes: 2, equipamentos: 12, agenda: 5, visitas: 4 },
    empresas: [{ id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} }],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
    // passo 11: tem_contrato_manutencao virou tri-estado (null = ainda não informado) — o `false`
    // deste seed é uma escolha JÁ confirmada (equipamento 11, "sem contrato"), não um default de
    // passo 10 nunca confirmado, então marca a migração como já feita pra não virar null aqui
    // (ver _migracaoContratoNaoInformadoV1 em db.js e o teste dedicado em
    // contrato-manutencao-lock.e2e.test.js).
    _migracaoContratoNaoInformadoV1: true,
  };
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
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-kpis-contrato-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(seed));
  const porta = 44600 + Math.floor(Math.random() * 900);
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

test('GET /api/kpis com filtro contrato=com restringe ao equipamento com contrato', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const { kpis } = await (await fetch(`${base}/api/kpis?contrato=com`, { headers: auth })).json();
    // equipamento 10 (com contrato): 2 corretivas (4h e 2h de reparo) + 1 preventiva
    assert.equal(kpis.mttr_horas, 3); // (4+2)/2
    assert.equal(kpis.percentual_preventiva, 33.3); // 1 preventiva / 3 total
    assert.equal(kpis.percentual_corretiva, 66.7);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('GET /api/kpis com filtro contrato=sem restringe ao equipamento sem contrato', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const { kpis } = await (await fetch(`${base}/api/kpis?contrato=sem`, { headers: auth })).json();
    // equipamento 11 (sem contrato): só 1 corretiva, 1h de reparo, nenhuma preventiva
    assert.equal(kpis.mttr_horas, 1);
    assert.equal(kpis.percentual_preventiva, 0);
    assert.equal(kpis.percentual_corretiva, 100);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('GET /api/kpis/detalhe com filtro de contrato e sem filtro mostram o campo tem_contrato_manutencao certo', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const disp = await (await fetch(`${base}/api/kpis/detalhe?indicador=disponibilidade`, { headers: auth })).json();
    assert.equal(disp.linhas.length, 2);
    const linhaCom = disp.linhas.find((l) => l.equipamento_descricao.includes('SN-COM'));
    const linhaSem = disp.linhas.find((l) => l.equipamento_descricao.includes('SN-SEM'));
    assert.equal(linhaCom.tem_contrato_manutencao, true);
    assert.equal(linhaSem.tem_contrato_manutencao, false);

    const mttrCom = await (await fetch(`${base}/api/kpis/detalhe?indicador=mttr&contrato=com`, { headers: auth })).json();
    assert.equal(mttrCom.linhas.length, 2);
    assert.ok(mttrCom.linhas.every((l) => l.equipamento_descricao.includes('SN-COM')));
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('GET /api/kpis/mensal respeita o filtro de contrato', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const semFiltro = await (await fetch(`${base}/api/kpis/mensal`, { headers: auth })).json();
    const comFiltro = await (await fetch(`${base}/api/kpis/mensal?contrato=sem`, { headers: auth })).json();
    const totalCorretivasSemFiltro = semFiltro.meses.reduce((s, m) => s + m.corretivas, 0);
    const totalCorretivasComFiltroSem = comFiltro.meses.reduce((s, m) => s + m.corretivas, 0);
    assert.equal(totalCorretivasSemFiltro, 3); // todas as corretivas, dos 2 equipamentos
    assert.equal(totalCorretivasComFiltroSem, 1); // só a do equipamento sem contrato
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('POST /api/equipamentos/:id/atrelar e PUT aceitam tem_contrato_manutencao', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const authJson = { ...auth, 'Content-Type': 'application/json' };
    const resAtrelar = await fetch(`${base}/api/equipamentos/1/atrelar`, {
      method: 'POST', headers: authJson,
      body: JSON.stringify({ cliente_id: 1, numero_serie: 'SN-NOVO', tem_contrato_manutencao: true }),
    });
    const { equipamento } = await resAtrelar.json();
    assert.equal(resAtrelar.status, 201);
    assert.equal(equipamento.tem_contrato_manutencao, true);

    const resPut = await fetch(`${base}/api/equipamentos/${equipamento.id}`, {
      method: 'PUT', headers: authJson,
      body: JSON.stringify({ numero_serie: 'SN-NOVO', tem_contrato_manutencao: false }),
    });
    const putBody = await resPut.json();
    assert.equal(putBody.equipamento.tem_contrato_manutencao, false);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
