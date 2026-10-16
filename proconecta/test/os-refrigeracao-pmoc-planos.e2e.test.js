// pedido do usuário: pacote "Climatização / PMOC", Fase 2 — Plano e preventivas. Prova pela API
// HTTP de verdade: Modelo de Checklist (lazy-seed com os itens da Lei 13.589/2018 na primeira
// consulta + CRUD), Plano PMOC por local (1 por local, itens pré-preenchidos do modelo), ativação
// gerando as visitas dos PRÓXIMOS 3 MESES na Agenda já existente (os_refrigeracao_agendamentos,
// sem técnico — "entram na agenda geral sem técnico definido"), periodicidade correta (mensal
// sempre, trimestral só a cada 3 meses, e só nos aparelhos do tipo certo quando o item restringe),
// idempotência da geração, designação de técnico respeitando a grade/cota (só administrador),
// recálculo ao editar o plano ativo (preserva visita já iniciada/no passado, regenera só as
// futuras ainda pendentes) e vencimento automático por data (lazy, igual trial expirado).
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
      { id: 1, nome: 'Admin PMOC', email: 'admin@pmoc2.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico PMOC', email: 'tec@pmoc2.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    _seq: {
      usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
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

test('PMOC (Fase 2 — Plano e preventivas): modelo de checklist, plano por local, geração automática (periodicidade/tipo de aparelho/idempotência), designação de técnico, recálculo e vencimento', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-planos-${Date.now()}.json`);
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
    const login = async (email) => {
      const r = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha: 'senha1234' }),
      });
      return (await r.json()).token;
    };
    const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    const authAdmin = auth(await login('admin@pmoc2.com'));
    const authTecnico = auth(await login('tec@pmoc2.com'));

    // ---- modelo de checklist: lazy-seed na primeira consulta ----
    const rModelo = await fetch(`${base}/api/pmoc/modelo-checklist`, { headers: authAdmin });
    const modelo = (await rModelo.json()).itens;
    assert.equal(modelo.length, 16); // 6 mensal + 4 trimestral + 4 semestral + 2 anual (Lei 13.589/2018)
    assert.equal(modelo.filter((i) => i.periodicidade === 'mensal').length, 6);
    assert.equal(modelo.filter((i) => i.periodicidade === 'anual').length, 2);
    // consulta de novo não duplica (idempotente).
    const rModelo2 = await fetch(`${base}/api/pmoc/modelo-checklist`, { headers: authAdmin });
    assert.equal((await rModelo2.json()).itens.length, 16);

    // CRUD do modelo.
    const rNovoItem = await fetch(`${base}/api/pmoc/modelo-checklist`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ descricao: 'Item customizado', periodicidade: 'mensal', tipos_aparelho: [] }) });
    assert.equal(rNovoItem.status, 201);
    const itemNovo = (await rNovoItem.json()).item;
    const rEditaItem = await fetch(`${base}/api/pmoc/modelo-checklist/${itemNovo.id}`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ descricao: 'Item editado', periodicidade: 'anual', tipos_aparelho: [] }) });
    assert.equal((await rEditaItem.json()).item.descricao, 'Item editado');
    const rExcluiItem = await fetch(`${base}/api/pmoc/modelo-checklist/${itemNovo.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(rExcluiItem.status, 200);

    // ---- cadastro base: cliente → local → ambiente → 2 aparelhos de tipos diferentes ----
    const cliente = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Loja Teste Ltda' }) })).json()).cliente;
    const local = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Loja Teste', tipo_atividade: 'loja' }) })).json()).local;
    const ambiente = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Salão' }) })).json()).ambiente;
    const apSplit = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'Split hi-wall' }) })).json()).aparelho;
    const apCassete = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'Cassete' }) })).json()).aparelho;
    const responsavel = (await (await fetch(`${base}/api/pmoc/responsaveis-tecnicos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Resp. Teste' }) })).json()).responsavel;

    // ---- plano: 1 item mensal (todos os tipos) + 1 item trimestral (só Cassete) ----
    const semLocal = await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ data_inicio: '2026-01-10' }) });
    assert.equal(semLocal.status, 400);
    const semData = await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id }) });
    assert.equal(semData.status, 400);

    const rPlano = await fetch(`${base}/api/pmoc/planos`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        local_id: local.id, responsavel_tecnico_id: responsavel.id, data_inicio: '2026-01-10', vigencia_meses: 6,
        itens: [
          { descricao: 'Limpeza de filtros', periodicidade: 'mensal', tipos_aparelho: [] },
          { descricao: 'Limpeza da serpentina', periodicidade: 'trimestral', tipos_aparelho: ['Cassete'] },
        ],
      }),
    });
    assert.equal(rPlano.status, 201);
    const plano = (await rPlano.json()).plano;
    assert.equal(plano.status, 'rascunho');

    // mesmo local já tem plano — bloqueia criar outro.
    const rDuplicado = await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, data_inicio: '2026-01-10' }) });
    assert.equal(rDuplicado.status, 409);

    // ---- ativação: gera os próximos 3 meses a partir de "hoje" (2026-03-05, diff 2/3/4 do início) ----
    const rAtivar = await fetch(`${base}/api/pmoc/planos/${plano.id}/ativar?hoje=2026-03-05`, { method: 'PUT', headers: authAdmin });
    assert.equal(rAtivar.status, 200);
    assert.equal((await rAtivar.json()).plano.status, 'ativo');

    const rDetalhe = await fetch(`${base}/api/pmoc/planos/${plano.id}?hoje=2026-03-05`, { headers: authAdmin });
    const detalhe = await rDetalhe.json();
    assert.equal(detalhe.visitas.length, 3);
    const porData = Object.fromEntries(detalhe.visitas.map((v) => [v.data, v]));
    // março (diff=2 do início): só o item mensal, nos 2 aparelhos → 2 itens.
    assert.equal(porData['2026-03-10'].pmoc_itens.length, 2);
    assert.ok(porData['2026-03-10'].pmoc_itens.every((i) => i.item_descricao === 'Limpeza de filtros'));
    // abril (diff=3, múltiplo de 3): mensal (2 aparelhos) + trimestral só no Cassete (1) → 3 itens.
    assert.equal(porData['2026-04-10'].pmoc_itens.length, 3);
    assert.equal(porData['2026-04-10'].pmoc_itens.filter((i) => i.item_descricao === 'Limpeza da serpentina').length, 1);
    assert.equal(porData['2026-04-10'].pmoc_itens.find((i) => i.item_descricao === 'Limpeza da serpentina').aparelho_id, apCassete.id);
    // maio (diff=4): só mensal de novo → 2 itens.
    assert.equal(porData['2026-05-10'].pmoc_itens.length, 2);
    // todas nascem sem técnico, na Agenda geral.
    for (const v of detalhe.visitas) { assert.equal(v.status, 'pendente_designacao'); assert.equal(v.tecnico_id, null); assert.equal(v.tipo_servico, 'manutencao_preventiva'); }

    // ---- idempotência: consultar nos meses seguintes não duplica o que já existe ----
    await fetch(`${base}/api/pmoc/planos?hoje=2026-03-05`, { headers: authAdmin });
    await fetch(`${base}/api/pmoc/planos?hoje=2026-03-05`, { headers: authAdmin });
    const rDetalhe2 = await fetch(`${base}/api/pmoc/planos/${plano.id}?hoje=2026-03-05`, { headers: authAdmin });
    assert.equal((await rDetalhe2.json()).visitas.length, 3);

    // ---- designação de técnico: só administrador, respeita a grade do técnico ----
    const rPendentesSemAcesso = await fetch(`${base}/api/pmoc/visitas-pendentes?hoje=2026-03-05`, { headers: authTecnico });
    assert.equal(rPendentesSemAcesso.status, 403);
    const rPendentes = await fetch(`${base}/api/pmoc/visitas-pendentes?hoje=2026-03-05`, { headers: authAdmin });
    const pendentes = (await rPendentes.json()).visitas;
    assert.equal(pendentes.length, 3);
    const visitaMarco = pendentes.find((v) => v.data === '2026-03-10');

    // sem agenda configurada pro técnico ainda.
    const rDesignarSemConfig = await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaMarco.id}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '08:00' }) });
    assert.equal(rDesignarSemConfig.status, 400);

    await fetch(`${base}/api/os-refrigeracao-agenda/config`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({
        dias_semana: ['seg', 'ter', 'qua', 'qui', 'sex'], hora_inicio: '08:00', hora_fim: '12:00',
        pausa_ativa: false, duracao_min: 60, max_por_dia: 4, datas_bloqueadas: [],
      }),
    });
    const rDesignarHoraRuim = await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaMarco.id}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '23:00' }) });
    assert.equal(rDesignarHoraRuim.status, 400);
    const rDesignar = await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaMarco.id}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '09:00' }) });
    assert.equal(rDesignar.status, 200);
    const designada = (await rDesignar.json()).visita;
    assert.equal(designada.status, 'agendado');
    assert.equal(designada.tecnico_nome, 'Tecnico PMOC');
    // já designada não pode ser designada de novo.
    const rDesignarDeNovo = await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaMarco.id}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '10:00' }) });
    assert.equal(rDesignarDeNovo.status, 400);
    // some da fila de pendentes.
    const rPendentesDepois = await fetch(`${base}/api/pmoc/visitas-pendentes?hoje=2026-03-05`, { headers: authAdmin });
    assert.equal((await rPendentesDepois.json()).visitas.length, 2);

    // ---- recálculo: editar o plano ativo regenera só as visitas futuras ainda não iniciadas ----
    // "hoje" passa a ser depois da visita de março (já designada) — ela deve ficar intacta; as de
    // abril/maio (ainda pendentes) são apagadas e geradas de novo com o item novo.
    const rEditaPlano = await fetch(`${base}/api/pmoc/planos/${plano.id}?hoje=2026-03-20`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({
        responsavel_tecnico_id: responsavel.id, data_inicio: '2026-01-10', vigencia_meses: 6,
        itens: [{ descricao: 'Item único pós-edição', periodicidade: 'mensal', tipos_aparelho: [] }],
      }),
    });
    assert.equal(rEditaPlano.status, 200);
    const rDetalhe3 = await fetch(`${base}/api/pmoc/planos/${plano.id}?hoje=2026-03-20`, { headers: authAdmin });
    const detalhe3 = await rDetalhe3.json();
    const visitaMarcoDepois = detalhe3.visitas.find((v) => v.data === '2026-03-10');
    // a de março continua a mesma (status agendado, técnico mantido, itens antigos preservados).
    assert.equal(visitaMarcoDepois.id, visitaMarco.id);
    assert.equal(visitaMarcoDepois.status, 'agendado');
    assert.equal(visitaMarcoDepois.tecnico_nome, 'Tecnico PMOC');
    assert.equal(visitaMarcoDepois.pmoc_itens[0].item_descricao, 'Limpeza de filtros'); // snapshot antigo, não mudou
    // abril (ainda pendente) foi regenerada com o item novo do plano editado.
    const visitaAbrilDepois = detalhe3.visitas.find((v) => v.data === '2026-04-10');
    assert.ok(visitaAbrilDepois);
    assert.equal(visitaAbrilDepois.status, 'pendente_designacao');
    assert.ok(visitaAbrilDepois.pmoc_itens.every((i) => i.item_descricao === 'Item único pós-edição'));

    // ---- vencimento automático (lazy, igual trial expirado) ----
    const rLocal2 = await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Loja Vencida', tipo_atividade: 'loja' }) });
    const local2 = (await rLocal2.json()).local;
    const plano2 = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local2.id, data_inicio: '2025-01-01', vigencia_meses: 1, itens: [{ descricao: 'X', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${plano2.id}/ativar?hoje=2025-01-05`, { method: 'PUT', headers: authAdmin });
    const rPlanos = await fetch(`${base}/api/pmoc/planos?hoje=2026-03-20`, { headers: authAdmin });
    const planos = (await rPlanos.json()).planos;
    assert.equal(planos.find((p) => p.id === plano2.id).status, 'vencido');

    // ---- plano que ainda não começou: ativação não gera visita nenhuma (janela de 3 meses não alcança o início) ----
    const rLocal3 = await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Loja Futura', tipo_atividade: 'loja' }) });
    const local3 = (await rLocal3.json()).local;
    const plano3 = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local3.id, data_inicio: '2027-01-10', itens: [{ descricao: 'Y', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    const rAtivar3 = await fetch(`${base}/api/pmoc/planos/${plano3.id}/ativar?hoje=2026-03-20`, { method: 'PUT', headers: authAdmin });
    assert.equal((await rAtivar3.json()).plano.status, 'ativo');
    const rDetalhe4 = await fetch(`${base}/api/pmoc/planos/${plano3.id}?hoje=2026-03-20`, { headers: authAdmin });
    assert.deepEqual((await rDetalhe4.json()).visitas, []);

    // ---- gate: perfil + módulo (mesma checagem das rotas da Fase 1) ----
    const semToken = await fetch(`${base}/api/pmoc/planos?hoje=2026-03-20`);
    assert.equal(semToken.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
