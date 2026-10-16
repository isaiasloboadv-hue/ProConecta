// pedido do usuário: pacote "Climatização / PMOC", Fase 3 — Execução e relatórios. Prova pela API
// HTTP de verdade: acesso restrito ao técnico designado (ou administrador), progresso parcial do
// checklist (sem concluir), validação na conclusão (todos os itens respondidos + assinatura do
// responsável no local), geração de O.S. corretiva a partir de um item "Não conforme" (vinculada
// ao aparelho/cliente certos, nascendo "pendente" — o serviço ainda não foi feito), bloqueio de
// corretiva duplicada, envio do relatório por e-mail (modo simulado sem SMTP configurado, mesmo
// assim confirma o endpoint/fluxo) e as notificações de preventiva atrasada / não conformidade sem
// O.S. corretiva (e que a notificação some assim que a corretiva é gerada).
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
      { id: 1, nome: 'Admin PMOC', email: 'admin@pmoc3.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico Designado', email: 'tec1@pmoc3.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Tecnico Estranho', email: 'tec2@pmoc3.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    _seq: {
      usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa', site: '', whatsapp: '', telefone: '', emails: ['contato@climacerta.com'], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
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

test('PMOC (Fase 3 — Execução e relatórios): progresso, conclusão validada, O.S. corretiva, envio de relatório e notificações', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-execucao-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44600 + Math.floor(Math.random() * 900);

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
    const authAdmin = auth(await login('admin@pmoc3.com'));
    const authTecnico = auth(await login('tec1@pmoc3.com'));
    const authOutroTecnico = auth(await login('tec2@pmoc3.com'));

    // ---- cadastro base ----
    const cliente = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente Execução' }) })).json()).cliente;
    const local = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Execução', tipo_atividade: 'loja', endereco: 'Rua Y, 1', responsavel_email: 'local@cliente.com' }) })).json()).local;
    const ambiente = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Salão' }) })).json()).ambiente;
    const aparelho = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'Split hi-wall', marca: 'Daikin', modelo: 'X1' }) })).json()).aparelho;

    // ---- plano com 2 itens mensais (2 itens, 1 aparelho → 2 pmoc_itens na visita) ----
    const plano = (await (await fetch(`${base}/api/pmoc/planos`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        local_id: local.id, data_inicio: '2026-01-10',
        itens: [
          { descricao: 'Item A', periodicidade: 'mensal', tipos_aparelho: [] },
          { descricao: 'Item B', periodicidade: 'mensal', tipos_aparelho: [] },
        ],
      }),
    })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${plano.id}/ativar?hoje=2026-01-10`, { method: 'PUT', headers: authAdmin });
    const { visitas } = await (await fetch(`${base}/api/pmoc/planos/${plano.id}?hoje=2026-01-10`, { headers: authAdmin })).json();
    const visitaId = visitas[0].id;

    // configura agenda do técnico e designa.
    await fetch(`${base}/api/os-refrigeracao-agenda/config`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({ dias_semana: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'], hora_inicio: '08:00', hora_fim: '12:00', pausa_ativa: false, duracao_min: 60, max_por_dia: 4, datas_bloqueadas: [] }),
    });
    await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaId}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '09:00' }) });

    // ---- acesso: só o técnico designado ou admin ----
    const rAcessoEstranho = await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authOutroTecnico });
    assert.equal(rAcessoEstranho.status, 403);
    const rAcessoCerto = await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authTecnico });
    assert.equal(rAcessoCerto.status, 200);
    const visitaDetalhe = (await rAcessoCerto.json()).visita;
    assert.equal(visitaDetalhe.pmoc_itens.length, 2);

    // ---- progresso: salva parcial, sem concluir ----
    const itensParciais = visitaDetalhe.pmoc_itens.map((it, i) => i === 0 ? { ...it, resposta: 'nao_conforme', observacao: 'Vazamento', foto_antes: PNG_1X1 } : it);
    const rProgresso = await fetch(`${base}/api/pmoc/visitas/${visitaId}/progresso`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: itensParciais }) });
    assert.equal(rProgresso.status, 200);
    const visitaAposProgresso = (await (await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authTecnico })).json()).visita;
    assert.equal(visitaAposProgresso.status, 'agendado'); // progresso não muda status
    assert.equal(visitaAposProgresso.pmoc_itens[0].resposta, 'nao_conforme');
    assert.equal(visitaAposProgresso.pmoc_itens[1].resposta, null); // item 1 ainda não respondido

    // ---- gerar corretiva só funciona em item "não conforme" ----
    const rCorretivaItemErrado = await fetch(`${base}/api/pmoc/visitas/${visitaId}/itens/1/gerar-corretiva`, { method: 'POST', headers: authTecnico });
    assert.equal(rCorretivaItemErrado.status, 400);
    const rCorretiva = await fetch(`${base}/api/pmoc/visitas/${visitaId}/itens/0/gerar-corretiva`, { method: 'POST', headers: authTecnico });
    assert.equal(rCorretiva.status, 201);
    const osCorretiva = (await rCorretiva.json()).os;
    assert.equal(osCorretiva.status, 'pendente');
    assert.equal(osCorretiva.cliente_nome, 'Cliente Execução');
    assert.equal(osCorretiva.equipamento.tipo, 'Split hi-wall');
    assert.equal(osCorretiva.equipamento.marca, 'Daikin');
    assert.ok(osCorretiva.problema_relatado.includes('Item A'));
    // não dá pra gerar de novo pro mesmo item.
    const rCorretivaDeNovo = await fetch(`${base}/api/pmoc/visitas/${visitaId}/itens/0/gerar-corretiva`, { method: 'POST', headers: authTecnico });
    assert.equal(rCorretivaDeNovo.status, 400);

    // ---- concluir: valida itens todos respondidos + assinatura ----
    const rConcluirSemTudoRespondido = await fetch(`${base}/api/pmoc/visitas/${visitaId}/concluir`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: itensParciais, assinatura_responsavel_img: PNG_1X1 }) });
    assert.equal(rConcluirSemTudoRespondido.status, 400);
    const itensCompletos = itensParciais.map((it, i) => i === 1 ? { ...it, resposta: 'conforme' } : it);
    const rConcluirSemAssinatura = await fetch(`${base}/api/pmoc/visitas/${visitaId}/concluir`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: itensCompletos }) });
    assert.equal(rConcluirSemAssinatura.status, 400);
    const rConcluir = await fetch(`${base}/api/pmoc/visitas/${visitaId}/concluir`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: itensCompletos, assinatura_responsavel_img: PNG_1X1, assinatura_responsavel_nome: 'Fulano Responsável' }) });
    assert.equal(rConcluir.status, 200);
    const visitaConcluida = (await rConcluir.json()).visita;
    assert.equal(visitaConcluida.status, 'concluido');
    assert.ok(visitaConcluida.concluido_em);
    // já concluída: nem progresso nem concluir de novo funcionam.
    const rProgressoDepois = await fetch(`${base}/api/pmoc/visitas/${visitaId}/progresso`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: itensCompletos }) });
    assert.equal(rProgressoDepois.status, 400);
    const rConcluirDeNovo = await fetch(`${base}/api/pmoc/visitas/${visitaId}/concluir`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: itensCompletos, assinatura_responsavel_img: PNG_1X1 }) });
    assert.equal(rConcluirDeNovo.status, 400);

    // ---- envio do relatório por e-mail (sem SMTP configurado no ambiente de teste = modo simulado,
    // mas confirma que o endpoint recebe o PDF e devolve o resultado do envio) ----
    const rEnvioSemDados = await fetch(`${base}/api/pmoc/visitas/${visitaId}/enviar-relatorio`, { method: 'POST', headers: authTecnico, body: JSON.stringify({}) });
    assert.equal(rEnvioSemDados.status, 400);
    const rEnvio = await fetch(`${base}/api/pmoc/visitas/${visitaId}/enviar-relatorio`, { method: 'POST', headers: authTecnico, body: JSON.stringify({ pdf_base64: 'JVBERi0xLjQK', emails: ['cliente@teste.com', 'admin@teste.com'] }) });
    assert.equal(rEnvio.status, 200);
    const envio = (await rEnvio.json()).envio;
    assert.deepEqual(envio.destinatarios, ['cliente@teste.com', 'admin@teste.com']);
    assert.ok(['simulado', undefined].includes(envio.modo) || envio.enviado === true); // sem SMTP: simulado

    // ---- notificações: preventiva atrasada (plano separado, bem no passado) ----
    const local2 = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Atrasado', tipo_atividade: 'loja' }) })).json()).local;
    const planoAtrasado = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local2.id, data_inicio: '2000-01-10', itens: [{ descricao: 'Item Antigo', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${planoAtrasado.id}/ativar?hoje=2000-01-10`, { method: 'PUT', headers: authAdmin });

    const rNotif1 = await fetch(`${base}/api/notificacoes`, { headers: authAdmin });
    const notifs1 = (await rNotif1.json()).notificacoes.filter((n) => n.tipo.startsWith('pmoc_'));
    assert.ok(notifs1.some((n) => n.tipo === 'pmoc_preventiva_atrasada'));
    // essa visita concluída tem um item não conforme SEM corretiva ainda (item 0 — Local Execução
    // já tem corretiva gerada acima, então essa aqui não deve contar) — gera uma segunda visita
    // concluída com não conformidade pendente pra provar a notificação de não conformidade.
    const localNC = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Não Conforme', tipo_atividade: 'loja' }) })).json()).local;
    const ambienteNC = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: localNC.id, nome: 'Salão' }) })).json()).ambiente;
    await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambienteNC.id, tipo: 'Cassete' }) });
    const planoNC = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: localNC.id, data_inicio: '2026-02-05', itens: [{ descricao: 'Item NC', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${planoNC.id}/ativar?hoje=2026-02-05`, { method: 'PUT', headers: authAdmin });
    const { visitas: visitasNC } = await (await fetch(`${base}/api/pmoc/planos/${planoNC.id}?hoje=2026-02-05`, { headers: authAdmin })).json();
    const visitaNC = visitasNC[0];
    await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaNC.id}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '10:00' }) });
    const itemNC = { ...visitaNC.pmoc_itens[0], resposta: 'nao_conforme', observacao: 'Pendente' };
    await fetch(`${base}/api/pmoc/visitas/${visitaNC.id}/concluir`, { method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: [itemNC], assinatura_responsavel_img: PNG_1X1, assinatura_responsavel_nome: 'Resp.' }) });

    const rNotif2 = await fetch(`${base}/api/notificacoes`, { headers: authAdmin });
    const notifs2 = (await rNotif2.json()).notificacoes.filter((n) => n.tipo.startsWith('pmoc_'));
    assert.ok(notifs2.some((n) => n.tipo === 'pmoc_nao_conformidade' && n.registro_id === visitaNC.id));

    // gerar a corretiva faz a notificação de não conformidade sumir.
    await fetch(`${base}/api/pmoc/visitas/${visitaNC.id}/itens/0/gerar-corretiva`, { method: 'POST', headers: authAdmin });
    const rNotif3 = await fetch(`${base}/api/notificacoes`, { headers: authAdmin });
    const notifs3 = (await rNotif3.json()).notificacoes.filter((n) => n.tipo === 'pmoc_nao_conformidade');
    assert.ok(!notifs3.some((n) => n.registro_id === visitaNC.id));

    // técnico não vê essas notificações (são só do administrador).
    const rNotifTecnico = await fetch(`${base}/api/notificacoes`, { headers: authTecnico });
    const notifsTecnico = (await rNotifTecnico.json()).notificacoes.filter((n) => n.tipo.startsWith('pmoc_'));
    assert.deepEqual(notifsTecnico, []);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
