// pedido do usuário: "estou preenchendo um relatório... esqueci de pedir pro cliente preencher
// nome dele, e-mail e assinatura. Coloque um botão pra gerar link pra enviar pro cliente preencher
// sem precisar logar. As outras área ficam bloqueada, só a área que o cliente tem que preencher
// fica livre. Ele preenche, quando ele enviar aparecerá pra mim e eu concluo e envio o termo."
// Pedido de acompanhamento: "Faltou a parte que o cliente preenche o aceite e avaliação de
// desempenho. Ele precisa visualizar o restante das informações mesmo que não esteja preenchido."
//
// Cobre, pros 4 tipos que já pedem assinatura do cliente (Preventiva, Preventiva 2, Corretiva,
// Termo de Aceite): salvar em modo rascunho (sem exigir os campos todos) gera o token de
// assinatura; a rota pública devolve o contexto de leitura (o que já foi feito — checklist,
// descrição do atendimento — mesmo vazio, mas nunca autor_id/tecnico_email/emails_copia/
// empresa_id); o PUT público só aceita os campos "do cliente" (nome/e-mail/assinatura, avaliação
// de desempenho, e aceite só no Termo de Aceite — qualquer outro campo do corpo é ignorado);
// bloqueia reenvio depois de concluído; e-mail inválido/campos faltando são rejeitados; token
// inválido dá 404. Sobe o server.js de verdade contra um data.json descartável, mesmo padrão de
// test/relatorio-promotor-devolutivo.test.js.
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
      { id: 1, nome: 'Técnico Teste', email: 'tecnico@teste-assinatura.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 2 },
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

test('link de assinatura pública: Corretiva — gerar, ler resumo, assinar, bloquear reenvio e campos fora da lista', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-assinatura-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 34000 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const loginResp = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tecnico@teste-assinatura.com', senha: 'senha1234' }),
    });
    const token = (await loginResp.json()).token;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // sem rascunho:true, continua exigindo tudo (regressão — não pode ter ficado mais permissivo
    // pro fluxo normal, só quando o técnico pede explicitamente pra gerar o link)
    const semRascunho = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: auth, body: JSON.stringify({ tipo: 'corretiva', empresa: 'Cliente Incompleto' }),
    });
    assert.equal(semRascunho.status, 400);

    // técnico preenche só o começo e pede o link (rascunho:true) — não deve exigir checklist,
    // fotos, satisfação nem assinatura ainda
    const criarResp = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        tipo: 'corretiva', rascunho: true, empresa: 'Promarking Cliente Final',
        defeito_informado: 'Máquina não liga', acoes_executadas: 'Troca de fusível',
      }),
    });
    assert.equal(criarResp.status, 201);
    const { relatorio: criado } = await criarResp.json();
    assert.ok(criado.token_assinatura_cliente, 'deveria ter gerado o token de assinatura');
    assert.equal(criado.assinatura_cliente_concluida, false);

    // ---------- lado do cliente, sem login ----------
    const getPublico = await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`);
    assert.equal(getPublico.status, 200);
    const { relatorio: publico } = await getPublico.json();
    // contexto de leitura — o que já foi feito, mas nunca o relatório inteiro
    assert.equal(publico.empresa, 'Promarking Cliente Final');
    assert.equal(publico.tipo_label, 'Termo de Manutenção Corretiva');
    assert.equal(publico.defeito_informado, 'Máquina não liga');
    assert.equal(publico.acoes_executadas, 'Troca de fusível');
    // "ele precisa visualizar o restante das informações mesmo que não esteja preenchido" —
    // observacoes não foi preenchida ainda, mas o campo aparece (vazio), não some
    assert.equal(publico.observacoes, '');
    assert.equal(publico.assinatura_cliente_concluida, false);
    assert.equal(publico.autor_id, undefined, 'não pode vazar autor_id pro link público');
    assert.equal(publico.emails_copia, undefined, 'não pode vazar campos internos do relatório');
    assert.equal(publico.empresa_id, undefined, 'não pode vazar empresa_id pro link público');
    assert.equal(publico.tecnico_email, undefined, 'não pode vazar e-mail do técnico pro link público');

    // token inválido -> 404
    const getInvalido = await fetch(`${base}/api/relatorios-manutencao/assinatura/tokeninexistente`);
    assert.equal(getInvalido.status, 404);

    // falta nome -> 400
    const semNome = await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assinatura_cliente_email: 'cliente@empresa.com', assinatura_cliente_img: 'data:image/png;base64,abc' }),
    });
    assert.equal(semNome.status, 400);

    // e-mail inválido -> 400
    const emailInvalido = await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assinatura_cliente_nome: 'Cliente Final', assinatura_cliente_email: 'nao-e-email', assinatura_cliente_img: 'data:image/png;base64,abc' }),
    });
    assert.equal(emailInvalido.status, 400);

    // avaliação de desempenho faltando (sem estrelas/autoriza) -> 400 — agora faz parte da área
    // que o cliente preenche, não é mais opcional
    const semAvaliacao = await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assinatura_cliente_nome: 'Cliente Final', assinatura_cliente_email: 'cliente@empresa.com', assinatura_cliente_img: 'data:image/png;base64,abc' }),
    });
    assert.equal(semAvaliacao.status, 400);
    const semAutoriza = await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assinatura_cliente_nome: 'Cliente Final', assinatura_cliente_email: 'cliente@empresa.com', assinatura_cliente_img: 'data:image/png;base64,abc', satisfacao_estrelas: 5 }),
    });
    assert.equal(semAutoriza.status, 400);

    // envio completo e válido: nome/e-mail/assinatura + avaliação de desempenho (satisfacao_estrelas
    // e satisfacao_autoriza/comentario, que a Corretiva usa) — e tenta forjar "empresa" e
    // "defeito_informado" junto, que a rota pública NUNCA aceita ("as outras área ficam bloqueada")
    const assinarResp = await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assinatura_cliente_nome: 'Cliente Final', assinatura_cliente_email: 'cliente@empresa.com',
        assinatura_cliente_img: 'data:image/png;base64,abc',
        satisfacao_estrelas: 5, satisfacao_autoriza: 'sim', satisfacao_comentario: 'Atendimento rápido',
        empresa: 'EMPRESA FORJADA', defeito_informado: 'TEXTO FORJADO',
      }),
    });
    assert.equal(assinarResp.status, 200);
    const { relatorio: assinado } = await assinarResp.json();
    assert.equal(assinado.assinatura_cliente_concluida, true);
    assert.equal(assinado.assinatura_cliente_nome, 'Cliente Final');
    assert.equal(assinado.assinatura_cliente_email, 'cliente@empresa.com');
    assert.equal(assinado.satisfacao_estrelas, 5);
    assert.equal(assinado.satisfacao_autoriza, 'sim');
    assert.ok(assinado.assinatura_cliente_img);

    // confirma do lado autenticado (relatório inteiro) que os campos forjados NÃO mudaram, mas a
    // avaliação de desempenho (legítima) foi salva de verdade
    const detalheResp = await fetch(`${base}/api/relatorios-manutencao/${criado.id}`, { headers: auth });
    const { relatorio: detalhe } = await detalheResp.json();
    assert.equal(detalhe.empresa, 'Promarking Cliente Final');
    assert.equal(detalhe.defeito_informado, 'Máquina não liga');
    assert.equal(detalhe.satisfacao_estrelas, 5);
    assert.equal(detalhe.satisfacao_autoriza, 'sim');
    assert.equal(detalhe.satisfacao_comentario, 'Atendimento rápido');
    assert.equal(detalhe.assinatura_cliente_nome, 'Cliente Final');
    assert.equal(detalhe.assinatura_cliente_email, 'cliente@empresa.com');

    // reenvio depois de concluído -> 409 (não dá pra sobrescrever a assinatura)
    const reenvio = await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assinatura_cliente_nome: 'Outra Pessoa', assinatura_cliente_email: 'outra@empresa.com', assinatura_cliente_img: 'data:image/png;base64,xyz' }),
    });
    assert.equal(reenvio.status, 409);

    // reabrir o link depois de concluído (GET) continua funcionando, só pra mostrar a tela de
    // "já concluído" — e reflete o que foi assinado, não o que o reenvio tentou forjar
    const getDepois = await (await fetch(`${base}/api/relatorios-manutencao/assinatura/${criado.token_assinatura_cliente}`)).json();
    assert.equal(getDepois.relatorio.assinatura_cliente_concluida, true);
    assert.equal(getDepois.relatorio.assinatura_cliente_nome, 'Cliente Final');
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('link de assinatura pública: Preventiva, Preventiva 2 e Termo de Aceite também geram token ao salvar em rascunho', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-assinatura2-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 34900 + Math.floor(Math.random() * 90);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const loginResp = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tecnico@teste-assinatura.com', senha: 'senha1234' }),
    });
    const token = (await loginResp.json()).token;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    for (const tipo of ['preventiva', 'preventiva2', 'aceite_entrega']) {
      const resp = await fetch(`${base}/api/relatorios-manutencao`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ tipo, rascunho: true, empresa: `Cliente ${tipo}` }),
      });
      assert.equal(resp.status, 201, `falhou pro tipo ${tipo}`);
      const { relatorio } = await resp.json();
      assert.ok(relatorio.token_assinatura_cliente, `token não gerado pro tipo ${tipo}`);

      // PUT de volta (editando, ainda em rascunho) reaproveita o MESMO token em vez de gerar outro
      const resp2 = await fetch(`${base}/api/relatorios-manutencao/${relatorio.id}`, {
        method: 'PUT', headers: auth,
        body: JSON.stringify({ ...relatorio, rascunho: true, empresa: `Cliente ${tipo} atualizado` }),
      });
      assert.equal(resp2.status, 200, `PUT falhou pro tipo ${tipo}`);
      const { relatorio: atualizado } = await resp2.json();
      assert.equal(atualizado.token_assinatura_cliente, relatorio.token_assinatura_cliente, `token mudou no PUT pro tipo ${tipo}`);

      // contexto público mostra o checklist/campos do serviço mesmo vazios ("visualizar o restante
      // das informações mesmo que não esteja preenchido"), nunca omitidos
      const ctxResp = await fetch(`${base}/api/relatorios-manutencao/assinatura/${atualizado.token_assinatura_cliente}`);
      const { relatorio: ctx } = await ctxResp.json();
      assert.deepEqual(ctx.checklist, [], `checklist deveria vir como array vazio, não sumir, pro tipo ${tipo}`);
      assert.equal(ctx.empresa, `Cliente ${tipo} atualizado`);
    }

    // ---------- Termo de Aceite: fluxo completo de assinatura pública, com o campo "aceite" ----------
    const criarAceite = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ tipo: 'aceite_entrega', rascunho: true, empresa: 'Cliente Aceite Final', servico: 'Instalação de equipamento' }),
    });
    const { relatorio: aceiteRelatorio } = await criarAceite.json();

    // sem o campo "aceite" -> 400 (é exclusivo desse tipo, os outros 3 não têm)
    const semAceite = await fetch(`${base}/api/relatorios-manutencao/assinatura/${aceiteRelatorio.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assinatura_cliente_nome: 'Cliente Aceite', assinatura_cliente_email: 'aceite@empresa.com', assinatura_cliente_img: 'data:image/png;base64,abc', satisfacao_estrelas: 4, satisfacao_duvidas: 'sim', satisfacao_apto: 'sim' }),
    });
    assert.equal(semAceite.status, 400);

    const assinarAceite = await fetch(`${base}/api/relatorios-manutencao/assinatura/${aceiteRelatorio.token_assinatura_cliente}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assinatura_cliente_nome: 'Cliente Aceite', assinatura_cliente_email: 'aceite@empresa.com',
        assinatura_cliente_img: 'data:image/png;base64,abc',
        satisfacao_estrelas: 4, aceite: 'aceito', satisfacao_duvidas: 'sim', satisfacao_apto: 'sim',
      }),
    });
    assert.equal(assinarAceite.status, 200);
    const { relatorio: aceiteAssinado } = await assinarAceite.json();
    assert.equal(aceiteAssinado.aceite, 'aceito');
    assert.equal(aceiteAssinado.satisfacao_duvidas, 'sim');
    assert.equal(aceiteAssinado.satisfacao_apto, 'sim');
    assert.equal(aceiteAssinado.assinatura_cliente_concluida, true);

    const aceiteDetalheResp = await fetch(`${base}/api/relatorios-manutencao/${aceiteRelatorio.id}`, { headers: auth });
    const { relatorio: aceiteDetalhe } = await aceiteDetalheResp.json();
    assert.equal(aceiteDetalhe.aceite, 'aceito');
    assert.equal(aceiteDetalhe.satisfacao_estrelas, 4);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
