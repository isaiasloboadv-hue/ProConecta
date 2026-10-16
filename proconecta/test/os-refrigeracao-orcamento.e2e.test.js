// pedido do usuário (perfil "Refrigeração e Climatização", referência: app concorrente iClima) —
// 3º atalho construído do zero pra esse perfil: Orçamentos, reaproveitando só o cadastro de
// clientes de os_refrigeracao_clientes (mesma base da O.S.). Diferente da O.S.: a assinatura do
// técnico é opcional/posterior ("Assinar agora" no detalhe, não exigida na criação) e o status só
// vira "aprovado" quando o CLIENTE assina pelo link público (nunca manualmente). Prova pela API
// HTTP de verdade: gate por `perfil`, CRUD completo, cálculo de totais/desconto, assinatura do
// técnico separada da criação, o fluxo público de aprovação ponta a ponta — e, pedido explícito do
// usuário (que apontou um defeito do app de referência iClima: lá o PDF/link só mostra o total,
// escondendo o que está sendo cobrado), que o resumo público SEMPRE devolve o detalhamento
// completo (serviços, materiais, mão de obra, desconto, condições de pagamento), nunca só o total.
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
    _seq: { usuarios: 5, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1 },
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

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';

test('Orçamentos (Refrigeração): gate por perfil, CRUD, totais, assinatura do técnico opcional, aprovação por link público com detalhamento completo', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-orcamento-refrigeracao-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 42900 + Math.floor(Math.random() * 900);

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

    // gate por Perfil, não por módulo — mesma empresa de outro perfil nega 403
    const negaPerfil = await fetch(`${base}/api/os-refrigeracao-orcamentos`, { headers: auth(tokenOutroPerfil) });
    assert.equal(negaPerfil.status, 403);

    // cliente — reaproveita a mesma coleção/base da O.S. (os_refrigeracao_clientes)
    const rCliente = await fetch(`${base}/api/os-refrigeracao-clientes`, {
      method: 'POST', headers: authA,
      body: JSON.stringify({ nome: 'Isaías da Paixão Lobo', telefone: '(12) 98882-8780', email: 'isaias.lobo@hotmail.com', endereco: 'Rua Durango, 230' }),
    });
    assert.equal(rCliente.status, 201);
    const cliente = (await rCliente.json()).cliente;

    const corpoOrcamento = {
      cliente_id: cliente.id,
      titulo: 'Instalação de Split 12000 BTU',
      descricao_cliente: 'Quer instalar um ar-condicionado novo no quarto',
      diagnostico_tecnico: 'Ambiente de 15m², ideal 12000 BTU',
      descricao_geral: 'Instalação completa com infraestrutura',
      servicos: [{ descricao: 'Instalação', valor: 400 }],
      materiais: [{ nome: 'Split 12000 BTU', quantidade: 1, valor_unitario: 1800 }],
      mao_de_obra: 100,
      desconto_tipo: 'percentual', desconto_valor: 10,
      condicoes_pagamento: '50% de entrada, 50% na conclusão',
      validade_dias: 15,
    };

    // sem cliente válido, recusa
    const semCliente = await fetch(`${base}/api/os-refrigeracao-orcamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoOrcamento, cliente_id: 999 }) });
    assert.equal(semCliente.status, 400);
    // sem título, recusa
    const semTitulo = await fetch(`${base}/api/os-refrigeracao-orcamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoOrcamento, titulo: '' }) });
    assert.equal(semTitulo.status, 400);
    // sem serviço nem material, recusa
    const semItens = await fetch(`${base}/api/os-refrigeracao-orcamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoOrcamento, servicos: [], materiais: [] }) });
    assert.equal(semItens.status, 400);

    // diferente da O.S.: cria SEM assinatura do técnico — é opcional/posterior
    const rCriar = await fetch(`${base}/api/os-refrigeracao-orcamentos`, { method: 'POST', headers: authA, body: JSON.stringify(corpoOrcamento) });
    assert.equal(rCriar.status, 201);
    const criado = (await rCriar.json()).orcamento;
    assert.equal(criado.cliente_nome, 'Isaías da Paixão Lobo');
    assert.equal(criado.tecnico_nome, 'Tecnico A');
    assert.equal(criado.assinatura_tecnico_img, null);
    assert.equal(criado.assinatura_cliente_img, null);
    assert.ok(criado.token_assinatura);
    // nasce em Rascunho (nunca "concluída" como a O.S.)
    assert.equal(criado.status, 'rascunho');
    // materiais: 1x1800=1800, serviços: 400, mão de obra: 100 -> subtotal 2300, 10% = 230 -> total 2070
    assert.equal(criado.total_materiais, 1800);
    assert.equal(criado.total_servicos, 400);
    assert.equal(criado.subtotal, 2300);
    assert.equal(criado.desconto_aplicado, 230);
    assert.equal(criado.total, 2070);
    const orcamentoId = criado.id;

    // ---- "Assinar agora" (assinatura do técnico — separada da criação) ----
    const semAssinaturaTecnico = await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}/assinar-tecnico`, { method: 'POST', headers: authA, body: JSON.stringify({}) });
    assert.equal(semAssinaturaTecnico.status, 400);
    const rAssinarTecnico = await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}/assinar-tecnico`, { method: 'POST', headers: authB, body: JSON.stringify({ assinatura_tecnico_img: PNG_1X1 }) });
    assert.equal(rAssinarTecnico.status, 200);
    const comAssinaturaTecnico = (await rAssinarTecnico.json()).orcamento;
    assert.ok(comAssinaturaTecnico.assinatura_tecnico_img.startsWith('data:image/png;base64,'));
    // assinar o técnico não muda o status — continua Rascunho
    assert.equal(comAssinaturaTecnico.status, 'rascunho');

    // ---- status manual: Rascunho/Cancelado — nunca "aprovado" por aqui ----
    const statusAprovadoRecusado = await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}/status`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ status: 'aprovado' }) });
    assert.equal(statusAprovadoRecusado.status, 400);
    const rCancelar = await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}/status`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ status: 'cancelado' }) });
    assert.equal(rCancelar.status, 200);
    assert.equal((await rCancelar.json()).orcamento.status, 'cancelado');
    // volta pra rascunho pro resto do teste
    await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}/status`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ status: 'rascunho' }) });

    // lista + busca por título/cliente + filtro de status
    const { orcamentos: listaTodos } = await (await fetch(`${base}/api/os-refrigeracao-orcamentos`, { headers: authAdmin })).json();
    assert.equal(listaTodos.length, 1);
    const { orcamentos: listaRascunho } = await (await fetch(`${base}/api/os-refrigeracao-orcamentos?status=rascunho`, { headers: authAdmin })).json();
    assert.equal(listaRascunho.length, 1);
    const { orcamentos: listaAprovado } = await (await fetch(`${base}/api/os-refrigeracao-orcamentos?status=aprovado`, { headers: authAdmin })).json();
    assert.equal(listaAprovado.length, 0);
    const { orcamentos: listaBuscaTitulo } = await (await fetch(`${base}/api/os-refrigeracao-orcamentos?q=split`, { headers: authAdmin })).json();
    assert.equal(listaBuscaTitulo.length, 1);

    // ---- link público de aprovação (sem login) — SEMPRE com o detalhamento completo ----
    const rPublicoAntes = await fetch(`${base}/api/os-refrigeracao-orcamentos-assinar/${criado.token_assinatura}`);
    assert.equal(rPublicoAntes.status, 200);
    const resumoPublico = (await rPublicoAntes.json()).orcamento;
    assert.equal(resumoPublico.cliente_nome, 'Isaías da Paixão Lobo');
    assert.equal(resumoPublico.titulo, 'Instalação de Split 12000 BTU');
    // pedido explícito do usuário: nunca só o total — serviços/materiais/mão de obra/desconto/
    // condições de pagamento sempre presentes (ao contrário do defeito apontado no app de referência)
    assert.deepEqual(resumoPublico.servicos, [{ descricao: 'Instalação', valor: 400 }]);
    assert.deepEqual(resumoPublico.materiais, [{ nome: 'Split 12000 BTU', quantidade: 1, valor_unitario: 1800 }]);
    assert.equal(resumoPublico.mao_de_obra, 100);
    assert.equal(resumoPublico.desconto_aplicado, 230);
    assert.equal(resumoPublico.condicoes_pagamento, '50% de entrada, 50% na conclusão');
    assert.equal(resumoPublico.total, 2070);
    // nunca vaza dado interno pro cliente
    assert.equal(resumoPublico.token_assinatura, undefined);
    assert.equal(resumoPublico.tecnico_id, undefined);
    assert.equal(resumoPublico.empresa_id, undefined);

    // token inválido -> 404
    const rTokenInvalido = await fetch(`${base}/api/os-refrigeracao-orcamentos-assinar/deadbeef`);
    assert.equal(rTokenInvalido.status, 404);

    // cliente aprova (assina) — status vira "aprovado" automaticamente
    const rAssinarCliente = await fetch(`${base}/api/os-refrigeracao-orcamentos-assinar/${criado.token_assinatura}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assinatura_cliente_img: PNG_1X1 }),
    });
    assert.equal(rAssinarCliente.status, 200);
    const aprovado = (await rAssinarCliente.json()).orcamento;
    assert.ok(aprovado.assinatura_cliente_img.startsWith('data:image/png;base64,'));
    assert.equal(aprovado.status, 'aprovado');

    // aprovar de novo é recusado (só uma vez)
    const rAssinarDeNovo = await fetch(`${base}/api/os-refrigeracao-orcamentos-assinar/${criado.token_assinatura}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assinatura_cliente_img: PNG_1X1 }),
    });
    assert.equal(rAssinarDeNovo.status, 409);

    // detalhe autenticado reflete o status aprovado
    const rDetalheDepois = await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}`, { headers: authAdmin });
    assert.equal((await rDetalheDepois.json()).orcamento.status, 'aprovado');
    const { orcamentos: listaAprovadoDepois } = await (await fetch(`${base}/api/os-refrigeracao-orcamentos?status=aprovado`, { headers: authAdmin })).json();
    assert.equal(listaAprovadoDepois.length, 1);

    // orçamento cancelado não pode mais ser aprovado pelo link público
    const rCliente2 = await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authA, body: JSON.stringify({ nome: 'Outro Cliente' }) });
    const cliente2 = (await rCliente2.json()).cliente;
    const rCriar2 = await fetch(`${base}/api/os-refrigeracao-orcamentos`, { method: 'POST', headers: authA, body: JSON.stringify({ ...corpoOrcamento, cliente_id: cliente2.id }) });
    const criado2 = (await rCriar2.json()).orcamento;
    await fetch(`${base}/api/os-refrigeracao-orcamentos/${criado2.id}/status`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ status: 'cancelado' }) });
    const rAssinarCancelado = await fetch(`${base}/api/os-refrigeracao-orcamentos-assinar/${criado2.token_assinatura}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assinatura_cliente_img: PNG_1X1 }),
    });
    assert.equal(rAssinarCancelado.status, 409);

    // ---- edição e exclusão ----
    const rEditar = await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}`, {
      method: 'PUT', headers: authB, body: JSON.stringify({ ...corpoOrcamento, mao_de_obra: 250 }),
    });
    assert.equal(rEditar.status, 200);
    const editado = (await rEditar.json()).orcamento;
    assert.equal(editado.mao_de_obra, 250);
    // PUT não toca em assinaturas nem status
    assert.ok(editado.assinatura_tecnico_img);
    assert.ok(editado.assinatura_cliente_img);
    assert.equal(editado.status, 'aprovado');

    const rExcluir = await fetch(`${base}/api/os-refrigeracao-orcamentos/${orcamentoId}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(rExcluir.status, 200);
    const { orcamentos: depoisExcluir } = await (await fetch(`${base}/api/os-refrigeracao-orcamentos`, { headers: authAdmin })).json();
    assert.equal(depoisExcluir.length, 1); // só sobrou o criado2

    // sem token nenhum, 401
    const semToken = await fetch(`${base}/api/os-refrigeracao-orcamentos`);
    assert.equal(semToken.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
