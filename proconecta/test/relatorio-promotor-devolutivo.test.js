// teste de ponta a ponta dos três relatórios do fluxo de Demonstração Técnica: "Promotor"
// (Briefing Pré-Visita, o administrador/vendedor prepara antes da visita), "Devolutivo" (o
// técnico/promotor devolve o resultado depois, incluindo a oportunidade adicional de
// automação/retrofit) e "Levantamento Técnico" (segunda visita, de engenharia, vinculado ao
// Devolutivo que sinalizou a oportunidade). Sobe o server.js de verdade contra um data.json
// descartável, mesmo padrão de test/dispatcher-modulo.e2e.test.js.
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
      { id: 1, nome: 'Admin Vendedor', email: 'admin@teste-promotor.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Técnico Promotor', email: 'tecnico@teste-promotor.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [{ id: 1, nome_empresa: 'Cliente Demo', empresa_id: 1, contato: 'Fulano', telefone: '' }],
    equipamentos: [], visitas: [],
    agenda: [{
      id: 1, empresa_id: 1, numero_os: 'OS-0001', tecnico_id: 2, cliente_id: 1, equipamento_id: null,
      tipo: 'demonstracao_tecnica', categoria: 'presencial', status: 'pendente', finalizada: false,
      data_hora_inicio: '2026-10-01T10:00', data_hora_fim: '2026-10-01T11:00',
      contato: 'Fulano', telefone: '', email: '', criado_em: new Date().toISOString(),
    }],
    _seq: { usuarios: 3, clientes: 2, equipamentos: 1, agenda: 2, visitas: 1 },
    empresas: [{
      id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [],
      cor_primaria: '#000', cor_secundaria: '#000',
      versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {},
    }],
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

test('Promotor, Devolutivo e Levantamento Técnico: papéis, vínculo com O.S./Devolutivo e oportunidade adicional', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-promotor-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 33000 + Math.floor(Math.random() * 900);

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
    const tokenAdmin = await login('admin@teste-promotor.com');
    const tokenTecnico = await login('tecnico@teste-promotor.com');
    const authAdmin = { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' };
    const authTecnico = { Authorization: `Bearer ${tokenTecnico}`, 'Content-Type': 'application/json' };

    // ---------- administrador cria o Briefing "Promotor", vinculado à O.S. ----------
    const briefingIncompleto = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ tipo: 'promotor', empresa: 'Cliente Demo' }),
    });
    assert.equal(briefingIncompleto.status, 400);

    const briefingResp = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({
        tipo: 'promotor', agenda_id: 1,
        empresa: 'Cliente Demo', contato: '', data_visita: '2026-09-18',
        vendedor: 'Admin Vendedor', promotor: 'Técnico Promotor',
        motivo_visita: 'Demonstração de gravação MP80P',
        processo_atual: 'Gravação manual com caneta',
        necessidade_informada: 'Qualidade de gravação pra rastreabilidade',
        o_que_demonstrar: 'MP5 80P', ponto_importante_demo: 'Qualidade dentro do tempo aceitável',
        duvidas_preocupacoes: 'Nenhuma no momento', concorrente: 'Sem concorrência no momento',
        o_que_observar: 'Possibilidade de integração futura',
        objetivo_visita: 'Aprovar qualidade de gravação',
        ponto_principal_observar: 'Tempo de ciclo',
      }),
    });
    assert.equal(briefingResp.status, 201);
    const { relatorio: briefing } = await briefingResp.json();
    assert.equal(briefing.tipo, 'promotor');
    assert.equal(briefing.agenda_id, 1);
    assert.equal(briefing.autor_id, 1);

    // administrador só cria "Promotor" — qualquer outro tipo é rejeitado
    const bloqueado = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ tipo: 'completo', empresa: 'X', equipamento: 'Y' }),
    });
    assert.equal(bloqueado.status, 403);
    const bloqueadoDevolutivo = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ tipo: 'devolutivo', empresa: 'Cliente Demo' }),
    });
    assert.equal(bloqueadoDevolutivo.status, 403);

    // administrador vê o próprio briefing na lista "meus"
    const listaAdmin = await (await fetch(`${base}/api/relatorios-manutencao/meus`, { headers: authAdmin })).json();
    assert.equal(listaAdmin.relatorios.length, 1);
    assert.equal(listaAdmin.relatorios[0].tipo, 'promotor');

    // administrador edita o próprio briefing
    const editarResp = await fetch(`${base}/api/relatorios-manutencao/${briefing.id}`, {
      method: 'PUT', headers: authAdmin,
      body: JSON.stringify({ ...briefing, objetivo_visita: 'Objetivo atualizado' }),
    });
    assert.equal(editarResp.status, 200);
    const { relatorio: briefingEditado } = await editarResp.json();
    assert.equal(briefingEditado.objetivo_visita, 'Objetivo atualizado');

    // ---------- técnico (promotor em campo) cria o Relatório Devolutivo ----------
    // sem responder se identificou oportunidade adicional: rejeitado
    const devolutivoSemResposta = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({
        tipo: 'devolutivo', agenda_id: 1, empresa: 'Cliente Demo', data_visita: '2026-10-01',
        promotor: 'Técnico Promotor', equipamento_demonstrado: 'MP5 80P',
        resultado_demonstracao: 'aprovado', feedback_cliente: 'Cliente gostou muito',
      }),
    });
    assert.equal(devolutivoSemResposta.status, 400);

    // respondeu "sim" mas sem detalhar a oportunidade: rejeitado
    const devolutivoSemDetalhe = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({
        tipo: 'devolutivo', agenda_id: 1, empresa: 'Cliente Demo', data_visita: '2026-10-01',
        promotor: 'Técnico Promotor', equipamento_demonstrado: 'MP5 80P',
        resultado_demonstracao: 'aprovado', feedback_cliente: 'Cliente gostou muito',
        identificou_oportunidade_adicional: true,
      }),
    });
    assert.equal(devolutivoSemDetalhe.status, 400);

    // devolutivo completo, com a oportunidade de automação identificada — é exatamente o cenário
    // que o usuário pediu: visita de demonstração revela necessidade de automação/retrofit
    const devolutivoResp = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({
        tipo: 'devolutivo', agenda_id: 1, empresa: 'Cliente Demo', contato: 'Fulano', data_visita: '2026-10-01',
        promotor: 'Técnico Promotor', equipamento_demonstrado: 'MP5 80P',
        resultado_demonstracao: 'aprovado', feedback_cliente: 'Cliente aprovou a qualidade da gravação',
        pontos_positivos: 'Rapidez e qualidade', pontos_ajuste: '',
        identificou_oportunidade_adicional: true,
        tipo_oportunidade: ['automacao', 'retrofit'],
        descricao_oportunidade: 'Cliente quer integrar a gravação dentro da célula de solda automatizada',
        valor_agregado: 'Pode virar uma venda de equipamento personalizado com automação embarcada',
        proximos_passos: 'Agendar visita técnica de engenharia',
      }),
    });
    assert.equal(devolutivoResp.status, 201);
    const { relatorio: devolutivo } = await devolutivoResp.json();
    assert.equal(devolutivo.tipo, 'devolutivo');
    assert.equal(devolutivo.agenda_id, 1);
    assert.equal(devolutivo.identificou_oportunidade_adicional, true);
    assert.deepEqual(devolutivo.tipo_oportunidade.sort(), ['automacao', 'retrofit'].sort());
    assert.equal(devolutivo.autor_id, 2);

    // técnico também pode criar "Promotor" (não é exclusivo do administrador)
    const promotorPorTecnico = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({
        tipo: 'promotor', empresa: 'Outro Cliente', data_visita: '2026-11-01',
        vendedor: 'Técnico Promotor', promotor: 'Técnico Promotor',
        motivo_visita: 'x', processo_atual: 'x', necessidade_informada: 'x',
        o_que_demonstrar: 'x', ponto_importante_demo: 'x',
        duvidas_preocupacoes: 'x', concorrente: 'x', o_que_observar: 'x',
        objetivo_visita: 'x', ponto_principal_observar: 'x',
      }),
    });
    assert.equal(promotorPorTecnico.status, 201);

    // ---------- Levantamento Técnico (segunda visita, de engenharia), vinculado ao Devolutivo ----------
    const levantamentoIncompleto = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ tipo: 'levantamento_tecnico', empresa: 'Cliente Demo' }),
    });
    assert.equal(levantamentoIncompleto.status, 400);

    // administrador NÃO pode criar levantamento técnico (só o Promotor é liberado pra ele)
    const levantamentoPorAdmin = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ tipo: 'levantamento_tecnico', empresa: 'Cliente Demo' }),
    });
    assert.equal(levantamentoPorAdmin.status, 403);

    const levantamentoResp = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({
        tipo: 'levantamento_tecnico', agenda_id: 1, devolutivo_id: devolutivo.id,
        empresa: 'Cliente Demo', contato: 'Fulano', data_levantamento: '2026-10-15',
        responsavel_tecnico: 'Técnico Promotor',
        tempo_ciclo_atual: '12s por peça', volume_producao: '800 peças/turno',
        material_peca: 'Aço inox, 40x40mm',
        automacao_existente: 'PLC Siemens S7-1200, sem robô',
        integracao_necessaria: 'Integrar gravação dentro da célula de solda existente',
        espaco_disponivel: '1,2m x 0,8m ao lado da célula',
        escopo_proposto: 'Gravador automatizado integrado ao PLC da célula de solda',
        viabilidade_tecnica: 'viavel_com_ressalvas',
        proximos_passos: 'Elaborar proposta técnica com cronograma',
      }),
    });
    assert.equal(levantamentoResp.status, 201);
    const { relatorio: levantamento } = await levantamentoResp.json();
    assert.equal(levantamento.tipo, 'levantamento_tecnico');
    assert.equal(levantamento.devolutivo_id, devolutivo.id);
    assert.equal(levantamento.agenda_id, 1);
    assert.equal(levantamento.viabilidade_tecnica, 'viavel_com_ressalvas');

    // técnico não vê o briefing do administrador na própria lista "meus" (cada um só vê o que
    // criou), e o administrador não vê os relatórios do técnico
    const listaTecnico = await (await fetch(`${base}/api/relatorios-manutencao/meus`, { headers: authTecnico })).json();
    assert.equal(listaTecnico.relatorios.length, 3);
    assert.ok(listaTecnico.relatorios.every((r) => r.autor_id === 2));
    const listaAdminFinal = await (await fetch(`${base}/api/relatorios-manutencao/meus`, { headers: authAdmin })).json();
    assert.equal(listaAdminFinal.relatorios.length, 1);

    // administrador exclui o próprio briefing
    const excluirResp = await fetch(`${base}/api/relatorios-manutencao/${briefing.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(excluirResp.status, 200);
    const listaAposExcluir = await (await fetch(`${base}/api/relatorios-manutencao/meus`, { headers: authAdmin })).json();
    assert.equal(listaAposExcluir.relatorios.length, 0);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
