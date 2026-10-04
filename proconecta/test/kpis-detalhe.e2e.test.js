// RCM/SAP PM Fase 1, passo 9: drill-down por indicador (GET /api/kpis/detalhe) — pedido do
// usuário pra, a partir de cada card do dashboard, ver quais clientes/equipamentos/O.S. formam
// aquele número. Reaproveita o mesmo cenário de dados dos passos 6/7 (equipamento 10 com 3
// corretivas + 2 preventivas + 1 atendimento aberto; equipamento 11 com 1 corretiva isolada).
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
      { id: 10, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-A', data_fabricacao: '' },
      { id: 11, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-B', data_fabricacao: '' },
    ],
    agenda: [
      { id: 1, empresa_id: 1, numero_os: 'OS-000001', tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(40), finalizada: true, finalizado_em: iso(39) },
      { id: 2, empresa_id: 1, numero_os: 'OS-000002', tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(30), finalizada: true, finalizado_em: iso(29) },
      { id: 3, empresa_id: 1, numero_os: 'OS-000003', tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(10), finalizada: true, finalizado_em: iso(9) },
      { id: 4, empresa_id: 1, numero_os: 'OS-000004', tipo: 'corretiva', equipamento_id: 11, cliente_id: 1, tecnico_id: 1, criado_em: iso(5), finalizada: true, finalizado_em: iso(4) },
      { id: 5, empresa_id: 1, numero_os: 'OS-000005', tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(20), finalizada: true, finalizado_em: iso(19) },
      { id: 6, empresa_id: 1, numero_os: 'OS-000006', tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(15), finalizada: true, finalizado_em: iso(14) },
      { id: 7, empresa_id: 1, numero_os: 'OS-000007', tipo: 'atendimento', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(0, 48), finalizada: false, finalizado_em: null },
    ],
    visitas: [
      { id: 1, empresa_id: 1, agenda_id: 1, rodada: 1, laudo: { data_entrada: iso(40), data_conclusao: iso(40, -2) } },
      { id: 2, empresa_id: 1, agenda_id: 2, rodada: 1, laudo: { data_entrada: iso(30), data_conclusao: iso(30, -4) } },
      { id: 3, empresa_id: 1, agenda_id: 3, rodada: 1, laudo: { data_entrada: iso(10), data_conclusao: iso(10, -3) } },
      { id: 4, empresa_id: 1, agenda_id: 4, rodada: 1, laudo: { data_entrada: iso(5), data_conclusao: iso(5, -1) } },
    ],
    fmea_componentes: [], fmea_modos_falha: [], fmea_causas: [], fmea_efeitos: [],
    _seq: { usuarios: 2, clientes: 2, equipamentos: 12, agenda: 8, visitas: 5 },
    empresas: [{ id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} }],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
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

test('GET /api/kpis/detalhe devolve as linhas certas pra cada indicador', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-kpis-detalhe-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44500 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const r = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@x.com', senha: 'senha1234' }),
    });
    const token = (await r.json()).token;
    const auth = { Authorization: `Bearer ${token}` };

    // MTTR: 4 linhas (uma por corretiva com laudo), com cliente/equipamento/horas certos
    const mttr = await (await fetch(`${base}/api/kpis/detalhe?indicador=mttr`, { headers: auth })).json();
    assert.equal(mttr.indicador, 'mttr');
    assert.equal(mttr.linhas.length, 4);
    const linhaOs1 = mttr.linhas.find((l) => l.numero_os === 'OS-000001');
    assert.equal(linhaOs1.cliente_nome, 'Cliente X');
    assert.equal(linhaOs1.equipamento_descricao, 'Gravadora X200 (SN-A)');
    assert.equal(linhaOs1.horas_reparo, 2);

    // MTBF: 2 intervalos no equipamento 10 (OS1->OS2: 10 dias; OS2->OS3: 20 dias); nenhum no 11
    const mtbf = await (await fetch(`${base}/api/kpis/detalhe?indicador=mtbf`, { headers: auth })).json();
    assert.equal(mtbf.linhas.length, 2);
    const intervalo1 = mtbf.linhas.find((l) => l.os_anterior === 'OS-000001' && l.os_atual === 'OS-000002');
    assert.equal(intervalo1.intervalo_dias, 10);
    const intervalo2 = mtbf.linhas.find((l) => l.os_anterior === 'OS-000002' && l.os_atual === 'OS-000003');
    assert.equal(intervalo2.intervalo_dias, 20);

    // Backlog: só a OS 7 (atendimento aberto)
    const backlog = await (await fetch(`${base}/api/kpis/detalhe?indicador=backlog`, { headers: auth })).json();
    assert.equal(backlog.linhas.length, 1);
    assert.equal(backlog.linhas[0].numero_os, 'OS-000007');
    assert.ok(Math.abs(backlog.linhas[0].horas_aberta - 48) < 1);

    // Preventiva x corretiva: 6 linhas (4 corretivas + 2 preventivas), sem o atendimento
    const prevCorr = await (await fetch(`${base}/api/kpis/detalhe?indicador=preventiva_corretiva`, { headers: auth })).json();
    assert.equal(prevCorr.linhas.length, 6);
    assert.ok(!prevCorr.linhas.some((l) => l.numero_os === 'OS-000007'));

    // Disponibilidade: 2 linhas (equipamento 10 e 11), cada uma com cliente/equipamento resolvidos
    const disp = await (await fetch(`${base}/api/kpis/detalhe?indicador=disponibilidade`, { headers: auth })).json();
    assert.equal(disp.linhas.length, 2);
    const equip10 = disp.linhas.find((l) => l.equipamento_descricao.includes('SN-A'));
    assert.equal(equip10.cliente_nome, 'Cliente X');
    assert.ok(equip10.disponibilidade_percentual > 0 && equip10.disponibilidade_percentual <= 100);

    // indicador inválido -> 400
    const invalido = await fetch(`${base}/api/kpis/detalhe?indicador=lixo`, { headers: auth });
    assert.equal(invalido.status, 400);

    // filtro de equipamento restringe o detalhe também (mesma função filtrarAgendaKpis)
    const mttrFiltrado = await (await fetch(`${base}/api/kpis/detalhe?indicador=mttr&equipamento_id=11`, { headers: auth })).json();
    assert.equal(mttrFiltrado.linhas.length, 1);
    assert.equal(mttrFiltrado.linhas[0].numero_os, 'OS-000004');
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
