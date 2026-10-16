// pedido do usuário: pacote "Climatização / PMOC", Fase B (análise de concorrentes) — prova pela
// API HTTP de verdade: (1) faturamento do contrato recorrente do Plano PMOC — geração lazy (3
// meses rolantes, só quando valor_mensal/dia_vencimento estão configurados), marcar paga/desfazer,
// status "atrasada" lazy, filtro por status, integração com o Painel PMOC; (2) pesquisa de
// satisfação pública pós-visita — token por visita, idempotência (só responde uma vez), validação.
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
      { id: 1, nome: 'Admin Fase B', email: 'admin@pmocB.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico Fase B', email: 'tec@pmocB.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    os_refrigeracao_pmoc_qualidade_ar: [], os_refrigeracao_pmoc_config: [],
    os_refrigeracao_pmoc_gas_registros: [], os_refrigeracao_pmoc_faturas: [],
    _seq: {
      usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
      os_refrigeracao_pmoc_qualidade_ar: 1, os_refrigeracao_pmoc_config: 1,
      os_refrigeracao_pmoc_gas_registros: 1, os_refrigeracao_pmoc_faturas: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa B', site: '', whatsapp: '', telefone: '', emails: ['contato@climacertab.com'], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
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

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('PMOC (Fase B — análise de concorrentes): Faturamento (contrato recorrente) e pesquisa de satisfação pública', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-faseB-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 45000 + Math.floor(Math.random() * 900);

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
    const authAdmin = auth(await login('admin@pmocB.com'));
    const authTecnico = auth(await login('tec@pmocB.com'));

    // ---- cadastro base ----
    const cliente = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente Fase B' }) })).json()).cliente;

    // local COM contrato recorrente.
    const localCobrado = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Cobrado', tipo_atividade: 'loja' }) })).json()).local;
    const ambienteCobrado = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: localCobrado.id, nome: 'Salão' }) })).json()).ambiente;
    await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambienteCobrado.id, tipo: 'Split hi-wall', marca: 'Daikin' }) });
    const planoCobrado = (await (await fetch(`${base}/api/pmoc/planos`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        local_id: localCobrado.id, data_inicio: '2025-01-10', valor_mensal: 350.5, dia_vencimento: 10,
        itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }],
      }),
    })).json()).plano;
    assert.equal(planoCobrado.valor_mensal, 350.5);
    await fetch(`${base}/api/pmoc/planos/${planoCobrado.id}/ativar?hoje=2025-01-10`, { method: 'PUT', headers: authAdmin });

    // local SEM contrato recorrente (plano sem valor_mensal) — nunca deve gerar fatura.
    const localSemCobranca = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Sem Cobrança', tipo_atividade: 'loja' }) })).json()).local;
    const planoSemCobranca = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: localSemCobranca.id, data_inicio: '2025-01-10', itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    assert.equal(planoSemCobranca.valor_mensal, null);
    await fetch(`${base}/api/pmoc/planos/${planoSemCobranca.id}/ativar?hoje=2025-01-10`, { method: 'PUT', headers: authAdmin });

    // ---- faturamento: acesso só administrador ----
    const rFaturasSoTecnico = await fetch(`${base}/api/pmoc/faturas?hoje=2025-01-10`, { headers: authTecnico });
    assert.equal(rFaturasSoTecnico.status, 403);

    const { faturas: faturasIniciais } = await (await fetch(`${base}/api/pmoc/faturas?hoje=2025-01-10`, { headers: authAdmin })).json();
    // 3 meses rolantes (Jan/Fev/Mar 2025) só do plano cobrado — nenhuma do plano sem cobrança.
    assert.equal(faturasIniciais.length, 3);
    assert.ok(faturasIniciais.every((f) => f.local_nome === 'Local Cobrado'));
    const faturaJan = faturasIniciais.find((f) => f.mes === '2025-01');
    assert.equal(faturaJan.valor, 350.5);
    assert.equal(faturaJan.vencimento, '2025-01-10');
    assert.equal(faturaJan.status, 'pendente');
    assert.equal(faturaJan.cliente_nome, 'Cliente Fase B');

    // ---- status "atrasada" (lazy, igual plano vencido) ----
    const { faturas: faturasAbril } = await (await fetch(`${base}/api/pmoc/faturas?hoje=2025-04-15`, { headers: authAdmin })).json();
    const faturaJanDepois = faturasAbril.find((f) => f.mes === '2025-01');
    assert.equal(faturaJanDepois.status, 'atrasada'); // venceu em 10/01, hoje é 15/04.
    const faturaJunhoNova = faturasAbril.find((f) => f.mes === '2025-06');
    assert.equal(faturaJunhoNova.status, 'pendente'); // essa ainda não venceu (vence em 10/06, hoje é 15/04).

    // ---- filtro por status ----
    const { faturas: soAtrasadas } = await (await fetch(`${base}/api/pmoc/faturas?hoje=2025-04-15&status=atrasada`, { headers: authAdmin })).json();
    assert.ok(soAtrasadas.length >= 3); // Jan/Fev/Mar, todas vencidas.
    assert.ok(soAtrasadas.every((f) => f.status === 'atrasada'));

    // ---- marcar paga / desfazer ----
    const rMarcaPaga = await fetch(`${base}/api/pmoc/faturas/${faturaJan.id}/marcar-paga`, { method: 'PUT', headers: authAdmin });
    assert.equal(rMarcaPaga.status, 200);
    const faturaPaga = (await rMarcaPaga.json()).fatura;
    assert.equal(faturaPaga.status, 'paga');
    assert.ok(faturaPaga.pago_em);
    // mesmo com hoje bem depois do vencimento, fatura paga nunca volta a "atrasada".
    const { faturas: faturasDepoisDoPagamento } = await (await fetch(`${base}/api/pmoc/faturas?hoje=2025-05-01`, { headers: authAdmin })).json();
    assert.equal(faturasDepoisDoPagamento.find((f) => f.id === faturaJan.id).status, 'paga');
    const rDesfaz = await fetch(`${base}/api/pmoc/faturas/${faturaJan.id}/marcar-pendente`, { method: 'PUT', headers: authAdmin });
    const faturaDesfeita = (await rDesfaz.json()).fatura;
    assert.equal(faturaDesfeita.status, 'pendente');
    assert.equal(faturaDesfeita.pago_em, null);

    // ---- integração com o Painel PMOC ----
    const painel = await (await fetch(`${base}/api/pmoc/painel?hoje=2025-04-15`, { headers: authAdmin })).json();
    assert.ok(painel.faturamento);
    assert.equal(typeof painel.faturamento.a_receber_mes_atual, 'number');
    assert.ok(painel.faturamento.qtd_atrasadas >= 3);

    // ---- pesquisa de satisfação pública pós-visita ----
    const { visitas } = await (await fetch(`${base}/api/pmoc/planos/${planoCobrado.id}?hoje=2025-01-10`, { headers: authAdmin })).json();
    const visitaId = visitas[0].id;
    await fetch(`${base}/api/os-refrigeracao-agenda/config`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({ dias_semana: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'], hora_inicio: '08:00', hora_fim: '12:00', pausa_ativa: false, duracao_min: 60, max_por_dia: 4, datas_bloqueadas: [] }),
    });
    await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaId}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '09:00' }) });
    const visitaDetalhe = (await (await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authTecnico })).json()).visita;
    const itensCompletos = visitaDetalhe.pmoc_itens.map((it) => ({ ...it, resposta: 'conforme' }));
    const rConcluir = await fetch(`${base}/api/pmoc/visitas/${visitaId}/concluir`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: itensCompletos, assinatura_responsavel_img: PNG_1X1, assinatura_responsavel_nome: 'Resp.' }) });
    assert.equal(rConcluir.status, 200);

    const rEnvio = await fetch(`${base}/api/pmoc/visitas/${visitaId}/enviar-relatorio`, { method: 'POST', headers: authTecnico, body: JSON.stringify({ pdf_base64: 'JVBERi0xLjQK', emails: ['cliente@teste.com'] }) });
    assert.equal(rEnvio.status, 200);

    // o token nasceu já na geração automática da visita (ver gerarVisitasPmocPlano) — pega do banco.
    const tokenPesquisa = JSON.parse(fs.readFileSync(dbTemp, 'utf8')).os_refrigeracao_agendamentos.find((a) => a.id === visitaId).token_pesquisa;
    assert.ok(tokenPesquisa);

    // pública: sem qualquer header de autenticação.
    const rPesquisaGet1 = await fetch(`${base}/api/pmoc/pesquisa/${tokenPesquisa}`);
    assert.equal(rPesquisaGet1.status, 200);
    const pesquisaInicial = await rPesquisaGet1.json();
    assert.equal(pesquisaInicial.respondida, false);
    assert.equal(pesquisaInicial.cliente_nome, visitaDetalhe.cliente_nome);
    assert.equal(pesquisaInicial.empresa_nome, 'Clima Certa B');

    // token inexistente: 404.
    const rPesquisaInvalida = await fetch(`${base}/api/pmoc/pesquisa/0000000000000000000000000000000f`);
    assert.equal(rPesquisaInvalida.status, 404);

    // nota fora do intervalo: 400.
    const rPesquisaNotaInvalida = await fetch(`${base}/api/pmoc/pesquisa/${tokenPesquisa}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nota: 7 }) });
    assert.equal(rPesquisaNotaInvalida.status, 400);

    const rPesquisaPost = await fetch(`${base}/api/pmoc/pesquisa/${tokenPesquisa}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nota: 5, comentario: 'Excelente atendimento' }) });
    assert.equal(rPesquisaPost.status, 200);

    const rPesquisaGet2 = await fetch(`${base}/api/pmoc/pesquisa/${tokenPesquisa}`);
    assert.equal((await rPesquisaGet2.json()).respondida, true);

    // idempotência: não deixa responder de novo.
    const rPesquisaPostDeNovo = await fetch(`${base}/api/pmoc/pesquisa/${tokenPesquisa}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nota: 1 }) });
    assert.equal(rPesquisaPostDeNovo.status, 400);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
