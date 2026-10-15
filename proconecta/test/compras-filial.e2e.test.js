// versão Restaurantes/rede multiunidade (Fase 4 — Compras, pedido do usuário): consolidação de
// solicitações em pedido de compra no atacado, estoque central/por loja, distribuição e
// transferência entre filiais (pedido -> aceite -> envio -> recebimento), com baixa automática na
// solicitação original quando aplicável. Prova pela API HTTP de verdade.
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
      { id: 1, nome: 'Admin Rede', email: 'admin@rede.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [], setores: [], filiais: [], areas: [],
    vistorias: [], vistoria_itens: [], apoios: [], pecas_catalogo: [], solicitacoes_peca: [],
    pedidos_compra: [], pedido_itens: [], estoque_central: [], estoque_loja: [], transferencias: [],
    _seq: {
      usuarios: 2, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, setores: 1, filiais: 1, areas: 1,
      vistorias: 1, vistoria_itens: 1, apoios: 1, pecas_catalogo: 1, solicitacoes_peca: 1,
      pedidos_compra: 1, pedido_itens: 1, estoque_central: 1, estoque_loja: 1, transferencias: 1,
    },
    empresas: [
      {
        id: 1, nome: 'Rede Franquia', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000',
        versao_id: null, modulos_ativos: ['filiais', 'relatorios', 'os_chamados', 'equipe_avancado'], terminologia: {},
        limite_aprovacao_1: 200, limite_aprovacao_2: 1000,
      },
    ],
    versoes: [],
    _migracaoPlanosPadraoV1: true, _migracaoPlanosPadraoV2: true, _migracaoPlanosPadraoV3: true, _migracaoSplitOsChamadosV1: true,
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

test('versão Restaurantes — Fase 4: pedido de compra no atacado, estoque e transferência entre filiais', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-compras-filial-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 40400 + Math.floor(Math.random() * 900);

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
    const tokenAdmin = await login('admin@rede.com');
    const authAdmin = auth(tokenAdmin);
    const post = (rota, body, authHdr) => fetch(`${base}${rota}`, { method: 'POST', headers: authHdr || authAdmin, body: JSON.stringify(body) });
    const put = (rota, body, authHdr) => fetch(`${base}${rota}`, { method: 'PUT', headers: authHdr || authAdmin, body: JSON.stringify(body) });
    const get = (rota, authHdr) => fetch(`${base}${rota}`, { headers: authHdr || authAdmin });

    async function criarUsuario(nome, email, papel, extra) {
      const r = await post('/api/usuarios', { nome, email, papel, ...extra });
      assert.equal(r.status, 201, `falhou criar ${papel} ${email}: ${JSON.stringify(await r.clone().json())}`);
      const corpo = await r.json();
      const token = new URL(corpo.convite.link).searchParams.get('token');
      const ativar = await fetch(`${base}/api/convite/${token}/ativar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'senha1234' }),
      });
      assert.equal(ativar.status, 200);
      return corpo.usuario;
    }

    // --- 2 setores, 2 filiais (uma em cada), pra testar transferência entre filiais de setores diferentes ---
    const setorA = (await (await post('/api/setores', { nome: 'Setor A' })).json()).setor;
    const setorB = (await (await post('/api/setores', { nome: 'Setor B' })).json()).setor;
    const coordA = await criarUsuario('Coordenador A', 'coordA@rede.com', 'coordenador_tecnico', { setor_id: setorA.id });
    await put(`/api/setores/${setorA.id}`, { nome: 'Setor A', coordenador_id: coordA.id });

    const lojaA = (await (await post('/api/filiais', { nome: 'Loja A', setor_id: setorA.id })).json()).filial;
    const tecnicoA = await criarUsuario('Técnico A', 'tecnicoA@rede.com', 'suporte', { filial_id: lojaA.id });
    const gerenteA = await criarUsuario('Gerente A', 'gerenteA@rede.com', 'gerente_loja', { filial_id: lojaA.id });
    await put(`/api/filiais/${lojaA.id}`, { nome: 'Loja A', setor_id: setorA.id, tecnico_id: tecnicoA.id, gerente_id: gerenteA.id });

    const lojaB = (await (await post('/api/filiais', { nome: 'Loja B', setor_id: setorB.id })).json()).filial;
    const tecnicoB = await criarUsuario('Técnico B', 'tecnicoB@rede.com', 'suporte', { filial_id: lojaB.id });
    const gerenteB = await criarUsuario('Gerente B', 'gerenteB@rede.com', 'gerente_loja', { filial_id: lojaB.id });
    await put(`/api/filiais/${lojaB.id}`, { nome: 'Loja B', setor_id: setorB.id, tecnico_id: tecnicoB.id, gerente_id: gerenteB.id });

    const { areas: areasLojaA } = await (await get(`/api/areas?filial_id=${lojaA.id}`)).json();
    const { areas: areasLojaB } = await (await get(`/api/areas?filial_id=${lojaB.id}`)).json();
    const areaA = areasLojaA.find((a) => a.nome === 'Cozinha');
    const areaB = areasLojaB.find((a) => a.nome === 'Cozinha');

    const catA = await (await post('/api/equipamentos', { tipo: 'Fritadeira', modelo: 'FR-100' })).json();
    const equipA = (await (await post(`/api/equipamentos/${catA.equipamento.id}/atrelar-filial`, { filial_id: lojaA.id, area_id: areaA.id, numero_serie: 'SN-A1' })).json()).equipamento;
    const catB = await (await post('/api/equipamentos', { tipo: 'Fritadeira', modelo: 'FR-100' })).json();
    const equipB = (await (await post(`/api/equipamentos/${catB.equipamento.id}/atrelar-filial`, { filial_id: lojaB.id, area_id: areaB.id, numero_serie: 'SN-B1' })).json()).equipamento;

    const tokenTecnicoA = await login('tecnicoA@rede.com');
    const tokenGerenteA = await login('gerenteA@rede.com');
    const tokenTecnicoB = await login('tecnicoB@rede.com');
    const tokenGerenteB = await login('gerenteB@rede.com');
    const tokenCoordA = await login('coordA@rede.com');

    // --- duas solicitações aprovadas, MESMO código, em lojas diferentes ---
    async function criarEAprovar(equipamentoId, tokenSolicitante, tokenGerente) {
      const r = await post('/api/solicitacoes-peca', {
        equipamento_id: equipamentoId, prioridade: 'urgente', descricao: 'Resistência da fritadeira',
        codigo_produto: 'RES-100', quantidade: 1, valor_unitario: 50,
      }, auth(tokenSolicitante));
      const sol = (await r.json()).solicitacao;
      await post(`/api/solicitacoes-peca/${sol.id}/ciente`, {}, auth(tokenGerente));
      const rAprova = await post(`/api/solicitacoes-peca/${sol.id}/aprovar-local`, {}, auth(tokenGerente));
      assert.equal(rAprova.status, 200, JSON.stringify(await rAprova.clone().json()));
      return (await rAprova.json()).solicitacao;
    }
    const solA = await criarEAprovar(equipA.id, tokenTecnicoA, tokenGerenteA);
    const solB = await criarEAprovar(equipB.id, tokenTecnicoB, tokenGerenteB);

    // --- consolidação: as duas aparecem juntas na sugestão por código ---
    const { sugestoes } = await (await get('/api/pedidos-compra/sugestoes', auth(tokenCoordA))).json();
    const grupoResistencia = sugestoes.find((g) => g.codigo_produto === 'RES-100');
    assert.ok(grupoResistencia);
    assert.equal(grupoResistencia.quantidade_total, 2);
    assert.equal(grupoResistencia.solicitacoes.length, 2);

    // --- pedido de compra no atacado, cobrindo as duas solicitações ---
    const rPedido = await post('/api/pedidos-compra', {
      fornecedor: 'Fornecedor Atacado', nota_fiscal_numero: 'NF-500',
      itens: [{ codigo_produto: 'RES-100', descricao: 'Resistência de fritadeira', quantidade: 5, valor_unitario: 45, solicitacoes_atendidas: [solA.id, solB.id] }],
    }, auth(tokenCoordA));
    assert.equal(rPedido.status, 201, JSON.stringify(await rPedido.clone().json()));
    const { pedido, itens: itensPedido } = await rPedido.json();
    const itemPedido = itensPedido[0];
    assert.equal(itemPedido.valor_total, 225);

    // ambas as solicitações avançaram pra "comprado" com a NF do pedido
    const solAAtualizada = (await (await get(`/api/solicitacoes-peca/${solA.id}`, auth(tokenGerenteA))).json()).solicitacao;
    assert.equal(solAAtualizada.status, 'comprado');
    assert.equal(solAAtualizada.nota_fiscal_numero, 'NF-500');

    // estoque central recebeu as 5 unidades
    const { estoque: estoqueCentral } = await (await get('/api/estoque-central', authAdmin)).json();
    assert.equal(estoqueCentral.find((e) => e.codigo_produto === 'RES-100').saldo, 5);

    // não dá pra incluir a mesma solicitação em outro pedido
    const rPedidoDuplicado = await post('/api/pedidos-compra', {
      fornecedor: 'Outro', itens: [{ codigo_produto: 'RES-100', descricao: 'x', quantidade: 1, valor_unitario: 10, solicitacoes_atendidas: [solA.id] }],
    }, auth(tokenCoordA));
    assert.equal(rPedidoDuplicado.status, 400);

    // --- distribuição central -> Loja A, vinculada à solicitação A ---
    const rTransfCentral = await post('/api/transferencias', {
      origem_tipo: 'central', destino_filial_id: lojaA.id, codigo_produto: 'RES-100', descricao: 'Resistência',
      quantidade: 2, pedido_item_id: itemPedido.id, solicitacao_id: solA.id,
    }, auth(tokenCoordA));
    assert.equal(rTransfCentral.status, 201);
    const transfCentral = (await rTransfCentral.json()).transferencia;
    assert.equal(transfCentral.status, 'enviada');
    const { estoque: estoqueCentralDepois } = await (await get('/api/estoque-central', authAdmin)).json();
    assert.equal(estoqueCentralDepois.find((e) => e.codigo_produto === 'RES-100').saldo, 3);

    // gerente da Loja A confirma o recebimento -> credita estoque da loja E avança a
    // solicitação A pra "peça na loja" (com O.S. de instalação automática)
    const rConfirma = await put(`/api/transferencias/${transfCentral.id}/confirmar-recebimento`, {}, auth(tokenGerenteA));
    assert.equal(rConfirma.status, 200);
    const { agenda: osInstalacaoA } = await rConfirma.json();
    assert.equal(osInstalacaoA.tecnico_id, tecnicoA.id);
    const solADepoisRecebimento = (await (await get(`/api/solicitacoes-peca/${solA.id}`, auth(tokenGerenteA))).json()).solicitacao;
    assert.equal(solADepoisRecebimento.status, 'peca_na_loja');

    // --- busca de peça no grupo: Loja A agora tem RES-100 em estoque ---
    const { nas_lojas: busca } = await (await get('/api/estoque-loja/buscar?codigo_produto=RES-100', auth(tokenGerenteB))).json();
    assert.ok(busca.some((b) => b.filial_id === lojaA.id && b.saldo === 2));

    // --- transferência entre filiais: Loja B pede pra Loja A (que agora tem estoque) ---
    const rPedeTransf = await post('/api/transferencias', {
      origem_tipo: 'filial', origem_filial_id: lojaA.id, destino_filial_id: lojaB.id,
      codigo_produto: 'RES-100', descricao: 'Resistência', quantidade: 1,
    }, auth(tokenGerenteB));
    assert.equal(rPedeTransf.status, 201);
    const transfEntreLojas = (await rPedeTransf.json()).transferencia;
    assert.equal(transfEntreLojas.status, 'pedida');

    // Loja B não pode aceitar o próprio pedido (só a origem decide)
    const negaAceitarPropria = await put(`/api/transferencias/${transfEntreLojas.id}/aceitar`, {}, auth(tokenGerenteB));
    assert.equal(negaAceitarPropria.status, 403);

    // Loja A aceita, despacha, e Loja B confirma o recebimento
    const rAceita = await put(`/api/transferencias/${transfEntreLojas.id}/aceitar`, {}, auth(tokenGerenteA));
    assert.equal((await rAceita.json()).transferencia.status, 'aceita');
    const rEnvia = await put(`/api/transferencias/${transfEntreLojas.id}/enviar`, {}, auth(tokenGerenteA));
    assert.equal(rEnvia.status, 200);
    const { estoque: estoqueLojaA } = await (await get(`/api/estoque-loja?filial_id=${lojaA.id}`, auth(tokenGerenteA))).json();
    assert.equal(estoqueLojaA.find((e) => e.codigo_produto === 'RES-100').saldo, 1, 'Loja A deveria ficar só com 1 depois de enviar 1 das 2');

    const rRecebeB = await put(`/api/transferencias/${transfEntreLojas.id}/confirmar-recebimento`, {}, auth(tokenGerenteB));
    assert.equal(rRecebeB.status, 200);
    const { estoque: estoqueLojaB } = await (await get(`/api/estoque-loja?filial_id=${lojaB.id}`, auth(tokenGerenteB))).json();
    assert.equal(estoqueLojaB.find((e) => e.codigo_produto === 'RES-100').saldo, 1);

    // --- rastreio por código: 1 comprado->instalado (fluxo A) + total distribuído ---
    const { rastreio } = await (await get('/api/pedidos-compra/rastreio?codigo_produto=RES-100', auth(tokenCoordA))).json();
    assert.equal(rastreio.length, 1);
    assert.equal(rastreio[0].distribuido, 2); // só a transferência central->Loja A conta (a de Loja A->B não é do pedido)

    // --- custo real por filial (a partir do valor de verdade pago no pedido: 45, não os 50 estimados) ---
    const { custos } = await (await get('/api/pedidos-compra/custos?agrupar_por=filial', auth(tokenCoordA))).json();
    const custoLojaA = custos.find((c) => c.label === 'Loja A');
    assert.equal(custoLojaA.total, 45);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
