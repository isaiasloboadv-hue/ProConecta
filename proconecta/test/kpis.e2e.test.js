// RCM/SAP PM Fase 1, passo 6: dashboard de KPIs do administrador (MTBF, MTTR, disponibilidade,
// backlog, % preventiva×corretiva). Prova, pela API HTTP de verdade, que GET /api/kpis calcula
// cada indicador certo a partir das próprias datas/horas das O.S. e dos laudos técnicos — sem
// precisar de nenhuma coleção nova (ver calcularKpis em server.js). MTBF e MTTR usam só
// timestamps fixos no passado (determinísticos); backlog e disponibilidade dependem de "agora",
// então são checados com tolerância.
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
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Técnico', email: 'tec@x.com', papel: 'producao', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [{ id: 1, empresa_id: 1, nome_empresa: 'Cliente X', contato: '', telefone: '', email: '' }],
    equipamentos: [
      // catálogo
      { id: 1, empresa_id: 1, cliente_id: null, catalogo_id: null, tipo: 'Gravadora', modelo: 'X200', numero_serie: '', data_fabricacao: '' },
      // 2 unidades atreladas: a unidade 10 teve 3 corretivas (2 intervalos), a unidade 11 teve 1
      { id: 10, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-A', data_fabricacao: '' },
      { id: 11, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-B', data_fabricacao: '' },
    ],
    // 3 corretivas no equipamento 10, abertas com 40, 30 e 10 dias atrás -> intervalos de 10 e 20 dias
    // 1 corretiva no equipamento 11, 5 dias atrás -> sem intervalo (só 1 ocorrência)
    // 2 preventivas (equipamento 10) -> pra %preventiva×corretiva
    // 1 O.S. aberta (não finalizada) há 48h -> backlog
    agenda: [
      { id: 1, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 2, criado_em: iso(40), finalizada: true, finalizado_em: iso(39) },
      { id: 2, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 2, criado_em: iso(30), finalizada: true, finalizado_em: iso(29) },
      { id: 3, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 2, criado_em: iso(10), finalizada: true, finalizado_em: iso(9) },
      { id: 4, empresa_id: 1, tipo: 'corretiva', equipamento_id: 11, cliente_id: 1, tecnico_id: 2, criado_em: iso(5), finalizada: true, finalizado_em: iso(4) },
      { id: 5, empresa_id: 1, tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 2, criado_em: iso(20), finalizada: true, finalizado_em: iso(19) },
      { id: 6, empresa_id: 1, tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 2, criado_em: iso(15), finalizada: true, finalizado_em: iso(14) },
      // tipo "atendimento" de propósito (não é corretiva nem preventiva) — prova que o backlog
      // conta qualquer O.S. não finalizada, sem interferir no MTBF (agrupamento por corretiva) nem
      // no %preventiva×corretiva.
      { id: 7, empresa_id: 1, tipo: 'atendimento', equipamento_id: 10, cliente_id: 1, tecnico_id: 2, criado_em: iso(0, 48), finalizada: false, finalizado_em: null },
    ],
    // laudos técnicos das 4 corretivas finalizadas, com entrada/conclusão -> MTTR
    // os 1: 2h de reparo; os 2: 4h; os 3: 3h; os 4: 1h -> média = (2+4+3+1)/4 = 2.5h
    visitas: [
      { id: 1, empresa_id: 1, agenda_id: 1, rodada: 1, laudo: { data_entrada: iso(40), data_conclusao: iso(40, -2) } },
      { id: 2, empresa_id: 1, agenda_id: 2, rodada: 1, laudo: { data_entrada: iso(30), data_conclusao: iso(30, -4) } },
      { id: 3, empresa_id: 1, agenda_id: 3, rodada: 1, laudo: { data_entrada: iso(10), data_conclusao: iso(10, -3) } },
      { id: 4, empresa_id: 1, agenda_id: 4, rodada: 1, laudo: { data_entrada: iso(5), data_conclusao: iso(5, -1) } },
    ],
    fmea_componentes: [], fmea_modos_falha: [], fmea_causas: [], fmea_efeitos: [],
    _seq: { usuarios: 3, clientes: 2, equipamentos: 12, agenda: 8, visitas: 5 },
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

test('GET /api/kpis calcula MTBF, MTTR, disponibilidade, backlog e %preventiva×corretiva', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-kpis-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44300 + Math.floor(Math.random() * 900);

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

    const { kpis } = await (await fetch(`${base}/api/kpis`, { headers: auth })).json();

    // MTTR: (2+4+3+1)/4 = 2.5h
    assert.equal(kpis.mttr_horas, 2.5);

    // MTBF: equipamento 10 teve 3 corretivas (40, 30, 10 dias atrás) -> intervalos de 10 e 20 dias;
    // equipamento 11 teve só 1 -> não gera intervalo. Média = (10+20)/2 = 15 dias.
    assert.equal(kpis.mtbf_dias, 15);

    // backlog: 1 O.S. aberta (id 7), criada há ~48h -> qtd 1, horas ~48 (tolerância de 1h pro tempo
    // de execução do teste)
    assert.equal(kpis.backlog_qtd, 1);
    assert.ok(Math.abs(kpis.backlog_horas - 48) < 1, `backlog_horas esperado ~48, veio ${kpis.backlog_horas}`);

    // % preventiva×corretiva: 2 preventivas, 4 corretivas -> total 6 -> 33.3% / 66.7%
    assert.equal(kpis.percentual_preventiva, 33.3);
    assert.equal(kpis.percentual_corretiva, 66.7);

    // disponibilidade: aproximação (não é o foco do teste determinístico, só confere que veio um
    // número plausível entre 0 e 100, já que há equipamentos com O.S. há várias décadas de dias)
    assert.ok(kpis.disponibilidade_percentual > 0 && kpis.disponibilidade_percentual <= 100);

    // aderência ao plano: Fase 2 (Planos de Manutenção) não existe ainda — sempre null
    assert.equal(kpis.aderencia_plano, null);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('GET /api/kpis com histórico vazio devolve indicadores null/zero sem quebrar', async () => {
  const vazio = dados();
  vazio.agenda = [];
  vazio.visitas = [];
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-kpis-vazio-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(vazio));
  const porta = 44300 + Math.floor(Math.random() * 900);

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
    const { kpis } = await (await fetch(`${base}/api/kpis`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(kpis.mtbf_dias, null);
    assert.equal(kpis.mttr_horas, null);
    assert.equal(kpis.disponibilidade_percentual, null);
    assert.equal(kpis.backlog_qtd, 0);
    assert.equal(kpis.backlog_horas, 0);
    assert.equal(kpis.percentual_preventiva, null);
    assert.equal(kpis.percentual_corretiva, null);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
