// pedido do usuário (perfil "Refrigeração e Climatização", referência: app concorrente iClima) —
// 4º atalho construído do zero pra esse perfil: Agenda, com uma configuração de disponibilidade
// POR TÉCNICO (dias de atendimento, horário, pausa, duração do atendimento, máx. por dia, datas
// bloqueadas) que gera a grade de horários do dia; o agendamento manual só pode ser criado num
// horário que a grade devolve como disponível. Diferente da O.S./Orçamento, não usa o cadastro
// os_refrigeracao_clientes — o agendamento guarda nome/telefone/endereço direto. Prova pela API
// HTTP de verdade: gate por `perfil`, upsert da config (própria e, só pro administrador, em nome
// de outro técnico), geração da grade (dia da semana fora do atendimento, data bloqueada, pausa,
// máx. por dia, horário já ocupado), criação só em horário disponível, status, exclusão, e
// isolamento entre técnicos (suporte só vê/mexe na própria agenda).
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
      { id: 3, nome: 'Tecnico B', email: 'tecB@refrigera.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 4, nome: 'Admin Outro Perfil', email: 'admin@outroperfil.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    _seq: {
      usuarios: 5, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
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

// uma segunda-feira (dia 'seg') — fixo, pra não depender da data em que o teste roda.
const SEGUNDA_FUTURA = '2026-11-02';
const DOMINGO_FUTURO = '2026-11-01';

test('Agenda (Refrigeração): gate por perfil, config por técnico, grade de horários, agendamento só em horário disponível, status e isolamento entre técnicos', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-agenda-refrigeracao-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 43900 + Math.floor(Math.random() * 900);

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
    const tokenB = await login('tecB@refrigera.com');
    const tokenOutroPerfil = await login('admin@outroperfil.com');
    const authAdmin = auth(tokenAdmin);
    const authA = auth(tokenA);
    const authB = auth(tokenB);

    // gate por Perfil
    const negaPerfil = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { headers: auth(tokenOutroPerfil) });
    assert.equal(negaPerfil.status, 403);

    // sem config ainda, devolve null (front mostra "Configure sua agenda")
    const rConfigVazia = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { headers: authA });
    assert.equal(rConfigVazia.status, 200);
    assert.equal((await rConfigVazia.json()).config, null);

    // validações
    const semDias = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { method: 'PUT', headers: authA, body: JSON.stringify({ dias_semana: [], hora_inicio: '08:00', hora_fim: '18:00', duracao_min: 60 }) });
    assert.equal(semDias.status, 400);
    const horarioInvertido = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { method: 'PUT', headers: authA, body: JSON.stringify({ dias_semana: ['seg'], hora_inicio: '18:00', hora_fim: '08:00', duracao_min: 60 }) });
    assert.equal(horarioInvertido.status, 400);

    // configura a disponibilidade do técnico A: seg-sex, 08-18, pausa 12-13, 1h, máx 8/dia, 1 data bloqueada
    const corpoConfig = {
      dias_semana: ['seg', 'ter', 'qua', 'qui', 'sex'],
      hora_inicio: '08:00', hora_fim: '18:00',
      pausa_ativa: true, pausa_inicio: '12:00', pausa_fim: '13:00',
      duracao_min: 60, max_por_dia: 8,
      datas_bloqueadas: ['2026-11-09'],
    };
    const rConfig = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { method: 'PUT', headers: authA, body: JSON.stringify(corpoConfig) });
    assert.equal(rConfig.status, 200);
    const config = (await rConfig.json()).config;
    assert.deepEqual(config.dias_semana.sort(), ['qua', 'qui', 'seg', 'sex', 'ter'].sort());
    assert.equal(config.max_por_dia, 8);

    // ---- grade de horários (SEGUNDA_FUTURA é segunda-feira) ----
    const rSlots = await fetch(`${base}/api/os-refrigeracao-agenda/slots?data=${SEGUNDA_FUTURA}`, { headers: authA });
    assert.equal(rSlots.status, 200);
    const { config_existe, slots } = await rSlots.json();
    assert.equal(config_existe, true);
    // 08-09,09-10,10-11,11-12,12-13(pausa),13-14,14-15,15-16,16-17,17-18 = 10 slots, 9 não-pausa
    assert.equal(slots.length, 10);
    const naoPausa = slots.filter((s) => !s.pausa);
    assert.equal(naoPausa.length, 9);
    const slotPausa = slots.find((s) => s.hora === '12:00');
    assert.equal(slotPausa.pausa, true);
    assert.equal(slotPausa.disponivel, false);
    // máx. por dia = 8: só os 8 primeiros não-pausa ficam disponíveis, o 9º (17:00) não
    assert.equal(slots.find((s) => s.hora === '08:00').disponivel, true);
    assert.equal(slots.find((s) => s.hora === '17:00').disponivel, false);

    // domingo não é dia de atendimento -> grade vazia
    const rSlotsDomingo = await fetch(`${base}/api/os-refrigeracao-agenda/slots?data=${DOMINGO_FUTURO}`, { headers: authA });
    assert.equal((await rSlotsDomingo.json()).slots.length, 0);

    // data bloqueada -> grade vazia
    const rSlotsBloqueada = await fetch(`${base}/api/os-refrigeracao-agenda/slots?data=2026-11-09`, { headers: authA });
    assert.equal((await rSlotsBloqueada.json()).slots.length, 0);

    // ---- resumo do mês (calendário — "X/Y" por dia, ver renderMesAgendaRef em app.js) ----
    const rResumoMesAntes = await fetch(`${base}/api/os-refrigeracao-agenda/resumo-mes?mes=2026-11`, { headers: authA });
    assert.equal(rResumoMesAntes.status, 200);
    const resumoAntes = (await rResumoMesAntes.json()).dias;
    // segunda-feira: capacidade 8 (máx. por dia), nenhum agendamento ainda
    assert.deepEqual(resumoAntes[SEGUNDA_FUTURA], { total: 8, agendados: 0 });
    // domingo não tem atendimento -> nem aparece no mapa
    assert.equal(resumoAntes[DOMINGO_FUTURO], undefined);
    // data bloqueada (09/11, uma segunda) também não aparece
    assert.equal(resumoAntes['2026-11-09'], undefined);

    // ---- agendamento manual ----
    const corpoAgendamento = {
      cliente_nome: 'João Silva', telefone: '(12) 98882-8780', endereco: 'Rua Durango, 230',
      tipo_servico: 'instalacao', data: SEGUNDA_FUTURA, hora: '09:00', valor_servico: 350, observacoes: 'Levar escada',
    };
    // sem nome, recusa
    const semNome = await fetch(`${base}/api/os-refrigeracao-agendamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoAgendamento, cliente_nome: '' }) });
    assert.equal(semNome.status, 400);
    // horário na pausa, recusa
    const naPausa = await fetch(`${base}/api/os-refrigeracao-agendamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoAgendamento, hora: '12:00' }) });
    assert.equal(naPausa.status, 400);
    // horário além do máx. por dia (17:00, o 9º não-pausa), recusa
    const alemDoLimite = await fetch(`${base}/api/os-refrigeracao-agendamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoAgendamento, hora: '17:00' }) });
    assert.equal(alemDoLimite.status, 400);
    // data bloqueada, recusa
    const dataBloqueada = await fetch(`${base}/api/os-refrigeracao-agendamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoAgendamento, data: '2026-11-09' }) });
    assert.equal(dataBloqueada.status, 400);

    const rCriar = await fetch(`${base}/api/os-refrigeracao-agendamentos`, { method: 'POST', headers: authA, body: JSON.stringify(corpoAgendamento) });
    assert.equal(rCriar.status, 201);
    const criado = (await rCriar.json()).agendamento;
    assert.equal(criado.tecnico_id, 2);
    assert.equal(criado.tecnico_nome, 'Tecnico A');
    assert.equal(criado.status, 'agendado');
    const agendamentoId = criado.id;

    // resumo do mês reflete o agendamento recém-criado
    const rResumoMesDepois = await fetch(`${base}/api/os-refrigeracao-agenda/resumo-mes?mes=2026-11`, { headers: authA });
    assert.deepEqual((await rResumoMesDepois.json()).dias[SEGUNDA_FUTURA], { total: 8, agendados: 1 });

    // horário já ocupado agora recusa de novo
    const jaOcupado = await fetch(`${base}/api/os-refrigeracao-agendamentos`, { method: 'POST', headers: authA, body: JSON.stringify(corpoAgendamento) });
    assert.equal(jaOcupado.status, 400);

    // a grade agora marca 09:00 como ocupado/indisponível
    const rSlotsDepois = await fetch(`${base}/api/os-refrigeracao-agenda/slots?data=${SEGUNDA_FUTURA}`, { headers: authA });
    const slotOcupado = (await rSlotsDepois.json()).slots.find((s) => s.hora === '09:00');
    assert.equal(slotOcupado.ocupado, true);
    assert.equal(slotOcupado.disponivel, false);

    // ---- isolamento: técnico B não vê o agendamento do técnico A ----
    const { agendamentos: listaB } = await (await fetch(`${base}/api/os-refrigeracao-agendamentos?data=${SEGUNDA_FUTURA}`, { headers: authB })).json();
    assert.equal(listaB.length, 0);
    // nem a config do técnico A
    const rConfigB = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { headers: authB });
    assert.equal((await rConfigB.json()).config, null);
    // técnico B não pode mexer na agenda do técnico A
    const negaTecnicoB = await fetch(`${base}/api/os-refrigeracao-agenda/config?tecnico_id=2`, { headers: authB });
    assert.equal(negaTecnicoB.status, 403);

    // administrador vê e consegue mexer na agenda de qualquer técnico, passando tecnico_id
    const { agendamentos: listaAdmin } = await (await fetch(`${base}/api/os-refrigeracao-agendamentos?data=${SEGUNDA_FUTURA}&tecnico_id=2`, { headers: authAdmin })).json();
    assert.equal(listaAdmin.length, 1);
    const { agendamentos: listaAdminTodos } = await (await fetch(`${base}/api/os-refrigeracao-agendamentos?data=${SEGUNDA_FUTURA}`, { headers: authAdmin })).json();
    assert.equal(listaAdminTodos.length, 1); // sem filtro, administrador vê de todos os técnicos

    // administrador configura a agenda do técnico B em nome dele
    const rConfigAdminParaB = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ ...corpoConfig, tecnico_id: 3 }) });
    assert.equal(rConfigAdminParaB.status, 200);
    const rConfigBDepois = await fetch(`${base}/api/os-refrigeracao-agenda/config`, { headers: authB });
    assert.ok((await rConfigBDepois.json()).config);

    // ---- status (menu "⋮") ----
    const statusInvalido = await fetch(`${base}/api/os-refrigeracao-agendamentos/${agendamentoId}/status`, { method: 'PUT', headers: authA, body: JSON.stringify({ status: 'em-andamento' }) });
    assert.equal(statusInvalido.status, 400);
    // técnico B não pode mudar status do agendamento do técnico A
    const negaStatusB = await fetch(`${base}/api/os-refrigeracao-agendamentos/${agendamentoId}/status`, { method: 'PUT', headers: authB, body: JSON.stringify({ status: 'concluido' }) });
    assert.equal(negaStatusB.status, 403);
    const rConcluir = await fetch(`${base}/api/os-refrigeracao-agendamentos/${agendamentoId}/status`, { method: 'PUT', headers: authA, body: JSON.stringify({ status: 'concluido' }) });
    assert.equal(rConcluir.status, 200);
    assert.equal((await rConcluir.json()).agendamento.status, 'concluido');
    // administrador também pode (mesmo não sendo o técnico)
    const rCancelarAdmin = await fetch(`${base}/api/os-refrigeracao-agendamentos/${agendamentoId}/status`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ status: 'cancelado' }) });
    assert.equal(rCancelarAdmin.status, 200);

    // cancelar libera o horário de novo (não conta mais como ocupado)
    const rSlotsAposCancelar = await fetch(`${base}/api/os-refrigeracao-agenda/slots?data=${SEGUNDA_FUTURA}`, { headers: authA });
    const slotLiberado = (await rSlotsAposCancelar.json()).slots.find((s) => s.hora === '09:00');
    assert.equal(slotLiberado.ocupado, false);
    assert.equal(slotLiberado.disponivel, true);

    // ---- exclusão ----
    const rExcluir = await fetch(`${base}/api/os-refrigeracao-agendamentos/${agendamentoId}`, { method: 'DELETE', headers: authA });
    assert.equal(rExcluir.status, 200);
    const { agendamentos: depoisExcluir } = await (await fetch(`${base}/api/os-refrigeracao-agendamentos?data=${SEGUNDA_FUTURA}`, { headers: authAdmin })).json();
    assert.equal(depoisExcluir.length, 0);

    // sem token nenhum, 401
    const semToken = await fetch(`${base}/api/os-refrigeracao-agendamentos`);
    assert.equal(semToken.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
