// pedido do usuário: pacote "Climatização / PMOC", Fase A (análise de concorrentes/conformidade
// legal) — prova pela API HTTP de verdade: (1) Qualidade do Ar ganhou os campos PM10/PM2,5/
// velocidade do ar (ABNT NBR 17037:2023, que substituiu a RE nº 9/2003 da ANVISA, revogada em
// 25/07/2024 pela RDC nº 886/2024) sem quebrar os campos antigos; (2) controle de carga/
// recolhimento de gás refrigerante por aparelho (Protocolo de Montreal/IBAMA) — CRUD completo,
// validação, e o relatório anual consolidado por fluido (só administrador).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dados() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin Fase A', email: 'admin@pmocA.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico Fase A', email: 'tec@pmocA.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    os_refrigeracao_pmoc_qualidade_ar: [], os_refrigeracao_pmoc_config: [],
    os_refrigeracao_pmoc_gas_registros: [],
    _seq: {
      usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
      os_refrigeracao_pmoc_qualidade_ar: 1, os_refrigeracao_pmoc_config: 1,
      os_refrigeracao_pmoc_gas_registros: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa A', site: '', whatsapp: '', telefone: '', emails: ['contato@climacertaa.com'], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: [] }],
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

test('PMOC (Fase A — conformidade legal): Qualidade do Ar (PM10/PM2,5/velocidade do ar) e controle de gás refrigerante', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-faseA-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44900 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const login = async (email) => {
      const r = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha: 'senha1234' }),
      });
      return (await r.json()).token;
    };
    const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    const authAdmin = auth(await login('admin@pmocA.com'));
    const authTecnico = auth(await login('tec@pmocA.com'));

    // ---- cadastro base ----
    const cliente = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente Fase A' }) })).json()).cliente;
    const local = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Fase A', tipo_atividade: 'loja' }) })).json()).local;
    const ambiente = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Salão' }) })).json()).ambiente;
    const aparelho = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'Split hi-wall', marca: 'Daikin' }) })).json()).aparelho;
    const aparelho2 = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'Cassete', marca: 'LG' }) })).json()).aparelho;

    // ---- Qualidade do Ar: novos campos (NBR 17037) convivem com os antigos ----
    const rCriaQa = await fetch(`${base}/api/pmoc/qualidade-ar`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        local_id: local.id, data: '2026-03-10', laboratorio: 'Lab NBR',
        temperatura: '24', umidade: '55', co2: '650',
        pm10: '35', pm25: '18', velocidade_ar: '0,15',
        observacoes: 'Dentro da NBR 17037.',
      }),
    });
    assert.equal(rCriaQa.status, 201);
    const analise = (await rCriaQa.json()).analise;
    assert.equal(analise.pm10, '35');
    assert.equal(analise.pm25, '18');
    assert.equal(analise.velocidade_ar, '0,15');
    assert.equal(analise.temperatura, '24'); // campos antigos continuam funcionando.

    const rEditaQa = await fetch(`${base}/api/pmoc/qualidade-ar/${analise.id}`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({
        data: '2026-03-10', laboratorio: 'Lab NBR', temperatura: '24', umidade: '55', co2: '650',
        pm10: '40', pm25: '20', velocidade_ar: '0,18', observacoes: 'Revisado.',
      }),
    });
    assert.equal(rEditaQa.status, 200);
    assert.equal((await rEditaQa.json()).analise.pm10, '40');

    const { analises } = await (await fetch(`${base}/api/pmoc/locais/${local.id}/qualidade-ar`, { headers: authAdmin })).json();
    assert.equal(analises.length, 1);
    assert.equal(analises[0].velocidade_ar, '0,18');

    // ---- controle de gás refrigerante: validação ----
    const rGasSemCampos = await fetch(`${base}/api/pmoc/gas-registros`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ aparelho_id: aparelho.id }) });
    assert.equal(rGasSemCampos.status, 400);
    const rGasAparelhoInvalido = await fetch(`${base}/api/pmoc/gas-registros`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ aparelho_id: 99999, tipo_operacao: 'carga', fluido: 'R-410A', quantidade_kg: 2, data: '2025-06-01' }) });
    assert.equal(rGasAparelhoInvalido.status, 400);

    // ---- CRUD de gás: carga e recolhimento no aparelho 1, carga no aparelho 2, em anos diferentes ----
    const cargaAp1_2025 = (await (await fetch(`${base}/api/pmoc/gas-registros`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ aparelho_id: aparelho.id, tipo_operacao: 'carga', fluido: 'R-410A', quantidade_kg: 2.5, data: '2025-06-01', observacoes: 'Carga inicial' }) })).json()).registro;
    assert.equal(cargaAp1_2025.tipo_operacao, 'carga');
    const recolhimentoAp1_2025 = (await (await fetch(`${base}/api/pmoc/gas-registros`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ aparelho_id: aparelho.id, tipo_operacao: 'recolhimento', fluido: 'R-410A', quantidade_kg: 1, data: '2025-11-20' }) })).json()).registro;
    const cargaAp2_2025 = (await (await fetch(`${base}/api/pmoc/gas-registros`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ aparelho_id: aparelho2.id, tipo_operacao: 'carga', fluido: 'R-32', quantidade_kg: 1.2, data: '2025-07-15' }) })).json()).registro;
    // ano diferente — não deve entrar no relatório de 2025.
    await fetch(`${base}/api/pmoc/gas-registros`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ aparelho_id: aparelho.id, tipo_operacao: 'carga', fluido: 'R-410A', quantidade_kg: 3, data: '2026-01-05' }) });

    const { registros: registrosAp1 } = await (await fetch(`${base}/api/pmoc/aparelhos/${aparelho.id}/gas`, { headers: authAdmin })).json();
    assert.equal(registrosAp1.length, 3); // 2 de 2025 + 1 de 2026, só desse aparelho.
    assert.equal(registrosAp1[0].data, '2026-01-05'); // ordenado do mais recente pro mais antigo.

    // edita um registro.
    const rEditaGas = await fetch(`${base}/api/pmoc/gas-registros/${recolhimentoAp1_2025.id}`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({ tipo_operacao: 'recolhimento', fluido: 'R-410A', quantidade_kg: 1.5, data: '2025-11-20', observacoes: 'Ajustado' }),
    });
    assert.equal(rEditaGas.status, 200);
    assert.equal((await rEditaGas.json()).registro.quantidade_kg, 1.5);

    // ---- relatório anual: só administrador, filtra por ano, consolida por fluido ----
    const rRelatorioSoTecnico = await fetch(`${base}/api/pmoc/relatorio-anual-gas?ano=2025`, { headers: authTecnico });
    assert.equal(rRelatorioSoTecnico.status, 403);

    const relatorio2025 = await (await fetch(`${base}/api/pmoc/relatorio-anual-gas?ano=2025`, { headers: authAdmin })).json();
    assert.equal(relatorio2025.ano, '2025');
    assert.equal(relatorio2025.registros.length, 3); // carga+recolhimento do ap1, carga do ap2 — não o de 2026.
    const totalR410a = relatorio2025.por_fluido.find((f) => f.fluido === 'R-410A');
    assert.equal(totalR410a.carga_kg, 2.5);
    assert.equal(totalR410a.recolhimento_kg, 1.5); // valor editado acima.
    const totalR32 = relatorio2025.por_fluido.find((f) => f.fluido === 'R-32');
    assert.equal(totalR32.carga_kg, 1.2);
    assert.equal(totalR32.recolhimento_kg, 0);
    // hidratação de aparelho/local pro relatório.
    const registroComDetalhe = relatorio2025.registros.find((g) => g.id === cargaAp1_2025.id);
    assert.equal(registroComDetalhe.aparelho_tipo, 'Split hi-wall');
    assert.equal(registroComDetalhe.local_nome, 'Local Fase A');

    const relatorio2026 = await (await fetch(`${base}/api/pmoc/relatorio-anual-gas?ano=2026`, { headers: authAdmin })).json();
    assert.equal(relatorio2026.registros.length, 1);

    // ---- exclusão ----
    const rExcluiGas = await fetch(`${base}/api/pmoc/gas-registros/${cargaAp2_2025.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(rExcluiGas.status, 200);
    const relatorio2025Depois = await (await fetch(`${base}/api/pmoc/relatorio-anual-gas?ano=2025`, { headers: authAdmin })).json();
    assert.equal(relatorio2025Depois.registros.length, 2);
    assert.ok(!relatorio2025Depois.por_fluido.some((f) => f.fluido === 'R-32'));
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
