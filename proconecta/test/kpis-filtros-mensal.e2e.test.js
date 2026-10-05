// RCM/SAP PM Fase 1, passo 7: filtros (período/cliente/equipamento/técnico) no GET /api/kpis e a
// série mensal nova GET /api/kpis/mensal, pros gráficos. Reaproveita o mesmo cenário de dados do
// passo 6 (test/kpis.e2e.test.js) — aqui o foco é só provar que os filtros restringem certo o
// recorte usado pelo cálculo (ver filtrarAgendaKpis em server.js) e que a série mensal agrupa
// certo por mês.
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
    ],
    clientes: [{ id: 1, empresa_id: 1, nome_empresa: 'Cliente X', contato: '', telefone: '', email: '' }],
    equipamentos: [
      { id: 1, empresa_id: 1, cliente_id: null, catalogo_id: null, tipo: 'Gravadora', modelo: 'X200', numero_serie: '', data_fabricacao: '' },
      { id: 10, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-A', data_fabricacao: '' },
      { id: 11, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-B', data_fabricacao: '' },
    ],
    // mesmo cenário do passo 6: equipamento 10 com 3 corretivas (40/30/10 dias atrás) + 2
    // preventivas (20/15 dias atrás) + 1 atendimento aberto (48h atrás); equipamento 11 com 1
    // corretiva isolada (5 dias atrás).
    agenda: [
      { id: 1, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(40), finalizada: true, finalizado_em: iso(39) },
      { id: 2, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(30), finalizada: true, finalizado_em: iso(29) },
      { id: 3, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(10), finalizada: true, finalizado_em: iso(9) },
      { id: 4, empresa_id: 1, tipo: 'corretiva', equipamento_id: 11, cliente_id: 1, tecnico_id: 1, criado_em: iso(5), finalizada: true, finalizado_em: iso(4) },
      { id: 5, empresa_id: 1, tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(20), finalizada: true, finalizado_em: iso(19) },
      { id: 6, empresa_id: 1, tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(15), finalizada: true, finalizado_em: iso(14) },
      { id: 7, empresa_id: 1, tipo: 'atendimento', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: iso(0, 48), finalizada: false, finalizado_em: null },
    ],
    // os 1: 2h; os 2: 4h; os 3: 3h; os 4: 1h de reparo
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

async function subirServidorComLogin(seed) {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-kpis-filtros-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(seed));
  const porta = 44400 + Math.floor(Math.random() * 900);
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

test('GET /api/kpis com filtro de equipamento restringe o cálculo a só aquele equipamento', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const { kpis } = await (await fetch(`${base}/api/kpis?equipamento_id=11`, { headers: auth })).json();
    // equipamento 11 só tem a OS 4: 1 corretiva isolada, 1h de reparo, sem preventiva, sem backlog.
    assert.equal(kpis.mttr_horas, 1);
    assert.equal(kpis.mtbf_dias, null); // só 1 corretiva nesse equipamento -> nenhum intervalo
    assert.equal(kpis.backlog_qtd, 0);
    assert.equal(kpis.percentual_preventiva, 0);
    assert.equal(kpis.percentual_corretiva, 100);
    assert.equal(kpis.disponibilidade_percentual, 99.2); // 1 - 1h/(5 dias=120h) = 99.166...% -> 99.2
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('GET /api/kpis com filtro de período exclui O.S. de fora do intervalo', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const periodoInicio = new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10);
    const { kpis } = await (await fetch(`${base}/api/kpis?periodo_inicio=${periodoInicio}`, { headers: auth })).json();
    // exclui a OS 1 (corretiva de 40 dias atrás) — sobram as corretivas de 30/10/5 dias atrás e as
    // 2 preventivas (20/15 dias atrás), todas dentro do período.
    assert.equal(kpis.mtbf_dias, 20); // equipamento 10 passa a ter só 2 corretivas (30 e 10 dias atrás) -> 1 intervalo de 20 dias
    assert.equal(kpis.mttr_horas, 2.7); // média de 4h, 3h, 1h = 2.666... -> 2.7
    assert.equal(kpis.percentual_preventiva, 40); // 2 preventivas / 5 total
    assert.equal(kpis.percentual_corretiva, 60); // 3 corretivas / 5 total
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('GET /api/kpis com filtro de cliente/técnico inexistente devolve indicadores vazios', async () => {
  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(dados());
  try {
    const { kpis } = await (await fetch(`${base}/api/kpis?tecnico_id=999999`, { headers: auth })).json();
    assert.equal(kpis.mtbf_dias, null);
    assert.equal(kpis.mttr_horas, null);
    assert.equal(kpis.backlog_qtd, 0);
    assert.equal(kpis.percentual_preventiva, null);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('GET /api/kpis/mensal agrupa corretivas/preventivas/MTTR por mês certo', async () => {
  const senha = hashSenha('senha1234');
  const agora = new Date();
  // dia 10 do mês atual e dia 10 do mês anterior, ao meio-dia — evita qualquer ambiguidade de
  // fuso/borda de mês que "dias atrás" teria perto do dia 1.
  const mesAtual = new Date(agora.getFullYear(), agora.getMonth(), 10, 12, 0, 0);
  const mesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 10, 12, 0, 0);
  const chaveAtual = `${mesAtual.getFullYear()}-${String(mesAtual.getMonth() + 1).padStart(2, '0')}`;
  const chaveAnterior = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;

  const seed = {
    usuarios: [{ id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha }],
    clientes: [{ id: 1, empresa_id: 1, nome_empresa: 'Cliente X', contato: '', telefone: '', email: '' }],
    equipamentos: [{ id: 10, empresa_id: 1, cliente_id: 1, catalogo_id: null, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-A', data_fabricacao: '' }],
    agenda: [
      { id: 1, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: mesAtual.toISOString(), finalizada: true, finalizado_em: mesAtual.toISOString() },
      { id: 2, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: mesAtual.toISOString(), finalizada: true, finalizado_em: mesAtual.toISOString() },
      { id: 3, empresa_id: 1, tipo: 'preventiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: mesAnterior.toISOString(), finalizada: true, finalizado_em: mesAnterior.toISOString() },
      { id: 4, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: mesAnterior.toISOString(), finalizada: true, finalizado_em: mesAnterior.toISOString() },
    ],
    visitas: [
      { id: 1, empresa_id: 1, agenda_id: 1, rodada: 1, laudo: { data_entrada: mesAtual.toISOString(), data_conclusao: new Date(mesAtual.getTime() + 2 * 36e5).toISOString() } },
      { id: 2, empresa_id: 1, agenda_id: 4, rodada: 1, laudo: { data_entrada: mesAnterior.toISOString(), data_conclusao: new Date(mesAnterior.getTime() + 6 * 36e5).toISOString() } },
    ],
    fmea_componentes: [], fmea_modos_falha: [], fmea_causas: [], fmea_efeitos: [],
    _seq: { usuarios: 2, clientes: 2, equipamentos: 11, agenda: 5, visitas: 3 },
    empresas: [{ id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} }],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
  };

  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(seed);
  try {
    const { meses } = await (await fetch(`${base}/api/kpis/mensal`, { headers: auth })).json();
    const doMesAtual = meses.find((m) => m.mes === chaveAtual);
    const doMesAnterior = meses.find((m) => m.mes === chaveAnterior);
    assert.ok(doMesAtual, `mês atual (${chaveAtual}) deveria estar na série`);
    assert.ok(doMesAnterior, `mês anterior (${chaveAnterior}) deveria estar na série`);
    assert.equal(doMesAtual.corretivas, 2);
    assert.equal(doMesAtual.preventivas, 0);
    assert.equal(doMesAtual.mttr_horas, 2);
    assert.equal(doMesAnterior.corretivas, 1);
    assert.equal(doMesAnterior.preventivas, 1);
    assert.equal(doMesAnterior.mttr_horas, 6);
    // a série cobre os últimos 12 meses sem filtro de período, sempre em ordem crescente
    assert.ok(meses.length <= 12);
    for (let i = 1; i < meses.length; i++) assert.ok(meses[i].mes > meses[i - 1].mes);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

// Pedido do usuário: "No mttr o gráfico colocar valores parcial atualizado durante o mês" — um
// reparo corretivo ainda em andamento (Laudo Técnico com data_entrada preenchida, sem
// data_conclusao ainda) no mês CORRENTE entra no MTTR mensal como valor parcial (agora -
// entrada), em vez de deixar o mês sem ponto algum até o 1º reparo fechar. O mesmo cenário num mês
// já fechado (passado) continua do jeito antigo: sem conclusão, não conta — senão o histórico
// "andaria" pra sempre. O indicador MTTR principal (GET /api/kpis, sem recorte de mês) também
// continua do jeito antigo, só concluído conta — o parcial é só pro gráfico mensal.
test('GET /api/kpis/mensal: reparo em andamento no mês corrente entra como MTTR parcial; no mês passado, não conta', async () => {
  const senha = hashSenha('senha1234');
  const agora = new Date();
  const chaveAtual = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
  const mesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 10, 12, 0, 0);
  const chaveAnterior = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;
  const entradaAtualHorasAtras = 3; // reparo do mês corrente, aberto há 3h, ainda sem conclusão
  const entradaAtual = new Date(Date.now() - entradaAtualHorasAtras * 36e5);

  const seed = {
    usuarios: [{ id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha }],
    clientes: [{ id: 1, empresa_id: 1, nome_empresa: 'Cliente X', contato: '', telefone: '', email: '' }],
    equipamentos: [{ id: 10, empresa_id: 1, cliente_id: 1, catalogo_id: null, tipo: 'Gravadora', modelo: 'X200', numero_serie: 'SN-A', data_fabricacao: '' }],
    agenda: [
      { id: 1, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: entradaAtual.toISOString(), finalizada: false, finalizado_em: null },
      { id: 2, empresa_id: 1, tipo: 'corretiva', equipamento_id: 10, cliente_id: 1, tecnico_id: 1, criado_em: mesAnterior.toISOString(), finalizada: false, finalizado_em: null },
    ],
    visitas: [
      { id: 1, empresa_id: 1, agenda_id: 1, rodada: 1, laudo: { data_entrada: entradaAtual.toISOString(), data_conclusao: null } },
      { id: 2, empresa_id: 1, agenda_id: 2, rodada: 1, laudo: { data_entrada: mesAnterior.toISOString(), data_conclusao: null } },
    ],
    fmea_componentes: [], fmea_modos_falha: [], fmea_causas: [], fmea_efeitos: [],
    _seq: { usuarios: 2, clientes: 2, equipamentos: 11, agenda: 3, visitas: 3 },
    empresas: [{ id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} }],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
  };

  const { base, auth, servidor, dbTemp } = await subirServidorComLogin(seed);
  try {
    const { meses } = await (await fetch(`${base}/api/kpis/mensal`, { headers: auth })).json();
    const doMesAtual = meses.find((m) => m.mes === chaveAtual);
    const doMesAnterior = meses.find((m) => m.mes === chaveAnterior);
    assert.ok(doMesAtual, `mês atual (${chaveAtual}) deveria estar na série`);
    assert.ok(doMesAnterior, `mês anterior (${chaveAnterior}) deveria estar na série`);

    // mês corrente: entra como parcial, valor ~3h (tolerância pro tempo de execução do teste)
    assert.equal(doMesAtual.parcial, true);
    assert.ok(doMesAtual.mttr_horas !== null, 'MTTR do mês corrente não deveria ficar nulo com reparo em andamento');
    assert.ok(Math.abs(doMesAtual.mttr_horas - entradaAtualHorasAtras) < 0.2, `esperava ~${entradaAtualHorasAtras}h, veio ${doMesAtual.mttr_horas}h`);

    // mês passado: reparo em andamento sem conclusão não conta — comportamento de antes, intacto
    assert.equal(doMesAnterior.parcial, false);
    assert.equal(doMesAnterior.mttr_horas, null);

    // o indicador principal (sem recorte mensal) continua só com reparo concluído — nenhum dos 2
    // reparos desse cenário tem conclusão, então o MTTR geral fica nulo mesmo (parcial é só do
    // gráfico mensal, não vaza pro indicador de topo).
    const { kpis } = await (await fetch(`${base}/api/kpis`, { headers: auth })).json();
    assert.equal(kpis.mttr_horas, null);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
