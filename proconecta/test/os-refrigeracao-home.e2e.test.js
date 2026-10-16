// pedido do usuário (perfil "Refrigeração e Climatização", referência: app concorrente iClima) —
// painel "Início" no topo do menu, com os números do PRÓPRIO usuário (hoje/semana/ocupação do
// mês, reaproveitando a Agenda já construída) + solicitações pendentes da empresa (orçamentos em
// rascunho). Prova pela API HTTP de verdade: gate por `perfil`, isolamento entre técnicos (cada
// um só vê a própria agenda no resumo), cálculo de hoje/próximo/semana/ocupação, e que
// "solicitações" é da empresa inteira (não por técnico).
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
      { id: 1, nome: 'Admin Refrigeração', email: 'admin@refrigera.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico A', email: 'tecA@refrigera.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Admin Outro Perfil', email: 'admin@outroperfil.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    _seq: {
      usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
    },
    empresas: [
      { id: 1, nome: 'Refrigera Clima', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, perfil: 'refrigeracao' },
      { id: 2, nome: 'Empresa Perfil Autônomo', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#111', cor_secundaria: '#111', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, perfil: 'autonomo' },
    ],
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

// segunda-feira fixa (não depende da data em que o teste roda)
const SEGUNDA_FUTURA = '2026-11-02';
const TERCA_FUTURA = '2026-11-03';

test('Início (Home, Refrigeração): gate por perfil, hoje/próximo, semana, ocupação do mês por técnico, solicitações da empresa inteira', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-home-refrigeracao-${Date.now()}.json`);
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
    const login = async (email) => {
      const r = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha: 'senha1234' }),
      });
      return (await r.json()).token;
    };
    const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    const tokenAdmin = await login('admin@refrigera.com');
    const tokenA = await login('tecA@refrigera.com');
    const tokenOutroPerfil = await login('admin@outroperfil.com');
    const authAdmin = auth(tokenAdmin);
    const authA = auth(tokenA);

    // gate por perfil
    const negaPerfil = await fetch(`${base}/api/os-refrigeracao-home/resumo?hoje=${SEGUNDA_FUTURA}`, { headers: auth(tokenOutroPerfil) });
    assert.equal(negaPerfil.status, 403);

    // sem `hoje`, recusa
    const semHoje = await fetch(`${base}/api/os-refrigeracao-home/resumo`, { headers: authA });
    assert.equal(semHoje.status, 400);

    // sem config nenhuma ainda: tudo zerado, ocupação 0
    const rVazio = await fetch(`${base}/api/os-refrigeracao-home/resumo?hoje=${SEGUNDA_FUTURA}`, { headers: authA });
    assert.equal(rVazio.status, 200);
    const vazio = await rVazio.json();
    assert.deepEqual(vazio.hoje, { total: 0, proximo: null });
    assert.deepEqual(vazio.semana, { total: 0, valor_total: 0 });
    assert.deepEqual(vazio.solicitacoes, { total: 0 });
    assert.deepEqual(vazio.ocupacao, { percentual: 0 });

    // configura a disponibilidade do técnico A (seg-sex, 08-18, pausa 12-13, 1h, máx 8/dia)
    await fetch(`${base}/api/os-refrigeracao-agenda/config`, {
      method: 'PUT', headers: authA, body: JSON.stringify({
        dias_semana: ['seg', 'ter', 'qua', 'qui', 'sex'], hora_inicio: '08:00', hora_fim: '18:00',
        pausa_ativa: true, pausa_inicio: '12:00', pausa_fim: '13:00', duracao_min: 60, max_por_dia: 8, datas_bloqueadas: [],
      }),
    });

    // dois agendamentos na segunda (hoje), um na terça (mesma semana)
    const criar = (corpo, headers) => fetch(`${base}/api/os-refrigeracao-agendamentos`, { method: 'POST', headers, body: JSON.stringify(corpo) });
    await criar({ cliente_nome: 'Cliente 10h', telefone: 'x', tipo_servico: 'instalacao', data: SEGUNDA_FUTURA, hora: '10:00', valor_servico: 200 }, authA);
    const rCriadoNove = await criar({ cliente_nome: 'Cliente 09h', telefone: 'x', tipo_servico: 'instalacao', data: SEGUNDA_FUTURA, hora: '09:00', valor_servico: 100 }, authA);
    const criadoNove = (await rCriadoNove.json()).agendamento;
    await criar({ cliente_nome: 'Cliente Terça', telefone: 'x', tipo_servico: 'instalacao', data: TERCA_FUTURA, hora: '08:00', valor_servico: 300 }, authA);

    const rResumo = await fetch(`${base}/api/os-refrigeracao-home/resumo?hoje=${SEGUNDA_FUTURA}`, { headers: authA });
    const resumo = await rResumo.json();
    // hoje: 2 agendamentos, "próximo" é o de horário mais cedo (09:00), não o criado primeiro
    assert.equal(resumo.hoje.total, 2);
    assert.deepEqual(resumo.hoje.proximo, { hora: '09:00', cliente_nome: 'Cliente 09h' });
    // semana (domingo a sábado contendo a segunda): 3 agendamentos, soma dos valores
    assert.equal(resumo.semana.total, 3);
    assert.equal(resumo.semana.valor_total, 600);
    // ocupação do mês > 0 agora que há agendamentos
    assert.ok(resumo.ocupacao.percentual > 0);

    // cancelar um agendamento de hoje tira ele da contagem (de "hoje" e de "semana")
    await fetch(`${base}/api/os-refrigeracao-agendamentos/${criadoNove.id}/status`, { method: 'PUT', headers: authA, body: JSON.stringify({ status: 'cancelado' }) });
    const rResumoDepois = await fetch(`${base}/api/os-refrigeracao-home/resumo?hoje=${SEGUNDA_FUTURA}`, { headers: authA });
    const resumoDepois = await rResumoDepois.json();
    assert.equal(resumoDepois.hoje.total, 1);
    assert.deepEqual(resumoDepois.hoje.proximo, { hora: '10:00', cliente_nome: 'Cliente 10h' });
    assert.equal(resumoDepois.semana.total, 2);
    assert.equal(resumoDepois.semana.valor_total, 500);

    // ---- solicitações: orçamentos em rascunho, da EMPRESA INTEIRA (não por técnico) ----
    const rCliente = await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authA, body: JSON.stringify({ nome: 'Cliente Orçamento' }) });
    const cliente = (await rCliente.json()).cliente;
    await fetch(`${base}/api/os-refrigeracao-orcamentos`, {
      method: 'POST', headers: authA, body: JSON.stringify({
        cliente_id: cliente.id, titulo: 'Orçamento pendente', servicos: [{ descricao: 'Instalação', valor: 100 }], materiais: [],
      }),
    });
    // administrador (que não tem agenda própria configurada) já vê a solicitação, mesmo sem ser o
    // autor do orçamento nem ter agenda — confirma que não é escopado por técnico.
    const rResumoAdmin = await fetch(`${base}/api/os-refrigeracao-home/resumo?hoje=${SEGUNDA_FUTURA}`, { headers: authAdmin });
    const resumoAdmin = await rResumoAdmin.json();
    assert.equal(resumoAdmin.solicitacoes.total, 1);
    // a agenda do admin (hoje/semana/ocupação) continua isolada da do técnico A
    assert.equal(resumoAdmin.hoje.total, 0);
    assert.equal(resumoAdmin.ocupacao.percentual, 0);

    // sem token nenhum, 401
    const semToken = await fetch(`${base}/api/os-refrigeracao-home/resumo?hoje=${SEGUNDA_FUTURA}`);
    assert.equal(semToken.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
