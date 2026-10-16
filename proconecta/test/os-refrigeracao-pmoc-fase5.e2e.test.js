// pedido do usuário: pacote "Climatização / PMOC", Fase 5 — QR, alertas e painel. Prova pela API
// HTTP de verdade: aparelho aberto pelo QR enxerga dados diferentes conforme o papel (técnico vê
// histórico + "ir pra preventiva"/"abrir corretiva"; cliente vê histórico + "abrir chamado",
// isolado por dono; sem login só o mínimo público, respeitando o toggle configurável); os 4 tipos
// de alerta no sininho do administrador (preventiva atrasada, plano vencendo em 30 dias, ART/TRT
// ausente/vencida, qualidade do ar desatualizada) com o dedup do e-mail (não reenvia a cada
// consulta); o painel/dashboard agregando tudo isso pra empresa inteira; e a config do pacote.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function isoMenos(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}
function isoMais(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function dados() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin PMOC5', email: 'admin@pmoc5.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico PMOC5', email: 'tec@pmoc5.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Portal Cliente A', email: 'portalA@pmoc5.com', papel: 'cliente', status: 'ativo', empresa_id: 1, cliente_id: null, os_refrigeracao_cliente_id: null, ...senha },
      { id: 4, nome: 'Portal Cliente B', email: 'portalB@pmoc5.com', papel: 'cliente', status: 'ativo', empresa_id: 1, cliente_id: null, os_refrigeracao_cliente_id: null, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    os_refrigeracao_pmoc_qualidade_ar: [], os_refrigeracao_pmoc_config: [],
    _seq: {
      usuarios: 5, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
      os_refrigeracao_pmoc_qualidade_ar: 1, os_refrigeracao_pmoc_config: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa 5', site: '', whatsapp: '', telefone: '', emails: ['contato@climacerta5.com'], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
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

test('PMOC (Fase 5 — QR, alertas e painel): scan por papel, 4 tipos de alerta com dedup de e-mail, painel e config', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-fase5-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44800 + Math.floor(Math.random() * 900);

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
    const authAdmin = auth(await login('admin@pmoc5.com'));
    const authTecnico = auth(await login('tec@pmoc5.com'));

    // ---- cadastro base: 1 cliente, 1 ambiente+aparelho por "situação" de alerta a testar ----
    const cliente = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente Fase 5' }) })).json()).cliente;
    const clienteB = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente Fase 5 B' }) })).json()).cliente;

    async function criarLocalComAparelho(nome) {
      const local = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome, tipo_atividade: 'loja' }) })).json()).local;
      const ambiente = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Salão' }) })).json()).ambiente;
      const aparelho = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'Split hi-wall', marca: 'Daikin' }) })).json()).aparelho;
      return { local, ambiente, aparelho };
    }

    // local "Atrasado": plano antigo (2000) — gera visita bem no passado, nunca concluída.
    const locAtrasado = await criarLocalComAparelho('Local Atrasado');
    const planoAtrasado = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: locAtrasado.local.id, data_inicio: '2000-01-10', itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${planoAtrasado.id}/ativar?hoje=2000-01-10`, { method: 'PUT', headers: authAdmin });
    const { visitas: visitasAtrasado } = await (await fetch(`${base}/api/pmoc/planos/${planoAtrasado.id}?hoje=2000-01-10`, { headers: authAdmin })).json();
    await fetch(`${base}/api/os-refrigeracao-agenda/config`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({ dias_semana: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'], hora_inicio: '08:00', hora_fim: '12:00', pausa_ativa: false, duracao_min: 60, max_por_dia: 4, datas_bloqueadas: [] }),
    });
    const rDesignar = await fetch(`${base}/api/pmoc/visitas-pendentes/${visitasAtrasado[0].id}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '09:00' }) });
    assert.equal(rDesignar.status, 200);

    // local "Vencendo": plano ativo cuja vigência acaba dentro de 30 dias a partir de hoje.
    const locVencendo = await criarLocalComAparelho('Local Vencendo');
    const inicioVencendo = isoMenos(30 - 10); // vigência de 1 mês terminando em ~10 dias.
    const planoVencendo = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: locVencendo.local.id, data_inicio: inicioVencendo, vigencia_meses: 1, art_trt_numero: 'ART-OK-123', itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${planoVencendo.id}/ativar?hoje=${inicioVencendo}`, { method: 'PUT', headers: authAdmin });

    // local "Sem ART": plano ativo, ART ausente, vigência bem longe (não conta como "vencendo").
    const locSemArt = await criarLocalComAparelho('Local Sem ART');
    const planoSemArt = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: locSemArt.local.id, data_inicio: isoMenos(1), vigencia_meses: 24, itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${planoSemArt.id}/ativar?hoje=${isoMenos(1)}`, { method: 'PUT', headers: authAdmin });

    // local "Vencido de verdade": plano ativo cuja vigência já passou — deve virar status "vencido"
    // na primeira consulta e contar em clientes_problema.plano_vencido.
    const locVencido = await criarLocalComAparelho('Local Vencido');
    const planoVencido = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: locVencido.local.id, data_inicio: '2020-01-10', vigencia_meses: 1, art_trt_numero: 'ART-OK-456', itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${planoVencido.id}/ativar?hoje=2020-01-10`, { method: 'PUT', headers: authAdmin });

    // local "Sem qualidade do ar": nenhuma análise registrada — alerta de "nunca registrada".
    const locSemQa = await criarLocalComAparelho('Local Sem Qualidade do Ar');

    // ---- QR: técnico (modo "tecnico") ----
    const rQrTecnico = await fetch(`${base}/api/pmoc/aparelhos/por-qr/${locAtrasado.aparelho.qr_token}`, { headers: authTecnico });
    assert.equal(rQrTecnico.status, 200);
    const qrTecnico = await rQrTecnico.json();
    assert.equal(qrTecnico.modo, 'tecnico');
    assert.equal(qrTecnico.aparelho.id, locAtrasado.aparelho.id);
    assert.equal(qrTecnico.local.id, locAtrasado.local.id);
    assert.ok(qrTecnico.visita_pendente); // designado pro próprio técnico acima.
    assert.equal(qrTecnico.visita_pendente.id, visitasAtrasado[0].id);
    assert.deepEqual(qrTecnico.historico, []); // visita ainda não concluída — sem histórico ainda.

    // técnico (ou admin) escaneia o QR de outra empresa/token inválido: 404, nunca dado de outro lugar.
    const rQrInvalido = await fetch(`${base}/api/pmoc/aparelhos/por-qr/0000000000000000000000000000000f`, { headers: authTecnico });
    assert.equal(rQrInvalido.status, 404);

    // abrir corretiva avulsa pelo QR, do lado do técnico — nasce "pendente", já com ele designado.
    const rCorretivaSemDescricao = await fetch(`${base}/api/pmoc/aparelhos/${locAtrasado.aparelho.id}/abrir-corretiva`, { method: 'POST', headers: authTecnico, body: JSON.stringify({}) });
    assert.equal(rCorretivaSemDescricao.status, 400);
    const rCorretiva = await fetch(`${base}/api/pmoc/aparelhos/${locAtrasado.aparelho.id}/abrir-corretiva`, { method: 'POST', headers: authTecnico, body: JSON.stringify({ descricao: 'Vazamento visível' }) });
    assert.equal(rCorretiva.status, 201);
    const corretivaQr = (await rCorretiva.json()).os;
    assert.equal(corretivaQr.status, 'pendente');
    assert.equal(corretivaQr.tecnico_id, 2);
    assert.equal(corretivaQr.cliente_nome, 'Cliente Fase 5');

    // ---- QR: cliente logado (modo "cliente"), isolado por dono ----
    const rUsuarioA = await fetch(`${base}/api/usuarios/3`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ nome: 'Portal Cliente A', email: 'portalA@pmoc5.com', papel: 'cliente', os_refrigeracao_cliente_id: cliente.id }) });
    assert.equal(rUsuarioA.status, 200);
    const rUsuarioB = await fetch(`${base}/api/usuarios/4`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ nome: 'Portal Cliente B', email: 'portalB@pmoc5.com', papel: 'cliente', os_refrigeracao_cliente_id: clienteB.id }) });
    assert.equal(rUsuarioB.status, 200);
    // usuários 3/4 nascem "ativo" direto no fixture (sem fluxo de convite) — login direto.
    const authPortalA = auth(await login('portalA@pmoc5.com'));
    const authPortalB = auth(await login('portalB@pmoc5.com'));

    const rQrCliente = await fetch(`${base}/api/pmoc/aparelhos/por-qr/${locVencendo.aparelho.qr_token}`, { headers: authPortalA });
    assert.equal(rQrCliente.status, 200);
    const qrCliente = await rQrCliente.json();
    assert.equal(qrCliente.modo, 'cliente');
    assert.equal(qrCliente.aparelho.id, locVencendo.aparelho.id);
    // Cliente B (outro dono) não acessa o aparelho de Cliente A pelo QR.
    const rQrClienteCruzado = await fetch(`${base}/api/pmoc/aparelhos/por-qr/${locVencendo.aparelho.qr_token}`, { headers: authPortalB });
    assert.equal(rQrClienteCruzado.status, 403);
    // administrador/suporte não usam o modo "cliente" mesmo escaneando o mesmo aparelho.
    const rQrAdminMesmoAparelho = await fetch(`${base}/api/pmoc/aparelhos/por-qr/${locVencendo.aparelho.qr_token}`, { headers: authAdmin });
    assert.equal((await rQrAdminMesmoAparelho.json()).modo, 'tecnico');

    // ---- QR público (sem login nenhum) — respeita o toggle configurável ----
    const rPublico1 = await fetch(`${base}/api/pmoc/qr/${locVencendo.aparelho.qr_token}/publico`);
    assert.equal(rPublico1.status, 200);
    const publico1 = await rPublico1.json();
    assert.equal(publico1.exibir, true);
    assert.equal(publico1.empresa_nome, 'Clima Certa 5');
    assert.equal(publico1.ultima_manutencao, null); // nenhuma visita concluída ainda nesse local.
    // token inexistente: 404, nunca dado de outro aparelho.
    const rPublicoInvalido = await fetch(`${base}/api/pmoc/qr/0000000000000000000000000000000f/publico`);
    assert.equal(rPublicoInvalido.status, 404);

    // ---- config do pacote: desliga a página pública e confirma que ela some ----
    const rConfig1 = await fetch(`${base}/api/pmoc/config`, { headers: authAdmin });
    const config1 = (await rConfig1.json()).config;
    assert.equal(config1.qualidade_ar_meses_alerta, 6);
    assert.equal(config1.qr_publico_ativo, true);
    const rConfigSoTecnico = await fetch(`${base}/api/pmoc/config`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ qualidade_ar_meses_alerta: 3, qr_publico_ativo: false }) });
    assert.equal(rConfigSoTecnico.status, 403); // só administrador altera.
    const rConfigPut = await fetch(`${base}/api/pmoc/config`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ qualidade_ar_meses_alerta: 3, qr_publico_ativo: false }) });
    assert.equal(rConfigPut.status, 200);
    const rPublico2 = await fetch(`${base}/api/pmoc/qr/${locVencendo.aparelho.qr_token}/publico`);
    assert.deepEqual(await rPublico2.json(), { exibir: false });

    // ---- os 4 tipos de alerta no sininho do administrador ----
    const rNotif1 = await fetch(`${base}/api/notificacoes`, { headers: authAdmin });
    const notifs1 = (await rNotif1.json()).notificacoes.filter((n) => n.tipo.startsWith('pmoc_'));
    assert.ok(notifs1.some((n) => n.tipo === 'pmoc_preventiva_atrasada'));
    assert.ok(notifs1.some((n) => n.tipo === 'pmoc_plano_vencendo' && n.registro_id === planoVencendo.id));
    assert.ok(notifs1.some((n) => n.tipo === 'pmoc_art_trt_problema' && n.registro_id === planoSemArt.id));
    // o plano "vencendo" (ART preenchida) e o "vencido" (ART preenchida) não entram no alerta de ART.
    assert.ok(!notifs1.some((n) => n.tipo === 'pmoc_art_trt_problema' && n.registro_id === planoVencendo.id));
    assert.ok(!notifs1.some((n) => n.tipo === 'pmoc_art_trt_problema' && n.registro_id === planoVencido.id));
    assert.ok(notifs1.some((n) => n.tipo === 'pmoc_qualidade_ar_desatualizada' && n.registro_id === locSemQa.local.id));
    // técnico não vê esses alertas gerenciais (só o administrador).
    const rNotifTecnico = await fetch(`${base}/api/notificacoes`, { headers: authTecnico });
    const notifsTecnicoGerenciais = (await rNotifTecnico.json()).notificacoes.filter((n) => ['pmoc_plano_vencendo', 'pmoc_art_trt_problema', 'pmoc_qualidade_ar_desatualizada'].includes(n.tipo));
    assert.deepEqual(notifsTecnicoGerenciais, []);

    // dedup do e-mail: depois da primeira consulta (que já disparou, modo simulado sem SMTP), os
    // campos alerta_*_email_enviado_em ficam marcados no banco — confirma lendo o arquivo direto
    // (mesmo padrão de outros testes deste pacote) — e que uma SEGUNDA consulta não derruba isso.
    const lerDb = () => JSON.parse(fs.readFileSync(dbTemp, 'utf8'));
    const planoVencendoNoDisco1 = lerDb().os_refrigeracao_pmoc_planos.find((p) => p.id === planoVencendo.id);
    assert.ok(planoVencendoNoDisco1.alerta_vencimento_email_enviado_em);
    const planoSemArtNoDisco1 = lerDb().os_refrigeracao_pmoc_planos.find((p) => p.id === planoSemArt.id);
    assert.ok(planoSemArtNoDisco1.alerta_art_email_enviado_em);
    const localSemQaNoDisco1 = lerDb().os_refrigeracao_pmoc_locais.find((l) => l.id === locSemQa.local.id);
    assert.ok(localSemQaNoDisco1.alerta_qualidade_ar_email_enviado_em);
    const visitaAtrasadaNoDisco1 = lerDb().os_refrigeracao_agendamentos.find((a) => a.id === visitasAtrasado[0].id);
    assert.ok(visitaAtrasadaNoDisco1.alerta_atraso_email_enviado_em);

    await fetch(`${base}/api/notificacoes`, { headers: authAdmin }); // segunda consulta.
    const planoVencendoNoDisco2 = lerDb().os_refrigeracao_pmoc_planos.find((p) => p.id === planoVencendo.id);
    assert.equal(planoVencendoNoDisco2.alerta_vencimento_email_enviado_em, planoVencendoNoDisco1.alerta_vencimento_email_enviado_em); // não mudou — não reenviou.

    // editar o plano (mesma situação ainda, mas é exatamente quando o alerta deveria poder
    // reavisar se a situação persistir) limpa o dedup — confirma que o campo volta a null.
    const rEditaPlanoVencendo = await fetch(`${base}/api/pmoc/planos/${planoVencendo.id}?hoje=${isoMais(0)}`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({ data_inicio: inicioVencendo, vigencia_meses: 1, art_trt_numero: 'ART-OK-123', itens: planoVencendo.itens }),
    });
    assert.equal(rEditaPlanoVencendo.status, 200);
    const planoVencendoNoDisco3 = lerDb().os_refrigeracao_pmoc_planos.find((p) => p.id === planoVencendo.id);
    assert.equal(planoVencendoNoDisco3.alerta_vencimento_email_enviado_em, null);

    // registrar uma análise de qualidade do ar limpa o dedup do alerta daquele local.
    await fetch(`${base}/api/pmoc/qualidade-ar`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: locSemQa.local.id, data: isoMenos(1), laboratorio: 'Lab X' }) });
    const localSemQaNoDisco2 = lerDb().os_refrigeracao_pmoc_locais.find((l) => l.id === locSemQa.local.id);
    assert.equal(localSemQaNoDisco2.alerta_qualidade_ar_email_enviado_em, null);

    // ---- painel/dashboard: só administrador ----
    const rPainelSoAdmin = await fetch(`${base}/api/pmoc/painel?hoje=${isoMais(0)}`, { headers: authTecnico });
    assert.equal(rPainelSoAdmin.status, 403);
    const rPainel = await fetch(`${base}/api/pmoc/painel?hoje=${isoMais(0)}`, { headers: authAdmin });
    assert.equal(rPainel.status, 200);
    const painel = await rPainel.json();
    assert.equal(painel.percentual_no_prazo.ultimos_6_meses.length, 6);
    assert.ok(painel.atrasadas_por_tecnico.some((t) => t.nome === 'Tecnico PMOC5' && t.qtd >= 1));
    assert.ok(painel.atrasadas_por_cliente.some((c) => c.nome === 'Cliente Fase 5 — Local Atrasado' && c.qtd >= 1));
    assert.ok(painel.aparelhos_mais_corretivas.some((a) => a.aparelho_id === locAtrasado.aparelho.id && a.qtd === 1));
    const clienteProblemaPainel = painel.clientes_problema.find((c) => c.cliente_id === cliente.id);
    assert.ok(clienteProblemaPainel);
    assert.equal(clienteProblemaPainel.plano_vencido, true); // Local Vencido virou "vencido" de verdade.
    assert.equal(clienteProblemaPainel.sem_art, true); // Local Sem ART continua sem ART.
    // o plano do local "Vencido" realmente virou status "vencido" no banco (lazy-check, igual
    // atualizarStatusVencidoPlanoPmoc já fazia noutras rotas).
    const planoVencidoNoDisco = lerDb().os_refrigeracao_pmoc_planos.find((p) => p.id === planoVencido.id);
    assert.equal(planoVencidoNoDisco.status, 'vencido');
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
